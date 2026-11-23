import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, copyFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { generateScreenInventory } from "../../database/seeds/inventory.js";
import { validateSeatSelection } from "../src/features/seats/seatSelectionValidation.js";
import { parseBookingRequest } from "../src/features/bookings/bookingsService.js";
import { createBookingsRepository } from "../src/features/bookings/bookingsRepository.js";
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
const valid = {
  screeningId: 1,
  seatId: [2],
  clientEmail: "customer@example.test",
};
test("booking input requires real contact, unique integer IDs and supported customer categories", () => {
  assert.deepEqual(
    parseBookingRequest({
      ...valid,
      seatId: [2, { seatId: 3, category: "CHILD" }],
    }).items,
    [
      { seatId: 2, category: "adult" },
      { seatId: 3, category: "child" },
    ],
  );
  for (const body of [
    null,
    [],
    {},
    { ...valid, screeningId: "1" },
    { ...valid, screeningId: 2147483648 },
    { ...valid, seatId: [] },
    { ...valid, seatId: [2, 2] },
    { ...valid, seatId: [null] },
    { ...valid, seatId: [{ seatId: 2, category: null }] },
    { ...valid, seatId: [{ seatId: 2, category: "company" }] },
    { ...valid, clientEmail: undefined },
    { ...valid, clientEmail: "not-an-email" },
  ])
    assert.throws(() => parseBookingRequest(body));
});
test("rejected requests never acquire a connection; connection failures do not expose secrets", async (t) => {
  let connects = 0;
  const pool = {
    query: async () => ({ rows: [] }),
    end: async () => {},
    connect: async () => {
      connects++;
      throw Error("PRIVATE_PASSWORD");
    },
  };
  const running = await startServer({ config, pool, host: "127.0.0.1" });
  t.after(running.shutdown);
  const base = `http://127.0.0.1:${running.server.address().port}/api/bookings`;
  for (const body of [
    { ...valid, seatId: [2, 2] },
    { ...valid, clientEmail: null },
  ])
    assert.equal(
      (
        await fetch(base, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
      ).status,
      400,
    );
  assert.equal((await fetch(base + "/1", { method: "DELETE" })).status, 401);
  assert.equal(connects, 0);
  const failed = await fetch(base, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(valid),
  });
  assert.equal(failed.status, 500);
  assert.ok(!(await failed.text()).includes("PRIVATE"));
  assert.equal(connects, 1);
});
test("transaction failures always rollback and return the connection", async () => {
  const calls = [];
  let released = 0;
  const repository = createBookingsRepository({
    connect: async () => ({
      query: async (sql) => {
        calls.push(sql);
        return { rows: [] };
      },
      release() {
        released++;
      },
    }),
  });
  await assert.rejects(
    repository.transaction(async () => {
      throw Error("write failed");
    }),
    /write failed/,
  );
  assert.equal(calls.at(-1), "ROLLBACK");
  assert.equal(released, 1);
});

for (const capacity of [100, 200])
  test(`physical gap rules for ${capacity}: snake columns, skipped labels, prior gaps, edges and wheelchair exemptions`, () => {
    const seats = generateScreenInventory(capacity).map((seat, index) => ({
      ...seat,
      id: index + 50,
      isBooked: false,
      isReservedByCeo: false,
    }));
    const snapshot = {
      screen_id: 1,
      screening_id: 1,
      capacity,
      wheelchair_capacity: 10,
      seats,
    };
    const at = (row, col) =>
      seats.find((s) => s.physical_row === row && s.physical_column === col);
    const check = (places) =>
      validateSeatSelection(
        snapshot,
        places.map((s) => s.id),
      );
    for (const row of [1, 2, ...(capacity === 200 ? [13] : [])]) {
      at(row, 4).isBooked = true;
      const result = check([at(row, 6)]);
      assert.equal(result.valid, false);
      assert.equal(result.errors[0].code, "ISOLATED_SEAT_GAP");
      assert.deepEqual(result.errors[0].seat_ids, [at(row, 5).id]);
      assert.equal(check([at(row, 5), at(row, 6)]).valid, true);
      at(row, 6).isBooked = true;
      assert.equal(check([at(row, 7), at(row, 8)]).valid, true); // Prior gap at col5 is not this customer's responsibility.
      at(row, 4).isBooked = false;
      at(row, 6).isBooked = false;
    }
    assert.equal(check([at(1, 2)]).valid, true); // Single edge place at col1 remains permitted.
    assert.equal(check([at(0, 1), at(0, 3)]).valid, true);
    assert.equal(check([at(2, 6), at(2, 9)]).valid, true); // Two free places between.
    const incomplete = { ...snapshot, seats: seats.slice(1) };
    assert.equal(
      validateSeatSelection(incomplete, [at(1, 2).id]).errors[0].code,
      "INVENTORY_INCOMPLETE",
    );
  });

const databaseUrl = process.env.TEST_BOOKING_DATABASE_URL;
const mode = "isolated-development";
test(
  "real PostgreSQL booking safeguards",
  { skip: !databaseUrl, timeout: 90000 },
  async (t) => {
    const name = assertIsolatedDevelopment(databaseUrl, mode),
      admin = createClient(databaseUrl);
    await admin.connect();
    t.after(() => admin.end());
    await assertConnectedLocalTarget(admin, name);
    let serial = 0;
    async function database(run, { legacy = false } = {}) {
      const name = `rio_test_booking_${process.pid}_${++serial}`,
        url = new URL(databaseUrl);
      url.pathname = `/${name}`;
      await admin.query(`CREATE DATABASE ${name}`);
      const c = createClient(url.href);
      let running, pool;
      try {
        await c.connect();
        if (legacy) {
          const directory = await mkdtemp(
            join(tmpdir(), "rio-booking-migration-"),
          );
          try {
            const source = new URL(
              "../../database/migrations/",
              import.meta.url,
            );
            for (const file of await readdir(source))
              if (file.endsWith(".sql") && file < "0005")
                await copyFile(new URL(file, source), join(directory, file));
            await migrateDatabase({
              databaseUrl: url.href,
              mode,
              directory: pathToFileURL(directory + "/"),
            });
          } finally {
            await rm(directory, { recursive: true, force: true });
          }
        } else await migrateDatabase({ databaseUrl: url.href, mode });
        const data = await seedBrowsing({ databaseUrl: url.href, mode });
        await seedInventory({ databaseUrl: url.href, mode });
        await c.query(
          "UPDATE screenings SET screening_time=(statement_timestamp() AT TIME ZONE 'Europe/Helsinki')+interval '1 day'",
        );
        await c.query("DELETE FROM prices");
        await c.query(
          "INSERT INTO prices (category,amount_cents) VALUES ('adult',1200),('child',500)",
        );
        pool = new pg.Pool({
          connectionString: url.href,
          max: 8,
          connectionTimeoutMillis: 5000,
        });
        running = await startServer({
          config: { ...config, databaseUrl: url.href },
          pool,
          host: "127.0.0.1",
        });
        const base = `http://127.0.0.1:${running.server.address().port}`;
        async function request(path, { method = "GET", body, token } = {}) {
          const r = await fetch(base + path, {
            method,
            headers: {
              ...(body ? { "Content-Type": "application/json" } : {}),
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: body ? JSON.stringify(body) : undefined,
          });
          return { status: r.status, ...(await r.json()) };
        }
        async function places(screen) {
          return (
            await c.query(
              "SELECT * FROM seats WHERE screen_id=$1 ORDER BY physical_row,physical_column",
              [screen.id],
            )
          ).rows;
        }
        async function book(screen, ids, extra = {}) {
          return request("/api/bookings", {
            method: "POST",
            body: {
              ...valid,
              screeningId: screen.screenings[0].id,
              seatId: ids,
              ...extra,
            },
          });
        }
        const count = async () =>
          (
            await c.query(
              "SELECT (SELECT count(*)::int FROM bookings) AS bookings,(SELECT count(*)::int FROM tickets) AS tickets",
            )
          ).rows[0];
        const raw = async (show, id, status = "paid", expiry = null) => {
          const b = (
            await c.query(
              "INSERT INTO bookings(screening_id,status,expiry_time,guest_email) VALUES ($1,$2,$3,'history@example.test') RETURNING id",
              [show, status, expiry],
            )
          ).rows[0].id;
          await c.query(
            "INSERT INTO tickets(booking_id,seat_id,amount_charged) VALUES ($1,$2,1200)",
            [b, id],
          );
          return b;
        };
        await run({
          c,
          data,
          pool,
          request,
          places,
          book,
          count,
          raw,
          url: url.href,
        });
      } finally {
        if (running) await running.shutdown();
        else if (pool) await pool.end();
        await c.end();
        await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      }
    }
    await t.test(
      "real city → screen → movie → screening → checkout hold → conflict → release across four screens",
      async () =>
        database(async ({ c, request }) => {
          const evidence = [];
          const cities = await request("/api/cities");
          assert.equal(cities.status, 200);
          for (const city of cities.data) {
            const screens = await request(`/api/screens?cityId=${city.id}`);
            assert.equal(screens.status, 200);
            for (const screen of screens.data) {
              const screenings = await request(
                `/api/screenings?cityId=${city.id}&screenId=${screen.id}`,
              );
              assert.equal(screenings.status, 200);
              const show = screenings.data[0];
              assert.ok(show);
              const film = await request(`/api/films/${show.film_id}`);
              assert.equal(film.status, 200);
              const path = `/api/seats/availability?screenId=${screen.id}&screeningId=${show.id}`;
              const initial = await request(path);
              assert.equal(initial.data.seated.available, screen.capacity - 1);
              const seats = await request(
                `/api/seats?screenId=${screen.id}&screeningId=${show.id}`,
              );
              const selected = seats.data.filter(
                (s) => !s.is_wheelchair && [2, 3].includes(s.seat_label),
              );
              assert.equal(selected.length, 2);
              const body = {
                ...valid,
                screeningId: show.id,
                seatId: selected.map((s, i) => ({
                  seatId: s.id,
                  category: i ? "child" : "adult",
                })),
              };
              const hold = await request("/api/bookings", {
                method: "POST",
                body,
              });
              assert.equal(hold.status, 201);
              const during = await request(path);
              assert.equal(during.data.seated.available, screen.capacity - 3);
              const conflict = await request("/api/bookings", {
                method: "POST",
                body,
              });
              assert.equal(conflict.status, 409);
              const release = await request(
                `/api/bookings/${hold.data.bookingId}`,
                { method: "DELETE", token: hold.data.holdToken },
              );
              assert.equal(release.status, 200);
              const after = await request(path);
              assert.equal(after.data.seated.available, screen.capacity - 1);
              const history = (
                await c.query(
                  "SELECT b.status,count(t.id)::int AS tickets FROM bookings b JOIN tickets t ON t.booking_id=b.id WHERE b.id=$1 GROUP BY b.id",
                  [hold.data.bookingId],
                )
              ).rows[0];
              assert.deepEqual(history, { status: "expired", tickets: 2 });
              evidence.push({
                city: city.name,
                screenId: screen.id,
                capacity: screen.capacity,
                film: film.data.title,
                screeningId: show.id,
                selected: selected.map((s) => ({
                  id: s.id,
                  label: s.display_label,
                })),
                checkoutStatus: hold.status,
                bookingStatus: hold.data.status,
                paymentStatus: hold.data.paymentStatus,
                expiresAt: hold.data.expiresAt,
                totalCents: hold.data.totalCents,
                availableBefore: initial.data.seated.available,
                availableDuring: during.data.seated.available,
                conflictStatus: conflict.status,
                releaseStatus: release.status,
                availableAfter: after.data.seated.available,
                history,
              });
            }
          }
          assert.equal(evidence.length, 4);
          if (process.env.RIO_BOOKING_EVIDENCE_PATH)
            await writeFile(
              process.env.RIO_BOOKING_EVIDENCE_PATH,
              JSON.stringify(
                {
                  verifiedAt: new Date().toISOString(),
                  environment:
                    "disposable local PostgreSQL; synthetic adult=1200/legacy child=500 cents",
                  workflow: evidence,
                },
                null,
                2,
              ) + "\n",
            );
        }),
    );

    await t.test(
      "both capacities create unpaid five-minute holds, authoritative child prices, private release and retained history",
      async () =>
        database(async ({ c, data, places, book, request }) => {
          for (const screen of data.cities[0].screens) {
            const rows = await places(screen),
              seat = (n) =>
                rows.find((s) => !s.is_wheelchair && s.seat_label === n).id;
            const before = Date.now(),
              result = await book(
                screen,
                [seat(2), { seatId: seat(3), category: "child" }],
                { status: "paid", amountCharged: 1, userRole: "ceo" },
              );
            assert.equal(result.status, 201, JSON.stringify(result));
            const hold = result.data;
            assert.equal(hold.status, "hold");
            assert.equal(hold.paymentStatus, "unpaid");
            assert.equal(hold.totalCents, 1800);
            assert.deepEqual(
              hold.tickets.map((t) => t.amountCharged),
              [1200, 600],
            );
            assert.match(hold.holdToken, /^[\w-]{43}$/);
            assert.ok(new Date(hold.expiresAt).getTime() >= before + 299000);
            assert.ok(
              new Date(hold.expiresAt).getTime() <= Date.now() + 301000,
            );
            const stored = (
              await c.query(
                "SELECT status,hold_token_hash FROM bookings WHERE id=$1",
                [hold.bookingId],
              )
            ).rows[0];
            assert.equal(stored.status, "hold");
            assert.equal(
              stored.hold_token_hash,
              createHash("sha256").update(hold.holdToken).digest("hex"),
            );
            assert.deepEqual(
              (
                await c.query(
                  "SELECT ticket_category,amount_charged FROM tickets WHERE booking_id=$1 ORDER BY id",
                  [hold.bookingId],
                )
              ).rows,
              [
                { ticket_category: "adult", amount_charged: 1200 },
                { ticket_category: "child", amount_charged: 600 },
              ],
            );
            const listed = await request(
              `/api/bookings?screeningId=${screen.screenings[0].id}`,
            );
            assert.equal(listed.status, 401);
            assert.equal(listed.code, "STAFF_AUTH_REQUIRED");
            assert.ok(!JSON.stringify(listed).includes(hold.holdToken));
            assert.ok(!JSON.stringify(listed).includes("hold_token_hash"));
            assert.ok(!JSON.stringify(listed).includes(valid.clientEmail));
            const occupied = await request(
              `/api/seats?screenId=${screen.id}&screeningId=${screen.screenings[0].id}`,
            );
            assert.equal(
              occupied.data.find((s) => s.id === seat(2)).isBooked,
              true,
            );
            assert.equal(
              (
                await request(`/api/bookings/${hold.bookingId}`, {
                  method: "DELETE",
                })
              ).status,
              401,
            );
            assert.equal(
              (
                await request(`/api/bookings/${hold.bookingId}`, {
                  method: "DELETE",
                  token: "x".repeat(43),
                })
              ).status,
              404,
            );
            for (let i = 0; i < 2; i++)
              assert.equal(
                (
                  await request(`/api/bookings/${hold.bookingId}`, {
                    method: "DELETE",
                    token: hold.holdToken,
                  })
                ).status,
                200,
              );
            assert.equal(
              (
                await c.query(
                  "SELECT count(*)::int AS n FROM tickets WHERE booking_id=$1",
                  [hold.bookingId],
                )
              ).rows[0].n,
              2,
            );
            assert.equal((await book(screen, [seat(2), seat(3)])).status, 201);
          }
        }),
    );
    await t.test(
      "invalid membership, CEO, existing allocations and new gaps reject atomically; combined selection succeeds",
      async () =>
        database(async ({ c, data, places, book, count, raw }) => {
          const a = data.cities[0].screens[0],
            b = data.cities[1].screens[0],
            rows = await places(a),
            seat = (n) =>
              rows.find((s) => !s.is_wheelchair && s.seat_label === n).id;
          await raw(a.screenings[0].id, seat(5));
          await raw(a.screenings[0].id, seat(6));
          const before = await count();
          assert.equal(
            (await book(a, [seat(2)], { screeningId: 2147483647 })).status,
            404,
          );
          assert.deepEqual(await count(), before);
          for (const ids of [
            [seat(1)],
            [seat(5)],
            [seat(8)],
            [(await places(b))[1].id],
            [2147483647],
          ]) {
            const r = await book(a, ids);
            assert.equal(r.status, 409, JSON.stringify(r));
            assert.deepEqual(await count(), before);
          }
          assert.equal((await book(a, [seat(7), seat(8)])).status, 201);
          const wheel = rows.filter((s) => s.is_wheelchair);
          assert.equal((await book(a, [wheel[0].id, wheel[2].id])).status, 201);
          await c.query(
            "UPDATE screenings SET screening_time=(statement_timestamp() AT TIME ZONE 'Europe/Helsinki')-interval '1 minute' WHERE id=$1",
            [a.screenings[0].id],
          );
          assert.equal((await book(a, [seat(9)])).status, 409);
        }),
    );
    await t.test(
      "simultaneous same-place and jointly invalid gap requests serialize; different screenings remain independent",
      async () =>
        database(async ({ data, places, book, request, c }) => {
          const screen = data.cities[0].screens[0],
            rows = await places(screen),
            seat = (n) =>
              rows.find((s) => !s.is_wheelchair && s.seat_label === n).id;
          const results = await Promise.all([
            book(screen, [seat(2)]),
            book(screen, [seat(2)]),
          ]);
          assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
          const gaps = await Promise.all([
            book(screen, [
              rows.find((s) => s.physical_row === 2 && s.physical_column === 4)
                .id,
            ]),
            book(screen, [
              rows.find((s) => s.physical_row === 2 && s.physical_column === 6)
                .id,
            ]),
          ]);
          assert.deepEqual(gaps.map((r) => r.status).sort(), [201, 409]);
          assert.equal(
            (
              await request("/api/bookings", {
                method: "POST",
                body: {
                  ...valid,
                  screeningId: screen.screenings[1].id,
                  seatId: [seat(2)],
                },
              })
            ).status,
            201,
          );
          assert.equal(
            (
              await c.query(
                "SELECT count(*)::int AS n FROM tickets t JOIN bookings b ON b.id=t.booking_id WHERE b.screening_id=$1 AND t.seat_id=$2",
                [screen.screenings[0].id, seat(2)],
              )
            ).rows[0].n,
            1,
          );
        }),
    );
    await t.test(
      "expired holds are reusable, active holds block, paid and company records cannot be released",
      async () =>
        database(async ({ c, data, places, book, request }) => {
          const screen = data.cities[0].screens[0],
            rows = await places(screen),
            id = rows.find((s) => s.seat_label === 2 && !s.is_wheelchair).id;
          const a = (await book(screen, [id])).data;
          assert.equal((await book(screen, [id])).status, 409);
          await c.query(
            "UPDATE bookings SET expiry_time=(statement_timestamp() AT TIME ZONE 'Europe/Helsinki')-interval '1 second' WHERE id=$1",
            [a.bookingId],
          );
          const b = await book(screen, [id]);
          assert.equal(b.status, 201);
          await assert.rejects(
            c.query(
              "UPDATE bookings SET expiry_time=(statement_timestamp() AT TIME ZONE 'Europe/Helsinki')+interval '5 minutes' WHERE id=$1",
              [a.bookingId],
            ),
            { code: "23505" },
          );
          await c.query("UPDATE bookings SET status='paid' WHERE id=$1", [
            b.data.bookingId,
          ]);
          assert.equal(
            (
              await request(`/api/bookings/${b.data.bookingId}`, {
                method: "DELETE",
                token: b.data.holdToken,
              })
            ).status,
            409,
          );
          await c.query(
            "UPDATE bookings SET status='company_invoiced' WHERE id=$1",
            [b.data.bookingId],
          );
          assert.equal(
            (
              await request(`/api/bookings/${b.data.bookingId}`, {
                method: "DELETE",
                token: b.data.holdToken,
              })
            ).status,
            409,
          );
        }),
    );
    await t.test(
      "missing, duplicate or odd child price configuration fails without allocating; late ticket failure rolls everything back",
      async () =>
        database(async ({ c, data, places, book, count }) => {
          const screen = data.cities[0].screens[0],
            rows = await places(screen),
            id = rows.find((s) => s.seat_label === 2 && !s.is_wheelchair).id,
            before = await count();
          await c.query("DELETE FROM prices WHERE category='adult'");
          assert.equal((await book(screen, [id])).status, 503);
          await c.query(
            "INSERT INTO prices(category,amount_cents) VALUES ('adult',1201)",
          );
          assert.equal(
            (await book(screen, [{ seatId: id, category: "child" }])).status,
            503,
          );
          await c.query(
            "INSERT INTO prices(category,amount_cents) VALUES ('adult',1200)",
          );
          assert.equal((await book(screen, [id])).status, 503);
          assert.deepEqual(await count(), before);
          await c.query("DELETE FROM prices WHERE amount_cents=1201");
          await c.query(
            "CREATE FUNCTION reject_customer_ticket() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.ticket_category='child' THEN RAISE EXCEPTION 'simulated write failure'; END IF; RETURN NEW; END; $$; CREATE TRIGGER zz_reject_customer_ticket BEFORE INSERT ON tickets FOR EACH ROW EXECUTE FUNCTION reject_customer_ticket()",
          );
          assert.equal(
            (
              await book(screen, [
                id,
                {
                  seatId: rows.find(
                    (s) => s.seat_label === 3 && !s.is_wheelchair,
                  ).id,
                  category: "child",
                },
              ])
            ).status,
            500,
          );
          assert.deepEqual(await count(), before);
        }),
    );
    await t.test(
      "database guards reject direct and simultaneous duplicate active writes while keeping expired history",
      async () =>
        database(async ({ c, pool, data, places, raw }) => {
          const screen = data.cities[0].screens[0],
            rows = await places(screen),
            id = rows.find((s) => s.seat_label === 2 && !s.is_wheelchair).id,
            show = screen.screenings[0].id;
          const paid = await raw(show, id),
            old = await raw(show, id, "expired");
          await assert.rejects(
            c.query("UPDATE bookings SET status='paid' WHERE id=$1", [old]),
            { code: "23505" },
          );
          const duplicate = (
            await c.query(
              "INSERT INTO bookings(screening_id,status,guest_email) VALUES($1,'paid','guard@example.test') RETURNING id",
              [show],
            )
          ).rows[0].id;
          await assert.rejects(
            c.query(
              "INSERT INTO tickets(booking_id,seat_id,amount_charged) VALUES($1,$2,1200)",
              [duplicate, id],
            ),
            { code: "23505" },
          );
          const free = rows.find(
              (s) => s.seat_label === 3 && !s.is_wheelchair,
            ).id,
            bookings = (
              await c.query(
                "INSERT INTO bookings(screening_id,status,guest_email) VALUES($1,'paid','guard@example.test'),($1,'paid','guard@example.test') RETURNING id",
                [show],
              )
            ).rows;
          const clients = await Promise.all([pool.connect(), pool.connect()]);
          try {
            await Promise.all(clients.map((client) => client.query("BEGIN")));
            await clients[0].query(
              "INSERT INTO tickets(booking_id,seat_id,amount_charged) VALUES($1,$2,1200)",
              [bookings[0].id, free],
            );
            const waiting = clients[1].query(
              "INSERT INTO tickets(booking_id,seat_id,amount_charged) VALUES($1,$2,1200)",
              [bookings[1].id, free],
            );
            const rejected = assert.rejects(waiting, { code: "23505" });
            await clients[0].query("COMMIT");
            await rejected;
            await clients[1].query("ROLLBACK");
          } finally {
            for (const client of clients) {
              await client.query("ROLLBACK");
              client.release();
            }
          }
          const isolated = await pool.connect();
          try {
            for (const isolation of ["REPEATABLE READ", "SERIALIZABLE"]) {
              await isolated.query(`BEGIN ISOLATION LEVEL ${isolation}`);
              await assert.rejects(
                isolated.query(
                  "UPDATE bookings SET status=status WHERE id=$1",
                  [paid],
                ),
                { code: "40001" },
              );
              await isolated.query("ROLLBACK");
              await isolated.query(`BEGIN ISOLATION LEVEL ${isolation}`);
              await assert.rejects(
                isolated.query(
                  "INSERT INTO tickets(booking_id,seat_id,amount_charged) VALUES($1,$2,1200)",
                  [old, free],
                ),
                { code: "40001" },
              );
              await isolated.query("ROLLBACK");
            }
          } finally {
            await isolated.query("ROLLBACK");
            isolated.release();
          }
          const historical = rows.find(
            (s) => s.seat_label === 4 && !s.is_wheelchair,
          ).id;
          const repeated = await raw(show, historical, "expired");
          await c.query(
            "INSERT INTO tickets(booking_id,seat_id,amount_charged) VALUES($1,$2,1200)",
            [repeated, historical],
          );
          await assert.rejects(
            c.query("UPDATE bookings SET status='paid' WHERE id=$1", [
              repeated,
            ]),
            { code: "23505" },
          );
          assert.ok(paid > 0);
        }),
    );
    await t.test(
      "migration refuses pre-existing active conflicts without changing history",
      async () =>
        database(
          async ({ c, data, places, raw, url }) => {
            const screen = data.cities[0].screens[0],
              id = (await places(screen)).find(
                (s) => s.seat_label === 2 && !s.is_wheelchair,
              ).id;
            await raw(screen.screenings[0].id, id);
            await raw(screen.screenings[0].id, id);
            const snapshot = async () =>
              (
                await c.query(
                  "SELECT jsonb_agg(to_jsonb(b) ORDER BY id) AS rows FROM bookings b",
                )
              ).rows;
            const before = await snapshot();
            await assert.rejects(
              migrateDatabase({ databaseUrl: url, mode }),
              /Existing duplicate active allocations require review/,
            );
            assert.deepEqual(await snapshot(), before);
            assert.equal(
              (
                await c.query(
                  "SELECT count(*)::int AS n FROM rio_schema_migrations",
                )
              ).rows[0].n,
              4,
            );
          },
          { legacy: true },
        ),
    );
  },
);
