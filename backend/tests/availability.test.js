import test from "node:test";
import assert from "node:assert/strict";
import { migrateDatabase } from "../scripts/database/migrate.js";
import { seedBrowsing } from "../scripts/database/seed-browsing.js";
import { seedInventory } from "../scripts/database/seed-inventory.js";
import {
  assertIsolatedDevelopment,
  assertConnectedLocalTarget,
  createClient,
} from "../scripts/database/connection.js";
import { createSeatsService } from "../src/features/seats/seatsService.js";
import { startServer } from "../src/server.js";
import {
  parseSeatQuery,
  summarizeAvailability,
} from "../src/features/seats/seatsService.js";

const config = {
  databaseUrl: "postgresql://localhost/rio_test",
  frontendUrl: "http://localhost:5173",
  port: 0,
};

test("seat query accepts database ID bounds and preserves inventory-only requests", () => {
  assert.deepEqual(parseSeatQuery({ screenId: "0001" }), { screenId: 1 });
  assert.deepEqual(
    parseSeatQuery({ screenId: "2147483647", screeningId: "2" }),
    { screenId: 2147483647, screeningId: 2 },
  );
  assert.throws(() => parseSeatQuery({}), /screenId query parameter required/);
  assert.throws(
    () => parseSeatQuery({ screenId: "1" }, { requireScreening: true }),
    /screeningId query parameter required/,
  );
});

for (const name of ["screenId", "screeningId"])
  test(`${name} seat requests reject malformed and repeated IDs before database reads`, async (t) => {
    const calls = [];
    const pool = {
      async query(sql, args) {
        calls.push({ sql, args });
        return { rows: [] };
      },
      async end() {},
    };
    const running = await startServer({ config, pool, host: "127.0.0.1" });
    t.after(running.shutdown);
    const base = `http://127.0.0.1:${running.server.address().port}/api/seats`;
    const before = calls.length;
    for (const value of [
      "",
      "0",
      "-1",
      "1.5",
      "1e2",
      "+1",
      " 1",
      "1 ",
      "abc",
      "null",
      "2147483648",
      "9007199254740993",
      "1 OR 1=1",
    ]) {
      const query = new URLSearchParams(
        name === "screenId"
          ? { screenId: value }
          : { screenId: "1", screeningId: value },
      );
      const response = await fetch(`${base}?${query}`);
      assert.equal(response.status, 400, `${name}=${value}`);
      assert.deepEqual(await response.json(), {
        success: false,
        error: `${name} must be a positive integer between 1 and 2147483647`,
      });
    }
    for (const suffix of [
      `${name}=1&${name}=2`,
      `${name}[]=1`,
      `${name}[nested]=1`,
      `${name}=1&${name}[nested]=2`,
    ]) {
      const response = await fetch(
        `${base}?${name === "screeningId" ? "screenId=1&" : ""}${suffix}`,
      );
      assert.equal(response.status, 400, suffix);
    }
    assert.equal(calls.length, before);
  });

for (const capacity of [100, 200])
  test(`availability summary separates seated and wheelchair counts for ${capacity} places`, () => {
    const seats = Array.from({ length: capacity }, (_, i) => ({
      id: i + 1,
      is_wheelchair: false,
      isBooked: i === 0,
    }));
    seats.push(
      ...Array.from({ length: 10 }, (_, i) => ({
        id: capacity + i + 1,
        is_wheelchair: true,
        isBooked: i === 0,
      })),
    );
    const snapshot = {
      screen_id: 4,
      screening_id: 9,
      as_of: "2026-11-16T12:00:00.000Z",
      capacity,
      wheelchair_capacity: 10,
      seats,
    };
    assert.deepEqual(summarizeAvailability(snapshot), {
      screen_id: 4,
      screening_id: 9,
      as_of: snapshot.as_of,
      inventory_complete: true,
      seated: { total: capacity, available: capacity - 1 },
      wheelchair: { total: 10, available: 9 },
    });
    seats[0].isBooked = false; // Counts follow allocation state, not seat ID or CEO inventory designation.
    assert.equal(summarizeAvailability(snapshot).seated.available, capacity);
    const incomplete = summarizeAvailability({
      ...snapshot,
      seats: seats.slice(1),
    });
    assert.equal(incomplete.inventory_complete, false);
    assert.deepEqual(incomplete.seated, { total: capacity, available: null });
    assert.deepEqual(incomplete.wheelchair, { total: 10, available: null });
  });

test("a screening snapshot is read once and an authorised future release is not overridden by inventory flags", async () => {
  let calls = 0;
  const seats = Array.from({ length: 110 }, (_, i) => ({
    id: i + 40,
    is_wheelchair: i >= 100,
    isBooked: false,
    isReservedByCeo: false,
    is_ceo_reserved: i === 0,
  }));
  const snapshot = {
    screen_id: 4,
    screening_id: 8,
    capacity: 100,
    wheelchair_capacity: 10,
    as_of: "2026-12-01T13:00:00Z",
    seats,
  };
  const service = createSeatsService({
    async findScreeningAvailability(screenId, screeningId) {
      calls++;
      assert.equal(screenId, 4);
      assert.equal(screeningId, 8);
      return snapshot;
    },
  });
  assert.equal(
    (await service.getAvailability({ screenId: "4", screeningId: "8" })).seated
      .available,
    100,
  );
  assert.equal(calls, 1);
  assert.deepEqual(
    await service.listSeats({ screenId: "4", screeningId: "8" }),
    seats,
  );
  assert.equal(calls, 2);
});

test("availability HTTP errors are predictable and never expose database details", async (t) => {
  let fail = false;
  const pool = {
    async query(sql) {
      if (fail && sql !== "SELECT 1")
        throw new Error("PRIVATE_DATABASE_PASSWORD");
      return { rows: [] };
    },
    async end() {},
  };
  const running = await startServer({ config, pool, host: "127.0.0.1" });
  t.after(running.shutdown);
  const base = `http://127.0.0.1:${running.server.address().port}`;
  for (const [path, status, error] of [
    ["/api/seats", 400, "screenId query parameter required"],
    [
      "/api/seats/availability?screenId=1",
      400,
      "screeningId query parameter required",
    ],
    [
      "/api/seats/availability?screeningId=1",
      400,
      "screenId query parameter required",
    ],
    [
      "/api/seats?screenId=1&screeningId=999",
      400,
      "screeningId must belong to screenId",
    ],
    [
      "/api/seats/availability?screenId=999&screeningId=1",
      400,
      "screeningId must belong to screenId",
    ],
  ]) {
    const r = await fetch(base + path);
    assert.equal(r.status, status);
    assert.equal((await r.json()).error, error);
  }
  const empty = await fetch(base + "/api/seats?screenId=999");
  assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json(), { success: true, data: [] });
  for (const name of ["screenId", "screeningId"])
    for (const value of ["0", "", "2147483648", "1.5"]) {
      const query = new URLSearchParams({
        screenId: "1",
        screeningId: "2",
        [name]: value,
      });
      assert.equal(
        (await fetch(base + "/api/seats/availability?" + query)).status,
        400,
      );
    }
  fail = true;
  for (const path of [
    "/api/seats?screenId=1&screeningId=2",
    "/api/seats/availability?screenId=1&screeningId=2",
  ]) {
    const r = await fetch(base + path);
    assert.equal(r.status, 500);
    const body = await r.text();
    assert.ok(!body.includes("PRIVATE"));
  }
});

const databaseUrl = process.env.TEST_AVAILABILITY_DATABASE_URL;
const mode = "isolated-development";
test(
  "real PostgreSQL screening availability",
  { skip: !databaseUrl, timeout: 60000 },
  async (t) => {
    const name = assertIsolatedDevelopment(databaseUrl, mode);
    const admin = createClient(databaseUrl);
    await admin.connect();
    t.after(() => admin.end());
    await assertConnectedLocalTarget(admin, name);
    let serial = 0;
    async function withDatabase(run, { inventory = true } = {}) {
      const db = `rio_test_availability_${process.pid}_${++serial}`;
      const url = new URL(databaseUrl);
      url.pathname = `/${db}`;
      await admin.query(`CREATE DATABASE ${db}`);
      const c = createClient(url.href);
      let running;
      try {
        await c.connect();
        await migrateDatabase({ databaseUrl: url.href, mode });
        const data = await seedBrowsing({ databaseUrl: url.href, mode });
        if (inventory) await seedInventory({ databaseUrl: url.href, mode });
        await c.query(
          "UPDATE screenings SET screening_time='2026-12-01 18:00:00'",
        );
        await c.query("SET TIME ZONE 'UTC'");
        let now = "2026-12-01T13:00:00.000Z";
        // A fixed database clock makes exact deadline and DST boundaries reproducible.
        // No production request can supply a clock override.
        const pool = {
          async query(sql, args = []) {
            if (sql.includes("statement_timestamp()"))
              return c.query(
                sql.replaceAll(
                  "statement_timestamp()",
                  `$${args.length + 1}::timestamptz`,
                ),
                [...args, now],
              );
            return c.query(sql, args);
          },
          async end() {},
        };
        running = await startServer({
          config: { ...config, databaseUrl: url.href },
          pool,
          host: "127.0.0.1",
        });
        const base = `http://127.0.0.1:${running.server.address().port}`;
        async function get(path) {
          const r = await fetch(base + path);
          const body = await r.json();
          return { status: r.status, ...body };
        }
        await run({ c, data, get, setNow: (value) => (now = value) });
      } finally {
        if (running) await running.shutdown();
        await c.end();
        await admin.query(`DROP DATABASE ${db} WITH (FORCE)`);
      }
    }
    async function book(c, screeningId, seatId, status, expiry) {
      const booking = (
        await c.query(
          "INSERT INTO bookings (screening_id,status,expiry_time,guest_email) VALUES ($1,$2,$3::timestamp,'private@example.test') RETURNING id",
          [screeningId, status, expiry],
        )
      ).rows[0].id;
      await c.query(
        "INSERT INTO tickets (booking_id,seat_id,amount_charged) VALUES ($1,$2,1200)",
        [booking, seatId],
      );
      return booking;
    }
    const path = (screen, show, suffix = "") =>
      `/api/seats${suffix}?screenId=${screen}&screeningId=${show}`;

    await t.test(
      "all booking states, stored deadlines, exact expiry and duplicate tickets agree for both capacities",
      async () => {
        await withDatabase(async ({ c, data, get, setNow }) => {
          for (const screen of data.cities[0].screens) {
            const show = screen.screenings[0].id;
            const places = (
              await c.query("SELECT * FROM seats WHERE screen_id=$1", [
                screen.id,
              ])
            ).rows;
            const seat = (label) =>
              places.find((s) => !s.is_wheelchair && s.seat_label === label).id;
            const wheel = (label) =>
              places.find((s) => s.is_wheelchair && s.seat_label === label).id;
            for (const [label, status, expiry] of [
              [2, "paid", "2026-12-01 10:00:00"],
              [3, "company_invoiced", "2026-12-01 10:00:00"],
              [4, "expired", "2026-12-01 17:00:00"],
              [5, "hold", "2026-12-01 15:05:00"],
              [6, "hold", "2026-12-01 14:59:00"],
              [7, "hold", null],
              [8, "reserved", "2026-12-01 16:00:00"],
              [9, "reserved", "2026-12-01 14:59:00"],
              [10, "reserved", null],
              [11, "reserved", "2026-12-01 17:00:00"],
              [12, "hold", "2026-12-01 15:00:00"],
            ])
              await book(c, show, seat(label), status, expiry);
            // Historical inactive tickets remain; new active duplicates are guarded.
            await book(c, show, seat(2), "expired", null);
            await book(c, show, wheel(1), "paid", null);
            await book(c, show, wheel(2), "expired", "2026-12-01 17:00:00");
            const before = (
              await c.query(
                "SELECT id,status,expiry_time FROM bookings ORDER BY id",
              )
            ).rows;
            setNow("2026-12-01T13:00:00.000Z");
            const rows = await get(path(screen.id, show));
            assert.equal(rows.status, 200);
            const booked = rows.data
              .filter((s) => s.isBooked && !s.is_wheelchair)
              .map((s) => s.seat_label)
              .sort((a, b) => a - b);
            assert.deepEqual(booked, [1, 2, 3, 5, 7, 8, 10, 11]);
            const counts = await get(path(screen.id, show, "/availability"));
            assert.equal(counts.status, 200);
            assert.equal(counts.data.as_of, "2026-12-01T13:00:00.000Z");
            assert.equal(counts.data.inventory_complete, true);
            assert.deepEqual(counts.data.seated, {
              total: screen.capacity,
              available: screen.capacity - 8,
            });
            assert.deepEqual(counts.data.wheelchair, {
              total: 10,
              available: 9,
            });
            assert.ok(!JSON.stringify(rows).includes("private@example.test"));
            assert.ok(!JSON.stringify(counts).includes("guest_email"));
            setNow("2026-12-01T13:05:00.000Z");
            assert.equal(
              (await get(path(screen.id, show, "/availability"))).data.seated
                .available,
              screen.capacity - 7,
            );
            setNow("2026-12-01T14:00:00.000Z");
            const atCutoff = await get(path(screen.id, show));
            assert.equal(
              atCutoff.data.find((s) => s.seat_label === 8 && !s.is_wheelchair)
                .isBooked,
              false,
            );
            // Reads trust the stored deadline: this deliberately invalid late reservation
            // stays active until 17:00. Future creation/rescheduling must reject/correct it.
            assert.equal(
              atCutoff.data.find((s) => s.seat_label === 11 && !s.is_wheelchair)
                .isBooked,
              true,
            );
            assert.deepEqual(
              (
                await c.query(
                  "SELECT id,status,expiry_time FROM bookings ORDER BY id",
                )
              ).rows,
              before,
            );
          }
        });
      },
    );

    await t.test(
      "membership, screening isolation, unknown IDs and inventory-only behavior stay compatible",
      async () => {
        await withDatabase(async ({ c, data, get }) => {
          const a = data.cities[0].screens[0],
            b = data.cities[1].screens[0];
          const seat = (
            await c.query(
              "SELECT id FROM seats WHERE screen_id=$1 AND NOT is_wheelchair AND seat_label=2",
              [a.id],
            )
          ).rows[0].id;
          await book(c, a.screenings[0].id, seat, "paid", null);
          const other = await get(path(a.id, a.screenings[1].id));
          assert.equal(other.data.find((s) => s.id === seat).isBooked, false);
          for (const suffix of ["", "/availability"]) {
            assert.equal(
              (await get(path(a.id, b.screenings[0].id, suffix))).status,
              400,
            );
            assert.equal(
              (await get(path(a.id, 2147483647, suffix))).status,
              400,
            );
            assert.equal(
              (await get(path(2147483647, a.screenings[0].id, suffix))).status,
              400,
            );
          }
          const inventory = await get(`/api/seats?screenId=${a.id}`);
          assert.ok(inventory.data.every((s) => !s.isBooked));
          assert.equal(
            inventory.data.filter((s) => s.isReservedByCeo).length,
            1,
          );
        });
      },
    );

    await t.test(
      "missing inventory returns unknown counts instead of advertising missing seats as free",
      async () => {
        await withDatabase(
          async ({ data, get }) => {
            const s = data.cities[0].screens[0];
            const r = await get(
              path(s.id, s.screenings[0].id, "/availability"),
            );
            assert.equal(r.status, 200);
            assert.equal(r.data.inventory_complete, false);
            assert.deepEqual(r.data.seated, { total: 100, available: null });
            assert.deepEqual(r.data.wheelchair, { total: 10, available: null });
          },
          { inventory: false },
        );
      },
    );

    await t.test(
      "Helsinki summer deadlines work when the database session timezone is UTC",
      async () => {
        await withDatabase(async ({ c, data, get, setNow }) => {
          const s = data.cities[0].screens[0];
          const show = s.screenings[0].id;
          const id = (
            await c.query(
              "SELECT id FROM seats WHERE screen_id=$1 AND NOT is_wheelchair AND seat_label=2",
              [s.id],
            )
          ).rows[0].id;
          await book(c, show, id, "hold", "2027-06-01 15:05:00");
          setNow("2027-06-01T12:04:59.000Z");
          assert.equal(
            (await get(path(s.id, show))).data.find((s) => s.id === id)
              .isBooked,
            true,
          );
          setNow("2027-06-01T12:05:00.000Z");
          assert.equal(
            (await get(path(s.id, show))).data.find((s) => s.id === id)
              .isBooked,
            false,
          );
        });
      },
    );
  },
);
