-- Keep successful request identity with retained booking history.
ALTER TABLE public.bookings ADD COLUMN hold_request_fingerprint text,
  ADD CONSTRAINT bookings_request_fingerprint_check CHECK (
    hold_request_fingerprint IS NULL OR (
      booking_type = 'customer' AND hold_token_hash IS NOT NULL
      AND hold_request_fingerprint ~ '^[0-9a-f]{64}$'
    )
  );

-- Refuse ambiguous legacy credentials instead of merging/deleting allocations.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM public.bookings WHERE hold_token_hash IS NOT NULL
    GROUP BY hold_token_hash HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate legacy hold credentials require manual review; no records were changed';
  END IF;
END $$;

CREATE UNIQUE INDEX bookings_hold_token_hash_uidx
  ON public.bookings (hold_token_hash) WHERE hold_token_hash IS NOT NULL;
