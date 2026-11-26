import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  parseTicketSelection,
  parseBookingRequest,
} from "../src/features/bookings/bookingsService.js";
import { seedDemoPrices } from "../scripts/database/seed-demo-prices.js";
import {
  createClient,
  assertIsolatedDevelopment,
  assertConnectedLocalTarget,
} from "../scripts/database/connection.js";
import { migrateDatabase } from "../scripts/database/migrate.js";
import { seedBrowsing } from "../scripts/database/seed-browsing.js";
import { seedInventory } from "../scripts/database/seed-inventory.js";
import { startServer } from "../src/server.js";
const databaseUrl = process.env.TEST_DATABASE_URL,
  mode = "isolated-development";
test("quotes need only ticket selection; creation still needs contact and valid optional quote identity", () => {
  assert.deepEqual(parseTicketSelection({ screeningId: 1, seatId: [2] }), {
    screeningId: 1,
    items: [{ seatId: 2, category: "adult" }],
  });
  assert.throws(() => parseBookingRequest({ screeningId: 1, seatId: [2] }), {
    code: "INVALID_CONTACT",
  });
  for (const expectedQuote of [null, 0, "x", "A".repeat(64)])
    assert.throws(
      () =>
        parseBookingRequest({
          screeningId: 1,
          seatId: [2],
          clientEmail: "fixture@example.invalid",
          expectedQuote,
        }),
      { code: "INVALID_QUOTE" },
    );
});
test("local demo prices reject shared targets", async () => {
  await assert.rejects(
    seedDemoPrices({
      databaseUrl: "postgresql://shared.invalid/rio_dev",
      mode,
    }),
    /Migration requires/,
  );
});
test(
  "real quote to guest hold workflow preserves review and never silently changes charged details",
  { skip: !databaseUrl, timeout: 60000 },
  async (t) => {
    const source = assertIsolatedDevelopment(databaseUrl, mode),
      admin = createClient(databaseUrl);
    await admin.connect();
    await assertConnectedLocalTarget(admin, source);
    const name = `rio_test_checkout_${process.pid}`,
      url = new URL(databaseUrl);
    url.pathname = `/${name}`;
    await admin.query(`CREATE DATABASE ${name}`);
    const c = createClient(url.href);
    let runtime;
    t.after(async () => {
      await runtime?.shutdown();
      await c.end();
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    });
    const target = { databaseUrl: url.href, mode };
    await migrateDatabase(target);
    await seedBrowsing(target);
    await seedInventory(target);
    await c.connect();
    await seedDemoPrices(target);
    await seedDemoPrices(target);
    assert.equal(
      (await c.query("SELECT count(*)::int AS n FROM prices")).rows[0].n,
      2,
    );
    const screens = (
      await c.query(
        "SELECT s.id,s.capacity,c.name AS city FROM screens s JOIN cities c ON c.id=s.city_id ORDER BY s.id",
      )
    ).rows;
    const films = (await c.query("SELECT id FROM films ORDER BY id")).rows;
    runtime = await startServer({
      config: {
        databaseUrl: url.href,
        frontendUrl: "http://localhost:5173",
        port: 0,
      },
      host: "127.0.0.1",
    });
    const base = `http://127.0.0.1:${runtime.server.address().port}/api`;
    async function post(path, body, key) {
      const response = await fetch(base + path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(key ? { "Idempotency-Key": key } : {}),
        },
        body: JSON.stringify(body),
      });
      return {
        status: response.status,
        cache: response.headers.get("cache-control"),
        body: await response.json(),
      };
    }
    const snapshot = async () => {
      const result = {};
      for (const table of ["bookings", "tickets", "prices"])
        result[table] = (
          await c.query(`SELECT * FROM ${table} ORDER BY id`)
        ).rows;
      return result;
    };
    async function scenario(screen = screens[0]) {
      const show = (
        await c.query(
          "INSERT INTO screenings(film_id,screen_id,screening_time) VALUES($1,$2,(statement_timestamp() AT TIME ZONE 'Europe/Helsinki')+interval '2 days') RETURNING id",
          [films[0].id, screen.id],
        )
      ).rows[0];
      const seats = (
        await c.query("SELECT id,display_label FROM seats WHERE screen_id=$1", [
          screen.id,
        ])
      ).rows;
      const id = (label) =>
        seats.find((s) => s.display_label === String(label)).id;
      return {
        screen,
        show,
        id,
        body: {
          screeningId: show.id,
          seatId: [id(2), { seatId: id("W3"), category: "child" }],
        },
      };
    }
    await t.test(
      "both cities/capacities quote without allocation and bind exact totals on creation/retry",
      async () => {
        for (const screen of screens) {
          const s = await scenario(screen),
            before = await snapshot(),
            quote = await post("/bookings/quote", s.body);
          assert.equal(quote.status, 200);
          assert.equal(quote.cache, "no-store");
          assert.equal(quote.body.data.totalCents, 1800);
          assert.equal(quote.body.data.currency, "EUR");
          assert.equal(quote.body.data.filmId, films[0].id);
          assert.equal(quote.body.data.screenId, screen.id);
          assert.ok(Number.isFinite(Date.parse(quote.body.data.asOf)));
          assert.deepEqual(await snapshot(), before);
          const key = randomBytes(32).toString("base64url"),
            body = {
              ...s.body,
              clientEmail: "fixture@example.invalid",
              expectedQuote: quote.body.data.quoteFingerprint,
            };
          const first = await post("/bookings", body, key);
          assert.equal(first.status, 201);
          assert.equal(first.body.data.totalCents, 1800);
          assert.deepEqual(
            (await post("/bookings", body, key)).body,
            first.body,
          );
        }
      },
    );
    await t.test(
      "price changes require a new explicit review and no partial hold is created",
      async () => {
        const s = await scenario(),
          quote = await post("/bookings/quote", s.body);
        await c.query(
          "UPDATE prices SET amount_cents=1600 WHERE category='adult'",
        );
        const before = await snapshot(),
          key = randomBytes(32).toString("base64url"),
          body = {
            ...s.body,
            clientEmail: "fixture@example.invalid",
            expectedQuote: quote.body.data.quoteFingerprint,
          };
        const failed = await post("/bookings", body, key);
        assert.equal(failed.status, 409);
        assert.equal(failed.body.code, "QUOTE_CHANGED");
        assert.deepEqual(await snapshot(), before);
        const refreshed = await post("/bookings/quote", s.body);
        assert.equal(refreshed.body.data.totalCents, 2400);
        const hold = await post(
          "/bookings",
          { ...body, expectedQuote: refreshed.body.data.quoteFingerprint },
          key,
        );
        assert.equal(hold.status, 201);
        assert.equal(hold.body.data.totalCents, 2400);
        await c.query(
          "UPDATE prices SET amount_cents=1200,is_current=TRUE WHERE category='adult'",
        );
      },
    );
    await t.test(
      "film and showtime changes invalidate the reviewed quote",
      async () => {
        for (const field of ["film_id", "screening_time"]) {
          const s = await scenario(),
            quote = await post("/bookings/quote", s.body);
          if (field === "film_id")
            await c.query("UPDATE screenings SET film_id=$1 WHERE id=$2", [
              films[1].id,
              s.show.id,
            ]);
          else
            await c.query(
              "UPDATE screenings SET screening_time=screening_time+interval '1 hour' WHERE id=$1",
              [s.show.id],
            );
          const before = await snapshot(),
            result = await post(
              "/bookings",
              {
                ...s.body,
                clientEmail: "fixture@example.invalid",
                expectedQuote: quote.body.data.quoteFingerprint,
              },
              randomBytes(32).toString("base64url"),
            );
          assert.equal(result.status, 409);
          assert.equal(result.body.code, "QUOTE_CHANGED");
          assert.deepEqual(await snapshot(), before);
        }
      },
    );
    await t.test(
      "unavailable/gap/foreign selections and missing price configuration fail without allocation",
      async () => {
        const s = await scenario();
        for (const seatId of [[s.id(1)], [s.id(3)], [2147483647]]) {
          const response = await post("/bookings/quote", {
            screeningId: s.show.id,
            seatId,
          });
          assert.equal(response.status, 409);
          assert.equal(response.body.code, "INVALID_SELECTION");
        }
        await c.query(
          "UPDATE prices SET is_current=FALSE WHERE category='adult'",
        );
        const before = await snapshot(),
          missing = await post("/bookings/quote", s.body);
        assert.equal(missing.status, 503);
        assert.equal(missing.body.code, "PRICE_NOT_CONFIGURED");
        assert.deepEqual(await snapshot(), before);
      },
    );
    await t.test(
      "demo price setup is repeatable and never overwrites differing existing settings",
      async () => {
        await c.query(
          "UPDATE prices SET amount_cents=1200,is_current=TRUE WHERE category='adult'",
        );
        await seedDemoPrices(target);
        await c.query(
          "UPDATE prices SET amount_cents=1400 WHERE category='adult'",
        );
        const before = await snapshot();
        await assert.rejects(seedDemoPrices(target), /Existing prices differ/);
        assert.deepEqual(await snapshot(), before);
      },
    );
  },
);
