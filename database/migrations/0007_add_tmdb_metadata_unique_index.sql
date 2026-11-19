-- Append-only migration: enforce unique TMDB provider identities on films.metadata_api_id
-- Preserves films.id, screenings foreign keys, and existing rio-demo / NULL markers.

DO $$
DECLARE
  duplicate_report TEXT;
  malformed_report TEXT;
BEGIN
  SELECT string_agg(
           format('%s (film ids: %s)', metadata_api_id, film_ids),
           '; '
           ORDER BY metadata_api_id
         )
  INTO duplicate_report
  FROM (
    SELECT
      metadata_api_id,
      string_agg(id::TEXT, ', ' ORDER BY id) AS film_ids
    FROM films
    WHERE metadata_api_id IS NOT NULL
      AND metadata_api_id LIKE 'tmdb:%'
    GROUP BY metadata_api_id
    HAVING COUNT(*) > 1
  ) duplicates;

  IF duplicate_report IS NOT NULL THEN
    RAISE EXCEPTION
      'Preflight failed: duplicate TMDB metadata_api_id values found in films. Resolve manually without deleting referenced screenings: %',
      duplicate_report;
  END IF;

  SELECT string_agg(
           format('id=%s (%s)', id, metadata_api_id),
           '; '
           ORDER BY id
         )
  INTO malformed_report
  FROM films
  WHERE metadata_api_id IS NOT NULL
    AND metadata_api_id LIKE 'tmdb:%'
    AND metadata_api_id !~ '^tmdb:[1-9][0-9]*$';

  IF malformed_report IS NOT NULL THEN
    RAISE EXCEPTION
      'Preflight failed: malformed TMDB metadata_api_id values found in films. Expected tmdb:<positive-integer>: %',
      malformed_report;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS films_tmdb_metadata_api_id_uidx
  ON films (metadata_api_id)
  WHERE metadata_api_id IS NOT NULL AND metadata_api_id LIKE 'tmdb:%';