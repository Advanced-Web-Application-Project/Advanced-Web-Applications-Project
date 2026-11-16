-- Keep legacy integer labels/flags; add explicit stored positions and public labels.
-- Generated columns make the approved numbering and physical arrangement inseparable.
ALTER TABLE public.seats
  ADD COLUMN physical_column integer GENERATED ALWAYS AS (
    CASE WHEN is_wheelchair THEN seat_label
      WHEN physical_row % 2 = 1 THEN ((seat_label - CASE WHEN seat_label > 13 THEN 1 ELSE 0 END - 1) % 10) + 1
      ELSE 10 - ((seat_label - CASE WHEN seat_label > 13 THEN 1 ELSE 0 END - 1) % 10)
    END
  ) STORED,
  ADD COLUMN display_label text GENERATED ALWAYS AS (
    CASE WHEN is_wheelchair THEN 'W' || seat_label::text ELSE seat_label::text END
  ) STORED,
  ADD CONSTRAINT seats_layout_check CHECK (
    (is_wheelchair AND physical_row = 0 AND row_label = 0 AND seat_label BETWEEN 1 AND 10)
    OR (NOT is_wheelchair AND seat_label BETWEEN 1 AND 201 AND seat_label <> 13
      AND physical_row = (seat_label - CASE WHEN seat_label > 13 THEN 1 ELSE 0 END - 1) / 10 + 1
      AND row_label = physical_row + CASE WHEN physical_row >= 13 THEN 1 ELSE 0 END)
  );
CREATE UNIQUE INDEX seats_unique_zone_label ON public.seats (screen_id, is_wheelchair, seat_label);
CREATE UNIQUE INDEX seats_unique_position ON public.seats (screen_id, is_wheelchair, physical_row, physical_column);
ALTER TABLE public.screens ADD CONSTRAINT screens_wheelchair_capacity_check CHECK (wheelchair_capacity = 10);

-- Refuse incompatible legacy data; never silently move existing booked places.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.seats s JOIN public.screens sc ON sc.id = s.screen_id
    WHERE NOT s.is_wheelchair AND s.physical_row > sc.capacity / 10) THEN
    RAISE EXCEPTION 'Existing inventory exceeds screen capacity; inspect before migrating';
  END IF;
END;
$$;

CREATE FUNCTION public.guard_inventory_place()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE seated_capacity integer;
BEGIN
  SELECT capacity INTO seated_capacity FROM public.screens WHERE id = NEW.screen_id FOR NO KEY UPDATE;
  IF FOUND AND NOT NEW.is_wheelchair AND NEW.physical_row > seated_capacity / 10 THEN
    RAISE EXCEPTION 'Seat position exceeds screen capacity';
  END IF;
  IF TG_OP = 'UPDATE' AND ROW(NEW.id, NEW.screen_id, NEW.physical_row, NEW.row_label, NEW.seat_label, NEW.is_wheelchair)
    IS DISTINCT FROM ROW(OLD.id, OLD.screen_id, OLD.physical_row, OLD.row_label, OLD.seat_label, OLD.is_wheelchair)
    AND EXISTS (SELECT 1 FROM public.tickets WHERE seat_id = OLD.id) THEN
    RAISE EXCEPTION 'Referenced inventory cannot be moved or relabelled';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_guard_inventory_place BEFORE INSERT OR UPDATE ON public.seats
FOR EACH ROW EXECUTE FUNCTION public.guard_inventory_place();

CREATE FUNCTION public.guard_screen_inventory_capacity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.capacity IS DISTINCT FROM OLD.capacity AND EXISTS (
    SELECT 1 FROM public.seats WHERE screen_id = OLD.id AND NOT is_wheelchair AND physical_row > NEW.capacity / 10
  ) THEN RAISE EXCEPTION 'Screen capacity cannot exclude existing inventory'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_guard_screen_inventory_capacity BEFORE UPDATE OF capacity ON public.screens
FOR EACH ROW EXECUTE FUNCTION public.guard_screen_inventory_capacity();
