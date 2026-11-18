import test from "node:test";
import assert from "node:assert/strict";
import { generateScreenInventory } from "../../database/seeds/inventory.js";
import {
  parseSelectionRequest,
  validateSeatSelection,
  findNewSeatGaps,
} from "../src/features/seats/seatSelectionValidation.js";
import { createSeatsService } from "../src/features/seats/seatsService.js";
import { startServer } from "../src/server.js";
import { migrateDatabase } from "../scripts/database/migrate.js";
import { seedBrowsing } from "../scripts/database/seed-browsing.js";
import { seedInventory } from "../scripts/database/seed-inventory.js";
import {
  assertIsolatedDevelopment,
  assertConnectedLocalTarget,
  createClient,
} from "../scripts/database/connection.js";

const config = {
  databaseUrl: "postgresql://localhost/rio_test",
  frontendUrl: "http://localhost:5173",
  port: 0,
};
const mode = "isolated-development";
const databaseUrl = process.env.TEST_SELECTION_DATABASE_URL;

function layout(capacity, booked = []) {
  const seats = generateScreenInventory(capacity)
    .map((seat, index) => ({
      ...seat,
      id: index + 400,
      isBooked: seat.is_ceo_reserved || booked.includes(seat.display_label),
      isReservedByCeo: seat.is_ceo_reserved,
    }))
    .reverse();
  return {
    capacity,
    wheelchair_capacity: 10,
    screen_id: 7,
    screening_id: 9,
    as_of: "2026-11-16T12:00:00Z",
    seats,
  };
}
function select(snapshot, labels) {
  return labels.map(
    (label) => snapshot.seats.find((s) => s.display_label === String(label)).id,
  );
}
function check(snapshot, labels) {
  return validateSeatSelection(snapshot, select(snapshot, labels));
}

test("selection request rejects empty, malformed, duplicate and oversized selections", () => {
  const valid = { screenId: 1, screeningId: 2, seatIds: [3] };
  assert.deepEqual(parseSelectionRequest(valid), valid);
  for (const body of [
    undefined,
    null,
    [],
    1,
    "x",
    {},
    { ...valid, extra: true },
    { ...valid, screenId: "1" },
    { ...valid, screenId: 0 },
    { ...valid, screeningId: 2147483648 },
    { ...valid, seatIds: [] },
    { ...valid, seatIds: "3" },
    { ...valid, seatIds: ["3"] },
    { ...valid, seatIds: [1.5] },
    { ...valid, seatIds: [true] },
    { ...valid, seatIds: [null] },
    { ...valid, seatIds: new Array(1) },
    { ...valid, seatIds: [0] },
    { ...valid, seatIds: [-1] },
    { ...valid, seatIds: [2147483648] },
    { ...valid, seatIds: [3, 3] },
    { ...valid, seatIds: Array.from({ length: 211 }, (_, i) => i + 1) },
  ])
    assert.throws(() => parseSelectionRequest(body));
  const original = [3, 4];
  const parsed = parseSelectionRequest({ ...valid, seatIds: original });
  original.push(5);
  assert.deepEqual(parsed.seatIds, [3, 4]);
});

for (const capacity of [100, 200]) {
  test(`${capacity}: whole selections reject new gaps, allow edges and pairs, and protect occupied/CEO places`, () => {
    const base = layout(capacity);
    assert.equal(check(base, [1]).errors[0].code, "CEO_RESERVED");
    assert.equal(check(base, [2]).valid, true);
    const gap = check(base, [3]);
    assert.equal(gap.valid, false);
    assert.equal(gap.errors[0].code, "ISOLATED_SEAT_GAP");
    assert.deepEqual(gap.errors[0].seat_ids, select(base, [2]));
    assert.equal(check(base, [2, 3]).valid, true);
    assert.equal(check(base, [9]).valid, true);
    assert.equal(check(base, [10]).valid, true);
    const occupied = layout(capacity, ["5", "6"]);
    for (const [labels, valid] of [
      [[7], true],
      [[8], false],
      [[7, 8], true],
      [[9], true],
      [[2, 3, 4, 7, 8, 9, 10], true],
    ])
      assert.equal(check(occupied, labels).valid, valid, labels.join(","));
    assert.equal(check(occupied, [5]).errors[0].code, "SEATS_UNAVAILABLE");
    const unknown = validateSeatSelection(base, [2147483647]);
    assert.equal(unknown.errors[0].code, "SEATS_NOT_IN_SCREEN");
    assert.equal(
      check(base, [2, 3, 4, 5, 6, 7, 8, 9, 10]).valid,
      true,
      "payment threshold is not a selection limit",
    );
  });
  test(`${capacity}: pre-existing gaps are not the customer's responsibility`, () => {
    const base = layout(capacity, ["3"]); // Seat 2 was already isolated by CEO seat 1 and booked seat 3.
    assert.equal(check(base, [9]).valid, true);
    assert.equal(check(base, [2, 9]).valid, true);
    const result = check(base, [5]);
    assert.equal(result.valid, false);
    assert.deepEqual(
      result.errors.flatMap((e) => e.seat_ids ?? []),
      select(base, [4]),
    );
    assert.ok(
      !result.errors
        .flatMap((e) => e.seat_ids ?? [])
        .includes(select(base, [2])[0]),
    );
  });
  test(`${capacity}: physical columns determine gaps across skipped labels and wheelchairs have no gap rule`, () => {
    const base = layout(capacity, ["W2", "W4"]);
    const result = check(base, [14, 11]);
    assert.equal(result.valid, false);
    assert.deepEqual(result.errors[0].seat_ids, select(base, [12]));
    assert.equal(check(base, [14, 12]).valid, true);
    assert.equal(check(base, ["W3"]).valid, true);
    assert.equal(check(base, ["W2"]).errors[0].code, "SEATS_UNAVAILABLE");
    assert.equal(check(base, [2, "W1", "W3"]).valid, true);
    assert.equal(check(base, [14, 12, "W3"]).valid, true);
    if (capacity === 200) {
      const row = base.seats
        .filter((s) => !s.is_wheelchair && s.physical_row === 13)
        .sort((a, b) => a.physical_column - b.physical_column);
      const answer = validateSeatSelection(base, [row[1].id, row[3].id]);
      assert.equal(answer.errors[0].row_label, 14);
      assert.deepEqual(answer.errors[0].seat_ids, [row[2].id]);
    }
  });
}

test("incomplete, duplicate or missing physical positions cannot produce a valid selection", () => {
  const base = layout(100);
  for (const seats of [
    base.seats.slice(1),
    base.seats.map((s, i) => (i === 0 ? { ...s, physical_column: 0 } : s)),
    base.seats.map((s, i) => (i === 0 ? { ...base.seats[1] } : s)),
  ]) {
    const result = validateSeatSelection({ ...base, seats }, select(base, [2]));
    assert.equal(result.errors[0].code, "INVENTORY_INCOMPLETE");
  }
});

test("gap rule agrees with a run-length oracle for all 59049 occupied/selected/free row arrangements", () => {
  function singles(occupied) {
    const result = [];
    let column = 0;
    while (column < 10) {
      if (occupied[column]) {
        column++;
        continue;
      }
      const start = column;
      while (column < 10 && !occupied[column]) column++;
      if (column - start === 1 && start > 0 && column < 10)
        result.push(start + 1);
    }
    return result;
  }
  for (let arrangement = 0; arrangement < 3 ** 10; arrangement++) {
    let value = arrangement;
    const before = [],
      after = [],
      selected = new Set();
    const row = Array.from({ length: 10 }, (_, i) => {
      const state = value % 3;
      value = Math.floor(value / 3);
      before.push(state === 1);
      after.push(state !== 0);
      if (state === 2) selected.add(i + 1);
      return {
        id: i + 1,
        is_wheelchair: false,
        physical_row: 2,
        physical_column: i + 1,
        isBooked: state === 1,
      };
    });
    const prior = new Set(singles(before));
    const expected = singles(after).filter((id) => !prior.has(id));
    assert.deepEqual(
      findNewSeatGaps(row.reverse(), selected).map((s) => s.id),
      expected,
      `arrangement ${arrangement}`,
    );
  }
});

test("service reads one availability snapshot and follows released CEO allocation state", async () => {
  const base = layout(100);
  const ceo = base.seats.find((s) => s.is_ceo_reserved);
  ceo.isBooked = false;
  ceo.isReservedByCeo = false;
  let calls = 0;
  const service = createSeatsService({
    async findScreeningAvailability(screenId, screeningId) {
      calls++;
      assert.equal(screenId, 7);
      assert.equal(screeningId, 9);
      return base;
    },
  });
  assert.equal(
    (
      await service.validateSelection({
        screenId: 7,
        screeningId: 9,
        seatIds: [ceo.id],
      })
    ).valid,
    true,
  );
  assert.equal(calls, 1);
});

test("validation HTTP distinguishes malformed requests, invalid choices and safe failures", async (t) => {
  let calls = 0,
    fail = false;
  const base = layout(100);
  const pool = {
    async query(sql) {
      calls++;
      if (sql === "SELECT 1") return { rows: [] };
      if (fail) throw new Error("PRIVATE_SQL_PASSWORD");
      return { rows: [base] };
    },
    async end() {},
  };
  const running = await startServer({ config, pool, host: "127.0.0.1" });
  t.after(running.shutdown);
  const url = `http://127.0.0.1:${running.server.address().port}/api/seats/validate`;
  async function post(body) {
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  const before = calls;
  for (const body of [
    null,
    [],
    {},
    { screenId: 7, screeningId: 9, seatIds: [] },
    { screenId: "7", screeningId: 9, seatIds: [1] },
    { screenId: 7, screeningId: 9, seatIds: [1, 1] },
  ]) {
    const r = await post(body);
    assert.equal(r.status, 400);
    assert.equal((await r.json()).success, false);
  }
  assert.equal(calls, before, "malformed requests must not query PostgreSQL");
  const malformed = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{",
  });
  assert.equal(malformed.status, 400);
  const valid = await post({
    screenId: 7,
    screeningId: 9,
    seatIds: select(base, [2, 3]),
  });
  assert.equal(valid.status, 200);
  assert.equal((await valid.json()).data.valid, true);
  const invalid = await post({
    screenId: 7,
    screeningId: 9,
    seatIds: select(base, [3]),
  });
  assert.equal(invalid.status, 200);
  const result = await invalid.json();
  assert.equal(result.success, true);
  assert.equal(result.data.valid, false);
  fail = true;
  const failed = await post({
    screenId: 7,
    screeningId: 9,
    seatIds: select(base, [2]),
  });
  assert.equal(failed.status, 500);
  assert.ok(!(await failed.text()).includes("PRIVATE"));
});

test(
  "real PostgreSQL seat selection validation",
  { skip: !databaseUrl, timeout: 60000 },
  async (t) => {
    const database = assertIsolatedDevelopment(databaseUrl, mode);
    const admin = createClient(databaseUrl);
    await admin.connect();
    t.after(() => admin.end());
    await assertConnectedLocalTarget(admin, database);
    let serial = 0;
    async function withDatabase(run, { inventory = true } = {}) {
      const name = `rio_test_selection_${process.pid}_${++serial}`;
      const url = new URL(databaseUrl);
      url.pathname = `/${name}`;
      await admin.query(`CREATE DATABASE ${name}`);
      const c = createClient(url.href);
      let running;
      try {
        await c.connect();
        await migrateDatabase({ databaseUrl: url.href, mode });
        const data = await seedBrowsing({ databaseUrl: url.href, mode });
        if (inventory) await seedInventory({ databaseUrl: url.href, mode });
        let now = "2026-12-01T13:00:00.000Z";
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
        const origin = `http://127.0.0.1:${running.server.address().port}`;
        async function post(screenId, screeningId, seatIds) {
          const r = await fetch(origin + "/api/seats/validate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ screenId, screeningId, seatIds }),
          });
          return { status: r.status, ...(await r.json()) };
        }
        async function snapshot() {
          const result = {};
          for (const table of ["seats", "screenings", "bookings", "tickets"])
            result[table] = (
              await c.query(
                `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') AS rows FROM ${table} t`,
              )
            ).rows[0].rows;
          return result;
        }
        await run({
          c,
          data,
          post,
          snapshot,
          setNow: (value) => (now = value),
        });
      } finally {
        if (running) await running.shutdown();
        await c.end();
        await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      }
    }
    async function ticket(
      c,
      screeningId,
      seatId,
      status = "paid",
      expiry = null,
    ) {
      const booking = (
        await c.query(
          "INSERT INTO bookings (screening_id,status,expiry_time,guest_email) VALUES ($1,$2,$3,'selection@example.test') RETURNING id",
          [screeningId, status, expiry],
        )
      ).rows[0].id;
      await c.query(
        "INSERT INTO tickets (booking_id,seat_id,amount_charged) VALUES ($1,$2,1200)",
        [booking, seatId],
      );
      return booking;
    }

    await t.test(
      "both cities/capacities enforce full selections, membership and physical labels without writes",
      async () => {
        await withDatabase(async ({ c, data, post, snapshot }) => {
          const screens = data.cities.flatMap((city) => city.screens);
          const foreign = (
            await c.query(
              "SELECT id FROM seats WHERE screen_id=$1 AND seat_label=2 AND NOT is_wheelchair",
              [screens[1].id],
            )
          ).rows[0].id;
          for (const screen of screens) {
            const places = (
              await c.query("SELECT * FROM seats WHERE screen_id=$1", [
                screen.id,
              ])
            ).rows;
            const ids = (labels) =>
              labels.map(
                (label) =>
                  places.find((s) => s.display_label === String(label)).id,
              );
            const show = screen.screenings[0].id;
            for (const id of ids([5, 6])) await ticket(c, show, id);
            const before = await snapshot();
            for (const [labels, valid] of [
              [[7], true],
              [[8], false],
              [[7, 8], true],
              [[9], true],
              [[14, 11], false],
              [[14, 12], true],
              [["W3"], true],
            ]) {
              const answer = await post(screen.id, show, ids(labels));
              assert.equal(answer.status, 200);
              assert.equal(
                answer.data.valid,
                valid,
                `${screen.capacity}: ${labels}`,
              );
              if (labels[0] === 8)
                assert.deepEqual(answer.data.errors[0].seat_ids, ids([7]));
            }
            assert.equal(
              (await post(screen.id, show, ids([1]))).data.errors[0].code,
              "CEO_RESERVED",
            );
            assert.equal(
              (await post(screen.id, show, ids([5]))).data.errors[0].code,
              "SEATS_UNAVAILABLE",
            );
            assert.equal(
              (await post(screen.id, show, [2147483647])).data.errors[0].code,
              "SEATS_NOT_IN_SCREEN",
            );
            if (screen.id !== screens[1].id)
              assert.equal(
                (await post(screen.id, show, [foreign])).data.errors[0].code,
                "SEATS_NOT_IN_SCREEN",
              );
            const mismatch = await post(
              screen.id,
              screens.find((s) => s.id !== screen.id).screenings[0].id,
              ids([2]),
            );
            assert.equal(mismatch.status, 400);
            assert.equal(mismatch.code, "INVALID_SCREENING");
            assert.equal(
              (await post(screen.id, 2147483647, ids([2]))).status,
              400,
            );
            const other = await post(
              screen.id,
              screen.screenings[1].id,
              ids([8]),
            );
            assert.equal(
              other.data.valid,
              true,
              "another screening's tickets must not affect adjacency",
            );
            if (screen.capacity === 200) {
              const row = places
                .filter((s) => !s.is_wheelchair && s.physical_row === 13)
                .sort((a, b) => a.physical_column - b.physical_column);
              const result = await post(screen.id, show, [
                row[1].id,
                row[3].id,
              ]);
              assert.equal(result.data.errors[0].row_label, 14);
            }
            assert.deepEqual(
              await snapshot(),
              before,
              "successful and rejected previews must not write",
            );
          }
        });
      },
    );
    await t.test(
      "active holds create boundaries until their stored expiry; old gaps and wheelchair gaps remain allowed",
      async () => {
        await withDatabase(async ({ c, data, post, snapshot, setNow }) => {
          const screen = data.cities[0].screens[0],
            show = screen.screenings[0].id;
          const places = (
            await c.query("SELECT * FROM seats WHERE screen_id=$1", [screen.id])
          ).rows;
          const ids = (labels) =>
            labels.map(
              (label) =>
                places.find((s) => s.display_label === String(label)).id,
            );
          for (const id of ids([5, 6, "W2", "W4"]))
            await ticket(c, show, id, "hold", "2026-12-01 15:05:00");
          const before = await snapshot();
          assert.equal(
            (await post(screen.id, show, ids([8]))).data.errors[0].code,
            "ISOLATED_SEAT_GAP",
          );
          assert.equal(
            (await post(screen.id, show, ids([5]))).data.errors[0].code,
            "SEATS_UNAVAILABLE",
          );
          assert.equal(
            (await post(screen.id, show, ids(["W3"]))).data.valid,
            true,
          );
          setNow("2026-12-01T13:05:00.000Z");
          assert.equal(
            (await post(screen.id, show, ids([8]))).data.valid,
            true,
          );
          assert.equal(
            (await post(screen.id, show, ids([5]))).data.valid,
            true,
          );
          assert.deepEqual(await snapshot(), before);
          await ticket(c, show, ids([3])[0]); // Existing isolated seat 2 is not this customer's responsibility.
          const existing = await snapshot();
          assert.equal(
            (await post(screen.id, show, ids([9]))).data.valid,
            true,
          );
          const gap = await post(screen.id, show, ids([5]));
          assert.equal(gap.data.valid, false);
          assert.deepEqual(gap.data.errors[0].seat_ids, ids([4]));
          assert.deepEqual(await snapshot(), existing);
        });
      },
    );
    await t.test(
      "incomplete persisted inventory never validates a selection",
      async () => {
        await withDatabase(
          async ({ data, post, snapshot }) => {
            const s = data.cities[0].screens[0];
            const before = await snapshot();
            const result = await post(s.id, s.screenings[0].id, [1]);
            assert.equal(result.status, 200);
            assert.equal(result.data.errors[0].code, "INVENTORY_INCOMPLETE");
            assert.deepEqual(await snapshot(), before);
          },
          { inventory: false },
        );
      },
    );
  },
);
