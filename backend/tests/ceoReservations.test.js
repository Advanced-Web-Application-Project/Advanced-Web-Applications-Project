import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createSeatsService } from "../src/features/seats/seatsService.js";
import { startServer } from "../src/server.js";
import { migrateDatabase } from "../scripts/database/migrate.js";
import {
  assertIsolatedDevelopment,
  assertConnectedLocalTarget,
  createClient,
} from "../scripts/database/connection.js";

const databaseUrl = process.env.TEST_CEO_DATABASE_URL;
const mode = "isolated-development";
const baseline = new URL(
  "../../database/migrations/0001_initial_schema.sql",
  import.meta.url,
);

test("seat flags do not assume database ID 1 and use screening booking provenance", async () => {
  const places = [
    { id: 1, seat_label: 2, is_wheelchair: false, is_ceo_reserved: false },
    { id: 80, seat_label: 1, is_wheelchair: false, is_ceo_reserved: true },
    { id: 81, seat_label: 1, is_wheelchair: true, is_ceo_reserved: false },
  ];
  const service = createSeatsService({
    findScreeningAvailability: async () => ({
      seats: places.map((place) => ({
        ...place,
        isBooked: place.id === 80,
        isReservedByCeo: place.id === 80,
      })),
    }),
    findSeats: async () => places,
  });
  const inventory = await service.listSeats({ screenId: "4" });
  assert.deepEqual(
    inventory.map((row) => row.isReservedByCeo),
    [false, true, false],
  );
  const listing = await service.listSeats({ screenId: "4", screeningId: "9" });
  assert.deepEqual(
    listing.map((row) => [row.isBooked, row.isReservedByCeo]),
    [
      [false, false],
      [true, true],
      [false, false],
    ],
  );
});

test("cross-screen seat requests fail before inventory/occupancy is read", async () => {
  const service = createSeatsService({
    findScreeningAvailability: async () => null,
    findSeats: async () => {
      throw new Error("Should not read mismatched inventory");
    },
  });
  await assert.rejects(
    service.listSeats({ screenId: "1", screeningId: "2" }),
    /screeningId must belong/,
  );
});

test(
  "CEO reservation database and API workflow",
  { skip: !databaseUrl, timeout: 60000 },
  async (t) => {
    const dbName = assertIsolatedDevelopment(databaseUrl, mode);
    const admin = createClient(databaseUrl);
    await admin.connect();
    t.after(() => admin.end());
    await assertConnectedLocalTarget(admin, dbName);
    let serial = 0;
    async function withDatabase(run, migrate = true) {
      const name = `rio_test_ceo_${process.pid}_${++serial}`;
      const url = new URL(databaseUrl);
      url.pathname = `/${name}`;
      await admin.query(`CREATE DATABASE ${name}`);
      const client = createClient(url.href);
      try {
        await client.connect();
        if (migrate) await migrateDatabase({ databaseUrl: url.href, mode });
        await run(client, url.href);
      } finally {
        await client.end();
        await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      }
    }
    async function baseData(client) {
      const city = (
        await client.query(
          "INSERT INTO cities (name) VALUES ('Oulu') RETURNING id",
        )
      ).rows[0];
      const screens = (
        await client.query(
          "INSERT INTO screens (city_id, capacity) VALUES ($1, 100), ($1, 200) RETURNING *",
          [city.id],
        )
      ).rows;
      const film = (
        await client.query(
          "INSERT INTO films (title) VALUES ('CEO test film') RETURNING id",
        )
      ).rows[0];
      return { screens, filmId: film.id };
    }
    async function listing(client, screenId, filmId) {
      return (
        await client.query(
          "INSERT INTO screenings (screen_id, film_id, screening_time) VALUES ($1,$2,'2030-01-01 18:00:00') RETURNING id",
          [screenId, filmId],
        )
      ).rows[0].id;
    }
    async function ceoSeat(client, screenId) {
      return (
        await client.query(
          "INSERT INTO seats (screen_id, physical_row, row_label, seat_label, is_ceo_reserved) VALUES ($1,1,1,1,true) RETURNING id",
          [screenId],
        )
      ).rows[0].id;
    }
    async function fillLayout(client, screen) {
      // Independent fixture construction also exercises legacy inserts without column fields.
      for (let ordinal = 1; ordinal <= screen.capacity; ordinal += 1) {
        const row = Math.floor((ordinal - 1) / 10) + 1;
        const label = ordinal >= 13 ? ordinal + 1 : ordinal;
        await client.query(
          "INSERT INTO seats (screen_id, physical_row, row_label, seat_label, is_ceo_reserved) VALUES ($1,$2,$3,$4,$5)",
          [screen.id, row, row >= 13 ? row + 1 : row, label, ordinal === 1],
        );
      }
      for (let label = 1; label <= 10; label += 1)
        await client.query(
          "INSERT INTO seats (screen_id, physical_row, row_label, seat_label, is_wheelchair) VALUES ($1,0,0,$2,true)",
          [screen.id, label],
        );
    }

    await t.test(
      "each screening receives one zero-price, non-expiring system booking and seat-1 ticket",
      async () => {
        await withDatabase(async (client, url) => {
          const { screens, filmId } = await baseData(client);
          // A normal seat intentionally owns database ID 1.
          const ordinary = (
            await client.query(
              "INSERT INTO seats (screen_id, physical_row, row_label, seat_label) VALUES ($1,1,1,2) RETURNING id",
              [screens[0].id],
            )
          ).rows[0];
          assert.equal(ordinary.id, 1);
          const protectedIds = [];
          for (const screen of screens)
            protectedIds.push(await ceoSeat(client, screen.id));
          const listings = [
            await listing(client, screens[0].id, filmId),
            await listing(client, screens[0].id, filmId),
            await listing(client, screens[1].id, filmId),
          ];
          for (let index = 0; index < listings.length; index += 1) {
            const rows = (
              await client.query(
                "SELECT b.*,t.seat_id,t.amount_charged,t.price_id,t.is_loyalty_rewarded FROM bookings b JOIN tickets t ON t.booking_id=b.id WHERE b.screening_id=$1",
                [listings[index]],
              )
            ).rows;
            assert.equal(rows.length, 1);
            const row = rows[0];
            assert.equal(row.booking_type, "ceo");
            assert.equal(row.status, "reserved");
            assert.equal(row.user_id, null);
            assert.equal(row.guest_email, null);
            assert.equal(row.expiry_time, null);
            assert.equal(row.amount_charged, 0);
            assert.equal(row.price_id, null);
            assert.equal(row.is_loyalty_rewarded, false);
            assert.equal(row.seat_id, protectedIds[index === 2 ? 1 : 0]);
          }
          const before = (
            await client.query(
              "SELECT b.id,b.screening_id,t.id AS ticket_id,t.seat_id FROM bookings b JOIN tickets t ON t.booking_id=b.id ORDER BY b.id",
            )
          ).rows;
          await client.query("SELECT ensure_ceo_reservation($1)", [
            listings[0],
          ]);
          await migrateDatabase({ databaseUrl: url, mode });
          assert.deepEqual(
            (
              await client.query(
                "SELECT b.id,b.screening_id,t.id AS ticket_id,t.seat_id FROM bookings b JOIN tickets t ON t.booking_id=b.id ORDER BY b.id",
              )
            ).rows,
            before,
          );
        });
      },
    );

    await t.test(
      "screenings created before inventory acquire their real seat ticket when seat 1 arrives",
      async () => {
        await withDatabase(async (client) => {
          const { screens, filmId } = await baseData(client);
          const id = await listing(client, screens[0].id, filmId);
          assert.equal(
            (
              await client.query(
                "SELECT count(*)::int AS count FROM bookings WHERE booking_type='ceo'",
              )
            ).rows[0].count,
            1,
          );
          assert.equal(
            (await client.query("SELECT count(*)::int AS count FROM tickets"))
              .rows[0].count,
            0,
          );
          const seatId = await ceoSeat(client, screens[0].id);
          assert.equal(
            (
              await client.query(
                "SELECT t.seat_id FROM tickets t JOIN bookings b ON b.id=t.booking_id WHERE b.screening_id=$1",
                [id],
              )
            ).rows[0].seat_id,
            seatId,
          );
        });
      },
    );

    await t.test(
      "customer/staff tickets and all CEO reservation tampering are rejected",
      async () => {
        await withDatabase(async (client) => {
          const { screens, filmId } = await baseData(client);
          const protectedId = await ceoSeat(client, screens[0].id);
          const ordinaryId = (
            await client.query(
              "INSERT INTO seats (screen_id, physical_row, row_label, seat_label) VALUES ($1,1,1,2) RETURNING id",
              [screens[0].id],
            )
          ).rows[0].id;
          const id = await listing(client, screens[0].id, filmId);
          const reservation = (
            await client.query(
              "SELECT id FROM bookings WHERE screening_id=$1 AND booking_type='ceo'",
              [id],
            )
          ).rows[0].id;
          for (const sql of [
            "INSERT INTO bookings (screening_id,booking_type,status,guest_email) VALUES ($1,'ceo','reserved','fake@example.test')",
            "INSERT INTO bookings (screening_id,booking_type,status,expiry_time) VALUES ($1,'ceo','reserved',CURRENT_TIMESTAMP)",
            "INSERT INTO bookings (screening_id,booking_type,status) VALUES ($1,'ceo','paid')",
          ])
            await assert.rejects(client.query(sql, [id]), { code: "23514" });
          await assert.rejects(
            client.query(
              "INSERT INTO bookings (screening_id,booking_type,status) VALUES ($1,'ceo','reserved')",
              [id],
            ),
            { code: "23505" },
          );
          for (const role of ["customer", "cashier", "administrator"]) {
            const user = (
              await client.query(
                "INSERT INTO users (role,email,password_hash) VALUES ($1,$2,'test-only-not-a-login') RETURNING id",
                [role, `${role}@example.test`],
              )
            ).rows[0];
            const booking = (
              await client.query(
                "INSERT INTO bookings (user_id,screening_id,status) VALUES ($1,$2,'paid') RETURNING id",
                [user.id, id],
              )
            ).rows[0];
            await assert.rejects(
              client.query(
                "INSERT INTO tickets (booking_id,seat_id,amount_charged) VALUES ($1,$2,0)",
                [booking.id, protectedId],
              ),
              { code: "P0001" },
            );
            await client.query(
              "INSERT INTO tickets (booking_id,seat_id,amount_charged) VALUES ($1,$2,0)",
              [booking.id, ordinaryId],
            );
            await assert.rejects(
              client.query(
                "UPDATE tickets SET seat_id=$1 WHERE booking_id=$2",
                [protectedId, booking.id],
              ),
              { code: "P0001" },
            );
            // Each role reuses the ordinary place only after its prior sale expires.
            await client.query(
              "UPDATE bookings SET status='expired' WHERE id=$1",
              [booking.id],
            );
          }
          for (const sql of [
            "UPDATE bookings SET status='expired' WHERE id=$1",
            "UPDATE bookings SET expiry_time=CURRENT_TIMESTAMP WHERE id=$1",
            "UPDATE bookings SET booking_type='customer',guest_email='fake@example.test' WHERE id=$1",
            "DELETE FROM bookings WHERE id=$1",
            "DELETE FROM tickets WHERE booking_id=$1",
            "UPDATE tickets SET amount_charged=1 WHERE booking_id=$1",
          ])
            await assert.rejects(client.query(sql, [reservation]), {
              code: "P0001",
            });
          await assert.rejects(
            client.query(
              "INSERT INTO tickets (booking_id,seat_id,amount_charged) VALUES ($1,$2,0)",
              [reservation, protectedId],
            ),
            { code: "P0001" },
          );
          await assert.rejects(
            client.query("UPDATE screenings SET screen_id=$1 WHERE id=$2", [
              screens[1].id,
              id,
            ]),
            { code: "P0001" },
          );
          assert.equal(
            (
              await client.query(
                "SELECT count(*)::int AS count FROM tickets WHERE booking_id=$1",
                [reservation],
              )
            ).rows[0].count,
            1,
          );
        });
      },
    );

    await t.test(
      "flags, protected identity and positions are guarded while normal and wheelchair places delete normally",
      async () => {
        await withDatabase(async (client) => {
          const { screens } = await baseData(client);
          await assert.rejects(
            client.query(
              "INSERT INTO seats (screen_id,physical_row,row_label,seat_label) VALUES ($1,1,1,1)",
              [screens[0].id],
            ),
            { code: "23514" },
          );
          await assert.rejects(
            client.query(
              "INSERT INTO seats (screen_id,physical_row,row_label,seat_label,is_ceo_reserved) VALUES ($1,1,1,2,true)",
              [screens[0].id],
            ),
            { code: "23514" },
          );
          await assert.rejects(
            client.query(
              "INSERT INTO seats (screen_id,physical_row,row_label,seat_label,is_wheelchair,is_ceo_reserved) VALUES ($1,0,0,1,true,true)",
              [screens[0].id],
            ),
            { code: "23514" },
          );
          const id = await ceoSeat(client, screens[0].id);
          await assert.rejects(ceoSeat(client, screens[0].id), {
            code: "23505",
          });
          for (const update of [
            "screen_id=" + screens[1].id,
            "physical_row=2",
            "row_label=2",
            "seat_label=2",
            "is_wheelchair=true",
            "is_ceo_reserved=false",
            "id=9000",
          ]) {
            await assert.rejects(
              client.query(`UPDATE seats SET ${update} WHERE id=$1`, [id]),
              { code: "P0001" },
            );
          }
          await assert.rejects(
            client.query("DELETE FROM seats WHERE id=$1", [id]),
            { code: "P0001" },
          );
          const ordinary = (
            await client.query(
              "INSERT INTO seats (screen_id,physical_row,row_label,seat_label) VALUES ($1,1,1,2) RETURNING id",
              [screens[0].id],
            )
          ).rows[0].id;
          assert.equal(
            (
              await client.query("DELETE FROM seats WHERE id=$1 RETURNING id", [
                ordinary,
              ])
            ).rowCount,
            1,
          );
          const wheelchair = (
            await client.query(
              "INSERT INTO seats (screen_id,physical_row,row_label,seat_label,is_wheelchair) VALUES ($1,0,0,1,true) RETURNING id",
              [screens[0].id],
            )
          ).rows[0].id;
          assert.equal(
            (
              await client.query("DELETE FROM seats WHERE id=$1 RETURNING id", [
                wheelchair,
              ])
            ).rowCount,
            1,
          );
        });
      },
    );

    await t.test(
      "a previously booked ordinary place cannot be relabelled as the CEO place",
      async () => {
        await withDatabase(async (client) => {
          const { screens, filmId } = await baseData(client);
          const id = await listing(client, screens[0].id, filmId);
          const ordinary = (
            await client.query(
              "INSERT INTO seats (screen_id,physical_row,row_label,seat_label) VALUES ($1,1,1,2) RETURNING id",
              [screens[0].id],
            )
          ).rows[0].id;
          const booking = (
            await client.query(
              "INSERT INTO bookings (screening_id,status,guest_email) VALUES ($1,'paid','existing@example.test') RETURNING id",
              [id],
            )
          ).rows[0].id;
          await client.query(
            "INSERT INTO tickets (booking_id,seat_id,amount_charged) VALUES ($1,$2,1200)",
            [booking, ordinary],
          );
          await assert.rejects(
            client.query(
              "UPDATE seats SET seat_label=1,is_ceo_reserved=true WHERE id=$1",
              [ordinary],
            ),
            { code: "P0001" },
          );
          assert.equal(
            (
              await client.query("SELECT seat_label FROM seats WHERE id=$1", [
                ordinary,
              ])
            ).rows[0].seat_label,
            2,
          );
          assert.equal(
            (
              await client.query(
                "SELECT seat_id FROM tickets WHERE booking_id=$1",
                [booking],
              )
            ).rows[0].seat_id,
            ordinary,
          );
        });
      },
    );

    await t.test(
      "API occupancy gives 99/100 and 199/200 seated availability with separate wheelchair places",
      async () => {
        await withDatabase(async (client, url) => {
          const { screens, filmId } = await baseData(client);
          for (const screen of screens) await fillLayout(client, screen);
          const listings = [];
          for (const screen of screens)
            listings.push(await listing(client, screen.id, filmId));
          const running = await startServer({
            config: {
              databaseUrl: url,
              frontendUrl: "http://localhost:5173",
              port: 0,
            },
            host: "127.0.0.1",
          });
          try {
            const base = `http://127.0.0.1:${running.server.address().port}`;
            for (let i = 0; i < screens.length; i += 1) {
              const response = await fetch(
                `${base}/api/seats?screenId=${screens[i].id}&screeningId=${listings[i]}`,
              );
              assert.equal(response.status, 200);
              const rows = (await response.json()).data;
              const seated = rows.filter((row) => !row.is_wheelchair);
              const wheelchairs = rows.filter((row) => row.is_wheelchair);
              assert.equal(seated.length, screens[i].capacity);
              assert.equal(wheelchairs.length, 10);
              assert.equal(
                seated.filter((row) => !row.isBooked && !row.isReservedByCeo)
                  .length,
                screens[i].capacity - 1,
              );
              assert.equal(
                seated.filter((row) => row.isBooked && row.isReservedByCeo)
                  .length,
                1,
              );
              assert.ok(
                wheelchairs.every(
                  (row) => !row.isBooked && !row.isReservedByCeo,
                ),
              );
            }
            const mismatch = await fetch(
              `${base}/api/seats?screenId=${screens[0].id}&screeningId=${listings[1]}`,
            );
            assert.equal(mismatch.status, 400);
            const bookings = await fetch(
              `${base}/api/bookings?screeningId=${listings[0]}`,
            );
            assert.equal((await bookings.json()).data[0].booking_type, "ceo");
            const release = await fetch(`${base}/api/bookings/1/release`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ role: "administrator", isCeo: true }),
            });
            assert.equal(release.status, 404);
          } finally {
            await running.shutdown();
          }
        });
      },
    );

    await t.test(
      "screening deletion cleans its system allocation without releasing another screening",
      async () => {
        await withDatabase(async (client) => {
          const { screens, filmId } = await baseData(client);
          await ceoSeat(client, screens[0].id);
          const first = await listing(client, screens[0].id, filmId);
          const second = await listing(client, screens[0].id, filmId);
          await client.query("DELETE FROM screenings WHERE id=$1", [first]);
          assert.equal(
            (
              await client.query(
                "SELECT count(*)::int AS count FROM bookings WHERE screening_id=$1",
                [first],
              )
            ).rows[0].count,
            0,
          );
          assert.equal(
            (
              await client.query(
                "SELECT count(*)::int AS count FROM tickets t JOIN bookings b ON b.id=t.booking_id WHERE b.screening_id=$1",
                [second],
              )
            ).rows[0].count,
            1,
          );
        });
      },
    );

    await t.test(
      "concurrent provisioning is serialized in either creation order",
      async () => {
        await withDatabase(async (client, url) => {
          const { screens, filmId } = await baseData(client);
          for (const order of ["seat-first", "screening-first"]) {
            const index = order === "seat-first" ? 0 : 1;
            const room = screens[index];
            const other = createClient(url);
            await other.connect();
            try {
              await client.query("BEGIN");
              await client.query(
                "SELECT id FROM screens WHERE id=$1 FOR NO KEY UPDATE",
                [room.id],
              );
              await other.query("SET lock_timeout='5s'");
              const blocker = (
                await client.query("SELECT pg_backend_pid() AS id")
              ).rows[0].id;
              const waiting = (
                await other.query("SELECT pg_backend_pid() AS id")
              ).rows[0].id;
              const pending =
                order === "seat-first"
                  ? listing(other, room.id, filmId)
                  : ceoSeat(other, room.id);
              // Wait for an observed database lock, not a guessed response delay.
              const deadline = Date.now() + 3000;
              let blocked = false;
              while (Date.now() < deadline) {
                const row = (
                  await admin.query("SELECT pg_blocking_pids($1) AS ids", [
                    waiting,
                  ])
                ).rows[0];
                if (row.ids.includes(blocker)) {
                  blocked = true;
                  break;
                }
                await new Promise((resolve) => setTimeout(resolve, 10));
              }
              assert.equal(blocked, true);
              if (order === "seat-first") await ceoSeat(client, room.id);
              else await listing(client, room.id, filmId);
              await client.query("COMMIT");
              await pending;
              assert.equal(
                (
                  await client.query(
                    "SELECT count(*)::int AS count FROM tickets t JOIN bookings b ON b.id=t.booking_id JOIN screenings sc ON sc.id=b.screening_id WHERE sc.screen_id=$1 AND b.booking_type='ceo'",
                    [room.id],
                  )
                ).rows[0].count,
                1,
              );
            } finally {
              await client.query("ROLLBACK");
              await other.end();
            }
          }
        });
      },
    );

    await t.test(
      "upgrade preserves ordinary customer tickets and rejects conflicting legacy seat-1 sales",
      async () => {
        for (const conflict of [false, true])
          await withDatabase(async (client, url) => {
            const directory = await mkdtemp(
              join(tmpdir(), "rio-ceo-baseline-"),
            );
            try {
              await writeFile(
                join(directory, "0001_initial_schema.sql"),
                await readFile(baseline),
              );
              await migrateDatabase({
                databaseUrl: url,
                mode,
                directory: pathToFileURL(directory + "/"),
              });
              const { screens, filmId } = await baseData(client);
              const seat = (
                await client.query(
                  "INSERT INTO seats (screen_id,physical_row,row_label,seat_label) VALUES ($1,1,1,$2) RETURNING id",
                  [screens[0].id, conflict ? 1 : 3],
                )
              ).rows[0].id;
              const id = await listing(client, screens[0].id, filmId);
              const booking = (
                await client.query(
                  "INSERT INTO bookings (screening_id,status,guest_email) VALUES ($1,'paid','customer@example.test') RETURNING id",
                  [id],
                )
              ).rows[0].id;
              const ticket = (
                await client.query(
                  "INSERT INTO tickets (booking_id,seat_id,amount_charged) VALUES ($1,$2,1200) RETURNING id",
                  [booking, seat],
                )
              ).rows[0].id;
              if (conflict) {
                await assert.rejects(
                  migrateDatabase({ databaseUrl: url, mode }),
                  /Existing customer tickets/,
                );
              } else {
                await migrateDatabase({ databaseUrl: url, mode });
              }
              const kept = (
                await client.query(
                  "SELECT id,booking_id,seat_id,amount_charged FROM tickets WHERE id=$1",
                  [ticket],
                )
              ).rows[0];
              assert.deepEqual(kept, {
                id: ticket,
                booking_id: booking,
                seat_id: seat,
                amount_charged: 1200,
              });
              assert.equal(
                (
                  await client.query(
                    "SELECT count(*)::int AS count FROM rio_schema_migrations",
                  )
                ).rows[0].count,
                conflict ? 1 : 7,
              );
            } finally {
              await rm(directory, { recursive: true, force: true });
            }
          }, false);
      },
    );
  },
);
