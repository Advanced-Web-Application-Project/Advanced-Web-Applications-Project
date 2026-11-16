-- Default CEO reservations are system allocations, not sales or expiring holds.
ALTER TABLE public.bookings
  ADD COLUMN booking_type text NOT NULL DEFAULT 'customer',
  ADD CONSTRAINT bookings_type_check CHECK (booking_type IN ('customer', 'ceo'));
ALTER TABLE public.bookings DROP CONSTRAINT chk_customer_contact;
ALTER TABLE public.bookings ADD CONSTRAINT chk_customer_contact CHECK (
  (booking_type = 'customer' AND (user_id IS NOT NULL OR guest_email IS NOT NULL))
  OR (booking_type = 'ceo' AND user_id IS NULL AND guest_email IS NULL)
);
ALTER TABLE public.bookings ADD CONSTRAINT bookings_ceo_shape_check CHECK (
  booking_type <> 'ceo' OR (status = 'reserved' AND expiry_time IS NULL)
);
CREATE UNIQUE INDEX bookings_one_ceo_per_screening
  ON public.bookings (screening_id) WHERE booking_type = 'ceo';

-- Refuse ambiguous/protected history instead of moving places or cancelling tickets.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.seats WHERE is_ceo_reserved AND (is_wheelchair OR seat_label <> 1)) THEN
    RAISE EXCEPTION 'Existing CEO flags require inventory review';
  END IF;
  IF EXISTS (SELECT 1 FROM public.seats WHERE NOT is_wheelchair AND seat_label = 1
             AND (physical_row <> 1 OR row_label <> 1)) THEN
    RAISE EXCEPTION 'Existing displayed seat 1 position requires inventory review';
  END IF;
  IF EXISTS (SELECT 1 FROM public.tickets t JOIN public.seats s ON s.id = t.seat_id
             WHERE NOT s.is_wheelchair AND s.seat_label = 1) THEN
    RAISE EXCEPTION 'Existing customer tickets for seat 1 require review';
  END IF;
END;
$$;
UPDATE public.seats SET is_ceo_reserved = true
WHERE NOT is_wheelchair AND seat_label = 1 AND NOT is_ceo_reserved;
ALTER TABLE public.seats ADD CONSTRAINT seats_ceo_flag_check
  CHECK (is_ceo_reserved = (seat_label = 1 AND NOT is_wheelchair));
ALTER TABLE public.seats ADD CONSTRAINT seats_ceo_position_check
  CHECK (is_wheelchair OR seat_label <> 1 OR (physical_row = 1 AND row_label = 1));
CREATE UNIQUE INDEX seats_one_ceo_per_screen
  ON public.seats (screen_id) WHERE seat_label = 1 AND NOT is_wheelchair;

CREATE OR REPLACE FUNCTION public.protect_ceo_seat_config()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.is_ceo_reserved OR (OLD.seat_label = 1 AND NOT OLD.is_wheelchair) THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'CEO-designated seat cannot be deleted';
    END IF;
    IF ROW(NEW.id, NEW.screen_id, NEW.physical_row, NEW.row_label, NEW.seat_label, NEW.is_wheelchair, NEW.is_ceo_reserved)
       IS DISTINCT FROM ROW(OLD.id, OLD.screen_id, OLD.physical_row, OLD.row_label, OLD.seat_label, OLD.is_wheelchair, OLD.is_ceo_reserved) THEN
      RAISE EXCEPTION 'CEO-designated seat cannot be moved, relabelled or released';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.protect_ceo_booking()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Cascading deletion of a deleted screening is not a release for sale.
    IF OLD.booking_type = 'ceo' AND EXISTS (SELECT 1 FROM public.screenings WHERE id = OLD.screening_id) THEN
      RAISE EXCEPTION 'CEO reservation release is disabled until CEO authentication is implemented';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.booking_type = 'ceo' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'CEO reservation release is disabled until CEO authentication is implemented';
  END IF;
  IF NEW.booking_type IS DISTINCT FROM OLD.booking_type THEN
    RAISE EXCEPTION 'Booking type cannot be reassigned';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_protect_ceo_booking BEFORE UPDATE OR DELETE ON public.bookings
FOR EACH ROW EXECUTE FUNCTION public.protect_ceo_booking();

CREATE OR REPLACE FUNCTION public.prevent_ceo_seat_booking()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  old_type text;
  booking_kind text;
  target_screen integer;
  place public.seats%ROWTYPE;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT booking_type INTO old_type FROM public.bookings WHERE id = OLD.booking_id;
    IF old_type = 'ceo' AND (TG_OP = 'DELETE' OR NEW IS DISTINCT FROM OLD) THEN
      RAISE EXCEPTION 'CEO reservation ticket cannot be changed or removed';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  PERFORM 1 FROM public.bookings WHERE id = NEW.booking_id FOR NO KEY UPDATE;
  SELECT b.booking_type, sc.screen_id INTO booking_kind, target_screen
    FROM public.bookings b JOIN public.screenings sc ON sc.id = b.screening_id
    WHERE b.id = NEW.booking_id;
  IF NOT FOUND THEN RETURN NEW; END IF; -- Existing FK reports a missing booking.
  SELECT * INTO place FROM public.seats WHERE id = NEW.seat_id;
  IF NOT FOUND THEN RETURN NEW; END IF; -- Existing FK reports a missing seat.
  IF place.screen_id <> target_screen THEN
    RAISE EXCEPTION 'Ticket seat must belong to the screening screen';
  END IF;
  IF booking_kind = 'ceo' THEN
    IF place.is_wheelchair OR place.seat_label <> 1 OR NOT place.is_ceo_reserved
       OR NEW.amount_charged <> 0 OR NEW.price_id IS NOT NULL OR NEW.is_loyalty_rewarded THEN
      RAISE EXCEPTION 'CEO reservation ticket must be the designated seat with no price or reward';
    END IF;
    IF EXISTS (SELECT 1 FROM public.tickets WHERE booking_id = NEW.booking_id AND id <> NEW.id) THEN
      RAISE EXCEPTION 'CEO reservation must contain exactly one place';
    END IF;
  ELSIF place.is_ceo_reserved OR (place.seat_label = 1 AND NOT place.is_wheelchair) THEN
    RAISE EXCEPTION 'CEO seat is unavailable to customer bookings';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER trg_prevent_ceo_seat_booking ON public.tickets;
CREATE TRIGGER trg_prevent_ceo_seat_booking BEFORE INSERT OR UPDATE OR DELETE ON public.tickets
FOR EACH ROW EXECUTE FUNCTION public.prevent_ceo_seat_booking();

CREATE FUNCTION public.ensure_ceo_reservation(p_screening_id integer)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  target_screen integer;
  reservation_id integer;
  protected_seat integer;
BEGIN
  SELECT screen_id INTO target_screen FROM public.screenings WHERE id = p_screening_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Screening not found'; END IF;
  -- Serialize screening creation and late seat-1 inventory provisioning per screen.
  PERFORM 1 FROM public.screens WHERE id = target_screen FOR NO KEY UPDATE;
  PERFORM 1 FROM public.screenings WHERE id = p_screening_id FOR NO KEY UPDATE;
  INSERT INTO public.bookings (screening_id, status, booking_type)
    VALUES (p_screening_id, 'reserved', 'ceo')
    ON CONFLICT (screening_id) WHERE booking_type = 'ceo' DO NOTHING;
  SELECT id INTO reservation_id FROM public.bookings
    WHERE screening_id = p_screening_id AND booking_type = 'ceo';
  SELECT id INTO protected_seat FROM public.seats
    WHERE screen_id = target_screen AND seat_label = 1 AND NOT is_wheelchair;
  IF protected_seat IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.tickets WHERE booking_id = reservation_id) THEN
    INSERT INTO public.tickets (booking_id, seat_id, amount_charged)
      VALUES (reservation_id, protected_seat, 0);
  END IF;
  RETURN reservation_id;
END;
$$;

CREATE FUNCTION public.ensure_ceo_after_inventory_or_screening()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  listing record;
BEGIN
  IF TG_TABLE_NAME = 'screenings' THEN
    PERFORM public.ensure_ceo_reservation(NEW.id);
  ELSIF NOT NEW.is_wheelchair AND NEW.seat_label = 1 THEN
    PERFORM 1 FROM public.screens WHERE id = NEW.screen_id FOR NO KEY UPDATE;
    FOR listing IN SELECT id FROM public.screenings WHERE screen_id = NEW.screen_id ORDER BY id LOOP
      PERFORM public.ensure_ceo_reservation(listing.id);
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_ensure_ceo_for_screening AFTER INSERT ON public.screenings
FOR EACH ROW EXECUTE FUNCTION public.ensure_ceo_after_inventory_or_screening();
CREATE TRIGGER trg_ensure_ceo_for_inventory AFTER INSERT OR UPDATE ON public.seats
FOR EACH ROW EXECUTE FUNCTION public.ensure_ceo_after_inventory_or_screening();

CREATE FUNCTION public.prevent_ceo_screening_relocation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.screen_id IS DISTINCT FROM OLD.screen_id AND
     EXISTS (SELECT 1 FROM public.bookings WHERE screening_id = OLD.id AND booking_type = 'ceo') THEN
    RAISE EXCEPTION 'Screening with a CEO reservation cannot move screens without a coordinated allocation change';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_protect_ceo_screening BEFORE UPDATE OF screen_id ON public.screenings
FOR EACH ROW EXECUTE FUNCTION public.prevent_ceo_screening_relocation();

DO $$
DECLARE listing record;
BEGIN
  FOR listing IN SELECT id FROM public.screenings ORDER BY screen_id, id LOOP
    PERFORM public.ensure_ceo_reservation(listing.id);
  END LOOP;
END;
$$;
