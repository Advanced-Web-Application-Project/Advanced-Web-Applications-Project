-- Lock-then-read guards need a fresh snapshot after waiting for another writer.
-- Reject stale-snapshot writers instead of silently permitting an allocation race.
CREATE FUNCTION public.require_allocation_isolation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION USING ERRCODE='40001',
      MESSAGE='Booking allocation writes require READ COMMITTED isolation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_require_booking_isolation BEFORE INSERT OR UPDATE ON public.bookings
FOR EACH ROW EXECUTE FUNCTION public.require_allocation_isolation();
CREATE TRIGGER trg_require_ticket_isolation BEFORE INSERT OR UPDATE ON public.tickets
FOR EACH ROW EXECUTE FUNCTION public.require_allocation_isolation();
