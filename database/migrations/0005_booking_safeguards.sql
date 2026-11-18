ALTER TABLE public.bookings ADD COLUMN hold_token_hash text,
  ADD CONSTRAINT bookings_hold_token_check CHECK (hold_token_hash IS NULL OR (
    booking_type = 'customer' AND hold_token_hash ~ '^[0-9a-f]{64}$'
    AND (status <> 'hold' OR expiry_time IS NOT NULL)
  ));
ALTER TABLE public.tickets ADD COLUMN ticket_category text,
  ADD CONSTRAINT tickets_category_check CHECK (ticket_category IS NULL OR ticket_category IN ('adult','child','company'));

-- One active-state definition for availability and database allocation guards.
CREATE FUNCTION public.booking_blocks_place(kind text, state text, deadline timestamp, local_now timestamp)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT kind = 'ceo' OR state IN ('paid','company_invoiced')
    OR (state IN ('hold','reserved') AND (deadline IS NULL OR deadline > local_now));
$$;

-- Do not guess which paid booking to cancel when adopting legacy data.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.tickets t JOIN public.bookings b ON b.id=t.booking_id
    WHERE public.booking_blocks_place(b.booking_type,b.status,b.expiry_time,statement_timestamp() AT TIME ZONE 'Europe/Helsinki')
    GROUP BY b.screening_id,t.seat_id HAVING count(*) > 1
  ) THEN RAISE EXCEPTION 'Existing duplicate active allocations require review; no bookings were changed'; END IF;
END;
$$;

CREATE FUNCTION public.guard_active_ticket_allocation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE booking_row public.bookings%ROWTYPE; target_screen integer;
BEGIN
  -- Existing CEO guards own the designated place and retain their error contract.
  IF EXISTS (SELECT 1 FROM public.seats WHERE id=NEW.seat_id AND is_ceo_reserved) THEN RETURN NEW; END IF;
  SELECT sc.screen_id INTO target_screen FROM public.bookings b JOIN public.screenings sc ON sc.id=b.screening_id WHERE b.id=NEW.booking_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  PERFORM 1 FROM public.screens WHERE id=target_screen FOR NO KEY UPDATE;
  SELECT * INTO booking_row FROM public.bookings WHERE id=NEW.booking_id FOR NO KEY UPDATE;
  IF public.booking_blocks_place(booking_row.booking_type,booking_row.status,booking_row.expiry_time,statement_timestamp() AT TIME ZONE 'Europe/Helsinki') AND EXISTS (
    SELECT 1 FROM public.tickets t JOIN public.bookings b ON b.id=t.booking_id
    WHERE b.screening_id=booking_row.screening_id AND t.seat_id=NEW.seat_id AND t.id<>NEW.id
      AND public.booking_blocks_place(b.booking_type,b.status,b.expiry_time,statement_timestamp() AT TIME ZONE 'Europe/Helsinki')
  ) THEN RAISE EXCEPTION USING ERRCODE='23505', CONSTRAINT='tickets_active_place_unique', MESSAGE='Active place allocation conflict'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_guard_active_ticket_allocation BEFORE INSERT OR UPDATE ON public.tickets
FOR EACH ROW EXECUTE FUNCTION public.guard_active_ticket_allocation();

CREATE FUNCTION public.guard_booking_allocation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_screen integer;
BEGIN
  SELECT screen_id INTO target_screen FROM public.screenings WHERE id=NEW.screening_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  PERFORM 1 FROM public.screens WHERE id=target_screen FOR NO KEY UPDATE;
  IF EXISTS (SELECT 1 FROM public.tickets t JOIN public.seats s ON s.id=t.seat_id WHERE t.booking_id=OLD.id AND s.screen_id<>target_screen) THEN
    RAISE EXCEPTION 'Booking cannot move its tickets to another screen';
  END IF;
  IF public.booking_blocks_place(NEW.booking_type,NEW.status,NEW.expiry_time,statement_timestamp() AT TIME ZONE 'Europe/Helsinki') AND (EXISTS (SELECT 1 FROM public.tickets WHERE booking_id=OLD.id GROUP BY seat_id HAVING count(*)>1) OR EXISTS (
    SELECT 1 FROM public.tickets own JOIN public.tickets other ON other.seat_id=own.seat_id AND other.booking_id<>OLD.id
    JOIN public.bookings b ON b.id=other.booking_id
    WHERE own.booking_id=OLD.id AND b.screening_id=NEW.screening_id
      AND public.booking_blocks_place(b.booking_type,b.status,b.expiry_time,statement_timestamp() AT TIME ZONE 'Europe/Helsinki')
  )) THEN RAISE EXCEPTION USING ERRCODE='23505', CONSTRAINT='tickets_active_place_unique', MESSAGE='Active place allocation conflict'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_guard_booking_allocation BEFORE UPDATE OF status, expiry_time, screening_id, booking_type ON public.bookings
FOR EACH ROW EXECUTE FUNCTION public.guard_booking_allocation();
