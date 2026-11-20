import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { createServer } from "node:http";
import { writeFile, mkdtemp, readdir, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  parseHoldRequestKey,
  parseBookingRequest,
  fingerprintHoldRequest,
  createBookingsService,
} from "../src/features/bookings/bookingsService.js";
import { migrateDatabase } from "../scripts/database/migrate.js";
import { seedBrowsing } from "../scripts/database/seed-browsing.js";
import { seedInventory } from "../scripts/database/seed-inventory.js";
import {
  createClient,
  assertIsolatedDevelopment,
  assertConnectedLocalTarget,
} from "../scripts/database/connection.js";
import { startServer } from "../src/server.js";

const databaseUrl = process.env.TEST_DATABASE_URL,
  mode = "isolated-development";
const key = () => randomBytes(32).toString("base64url");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const body = {
  screeningId: 1,
  clientEmail: "guest@example.invalid",
  seatId: [2, { seatId: 3, category: "child" }],
};
test("private retry credentials are canonical and invalid keys fail before connecting", async () => {
  assert.equal(parseHoldRequestKey(undefined), null);
  const valid = key();
  assert.equal(parseHoldRequestKey(valid), valid);
  let transactions = 0;
  const service = createBookingsService({
    transaction() {
      transactions++;
      throw Error("should not connect");
    },
  });
  for (const invalid of [
    null,
    0,
    [],
    "",
    randomBytes(16).toString("hex"),
    "a".repeat(42),
    "a".repeat(44),
    "A".repeat(42) + "B",
    ` ${valid}`,
    `${valid},${valid}`,
  ]) {
    assert.throws(() => parseHoldRequestKey(invalid), {
      code: "INVALID_IDEMPOTENCY_KEY",
    });
    await assert.rejects(service.createHold(body, invalid), {
      code: "INVALID_IDEMPOTENCY_KEY",
    });
  }
  assert.equal(transactions, 0);
});
test("request fingerprints bind meaningful normalized inputs while preserving category meaning", () => {
  const first = fingerprintHoldRequest(parseBookingRequest(body));
  assert.equal(
    first,
    fingerprintHoldRequest(
      parseBookingRequest({
        ...body,
        clientEmail: ` ${body.clientEmail} `,
        seatId: [
          { seatId: 3, category: "CHILD" },
          { seatId: 2, category: "ADULT" },
        ],
        amount: 1,
        status: "paid",
      }),
    ),
  );
  for (const changed of [
    { screeningId: 2 },
    { clientEmail: "other@example.invalid" },
    { seatId: [2, 3] },
    { seatId: [2, 4] },
  ])
    assert.notEqual(
      first,
      fingerprintHoldRequest(parseBookingRequest({ ...body, ...changed })),
    );
});

test(
  "real HTTP hold retries recover one owned hold without extending expiry",
  { skip: !databaseUrl, timeout: 90000 },
  async (t) => {
    const source = assertIsolatedDevelopment(databaseUrl, mode),
      admin = createClient(databaseUrl);
    await admin.connect();
    await assertConnectedLocalTarget(admin, source);
    const name = `rio_test_hold_retry_${process.pid}`,
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
    await c.query(
      "INSERT INTO prices(category,amount_cents) VALUES ('adult',1200),('child',500)",
    );
    runtime = await startServer({
      config: {
        databaseUrl: url.href,
        frontendUrl: "http://localhost:5173",
        port: 0,
      },
      host: "127.0.0.1",
    });
    const base = `http://127.0.0.1:${runtime.server.address().port}`;
    async function request(
      path,
      { body, key: privateKey, method = body ? "POST" : "GET", token } = {},
    ) {
      const response = await fetch(base + path, {
        method,
        headers: {
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(privateKey ? { "Idempotency-Key": privateKey } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      return {
        status: response.status,
        cache: response.headers.get("cache-control"),
        body: await response.json(),
      };
    }
    const post = (body, privateKey) =>
      request("/api/bookings", { body, key: privateKey });
    const snapshot = async () => {
      const out = {};
      for (const table of ["bookings", "tickets"])
        out[table] = (await c.query(`SELECT * FROM ${table} ORDER BY id`)).rows;
      return out;
    };
    const screens = (
      await c.query(
        "SELECT s.id,s.capacity,c.name AS city FROM screens s JOIN cities c ON c.id=s.city_id ORDER BY s.id",
      )
    ).rows;
    const filmId = (await c.query("SELECT id FROM films ORDER BY id LIMIT 1"))
      .rows[0].id;
    async function scenario(screen = screens[0]) {
      const show = (
        await c.query(
          "INSERT INTO screenings(film_id,screen_id,screening_time) VALUES($1,$2,(statement_timestamp() AT TIME ZONE 'Europe/Helsinki')+interval '2 days') RETURNING id",
          [filmId, screen.id],
        )
      ).rows[0];
      const rows = (
        await c.query("SELECT id,display_label FROM seats WHERE screen_id=$1", [
          screen.id,
        ])
      ).rows;
      const seat = (label) =>
        rows.find((s) => s.display_label === String(label)).id;
      return {
        show,
        seat,
        body: {
          screeningId: show.id,
          clientEmail: "fixture@example.invalid",
          seatId: [seat(2), { seatId: seat("W3"), category: "child" }],
        },
        screen,
      };
    }
    const examples = [];
    await t.test(
      "both cities and capacities retain the exact creation response, prices and owner credential",
      async () => {
        for (const screen of screens) {
          const s = await scenario(screen),
            privateKey = key();
          const preview = await request("/api/seats/validate", {
            body: {
              screenId: screen.id,
              screeningId: s.show.id,
              seatIds: [s.seat(2), s.seat("W3")],
            },
          });
          assert.equal(preview.body.data.valid, true);
          const first = await post(s.body, privateKey);
          assert.equal(first.status, 201);
          assert.equal(first.cache, "no-store");
          assert.equal(first.body.data.holdToken, privateKey);
          assert.equal(first.body.data.totalCents, 1800);
          await c.query(
            "UPDATE prices SET amount_cents=1400 WHERE category='adult'",
          );
          const retry = await post(
            {
              ...s.body,
              clientEmail: " fixture@example.invalid ",
              seatId: [
                { seatId: s.seat("W3"), category: "CHILD" },
                { seatId: s.seat(2), category: "adult" },
              ],
            },
            privateKey,
          );
          assert.deepEqual(retry, first);
          await c.query(
            "UPDATE prices SET amount_cents=1200 WHERE category='adult'",
          );
          const stored = (
            await c.query(
              "SELECT hold_token_hash,hold_request_fingerprint FROM bookings WHERE id=$1",
              [first.body.data.bookingId],
            )
          ).rows[0];
          assert.equal(stored.hold_token_hash, hash(privateKey));
          assert.equal(
            stored.hold_request_fingerprint,
            fingerprintHoldRequest(parseBookingRequest(s.body)),
          );
          assert.ok(!JSON.stringify(stored).includes(privateKey));
          const listed = await request(
            `/api/bookings?screeningId=${s.show.id}`,
          );
          for (const secret of [
            privateKey,
            stored.hold_token_hash,
            stored.hold_request_fingerprint,
            s.body.clientEmail,
          ])
            assert.ok(!JSON.stringify(listed).includes(secret));
          const other = await post(s.body, key());
          assert.equal(other.status, 409);
          assert.equal(other.body.code, "INVALID_SELECTION");
          const release = await request(
            `/api/bookings/${first.body.data.bookingId}`,
            { method: "DELETE", token: privateKey },
          );
          assert.equal(release.status, 200);
          const expired = await post(s.body, privateKey);
          assert.equal(expired.status, 409);
          assert.equal(expired.body.code, "HOLD_EXPIRED");
          assert.equal(expired.cache, "no-store");
          examples.push({
            city: screen.city,
            capacity: screen.capacity,
            screenId: screen.id,
            screeningId: s.show.id,
            selectedIds: [s.seat(2), s.seat("W3")],
            bookingId: first.body.data.bookingId,
            creationStatus: 201,
            retryStatus: 201,
            originalDeadline: first.body.data.expiresAt,
            retryDeadline: retry.body.data.expiresAt,
            totalCents: 1800,
            competingStatus: 409,
            releaseStatus: 200,
            releasedRetryStatus: 409,
          });
        }
      },
    );
    await t.test(
      "concurrent identical retries allocate only one hold and return the same result",
      async () => {
        const s = await scenario(),
          privateKey = key(),
          before = await snapshot();
        const results = await Promise.all(
          Array.from({ length: 6 }, () => post(s.body, privateKey)),
        );
        assert.ok(results.every((r) => r.status === 201));
        for (const r of results) assert.deepEqual(r, results[0]);
        const after = await snapshot();
        assert.equal(after.bookings.length - before.bookings.length, 1);
        assert.equal(after.tickets.length - before.tickets.length, 2);
      },
    );
    await t.test(
      "a committed hold is recovered after its first HTTP response is dropped",
      async () => {
        const s = await scenario(),
          privateKey = key();
        let committed;
        const proxy = createServer(async (req, res) => {
          try {
            const chunks = [];
            for await (const part of req) chunks.push(part);
            const response = await fetch(base + "/api/bookings", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Idempotency-Key": req.headers["idempotency-key"],
              },
              body: Buffer.concat(chunks),
            });
            assert.equal(response.status, 201);
            committed = await response.json();
            res.destroy();
          } catch {
            res.destroy();
          }
        });
        await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
        try {
          await assert.rejects(
            fetch(`http://127.0.0.1:${proxy.address().port}`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Idempotency-Key": privateKey,
              },
              body: JSON.stringify(s.body),
            }),
          );
          assert.ok(committed?.data.bookingId);
          const recovered = await post(s.body, privateKey);
          assert.equal(recovered.status, 201);
          assert.deepEqual(recovered.body, committed);
        } finally {
          proxy.closeAllConnections();
          await new Promise((resolve) => proxy.close(resolve));
        }
        assert.equal(
          (
            await c.query(
              "SELECT count(*)::int AS n FROM bookings WHERE hold_token_hash=$1",
              [hash(privateKey)],
            )
          ).rows[0].n,
          1,
        );
      },
    );
    await t.test(
      "changed choices, category, contact or screening cannot reuse a committed key",
      async () => {
        const s = await scenario(),
          privateKey = key(),
          first = await post(s.body, privateKey);
        assert.equal(first.status, 201);
        const before = await snapshot();
        const other = await scenario();
        const stable = await snapshot();
        for (const change of [
          { seatId: [s.seat(3)] },
          { seatId: [s.seat(2), s.seat("W3")] },
          { clientEmail: "different@example.invalid" },
          { screeningId: other.show.id },
        ]) {
          const result = await post({ ...s.body, ...change }, privateKey);
          assert.equal(result.status, 409);
          assert.equal(result.body.code, "IDEMPOTENCY_KEY_CONFLICT");
          assert.ok(!result.body.data);
          assert.ok(!JSON.stringify(result.body).includes(privateKey));
        }
        assert.deepEqual(await snapshot(), stable);
        assert.ok(
          before.bookings.some((b) => b.id === first.body.data.bookingId),
        );
      },
    );
    await t.test(
      "natural expiry and paid state never recreate or renew the original allocation",
      async () => {
        const s = await scenario(),
          privateKey = key(),
          first = await post(s.body, privateKey);
        assert.equal(first.status, 201);
        await c.query(
          "UPDATE bookings SET expiry_time=(statement_timestamp() AT TIME ZONE 'Europe/Helsinki')-interval '1 second' WHERE id=$1",
          [first.body.data.bookingId],
        );
        const before = await snapshot(),
          retry = await post(s.body, privateKey);
        assert.equal(retry.status, 409);
        assert.equal(retry.body.code, "HOLD_EXPIRED");
        assert.deepEqual(await snapshot(), before);
        const fresh = await post(s.body, key());
        assert.equal(fresh.status, 201);
        assert.notEqual(fresh.body.data.bookingId, first.body.data.bookingId);
        const paid = await scenario(),
          paidKey = key(),
          paidHold = await post(paid.body, paidKey);
        await c.query("UPDATE bookings SET status='paid' WHERE id=$1", [
          paidHold.body.data.bookingId,
        ]);
        const unchanged = await snapshot();
        const response = await post(paid.body, paidKey);
        assert.equal(response.status, 409);
        assert.equal(response.body.code, "HOLD_NOT_ACTIVE");
        assert.deepEqual(await snapshot(), unchanged);
      },
    );
    await t.test(
      "a retry waiting for a booking lock checks expiry after acquiring the lock",
      async () => {
        const s = await scenario(),
          privateKey = key(),
          first = await post(s.body, privateKey);
        assert.equal(first.status, 201);
        const blocker = createClient(url.href);
        await blocker.connect();
        let pending;
        try {
          await c.query(
            "UPDATE bookings SET expiry_time=(clock_timestamp() AT TIME ZONE 'Europe/Helsinki')+interval '0.5 seconds' WHERE id=$1",
            [first.body.data.bookingId],
          );
          await blocker.query("BEGIN");
          await blocker.query(
            "SELECT id FROM bookings WHERE id=$1 FOR NO KEY UPDATE",
            [first.body.data.bookingId],
          );
          pending = post(s.body, privateKey);
          let waiting = false;
          for (let attempt = 0; attempt < 50; attempt++) {
            waiting = (
              await c.query(
                "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FROM bookings WHERE id=$1 FOR NO KEY UPDATE%') AS waiting",
              )
            ).rows[0].waiting;
            if (waiting) break;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          assert.equal(
            waiting,
            true,
            "retry must actually wait on the booking lock",
          );
          await blocker.query("SELECT pg_sleep(0.6)");
          await blocker.query("COMMIT");
          const response = await pending;
          assert.equal(response.status, 409);
          assert.equal(response.body.code, "HOLD_EXPIRED");
        } finally {
          await blocker.query("ROLLBACK").catch(() => {});
          await blocker.end();
          await pending?.catch(() => {});
        }
      },
    );
    await t.test(
      "late write failure rolls back request identity, allowing a safe retry",
      async () => {
        const s = await scenario(),
          privateKey = key(),
          before = await snapshot();
        await c.query(
          `CREATE FUNCTION fail_retry_ticket() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.seat_id=${s.seat("W3")} THEN RAISE EXCEPTION 'PRIVATE_SQL_FAILURE'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_retry_ticket BEFORE INSERT ON tickets FOR EACH ROW EXECUTE FUNCTION fail_retry_ticket()`,
        );
        const failed = await post(s.body, privateKey);
        assert.equal(failed.status, 500);
        assert.ok(!JSON.stringify(failed.body).includes("PRIVATE"));
        assert.deepEqual(await snapshot(), before);
        await c.query(
          "DROP TRIGGER fail_retry_ticket ON tickets; DROP FUNCTION fail_retry_ticket()",
        );
        const retried = await post(s.body, privateKey);
        assert.equal(retried.status, 201);
        assert.equal(
          (await post(s.body, privateKey)).body.data.bookingId,
          retried.body.data.bookingId,
        );
      },
    );
    await t.test(
      "legacy calls stay compatible and their token cannot be adopted as a new request identity",
      async () => {
        const s = await scenario(),
          legacy = await post(s.body);
        assert.equal(legacy.status, 201);
        assert.match(legacy.body.data.holdToken, /^[A-Za-z0-9_-]{43}$/);
        assert.equal(
          (
            await c.query(
              "SELECT hold_request_fingerprint FROM bookings WHERE id=$1",
              [legacy.body.data.bookingId],
            )
          ).rows[0].hold_request_fingerprint,
          null,
        );
        const claimed = await post(
          { ...s.body, seatId: [s.seat(3)] },
          legacy.body.data.holdToken,
        );
        assert.equal(claimed.status, 409);
        assert.equal(claimed.body.code, "IDEMPOTENCY_KEY_CONFLICT");
        assert.equal(
          (
            await request(`/api/bookings/${legacy.body.data.bookingId}`, {
              method: "DELETE",
              token: legacy.body.data.holdToken,
            })
          ).status,
          200,
        );
      },
    );
    if (process.env.RIO_HOLD_RETRY_EVIDENCE_PATH)
      await writeFile(
        process.env.RIO_HOLD_RETRY_EVIDENCE_PATH,
        JSON.stringify(
          {
            scope:
              "Disposable PostgreSQL and real Express HTTP; synthetic adult 1200 cents; database removed after tests",
            examples,
          },
          null,
          2,
        ) + "\n",
      );
  },
);

test(
  "migration preserves legacy records and refuses ambiguous credentials without partial adoption",
  { skip: !databaseUrl, timeout: 45000 },
  async () => {
    const source = assertIsolatedDevelopment(databaseUrl, mode),
      admin = createClient(databaseUrl);
    await admin.connect();
    await assertConnectedLocalTarget(admin, source);
    const name = `rio_test_retry_migration_${process.pid}`,
      url = new URL(databaseUrl);
    url.pathname = `/${name}`;
    await admin.query(`CREATE DATABASE ${name}`);
    const c = createClient(url.href),
      directory = await mkdtemp(join(tmpdir(), "rio-retry-schema-"));
    try {
      const migrations = new URL("../../database/migrations/", import.meta.url);
      for (const file of await readdir(migrations))
        if (file.endsWith(".sql") && file < "0008")
          await copyFile(new URL(file, migrations), join(directory, file));
      await migrateDatabase({
        databaseUrl: url.href,
        mode,
        directory: pathToFileURL(directory + "/"),
      });
      await seedBrowsing({ databaseUrl: url.href, mode });
      await c.connect();
      const show = (
        await c.query("SELECT id FROM screenings ORDER BY id LIMIT 1")
      ).rows[0];
      const sharedHash = hash(key());
      await c.query(
        "INSERT INTO bookings(screening_id,guest_email,status,hold_token_hash) VALUES($1,'fixture@example.invalid','expired',$2),($1,'fixture@example.invalid','expired',$2)",
        [show.id, sharedHash],
      );
      const before = (await c.query("SELECT * FROM bookings ORDER BY id")).rows;
      await assert.rejects(
        migrateDatabase({ databaseUrl: url.href, mode }),
        /Duplicate legacy hold credentials/,
      );
      assert.deepEqual(
        (await c.query("SELECT * FROM bookings ORDER BY id")).rows,
        before,
      );
      assert.equal(
        (
          await c.query(
            "SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='bookings' AND column_name='hold_request_fingerprint'",
          )
        ).rows[0].n,
        0,
      );
      assert.equal(
        (await c.query("SELECT count(*)::int AS n FROM rio_schema_migrations"))
          .rows[0].n,
        7,
      );
      // Explicit manual repair in this disposable fixture, then safe adoption.
      await c.query("UPDATE bookings SET hold_token_hash=$1 WHERE id=$2", [
        hash(key()),
        before.at(-1).id,
      ]);
      const repaired = (await c.query("SELECT * FROM bookings ORDER BY id"))
        .rows;
      await migrateDatabase({ databaseUrl: url.href, mode });
      const adopted = (await c.query("SELECT * FROM bookings ORDER BY id"))
        .rows;
      assert.deepEqual(
        adopted.map(({ hold_request_fingerprint, ...row }) => {
          assert.equal(hold_request_fingerprint, null);
          return row;
        }),
        repaired,
      );
      await assert.rejects(
        c.query(
          "INSERT INTO bookings(screening_id,guest_email,status,hold_token_hash) VALUES($1,'fixture@example.invalid','expired',$2)",
          [show.id, sharedHash],
        ),
        { code: "23505" },
      );
      await assert.rejects(
        c.query(
          "INSERT INTO bookings(screening_id,guest_email,status,hold_request_fingerprint) VALUES($1,'fixture@example.invalid','expired',$2)",
          [show.id, hash(key())],
        ),
        { code: "23514" },
      );
    } finally {
      await c.end();
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
