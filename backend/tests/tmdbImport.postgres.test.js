import test from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { createFilmImportRepository } from "../src/features/films/filmImportRepository.js";
import { importTmdbFilms } from "../src/features/films/filmImportService.js";
import {
  assertIsolatedDevelopment,
  assertConnectedLocalTarget,
  createClient,
} from "../scripts/database/connection.js";
import { migrateDatabase } from "../scripts/database/migrate.js";
import { seedBrowsing } from "../scripts/database/seed-browsing.js";
import { startServer } from "../src/server.js";
import { readFile } from "node:fs/promises";

const databaseUrl = process.env.TEST_DATABASE_URL;
const mode = "isolated-development";
const movie = (id, title = `Movie ${id}`) => ({
  id,
  title,
  overview: "Retained description",
  poster_path: "/poster.jpg",
});
const stub = (movies) => ({
  async fetchConfiguration() {
    return {
      images: {
        secure_base_url: "https://image.tmdb.org/t/p/",
        poster_sizes: ["w500"],
      },
    };
  },
  async fetchMovieDetails(id) {
    return movies[id];
  },
});

test(
  "isolated PostgreSQL TMDB import and retained-data API workflow",
  { skip: !databaseUrl, timeout: 45000 },
  async (t) => {
    const sourceDatabase = assertIsolatedDevelopment(databaseUrl, mode);
    const admin = createClient(databaseUrl);
    await admin.connect();
    await assertConnectedLocalTarget(admin, sourceDatabase);
    const database = `rio_test_tmdb_${process.pid}`;
    const url = new URL(databaseUrl);
    url.pathname = `/${database}`;
    await admin.query(`CREATE DATABASE ${database}`);
    let pool;
    t.after(async () => {
      try {
        await pool?.end();
        await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    });
    await migrateDatabase({ databaseUrl: url.href, mode });
    await seedBrowsing({ databaseUrl: url.href, mode });
    pool = new Pool({ connectionString: url.href });
    const repo = createFilmImportRepository(pool, { database });
    const run = (rawIds, movies) =>
      importTmdbFilms({
        rawIds,
        tmdbClient: stub(movies),
        filmImportRepository: repo,
      });
    const snapshot = async () =>
      (await pool.query("SELECT * FROM films ORDER BY id")).rows;
    const demoBefore = await snapshot();
    let initial;

    await t.test(
      "reruns preserve local IDs and optional fields; demo rows are untouched",
      async () => {
        initial = await run("550,603", {
          550: movie(550, "Fight Club"),
          603: movie(603, "The Matrix"),
        });
        assert.equal(initial.insertedCount, 2);
        const rerun = await run("550,603", {
          550: {
            id: 550,
            title: "Fight Club refreshed",
            overview: "",
            poster_path: null,
          },
          603: movie(603, "The Matrix"),
        });
        assert.equal(rerun.insertedCount, 0);
        assert.equal(rerun.updatedCount, 2);
        assert.deepEqual(
          rerun.films.map((f) => f.localId),
          initial.films.map((f) => f.localId),
        );
        assert.equal(rerun.films[0].description, "Retained description");
        assert.equal(
          rerun.films[0].posterUrl,
          "https://image.tmdb.org/t/p/w500/poster.jpg",
        );
        assert.deepEqual(
          (await snapshot()).filter(
            (f) => !f.metadata_api_id.startsWith("tmdb:"),
          ),
          demoBefore,
        );
      },
    );

    await t.test(
      "concurrent reversed batches share IDs without duplicates",
      async () => {
        const movies = { 999001: movie(999001), 999002: movie(999002) };
        const results = await Promise.all([
          run("999001,999002", movies),
          run("999002,999001", movies),
        ]);
        assert.deepEqual(
          results[0].films.map((f) => f.localId),
          results[1].films.map((f) => f.localId),
        );
        assert.equal(
          (
            await pool.query(
              "SELECT COUNT(*)::int AS n FROM films WHERE metadata_api_id IN ('tmdb:999001','tmdb:999002')",
            )
          ).rows[0].n,
          2,
        );
      },
    );

    await t.test(
      "failed upstream validation leaves all retained rows unchanged",
      async () => {
        const before = await snapshot();
        await assert.rejects(
          run("550,777", {
            550: movie(550, "Must not persist"),
            777: { id: 777, title: "" },
          }),
          /title/,
        );
        assert.deepEqual(await snapshot(), before);
      },
    );

    await t.test(
      "a real late PostgreSQL error rolls back both updates and inserts",
      async () => {
        const before = await snapshot();
        await assert.rejects(
          repo.upsertBatchInTransaction([
            {
              tmdbId: 550,
              metadataApiId: "tmdb:550",
              title: "Must roll back",
              description: null,
              posterUrl: null,
            },
            {
              tmdbId: 888001,
              metadataApiId: "tmdb:888001",
              title: "x".repeat(256),
              description: null,
              posterUrl: null,
            },
          ]),
          { code: "22001" },
        );
        assert.deepEqual(await snapshot(), before);
      },
    );

    await t.test(
      "refresh preserves screening FK; stored film APIs work without upstream",
      async () => {
        const screen = (
          await pool.query("SELECT id FROM screens ORDER BY id LIMIT 1")
        ).rows[0];
        assert.ok(screen, "test must create its own screen fixture");
        const filmId = initial.films[0].localId;
        const screening = (
          await pool.query(
            "INSERT INTO screenings (film_id,screen_id,screening_time) VALUES ($1,$2,NOW()+INTERVAL '7 days') RETURNING id",
            [filmId, screen.id],
          )
        ).rows[0];
        await run("550", { 550: movie(550, "Fight Club linked refresh") });
        assert.equal(
          (
            await pool.query("SELECT film_id FROM screenings WHERE id=$1", [
              screening.id,
            ])
          ).rows[0].film_id,
          filmId,
        );
        const runtime = await startServer({
          config: {
            databaseUrl: url.href,
            frontendUrl: "http://localhost:5173",
            port: 0,
          },
          host: "127.0.0.1",
        });
        const originalFetch = globalThis.fetch;
        const token = process.env.TMDB_API_READ_ACCESS_TOKEN;
        delete process.env.TMDB_API_READ_ACCESS_TOKEN;
        let upstreamAttempts = 0;
        globalThis.fetch = (input, options) => {
          if (new URL(input).hostname !== "127.0.0.1") {
            upstreamAttempts++;
            throw new Error("TMDB unavailable during retained-data test");
          }
          return originalFetch(input, options);
        };
        try {
          const base = `http://127.0.0.1:${runtime.server.address().port}`;
          const list = await (await fetch(`${base}/api/films`)).json();
          const detail = await (
            await fetch(`${base}/api/films/${filmId}`)
          ).json();
          assert.equal(list.success, true);
          assert.equal(detail.success, true);
          assert.deepEqual(
            detail.data,
            list.data.find((f) => f.id === filmId),
          );
          assert.equal(detail.data.title, "Fight Club linked refresh");
          assert.equal(detail.data.metadata_api_id, "tmdb:550");
          assert.deepEqual(
            Object.keys(detail.data).sort(),
            [
              "id",
              "title",
              "description",
              "artwork_url",
              "metadata_api_id",
            ].sort(),
          );
          assert.equal(upstreamAttempts, 0);
        } finally {
          globalThis.fetch = originalFetch;
          if (token === undefined)
            delete process.env.TMDB_API_READ_ACCESS_TOKEN;
          else process.env.TMDB_API_READ_ACCESS_TOKEN = token;
          await runtime.shutdown();
        }
        assert.deepEqual(
          (await snapshot()).filter(
            (f) => !f.metadata_api_id.startsWith("tmdb:"),
          ),
          demoBefore,
        );
      },
    );

    await t.test(
      "migration preflight rejects ambiguous data without changing films",
      async () => {
        // Exercise the original append-only preflight directly inside a rolled-back transaction.
        const client = await pool.connect();
        try {
          const sql = await readFile(
            new URL(
              "../../database/migrations/0007_add_tmdb_metadata_unique_index.sql",
              import.meta.url,
            ),
            "utf8",
          );
          for (const [values, pattern] of [
            [
              [
                ["Duplicate A", "tmdb:123"],
                ["Duplicate B", "tmdb:123"],
              ],
              /duplicate TMDB/,
            ],
            [[["Malformed", "tmdb:abc"]], /malformed TMDB/],
          ]) {
            await client.query("BEGIN");
            await client.query("DROP INDEX films_tmdb_metadata_api_id_uidx");
            for (const valuesRow of values)
              await client.query(
                "INSERT INTO films (title,metadata_api_id) VALUES ($1,$2)",
                valuesRow,
              );
            await assert.rejects(client.query(sql), pattern);
            await client.query("ROLLBACK");
          }
        } finally {
          await client.query("ROLLBACK");
          client.release();
        }
      },
    );
  },
);
