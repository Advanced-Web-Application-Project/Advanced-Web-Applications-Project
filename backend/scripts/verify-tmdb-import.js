import "dotenv/config";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { loadTmdbImportConfig } from "../src/config/tmdbImportConfig.js";
import {
  assertConnectedLocalTarget,
  createClient,
} from "./database/connection.js";
import { migrateDatabase } from "./database/migrate.js";
import { seedBrowsing } from "./database/seed-browsing.js";
import { startServer } from "../src/server.js";

// Run the actual CLI, then verify retained rows through the actual Express API.
// Only a uniquely named disposable local database is modified.
const execute = promisify(execFile);
const backendDirectory = fileURLToPath(new URL("../", import.meta.url));
const mode = "isolated-development";
let admin, client, runtime, database, evidence;
let databaseCreated = false;
try {
  const config = loadTmdbImportConfig(process.env);
  admin = createClient(config.databaseUrl);
  await admin.connect();
  await assertConnectedLocalTarget(admin, config.dbName);
  database = `rio_test_tmdb_live_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(config.databaseUrl);
  url.pathname = `/${database}`;
  await admin.query(`CREATE DATABASE ${database}`);
  databaseCreated = true;
  await migrateDatabase({ databaseUrl: url.href, mode });
  await seedBrowsing({ databaseUrl: url.href, mode });
  client = createClient(url.href);
  await client.connect();
  const snapshot = async () =>
    (await client.query("SELECT * FROM films ORDER BY id")).rows;
  const before = await snapshot();
  const cli = async () => {
    // Do not relay child stdout/stderr: tokens and connection details never enter evidence.
    try {
      await execute(
        process.execPath,
        ["src/features/films/importTmdbCli.js", "--ids", "550,603"],
        {
          cwd: backendDirectory,
          timeout: 120000,
          env: {
            ...process.env,
            DATABASE_URL: url.href,
            RIO_DATABASE_MODE: mode,
          },
        },
      );
    } catch {
      throw new Error(
        "Live TMDB CLI failed. Check token, connectivity and migrations; child output is omitted.",
      );
    }
  };
  await cli();
  const first = await snapshot();
  const imported = first.filter((f) => f.metadata_api_id?.startsWith("tmdb:"));
  assert.equal(imported.length, 2);
  assert.equal(first.length, before.length + 2);
  for (const film of imported) {
    assert.ok(film.title.trim());
    assert.ok(film.description?.trim());
    assert.ok(
      film.artwork_url === null || film.artwork_url.startsWith("https://"),
    );
  }
  const screen = (
    await client.query("SELECT id FROM screens ORDER BY id LIMIT 1")
  ).rows[0];
  const screening = (
    await client.query(
      "INSERT INTO screenings (film_id, screen_id, screening_time) VALUES ($1,$2,NOW()+INTERVAL '7 days') RETURNING id",
      [imported[0].id, screen.id],
    )
  ).rows[0];
  await cli();
  const after = await snapshot();
  assert.deepEqual(
    after.map((f) => [f.id, f.metadata_api_id]),
    first.map((f) => [f.id, f.metadata_api_id]),
  );
  assert.deepEqual(
    after.filter((f) => !f.metadata_api_id?.startsWith("tmdb:")),
    before,
  );
  assert.equal(
    (
      await client.query("SELECT film_id FROM screenings WHERE id=$1", [
        screening.id,
      ])
    ).rows[0].film_id,
    imported[0].id,
  );

  // The API process has no token. Block upstream fetches during the retained-data check.
  const savedToken = process.env.TMDB_API_READ_ACCESS_TOKEN;
  const originalFetch = globalThis.fetch;
  delete process.env.TMDB_API_READ_ACCESS_TOKEN;
  let upstreamAttempts = 0;
  globalThis.fetch = (input, init) => {
    const target = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    if (target.hostname !== "127.0.0.1") {
      upstreamAttempts++;
      throw new Error("Upstream disabled for retained-data verification");
    }
    return originalFetch(input, init);
  };
  try {
    runtime = await startServer({
      config: {
        databaseUrl: url.href,
        frontendUrl: "http://localhost:5173",
        port: 0,
      },
      host: "127.0.0.1",
    });
    const base = `http://127.0.0.1:${runtime.server.address().port}`;
    const listResponse = await fetch(`${base}/api/films`);
    assert.equal(listResponse.status, 200);
    const list = await listResponse.json();
    assert.equal(list.success, true);
    for (const film of imported) {
      const response = await fetch(`${base}/api/films/${film.id}`);
      assert.equal(response.status, 200);
      const detail = await response.json();
      assert.deepEqual(detail, {
        success: true,
        data: list.data.find((f) => f.id === film.id),
      });
      assert.deepEqual(
        detail.data,
        after.find((f) => f.id === film.id),
      );
    }
    assert.equal(upstreamAttempts, 0);
  } finally {
    globalThis.fetch = originalFetch;
    process.env.TMDB_API_READ_ACCESS_TOKEN = savedToken;
  }
  evidence = {
    verifiedAt: new Date().toISOString(),
    scope:
      "Live TMDB to disposable local PostgreSQL, actual CLI twice, then actual Express API with upstream disabled; database removed after verification.",
    commands: [
      "npm run verify:tmdb",
      "node src/features/films/importTmdbCli.js --ids 550,603 (twice in disposable database)",
    ],
    rowCounts: {
      before: before.length,
      afterFirst: first.length,
      afterRerun: after.length,
    },
    films: imported.map((f) => ({
      localId: f.id,
      providerId: f.metadata_api_id,
      title: f.title,
      descriptionPresent: Boolean(f.description),
      artworkUrl: f.artwork_url,
    })),
    rerunPreservedLocalIds: true,
    demoRowsUnchanged: true,
    screening: {
      id: screening.id,
      filmId: imported[0].id,
      linkPreserved: true,
    },
    offlineApi: {
      listStatus: 200,
      detailStatuses: [200, 200],
      tokenUnset: true,
      upstreamFetchBlocked: true,
      upstreamAttempts,
    },
  };
} catch (error) {
  // Only our controlled messages may leave this verifier; pg/exec errors can contain secrets.
  console.error(
    error?.message ===
      "TMDB_API_READ_ACCESS_TOKEN is required in the server/local environment."
      ? error.message
      : "TMDB workflow verification failed. Check credentials, connectivity, schema and assertions; sensitive details are omitted.",
  );
  process.exitCode = 1;
} finally {
  try {
    await runtime?.shutdown();
    await client?.end();
    if (databaseCreated)
      await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  } catch {
    console.error(
      "Disposable database cleanup failed; inspect local rio_test_tmdb_live databases.",
    );
    process.exitCode = 1;
  } finally {
    await admin?.end();
  }
}

if (evidence && process.exitCode !== 1) {
  try {
    await writeFile(
      new URL(
        "../../database/verification/tmdb-import-live.json",
        import.meta.url,
      ),
      JSON.stringify(evidence, null, 2) + "\n",
    );
    console.log(
      "Verified live import, rerun, screening link, unchanged demo rows and offline film APIs. Evidence: database/verification/tmdb-import-live.json",
    );
  } catch {
    console.error(
      "Live checks passed but verification evidence could not be written.",
    );
    process.exitCode = 1;
  }
}
