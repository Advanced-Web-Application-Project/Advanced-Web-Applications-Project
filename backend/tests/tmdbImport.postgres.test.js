import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';

import { createFilmImportRepository } from '../src/features/films/filmImportRepository.js';
import { importTmdbFilms } from '../src/features/films/filmImportService.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

function makeStubTmdbClient(moviesById) {
  return {
    async fetchConfiguration() {
      return {
        images: {
          secure_base_url: 'https://image.tmdb.org/t/p/',
          poster_sizes: ['w500', 'original'],
        },
      };
    },
    async fetchMovieDetails(id) {
      const movie = moviesById[id];
      if (!movie) throw new Error(`Missing stub movie ${id}`);
      return movie;
    },
  };
}

test(
  'PostgreSQL TMDB import: idempotency, field preservation, concurrency, screening links, and rollback',
  { skip: !testDatabaseUrl },
  async (t) => {
    const pool = new Pool({ connectionString: testDatabaseUrl });
    const repo = createFilmImportRepository(pool);

    t.after(async () => {
      await pool.query("DELETE FROM films WHERE metadata_api_id IN ('tmdb:550', 'tmdb:603', 'tmdb:999001', 'tmdb:999002')");
      await pool.end();
    });

    await t.test('rerunning preserves films.id, creates no duplicates, and retains optional fields', async () => {
      const initial = await importTmdbFilms({
        rawIds: '550,603',
        tmdbClient: makeStubTmdbClient({
          550: { id: 550, title: 'Fight Club', overview: 'Initial overview', poster_path: '/fc.jpg' },
          603: { id: 603, title: 'The Matrix', overview: 'Reality is a simulation.', poster_path: null },
        }),
        filmImportRepository: repo,
      });

      const firstIds = Object.fromEntries(initial.films.map((f) => [f.metadataApiId, f.localId]));

      // Rerun with missing overview/poster on 550: must NOT erase retained description/artwork
      const rerun = await importTmdbFilms({
        rawIds: '550,603',
        tmdbClient: makeStubTmdbClient({
          550: { id: 550, title: 'Fight Club (Updated)', overview: '', poster_path: null },
          603: { id: 603, title: 'The Matrix', overview: 'Reality is a simulation.', poster_path: '/mx.jpg' },
        }),
        filmImportRepository: repo,
      });

      assert.equal(rerun.insertedCount, 0);
      assert.equal(rerun.updatedCount, 2);

      const fc = rerun.films.find((f) => f.metadataApiId === 'tmdb:550');
      assert.equal(fc.localId, firstIds['tmdb:550']);
      assert.equal(fc.title, 'Fight Club (Updated)');
      assert.equal(fc.description, 'Initial overview');
      assert.equal(fc.posterUrl, 'https://image.tmdb.org/t/p/w500/fc.jpg');

      const countRes = await pool.query(
        "SELECT COUNT(*)::INT AS c FROM films WHERE metadata_api_id IN ('tmdb:550', 'tmdb:603')"
      );
      assert.equal(countRes.rows[0].c, 2);
    });

    await t.test('concurrent imports with reversed ID order produce zero duplicates and no deadlocks', async () => {
      const stub = makeStubTmdbClient({
        999001: { id: 999001, title: 'Concurrent One', overview: 'A', poster_path: '/a.jpg' },
        999002: { id: 999002, title: 'Concurrent Two', overview: 'B', poster_path: '/b.jpg' },
      });

      const [runA, runB] = await Promise.all([
        importTmdbFilms({ rawIds: '999001,999002', tmdbClient: stub, filmImportRepository: repo }),
        importTmdbFilms({ rawIds: '999002,999001', tmdbClient: stub, filmImportRepository: repo }),
      ]);

      assert.deepEqual(
        runA.films.map((f) => f.localId),
        runB.films.map((f) => f.localId)
      );

      const { rows } = await pool.query(
        "SELECT COUNT(*)::INT AS c FROM films WHERE metadata_api_id IN ('tmdb:999001', 'tmdb:999002')"
      );
      assert.equal(rows[0].c, 2);
    });

    await t.test('late database failure rolls back entire batch with zero partial writes', async () => {
      const failingRepo = createFilmImportRepository({
        async connect() {
          const realClient = await pool.connect();
          let upsertCount = 0;
          return {
            async query(sql, params) {
              if (typeof sql === 'string' && sql.includes('INSERT INTO films')) {
                upsertCount += 1;
                if (upsertCount === 2) {
                  throw new Error('Simulated late database write failure');
                }
              }
              return realClient.query(sql, params);
            },
            release() {
              realClient.release();
            },
          };
        },
      });

      await assert.rejects(
        () =>
          failingRepo.upsertBatchInTransaction([
            { tmdbId: 888001, metadataApiId: 'tmdb:888001', title: 'Should Rollback 1', description: null, posterUrl: null },
            { tmdbId: 888002, metadataApiId: 'tmdb:888002', title: 'Should Rollback 2', description: null, posterUrl: null },
          ]),
        /Simulated late database write failure/
      );

      const { rows } = await pool.query(
        "SELECT COUNT(*)::INT AS c FROM films WHERE metadata_api_id IN ('tmdb:888001', 'tmdb:888002')"
      );
      assert.equal(rows[0].c, 0);
    });

    await t.test('screening FK link survives refresh and rio-demo rows remain untouched', async () => {
      // Assumes an existing screen row (e.g., seeded inventory/browsing data) exists in TEST_DATABASE_URL.
      const screenRes = await pool.query('SELECT id FROM screens ORDER BY id LIMIT 1');
      if (screenRes.rows.length === 0) return;

      const demoBefore = await pool.query(
        "SELECT id, title, metadata_api_id FROM films WHERE metadata_api_id LIKE 'rio-demo%' ORDER BY id"
      );

      const filmRes = await pool.query("SELECT id FROM films WHERE metadata_api_id = 'tmdb:550'");
      const filmId = filmRes.rows[0].id;

      // Insert a temporary screening referencing the TMDB film (adjust columns if your schema requires extras)
      const screeningRes = await pool.query(
        'INSERT INTO screenings (film_id, screen_id, screening_time) VALUES ($1, $2, NOW() + INTERVAL \'7 days\') RETURNING id',
        [filmId, screenRes.rows[0].id]
      );
      const screeningId = screeningRes.rows[0].id;

      try {
        await importTmdbFilms({
          rawIds: '550',
          tmdbClient: makeStubTmdbClient({
            550: { id: 550, title: 'Fight Club (Refreshed)', overview: 'Refreshed', poster_path: '/fc2.jpg' },
          }),
          filmImportRepository: repo,
        });

        const check = await pool.query('SELECT film_id FROM screenings WHERE id = $1', [screeningId]);
        assert.equal(check.rows[0].film_id, filmId);

        const demoAfter = await pool.query(
          "SELECT id, title, metadata_api_id FROM films WHERE metadata_api_id LIKE 'rio-demo%' ORDER BY id"
        );
        assert.deepEqual(demoAfter.rows, demoBefore.rows);
      } finally {
        await pool.query('DELETE FROM screenings WHERE id = $1', [screeningId]);
      }
    });
  }
);