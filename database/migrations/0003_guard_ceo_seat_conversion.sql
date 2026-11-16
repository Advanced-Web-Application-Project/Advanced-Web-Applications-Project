-- Preserve existing ticket meaning when ordinary inventory is corrected.
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
  ELSIF TG_OP = 'UPDATE' AND NOT NEW.is_wheelchair AND NEW.seat_label = 1 THEN
    IF EXISTS (SELECT 1 FROM public.tickets WHERE seat_id = OLD.id) THEN
      RAISE EXCEPTION 'A referenced ordinary place cannot be converted into the CEO place';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
