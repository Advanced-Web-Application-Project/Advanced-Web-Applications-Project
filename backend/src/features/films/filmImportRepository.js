const ARTWORK_COLUMN = 'artwork_url';

const UPSERT_TMDB_FILM_SQL = `
  INSERT INTO films (title, description, ${ARTWORK_COLUMN}, metadata_api_id)
  VALUES ($1, $2, $3, $4)
  ON CONFLICT (metadata_api_id)
  WHERE metadata_api_id IS NOT NULL AND metadata_api_id LIKE 'tmdb:%'
  DO UPDATE SET
    title = EXCLUDED.title,
    description = COALESCE(EXCLUDED.description, films.description),
    ${ARTWORK_COLUMN} = COALESCE(EXCLUDED.${ARTWORK_COLUMN}, films.${ARTWORK_COLUMN})
  RETURNING
    id,
    title,
    description,
    ${ARTWORK_COLUMN} AS poster_url,
    metadata_api_id,
    (xmax = 0) AS inserted;
`;

export function createFilmImportRepository(pool) {
  return {
    async upsertBatchInTransaction(films) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const results = [];
        for (const film of films) {
          const { rows } = await client.query(UPSERT_TMDB_FILM_SQL, [
            film.title,
            film.description,
            film.posterUrl,
            film.metadataApiId,
          ]);
          const row = rows[0];
          results.push({
            localId: row.id,
            tmdbId: film.tmdbId,
            metadataApiId: row.metadata_api_id,
            title: row.title,
            description: row.description,
            posterUrl: row.poster_url,
            action: row.inserted ? 'inserted' : 'updated',
          });
        }

        await client.query('COMMIT');
        return results;
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Preserve original error if rollback fails on a broken connection.
        }
        throw err;
      } finally {
        client.release();
      }
    },
  };
}