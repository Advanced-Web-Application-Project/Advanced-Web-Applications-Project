WITH ranked_prices AS (
  SELECT
    id,
    category,
    FIRST_VALUE(id) OVER (PARTITION BY category ORDER BY id ASC) AS keep_id
  FROM public.prices
)
UPDATE public.tickets t
SET price_id = r.keep_id
FROM ranked_prices r
WHERE t.price_id = r.id
  AND r.id <> r.keep_id;

WITH ranked_prices AS (
  SELECT
    id,
    ROW_NUMBER() OVER (PARTITION BY category ORDER BY id ASC) AS rn
  FROM public.prices
)
DELETE FROM public.prices p
USING ranked_prices r
WHERE p.id = r.id
  AND r.rn > 1;

ALTER TABLE public.prices
ADD CONSTRAINT prices_amount_positive_check CHECK (amount_cents > 0);

CREATE UNIQUE INDEX IF NOT EXISTS prices_category_uidx
ON public.prices (category);

ALTER TABLE public.prices
ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1,
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
ADD COLUMN IF NOT EXISTS updated_by_user_id INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS updated_by_email TEXT;