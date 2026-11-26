import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, copyFile, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateDatabase } from "../scripts/database/migrate.js";
import { seedBrowsing } from "../scripts/database/seed-browsing.js";
import { seedInventory } from "../scripts/database/seed-inventory.js";
import { manageStaff } from "../scripts/database/manage-staff.js";
import {
  createClient,
  assertIsolatedDevelopment,
  assertConnectedLocalTarget,
} from "../scripts/database/connection.js";
import { startServer } from "../src/server.js";

const sourceUrl = process.env.TEST_DATABASE_URL;
const mode = "isolated-development";
const staffOrigin = "http://127.0.0.1:5174";
const key = () => randomBytes(32).toString("base64url");

test(
  "pricing migrations preserve retained duplicate IDs/references and support an already-applied 0011",
  { skip: !sourceUrl, timeout: 60000 },
  async (t) => {
    const source = assertIsolatedDevelopment(sourceUrl, mode),
      admin = createClient(sourceUrl);
    await admin.connect();
    await assertConnectedLocalTarget(admin, source);
    t.after(() => admin.end());
    const directory = await mkdtemp(join(tmpdir(), "rio-price-migrations-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const migrations = new URL("../../database/migrations/", import.meta.url);
    for (const name of await readdir(migrations))
      if (name < "0011")
        await copyFile(new URL(name, migrations), join(directory, name));
    for (const alreadyApplied of [false, true]) {
      const name = `rio_test_price_history_${process.pid}_${alreadyApplied ? "applied" : "upgrade"}`;
      const url = new URL(sourceUrl);
      url.pathname = "/" + name;
      await admin.query(`CREATE DATABASE ${name}`);
      const c = createClient(url.href);
      try {
        const target = { databaseUrl: url.href, mode };
        await migrateDatabase({
          ...target,
          directory: pathToFileURL(directory + "/"),
        });
        await seedBrowsing(target);
        await seedInventory(target);
        await c.connect();
        await c.query(
          "INSERT INTO prices(category,amount_cents) VALUES('adult',1200),('child',600),('adult',1400)",
        );
        const seat = (
          await c.query(
            "SELECT s.id,sc.id AS screening_id FROM seats s JOIN screenings sc ON sc.screen_id=s.screen_id WHERE s.display_label='2' AND NOT s.is_wheelchair ORDER BY sc.id LIMIT 1",
          )
        ).rows[0];
        const booking = (
          await c.query(
            "INSERT INTO bookings(screening_id,guest_email,status) VALUES($1,'history@example.invalid','paid') RETURNING id",
            [seat.screening_id],
          )
        ).rows[0];
        const ticket = (
          await c.query(
            "INSERT INTO tickets(booking_id,seat_id,price_id,ticket_category,amount_charged) VALUES($1,$2,3,'adult',1350) RETURNING id,price_id,amount_charged",
            [booking.id, seat.id],
          )
        ).rows[0];
        if (alreadyApplied) {
          // Simulate the old release having committed 0011, including its known loss.
          const sql = await readFile(
            new URL("0011_price_administration.sql", migrations),
            "utf8",
          );
          await c.query(sql);
          await c.query(
            "INSERT INTO rio_schema_migrations(name,checksum) VALUES('0011_price_administration.sql',$1)",
            [createHash("sha256").update(sql).digest("hex")],
          );
        }
        await migrateDatabase(target);
        const actual = (
          await c.query(
            "SELECT id,price_id,amount_charged FROM tickets WHERE id=$1",
            [ticket.id],
          )
        ).rows[0];
        assert.deepEqual(actual, {
          ...ticket,
          price_id: alreadyApplied ? 1 : 3,
        });
        const rows = (
          await c.query(
            "SELECT id,is_current FROM prices WHERE category='adult' ORDER BY id",
          )
        ).rows;
        assert.deepEqual(
          rows,
          alreadyApplied
            ? [{ id: 1, is_current: true }]
            : [
                { id: 1, is_current: true },
                { id: 3, is_current: false },
              ],
        );
        assert.equal((await migrateDatabase(target)).previouslyApplied, 12);
        await assert.rejects(
          c.query(
            "INSERT INTO prices(category,amount_cents) VALUES('adult',1700)",
          ),
          { code: "23505" },
        );
        await c.query(
          "INSERT INTO prices(category,amount_cents,is_current) VALUES('adult',1700,FALSE)",
        );
      } finally {
        await c.end();
        await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      }
    }
  },
);

test(
  "real staff price edit, concurrent conflicts, guest re-review, hold replay and authorization",
  { skip: !sourceUrl, timeout: 90000 },
  async (t) => {
    const source = assertIsolatedDevelopment(sourceUrl, mode),
      admin = createClient(sourceUrl);
    await admin.connect();
    await assertConnectedLocalTarget(admin, source);
    const name = `rio_test_price_flow_${process.pid}`,
      url = new URL(sourceUrl);
    url.pathname = "/" + name;
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
    const accounts = {};
    for (const [label, role, city] of [
      ["admin", "administrator"],
      ["cashier", "cashier", "Oulu"],
    ]) {
      const password = key(),
        email = `${label}@example.invalid`;
      await manageStaff({
        ...target,
        input: { action: "provision", role, email, ...(city ? { city } : {}) },
        readPassword: async () => password,
      });
      accounts[label] = { email, password };
    }
    runtime = await startServer({
      config: {
        databaseUrl: url.href,
        frontendUrl: "http://127.0.0.1:5173",
        port: 0,
        staff: {
          origin: staffOrigin,
          secret: key(),
          secureCookies: false,
          trustProxyHops: 0,
        },
      },
      host: "127.0.0.1",
    });
    const base = `http://127.0.0.1:${runtime.server.address().port}/api`;
    async function request(
      path,
      {
        method = "GET",
        body,
        session,
        token = true,
        origin = staffOrigin,
        headers = {},
      } = {},
    ) {
      const response = await fetch(base + path, {
        method,
        headers: {
          Origin: origin,
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(session
            ? {
                Cookie: session.cookie,
                ...(token ? { "X-CSRF-Token": session.csrf } : {}),
              }
            : {}),
          ...headers,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return {
        status: response.status,
        body: await response.json(),
        cookie: response.headers.get("set-cookie")?.split(";")[0],
      };
    }
    async function login(label) {
      const result = await request("/staff/login", {
        method: "POST",
        body: accounts[label],
        headers: { "X-RIO-Staff": "1" },
      });
      assert.equal(result.status, 200);
      return { cookie: result.cookie, csrf: result.body.data.csrfToken };
    }
    const session = await login("admin"),
      cashier = await login("cashier");
    const write = (amountCents, expectedVersion, extra = {}) =>
      request("/prices", {
        method: "PUT",
        session,
        body: { category: "adult", amountCents, expectedVersion },
        ...extra,
      });
    assert.deepEqual(
      (await request("/staff/prices", { session })).body.data,
      [],
    );
    assert.equal((await write(1201, 0)).status, 200);
    assert.equal((await write(1300, 0)).status, 409);
    assert.equal((await write(1300, undefined)).status, 400);
    for (const category of ["child", "company"])
      assert.equal(
        (
          await write(1, 1, {
            body: { category, amountCents: 1, expectedVersion: 1 },
          })
        ).status,
        400,
      );
    assert.equal((await write(1300, 1, { session: undefined })).status, 401);
    assert.equal((await write(1300, 1, { session: cashier })).status, 403);
    assert.equal(
      (await request("/staff/prices", { session: cashier })).status,
      403,
    );
    assert.equal((await write(1300, 1, { token: false })).status, 403);
    assert.equal(
      (await write(1300, 1, { headers: { "X-CSRF-Token": "x".repeat(43) } }))
        .status,
      403,
    );
    assert.equal(
      (await write(1300, 1, { origin: "http://untrusted.invalid" })).status,
      403,
    );
    const publicRows = (
      await request("/prices", { origin: "http://127.0.0.1:5173" })
    ).body.data;
    assert.equal(publicRows[1].amount_cents, 601);
    for (const row of publicRows)
      assert.deepEqual(Object.keys(row).sort(), [
        "amount_cents",
        "category",
        "id",
      ]);
    const current = (await request("/staff/prices", { session })).body.data[0];
    assert.equal(current.updated_by_email, accounts.admin.email);
    assert.ok(current.updated_by_user_id);
    assert.ok(current.updated_at);
    const races = await Promise.all([write(1401, 1), write(1501, 1)]);
    assert.deepEqual(races.map((r) => r.status).sort(), [200, 409]);
    const show = (
      await c.query(
        "INSERT INTO screenings(film_id,screen_id,screening_time) SELECT f.id,s.id,(statement_timestamp() AT TIME ZONE 'Europe/Helsinki')+interval '2 days' FROM films f CROSS JOIN screens s ORDER BY f.id,s.id LIMIT 1 RETURNING id,screen_id",
      )
    ).rows[0];
    const seats = (
      await c.query(
        "SELECT id,display_label FROM seats WHERE screen_id=$1 AND display_label IN ('2','3') ORDER BY id",
        [show.screen_id],
      )
    ).rows;
    const selection = {
      screeningId: show.id,
      seatId: [
        { seatId: seats[0].id, category: "adult" },
        { seatId: seats[1].id, category: "child" },
      ],
    };
    const quote = await request("/bookings/quote", {
      method: "POST",
      body: selection,
    });
    assert.equal(quote.status, 200);
    assert.equal((await write(1601, 2)).status, 200);
    const requestKey = key();
    const body = {
      ...selection,
      clientEmail: "guest@example.invalid",
      expectedQuote: quote.body.data.quoteFingerprint,
    };
    const create = () =>
      request("/bookings", {
        method: "POST",
        body,
        headers: { "Idempotency-Key": requestKey },
      });
    const changed = await create();
    assert.equal(changed.status, 409);
    assert.equal(changed.body.code, "QUOTE_CHANGED");
    const fresh = await request("/bookings/quote", {
      method: "POST",
      body: selection,
    });
    assert.equal(fresh.body.data.totalCents, 2402);
    body.expectedQuote = fresh.body.data.quoteFingerprint;
    const hold = await create();
    assert.equal(hold.status, 201);
    const stored = (
      await c.query(
        "SELECT id,price_id,amount_charged FROM tickets WHERE booking_id=$1 ORDER BY id",
        [hold.body.data.bookingId ?? hold.body.data.id],
      )
    ).rows;
    assert.equal(stored.length, 2);
    assert.deepEqual(
      stored.map((row) => row.amount_charged).sort((a, b) => a - b),
      [801, 1601],
    );
    assert.equal((await write(1801, 3)).status, 200);
    const replay = await create();
    assert.equal(replay.status, 201);
    assert.deepEqual(replay.body.data, hold.body.data);
    assert.deepEqual(
      (
        await c.query(
          "SELECT id,price_id,amount_charged FROM tickets WHERE id=ANY($1) ORDER BY id",
          [stored.map((row) => row.id)],
        )
      ).rows,
      stored,
    );
    await manageStaff({
      ...target,
      input: { action: "disable", email: accounts.admin.email },
    });
    assert.equal((await write(1900, 4)).status, 401);
  },
);
