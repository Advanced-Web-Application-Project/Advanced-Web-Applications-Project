import test from "node:test";
import assert from "node:assert/strict";
import {
  planPresentation,
  seedPresentationScreenings,
} from "../scripts/database/seed-presentation.js";
import { PRESENTATION_MOVIES } from "../../database/seeds/presentation.js";
import { migrateDatabase } from "../scripts/database/migrate.js";
import { seedBrowsing } from "../scripts/database/seed-browsing.js";
import { seedInventory } from "../scripts/database/seed-inventory.js";
import {
  assertIsolatedDevelopment,
  assertConnectedLocalTarget,
  createClient,
} from "../scripts/database/connection.js";
import { startServer } from "../src/server.js";

const mode = "isolated-development";
const databaseUrl = process.env.TEST_DATABASE_URL;
const later = (days) =>
  new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
test("presentation plans ten films with three non-overlapping local showtimes each", () => {
  const plan = planPresentation("2026-11-21");
  assert.equal(plan.length, 30);
  assert.equal(new Set(plan.map((s) => s.providerId)).size, 10);
  assert.deepEqual(
    plan.slice(0, 3).map((s) => s.time),
    ["2026-11-21T12:00:00", "2026-11-21T16:00:00", "2026-11-21T20:00:00"],
  );
  assert.equal(plan.at(-1).time, "2026-11-30T20:00:00");
  for (const movie of PRESENTATION_MOVIES) {
    assert.equal(
      plan.filter((p) => p.providerId === `tmdb:${movie.tmdbId}`).length,
      3,
    );
    assert.ok(movie.runtimeMinutes + 30 <= 240);
  }
  for (const value of ["2026-02-30", "bad", "2026-1-01", null])
    assert.throws(() => planPresentation(value), /calendar date/);
});
test("presentation refuses unguarded targets before connecting", async () => {
  await assert.rejects(
    seedPresentationScreenings({
      databaseUrl: "postgresql://localhost/rio_dev",
    }),
    /RIO_DATABASE_MODE/,
  );
  await assert.rejects(
    seedPresentationScreenings({
      databaseUrl: "postgresql://shared.invalid/rio_dev",
      mode,
    }),
    /Migration requires/,
  );
});
test(
  "presentation setup preserves data, is atomic and rerunnable, and serves real seat APIs",
  { skip: !databaseUrl, timeout: 45000 },
  async (t) => {
    const name = assertIsolatedDevelopment(databaseUrl, mode),
      admin = createClient(databaseUrl);
    await admin.connect();
    await assertConnectedLocalTarget(admin, name);
    const database = `rio_test_presentation_${process.pid}`,
      url = new URL(databaseUrl);
    url.pathname = `/${database}`;
    await admin.query(`CREATE DATABASE ${database}`);
    const client = createClient(url.href);
    t.after(async () => {
      await client.end();
      await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
      await admin.end();
    });
    const target = { databaseUrl: url.href, mode };
    await migrateDatabase(target);
    await seedBrowsing({ ...target, includeDemoScreenings: false });
    await seedInventory(target);
    await client.connect();
    assert.equal(
      (await client.query("SELECT count(*)::int AS n FROM screenings")).rows[0]
        .n,
      0,
    );
    const snapshot = async () => {
      const out = {};
      for (const table of [
        "films",
        "seats",
        "screenings",
        "bookings",
        "tickets",
      ])
        out[table] = (
          await client.query(`SELECT * FROM ${table} ORDER BY id`)
        ).rows;
      return out;
    };
    const startDate = later(3);
    await assert.rejects(
      seedPresentationScreenings({ ...target, startDate }),
      /Import all ten/,
    );
    for (const f of PRESENTATION_MOVIES)
      await client.query(
        "INSERT INTO films(title,metadata_api_id) VALUES($1,$2)",
        [f.title, `tmdb:${f.tmdbId}`],
      );
    const screen = (
      await client.query("SELECT id FROM screens ORDER BY id DESC LIMIT 1")
    ).rows[0];
    const film = (
      await client.query("SELECT id FROM films ORDER BY id LIMIT 1")
    ).rows[0];
    const conflict = new Date(
      Date.parse(planPresentation(startDate).at(-1).time + "Z") - 3600000,
    )
      .toISOString()
      .slice(0, 19);
    await client.query(
      "INSERT INTO screenings(screen_id,film_id,screening_time) VALUES($1,$2,$3::timestamp)",
      [screen.id, film.id, conflict],
    );
    const before = await snapshot();
    await assert.rejects(
      seedPresentationScreenings({ ...target, startDate }),
      /conflicts/,
    );
    assert.deepEqual(await snapshot(), before);
    const clearDate = later(30),
      last = planPresentation(clearDate).at(-1).time;
    await client.query(
      `CREATE FUNCTION fail_last_presentation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.screen_id=${screen.id} AND NEW.screening_time='${last}'::timestamp THEN RAISE EXCEPTION 'synthetic insert failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_last_presentation BEFORE INSERT ON screenings FOR EACH ROW EXECUTE FUNCTION fail_last_presentation()`,
    );
    await assert.rejects(
      seedPresentationScreenings({ ...target, startDate: clearDate }),
      /synthetic insert failure/,
    );
    assert.deepEqual(await snapshot(), before);
    await client.query(
      "DROP TRIGGER fail_last_presentation ON screenings; DROP FUNCTION fail_last_presentation()",
    );
    const results = await Promise.all([
      seedPresentationScreenings({ ...target, startDate: clearDate }),
      seedPresentationScreenings({ ...target, startDate: clearDate }),
    ]);
    assert.deepEqual(
      results.map((r) => r.createdScreenings).sort((a, b) => a - b),
      [0, 120],
    );
    const seeded = results[0];
    assert.equal(seeded.films.length, 10);
    assert.equal(seeded.screenings.length, 120);
    for (const table of Object.keys(before)) {
      const after = (await snapshot())[table];
      for (const row of before[table])
        assert.deepEqual(
          after.find((r) => r.id === row.id),
          row,
        );
    }
    const stable = await snapshot();
    const rerun = await seedPresentationScreenings({
      ...target,
      startDate: clearDate,
    });
    assert.equal(rerun.createdScreenings, 0);
    assert.equal(rerun.retainedScreenings, 120);
    assert.deepEqual(await snapshot(), stable);
    const ids = seeded.screenings.map((s) => s.id);
    assert.equal(
      (
        await client.query(
          "SELECT count(*)::int AS n FROM bookings WHERE screening_id=ANY($1::int[]) AND booking_type='ceo'",
          [ids],
        )
      ).rows[0].n,
      120,
    );
    const runtime = await startServer({
      config: {
        databaseUrl: url.href,
        frontendUrl: "http://localhost:5173",
        port: 0,
      },
      host: "127.0.0.1",
    });
    try {
      const base = `http://127.0.0.1:${runtime.server.address().port}/api`;
      for (const capacity of [100, 200]) {
        const show = seeded.screenings.find((s) => s.capacity === capacity);
        const response = await fetch(
          `${base}/seats/availability?screenId=${show.screenId}&screeningId=${show.id}`,
        );
        assert.equal(response.status, 200);
        const { data } = await response.json();
        assert.deepEqual(data.seated, {
          total: capacity,
          available: capacity - 1,
        });
        assert.deepEqual(data.wheelchair, { total: 10, available: 10 });
      }
    } finally {
      await runtime.shutdown();
    }
  },
);
