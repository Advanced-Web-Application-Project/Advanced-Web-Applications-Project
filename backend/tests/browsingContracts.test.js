import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { writeFile } from "node:fs/promises";
import { createApp } from "../src/app.js";
import { startServer } from "../src/server.js";
import { migrateDatabase } from "../scripts/database/migrate.js";
import { seedBrowsing } from "../scripts/database/seed-browsing.js";
import { seedInventory } from "../scripts/database/seed-inventory.js";
import {
  assertIsolatedDevelopment,
  assertConnectedLocalTarget,
  createClient,
} from "../scripts/database/connection.js";

const databaseUrl = process.env.TEST_BROWSING_DATABASE_URL;
const mode = "isolated-development";
const frontendUrl = "http://localhost:5173";
const invalid = [
  "0",
  "-1",
  "1.5",
  "1e2",
  "+1",
  " 1",
  "1 ",
  "abc",
  "2147483648",
  "9007199254740993",
  "1 OR 1=1",
];
const detailPaths = ["cities", "screens", "films"];

// A double specifically proves that rejected input never reaches SQL.
test("baseline malformed identifiers are rejected before database access", async (t) => {
  let queries = 0;
  const pool = {
    async query() {
      queries++;
      return { rows: [] };
    },
  };
  const server = createApp({ pool, frontendUrl }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  for (const resource of detailPaths) {
    for (const value of invalid) {
      const response = await fetch(
        `${base}/${resource}/${encodeURIComponent(value)}`,
      );
      assert.equal(response.status, 400, `${resource}/${value}`);
      assert.deepEqual(await response.json(), {
        success: false,
        error: "id must be a positive integer between 1 and 2147483647",
      });
    }
  }
  for (const query of [
    ...["", ...invalid].map((v) => `cityId=${encodeURIComponent(v)}`),
    "cityId=1&cityId=2",
    "cityId[]=1",
    "cityId[nested]=1",
    "cityId=1&cityId[]=2",
  ]) {
    const response = await fetch(`${base}/screens?${query}`);
    assert.equal(response.status, 400, query);
    assert.deepEqual(await response.json(), {
      success: false,
      error: "cityId must be a positive integer between 1 and 2147483647",
    });
  }
  assert.equal(queries, 0);
});

test(
  "baseline contracts against isolated PostgreSQL, including actual database failures",
  { skip: !databaseUrl, timeout: 60000 },
  async (t) => {
    const database = assertIsolatedDevelopment(databaseUrl, mode);
    const admin = createClient(databaseUrl);
    await admin.connect();
    await assertConnectedLocalTarget(admin, database);
    const name = `rio_test_read_contracts_${process.pid}`;
    const role = `rio_test_read_denied_${process.pid}`;
    const url = new URL(databaseUrl);
    url.pathname = `/${name}`;
    let client,
      runtime,
      deniedRuntime,
      deniedPool,
      created = false,
      roleCreated = false;
    t.after(async () => {
      await deniedRuntime?.shutdown();
      if (!deniedRuntime) await deniedPool?.end();
      await runtime?.shutdown();
      await client?.end();
      if (created) await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      if (roleCreated) await admin.query(`DROP ROLE ${role}`);
      await admin.end();
    });
    await admin.query(`CREATE DATABASE ${name}`);
    created = true;
    const target = { databaseUrl: url.href, mode };
    await migrateDatabase(target);
    client = createClient(url.href);
    await client.connect();
    runtime = await startServer({
      config: { databaseUrl: url.href, frontendUrl, port: 0 },
      host: "127.0.0.1",
    });
    const base = `http://127.0.0.1:${runtime.server.address().port}/api`;
    const evidence = { database: "disposable PostgreSQL", checks: [] };
    async function get(path, status = 200, origin = base) {
      const response = await fetch(origin + path);
      assert.equal(response.status, status, path);
      const body = await response.json();
      assert.equal(body.success, status === 200, path);
      evidence.checks.push({ path, status });
      return body;
    }
    await t.test(
      "empty lists and missing entities preserve their different envelopes",
      async () => {
        assert.deepEqual(await get("/cities", 404), {
          success: false,
          error: "No cities found",
        });
        for (const path of [
          "/films",
          "/screens",
          "/screenings",
          "/screens?cityId=1",
          "/screenings?cityId=1",
        ])
          assert.deepEqual(await get(path), { success: true, data: [] });
        for (const [resource, label] of [
          ["cities", "City"],
          ["screens", "Screen"],
          ["films", "Film"],
        ])
          assert.deepEqual(await get(`/${resource}/2147483647`, 404), {
            success: false,
            error: `${label} not found`,
          });
      },
    );
    await seedBrowsing(target);
    await seedInventory(target);
    const fingerprint = async () => {
      const rows = {};
      for (const table of [
        "cities",
        "screens",
        "films",
        "screenings",
        "seats",
        "bookings",
        "tickets",
        "users",
        "prices",
      ])
        rows[table] = (
          await client.query(
            `SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY id)::text, '[]')) AS hash FROM ${table} t`,
          )
        ).rows[0].hash;
      return rows;
    };
    const before = await fingerprint();
    await t.test(
      "public fields, identities and all city/screen/film filters match real records",
      async () => {
        const cities = (await get("/cities")).data;
        assert.deepEqual(
          cities,
          (await client.query("SELECT id,name FROM cities ORDER BY id")).rows,
        );
        const films = (await get("/films")).data;
        assert.deepEqual(
          films,
          (
            await client.query(
              "SELECT id,title,metadata_api_id,description,artwork_url FROM films ORDER BY id",
            )
          ).rows,
        );
        for (const city of cities) {
          assert.deepEqual((await get(`/cities/00${city.id}`)).data, city);
          const screens = (await get(`/screens?cityId=00${city.id}`)).data;
          assert.equal(screens.length, 2);
          for (const screen of screens) {
            assert.deepEqual(
              Object.keys(screen).sort(),
              [
                "id",
                "capacity",
                "wheelchair_capacity",
                "city_id",
                "city_name",
              ].sort(),
            );
            assert.equal(screen.city_id, city.id);
            assert.equal(screen.city_name, city.name);
            assert.deepEqual(
              (await get(`/screens/00${screen.id}`)).data,
              screen,
            );
            const screenings = (
              await get(`/screenings?cityId=${city.id}&screenId=${screen.id}`)
            ).data;
            assert.equal(screenings.length, 2);
            for (const show of screenings) {
              assert.deepEqual(
                Object.keys(show).sort(),
                [
                  "id",
                  "screening_time",
                  "film_id",
                  "film_title",
                  "screen_id",
                  "city_id",
                  "city_name",
                ].sort(),
              );
              assert.equal(show.city_id, city.id);
              assert.equal(show.screen_id, screen.id);
              assert.equal(
                show.film_title,
                films.find((film) => film.id === show.film_id).title,
              );
              assert.ok(Date.parse(show.screening_time) > Date.now());
              for (const query of [
                `filmId=${show.film_id}`,
                `cityId=${city.id}&filmId=${show.film_id}`,
                `screenId=${screen.id}&filmId=${show.film_id}`,
              ])
                assert.ok(
                  (await get(`/screenings?${query}`)).data.some(
                    (row) => row.id === show.id,
                  ),
                );
              const counts = (
                await get(
                  `/seats/availability?screenId=${screen.id}&screeningId=${show.id}`,
                )
              ).data;
              assert.equal(counts.seated.total, screen.capacity);
              assert.equal(counts.seated.available, screen.capacity - 1);
              assert.deepEqual(counts.wheelchair, { total: 10, available: 10 });
            }
          }
        }
        for (const film of films) {
          assert.deepEqual((await get(`/films/00${film.id}`)).data, film);
          assert.deepEqual(
            Object.keys(film).sort(),
            [
              "id",
              "title",
              "metadata_api_id",
              "description",
              "artwork_url",
            ].sort(),
          );
        }
        for (const resource of detailPaths)
          await get(`/${resource}/2147483647`, 404);
        assert.deepEqual((await get("/screens?cityId=2147483647")).data, []);
        assert.deepEqual((await get("/screenings?filmId=2147483647")).data, []);
        assert.deepEqual(
          (
            await get(
              `/screenings?cityId=${cities[0].id}&screenId=${(await get(`/screens?cityId=${cities[1].id}`)).data[0].id}`,
            )
          ).data,
          [],
        );
        assert.deepEqual(
          await get("/films?unrecognized=ignored"),
          await get("/films"),
        );
        assert.deepEqual(
          await get("/cities?unrecognized=ignored"),
          await get("/cities"),
        );
        assert.deepEqual(
          await get("/screens?unrecognized=ignored"),
          await get("/screens"),
        );
        for (const path of [
          "/cities/1e2",
          "/screens/-1",
          "/films/2147483648",
          "/screens?cityId[]=1",
          "/screenings?filmId=1&filmId=2",
        ])
          await get(path, 400);
      },
    );
    assert.deepEqual(
      await fingerprint(),
      before,
      "all GET checks preserve data",
    );
    await t.test(
      "real PostgreSQL permission errors produce safe route-specific 500 responses",
      async () => {
        await admin.query(`CREATE ROLE ${role} NOLOGIN`);
        roleCreated = true;
        deniedPool = new pg.Pool({
          connectionString: url.href,
          options: `-c role=${role}`,
        });
        await assert.rejects(deniedPool.query("SELECT * FROM cities"), {
          code: "42501",
        });
        deniedRuntime = await startServer({
          config: { databaseUrl: url.href, frontendUrl, port: 0 },
          pool: deniedPool,
          host: "127.0.0.1",
        });
        const deniedBase = `http://127.0.0.1:${deniedRuntime.server.address().port}/api`;
        for (const [path, error] of [
          ["/cities", "There was an inside error while fetching cities"],
          ["/cities/1", "There was an inside error while fetching cities"],
          ["/screens", "There was an internal error while fetching screens"],
          ["/screens/1", "There was an inside error while fetching screen"],
          ["/films", "There was a inside error while fetching films"],
          ["/films/1", " There was an inside error while fetching film"],
          [
            "/screenings",
            "There was an inside error while fetching screenings",
          ],
        ]) {
          const body = await get(path, 500, deniedBase);
          assert.deepEqual(body, { success: false, error });
          assert.doesNotMatch(
            JSON.stringify(body),
            /42501|permission denied|SELECT|password|postgresql:|rio_test_read_denied/i,
          );
        }
      },
    );
    assert.deepEqual(
      await fingerprint(),
      before,
      "failed GET checks preserve data",
    );
    if (process.env.RIO_BROWSING_CONTRACT_EVIDENCE_PATH)
      await writeFile(
        process.env.RIO_BROWSING_CONTRACT_EVIDENCE_PATH,
        JSON.stringify(evidence, null, 2) + "\n",
      );
  },
);
