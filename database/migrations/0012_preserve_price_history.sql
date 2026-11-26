-- 0011 is immutable. The guarded runner snapshots pre-0011 references in the
-- same transaction when upgrading older databases through both migrations.
DROP INDEX public.prices_category_uidx;
DO $$
BEGIN
  IF to_regclass('pg_temp.rio_prices_before_0011') IS NOT NULL THEN
    INSERT INTO public.prices(id,category,amount_cents)
      SELECT id,category,amount_cents FROM pg_temp.rio_prices_before_0011
      ON CONFLICT(id) DO NOTHING;
    UPDATE public.tickets t SET price_id=b.price_id
      FROM pg_temp.rio_ticket_prices_before_0011 b WHERE t.id=b.id AND t.price_id IS DISTINCT FROM b.price_id;
  END IF;
END $$;

ALTER TABLE public.prices ADD COLUMN is_current BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE public.prices SET is_current=TRUE WHERE id IN (
  SELECT MIN(id) FROM public.prices GROUP BY category
);
ALTER TABLE public.prices ALTER COLUMN is_current SET DEFAULT TRUE;
CREATE UNIQUE INDEX prices_current_category_uidx ON public.prices(category) WHERE is_current;
ALTER TABLE public.prices ADD CONSTRAINT prices_version_positive CHECK(version > 0);
-- Existing noncurrent rows and ticket references are retained, never repriced.
