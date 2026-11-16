import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { generateScreenInventory } from "../../database/seeds/inventory.js";
import { seedInventory } from "../scripts/database/seed-inventory.js";
import { verifyInventory } from "../scripts/database/verify-inventory.js";
import { seedBrowsing } from "../scripts/database/seed-browsing.js";
import { migrateDatabase } from "../scripts/database/migrate.js";
import {
  assertIsolatedDevelopment,
  assertConnectedLocalTarget,
  createClient,
} from "../scripts/database/connection.js";
import { startServer } from "../src/server.js";

const mode = "isolated-development";
const databaseUrl = process.env.TEST_INVENTORY_DATABASE_URL;

for (const capacity of [100, 200])
  test(`${capacity}-seat inventory has physical snake positions, skipped labels and separate W1–W10`, () => {
    const places = generateScreenInventory(capacity);
    const seated = places.filter((p) => !p.is_wheelchair);
    assert.equal(seated.length, capacity);
    assert.equal(places.length, capacity + 10);
    assert.deepEqual(
      seated.filter((p) => p.physical_row === 1).map((p) => p.seat_label),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    );
    assert.deepEqual(
      seated.filter((p) => p.physical_row === 2).map((p) => p.seat_label),
      [21, 20, 19, 18, 17, 16, 15, 14, 12, 11],
    );
    assert.deepEqual(
      seated.filter((p) => p.physical_row === 3).map((p) => p.seat_label),
      [22, 23, 24, 25, 26, 27, 28, 29, 30, 31],
    );
    assert.equal(Math.max(...seated.map((p) => p.seat_label)), capacity + 1);
    assert.ok(seated.every((p) => p.seat_label !== 13 && p.row_label !== 13));
    assert.equal(
      new Set(seated.map((p) => `${p.physical_row}:${p.physical_column}`)).size,
      capacity,
    );
    assert.equal(seated.filter((p) => p.is_ceo_reserved).length, 1);
    for (let row = 1; row <= capacity / 10; row++)
      assert.equal(seated.filter((p) => p.physical_row === row).length, 10);
    if (capacity === 200) {
      assert.equal(seated.find((p) => p.physical_row === 13).row_label, 14);
      assert.equal(seated.find((p) => p.physical_row === 20).row_label, 21);
    }
    assert.deepEqual(
      places
        .filter((p) => p.is_wheelchair)
        .map((p) => [
          p.display_label,
          p.physical_row,
          p.physical_column,
          p.is_ceo_reserved,
        ]),
      Array.from({ length: 10 }, (_, i) => [`W${i + 1}`, 0, i + 1, false]),
    );
  });

test("inventory generator and command reject unsupported capacities and shared targets", async () => {
  for (const value of [0, 99, 101, "100", null, 300])
    assert.throws(() => generateScreenInventory(value), /100 or 200/);
  await assert.rejects(
    seedInventory({ databaseUrl: "postgresql://localhost/rio_dev" }),
    /RIO_DATABASE_MODE/,
  );
  await assert.rejects(
    seedInventory({ databaseUrl: "postgresql://shared.example/rio_dev", mode }),
    /Migration requires/,
  );
});

test(
  "real PostgreSQL inventory workflow",
  { skip: !databaseUrl, timeout: 90000 },
  async (t) => {
    const database = assertIsolatedDevelopment(databaseUrl, mode);
    const admin = createClient(databaseUrl);
    await admin.connect();
    t.after(() => admin.end());
    await assertConnectedLocalTarget(admin, database);
    let serial = 0;
    async function withDatabase(run, legacy = false) {
      const name = `rio_test_inventory_${process.pid}_${++serial}`;
      const url = new URL(databaseUrl);
      url.pathname = `/${name}`;
      await admin.query(`CREATE DATABASE ${name}`);
      const client = createClient(url.href);
      const directory = await mkdtemp(
        join(tmpdir(), "rio-inventory-migrations-"),
      );
      try {
        await client.connect();
        if (legacy) {
          for (const file of [
            "0001_initial_schema.sql",
            "0002_ceo_reservations.sql",
            "0003_guard_ceo_seat_conversion.sql",
          ])
            await copyFile(
              new URL(`../../database/migrations/${file}`, import.meta.url),
              join(directory, file),
            );
          await migrateDatabase({
            databaseUrl: url.href,
            mode,
            directory: pathToFileURL(directory + "/"),
          });
        } else await migrateDatabase({ databaseUrl: url.href, mode });
        await run(url.href, client);
      } finally {
        await client.end();
        await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
        await rm(directory, { recursive: true, force: true });
      }
    }
    const seed = (url) => seedInventory({ databaseUrl: url, mode });
    async function snapshot(client) {
      const result = {};
      for (const table of [
        "cities",
        "screens",
        "films",
        "screenings",
        "seats",
        "bookings",
        "tickets",
      ])
        result[table] = (
          await client.query(
            `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') AS rows FROM public.${table} t`,
          )
        ).rows[0].rows;
      return result;
    }

    await t.test(
      "partial inventory and booked IDs survive fill/rerun; real city → screen → movie → screening → seats",
      async () => {
        await withDatabase(async (url, client) => {
          await client.query(
            "INSERT INTO cities (name) VALUES ('Unrelated city')",
          );
          const browsing = await seedBrowsing({ databaseUrl: url, mode });
          const screen = browsing.cities[0].screens[0];
          await client.query("SELECT setval('seats_id_seq',40)");
          const ordinary = (
            await client.query(
              "INSERT INTO seats (screen_id,physical_row,row_label,seat_label) VALUES ($1,1,1,2) RETURNING id",
              [screen.id],
            )
          ).rows[0].id;
          const booking = (
            await client.query(
              "INSERT INTO bookings (screening_id,status,guest_email) VALUES ($1,'paid','inventory@example.test') RETURNING id",
              [screen.screenings[0].id],
            )
          ).rows[0].id;
          const ticket = (
            await client.query(
              "INSERT INTO tickets (booking_id,seat_id,amount_charged) VALUES ($1,$2,1200) RETURNING id",
              [booking, ordinary],
            )
          ).rows[0].id;
          const result = await seed(url);
          assert.equal(
            result.screens.reduce((sum, s) => sum + s.inserted, 0),
            639,
          );
          const before = await snapshot(client);
          assert.equal(before.seats.length, 640);
          assert.deepEqual(await seed(url), {
            ...result,
            screens: result.screens.map((s) => ({ ...s, inserted: 0 })),
          });
          assert.deepEqual(await snapshot(client), before);
          assert.equal(
            before.tickets.find((t) => t.id === ticket).seat_id,
            ordinary,
          );
          assert.equal(
            before.tickets.find((t) => t.id === ticket).booking_id,
            booking,
          );
          const running = await startServer({
            config: {
              databaseUrl: url,
              frontendUrl: "http://localhost:5173",
              port: 0,
            },
            host: "127.0.0.1",
          });
          try {
            const evidence = await verifyInventory({
              databaseUrl: url,
              baseUrl: `http://127.0.0.1:${running.server.address().port}`,
            });
            assert.equal(evidence.readOnly, true);
            assert.equal(evidence.screens.length, 4);
            assert.equal(
              evidence.screens.find((s) => s.id === screen.id).seated.available,
              98,
            );
            for (const s of evidence.screens.filter((s) => s.id !== screen.id))
              assert.equal(s.seated.available, s.capacity - 1);
            assert.ok(
              evidence.screens.every(
                (s) => s.wheelchair.available === 10 && s.ceo.seat_id !== 1,
              ),
            );
            await assert.rejects(
              client.query("UPDATE seats SET seat_label=3 WHERE id=$1", [
                ordinary,
              ]),
              /Referenced inventory/,
            );
            const large = evidence.screens.find((s) => s.capacity === 200);
            await assert.rejects(
              client.query("UPDATE screens SET capacity=100 WHERE id=$1", [
                large.id,
              ]),
              /cannot exclude/,
            );
            const newShow = (
              await client.query(
                "INSERT INTO screenings (screen_id,film_id,screening_time) VALUES ($1,$2,'2035-01-01') RETURNING id",
                [screen.id, screen.screenings[0].film_id],
              )
            ).rows[0].id;
            assert.equal(
              (
                await client.query(
                  "SELECT count(*)::int AS count FROM tickets t JOIN bookings b ON b.id=t.booking_id WHERE b.screening_id=$1 AND b.booking_type='ceo'",
                  [newShow],
                )
              ).rows[0].count,
              1,
            );
          } finally {
            await running.shutdown();
          }
        });
      },
    );

    await t.test(
      "simultaneous cold seeds insert exactly 640 unique places",
      async () => {
        await withDatabase(async (url, client) => {
          await seedBrowsing({ databaseUrl: url, mode });
          const results = await Promise.all([seed(url), seed(url)]);
          assert.equal(
            results
              .flatMap((r) => r.screens)
              .reduce((sum, s) => sum + s.inserted, 0),
            640,
          );
          assert.equal(
            (await client.query("SELECT count(*)::int AS count FROM seats"))
              .rows[0].count,
            640,
          );
          assert.equal(
            (await client.query("SELECT count(*)::int AS count FROM tickets"))
              .rows[0].count,
            8,
          );
        });
      },
    );

    await t.test(
      "invalid positions, duplicate labels and generated-column overrides are rejected",
      async () => {
        await withDatabase(async (url, client) => {
          const data = await seedBrowsing({ databaseUrl: url, mode });
          const id = data.cities[0].screens[0].id;
          await client.query(
            "INSERT INTO seats (screen_id,physical_row,row_label,seat_label) VALUES ($1,1,1,2)",
            [id],
          );
          await assert.rejects(
            client.query(
              "INSERT INTO seats (screen_id,physical_row,row_label,seat_label) VALUES ($1,1,1,2)",
              [id],
            ),
            { code: "23505" },
          );
          for (const values of [
            [2, 2, 3, false],
            [0, 0, 11, true],
            [1, 2, 3, false],
            [1, 1, -1, false],
          ])
            await assert.rejects(
              client.query(
                "INSERT INTO seats (screen_id,physical_row,row_label,seat_label,is_wheelchair) VALUES ($1,$2,$3,$4,$5)",
                [id, ...values],
              ),
              { code: "23514" },
            );
          await assert.rejects(
            client.query(
              "INSERT INTO seats (screen_id,physical_row,row_label,seat_label) VALUES ($1,11,11,102)",
              [id],
            ),
            /exceeds screen capacity/,
          );
          await assert.rejects(
            client.query(
              "INSERT INTO seats (screen_id,physical_row,row_label,seat_label,physical_column) VALUES ($1,1,1,3,4)",
              [id],
            ),
            { code: "428C9" },
          );
          await assert.rejects(
            client.query(
              "UPDATE screens SET wheelchair_capacity=9 WHERE id=$1",
              [id],
            ),
            { code: "23514" },
          );
        });
      },
    );

    await t.test(
      "a late seed failure rolls back every screen and CEO ticket; retry succeeds",
      async () => {
        await withDatabase(async (url, client) => {
          await seedBrowsing({ databaseUrl: url, mode });
          await client.query(`CREATE FUNCTION reject_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.screen_id=4 AND NEW.is_wheelchair THEN RAISE EXCEPTION 'test inventory failure'; END IF; RETURN NEW; END; $$;
        CREATE TRIGGER trg_reject_fixture BEFORE INSERT ON seats FOR EACH ROW EXECUTE FUNCTION reject_fixture()`);
          const before = await snapshot(client);
          await assert.rejects(seed(url), /test inventory failure/);
          assert.deepEqual(await snapshot(client), before);
          await client.query(
            "DROP TRIGGER trg_reject_fixture ON seats; DROP FUNCTION reject_fixture()",
          );
          assert.equal((await seed(url)).screens.length, 4);
        });
      },
    );

    await t.test(
      "missing or duplicate target screens fail without modifying inventory",
      async () => {
        await withDatabase(async (url, client) => {
          await assert.rejects(seed(url), /exactly one screen/);
          const data = await seedBrowsing({ databaseUrl: url, mode });
          await client.query(
            "INSERT INTO screens (city_id,capacity) VALUES ($1,100)",
            [data.cities[0].id],
          );
          const before = await snapshot(client);
          await assert.rejects(seed(url), /exactly one screen/);
          assert.deepEqual(await snapshot(client), before);
        });
      },
    );

    await t.test(
      "legacy upgrade preserves referenced IDs and refuses conflicting layouts atomically",
      async () => {
        for (const conflict of ["none", "duplicate", "row", "capacity"])
          await withDatabase(async (url, client) => {
            const data = await seedBrowsing({ databaseUrl: url, mode });
            const screen = data.cities[0].screens[0];
            const values =
              conflict === "row"
                ? [2, 2, 2]
                : conflict === "capacity"
                  ? [11, 11, 102]
                  : [1, 1, 2];
            const seat = (
              await client.query(
                "INSERT INTO seats (screen_id,physical_row,row_label,seat_label) VALUES ($1,$2,$3,$4) RETURNING id",
                [screen.id, ...values],
              )
            ).rows[0].id;
            if (conflict === "duplicate")
              await client.query(
                "INSERT INTO seats (screen_id,physical_row,row_label,seat_label) VALUES ($1,1,1,2)",
                [screen.id],
              );
            let legacyTicket;
            if (conflict === "none") {
              const booking = (
                await client.query(
                  "INSERT INTO bookings (screening_id,status,guest_email) VALUES ($1,'paid','legacy@example.test') RETURNING id",
                  [screen.screenings[0].id],
                )
              ).rows[0].id;
              legacyTicket = (
                await client.query(
                  "INSERT INTO tickets (booking_id,seat_id,amount_charged) VALUES ($1,$2,1200) RETURNING *",
                  [booking, seat],
                )
              ).rows[0];
            }
            const before = await snapshot(client);
            if (conflict === "none") {
              await migrateDatabase({ databaseUrl: url, mode });
              await seed(url);
              assert.deepEqual(
                (
                  await client.query("SELECT * FROM tickets WHERE id=$1", [
                    legacyTicket.id,
                  ])
                ).rows[0],
                legacyTicket,
              );
              assert.equal(
                (
                  await client.query(
                    "SELECT id FROM seats WHERE screen_id=$1 AND seat_label=2 AND NOT is_wheelchair",
                    [screen.id],
                  )
                ).rows[0].id,
                seat,
              );
            } else {
              await assert.rejects(migrateDatabase({ databaseUrl: url, mode }));
              assert.deepEqual(await snapshot(client), before);
              assert.equal(
                (
                  await client.query(
                    "SELECT count(*)::int AS count FROM rio_schema_migrations",
                  )
                ).rows[0].count,
                3,
              );
              assert.equal(
                (
                  await client.query(
                    "SELECT count(*)::int AS count FROM information_schema.columns WHERE table_name='seats' AND column_name='physical_column'",
                  )
                ).rows[0].count,
                0,
              );
            }
          }, true);
      },
    );
  },
);
