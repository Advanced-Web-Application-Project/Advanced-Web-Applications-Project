import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { readEnvironment } from "../src/config/environment.js";
import { startServer } from "../src/server.js";
import { createBookingsService } from "../src/features/bookings/bookingsService.js";
import {
  createStaffAuthService,
  STAFF_SESSION_MS,
} from "../src/features/staff/staffAuthService.js";
import { createStaffAuthRepository } from "../src/features/staff/staffAuthRepository.js";
import { requireStaffPermission } from "../src/features/staff/staffAccess.js";
import { hashStaffPassword } from "../src/features/staff/staffPassword.js";
import { manageStaff } from "../scripts/database/manage-staff.js";
import { migrateDatabase } from "../scripts/database/migrate.js";
import { seedBrowsing } from "../scripts/database/seed-browsing.js";
import { seedInventory } from "../scripts/database/seed-inventory.js";
import { seedDemoPrices } from "../scripts/database/seed-demo-prices.js";
import {
  createClient,
  assertIsolatedDevelopment,
  assertConnectedLocalTarget,
} from "../scripts/database/connection.js";

const key = () => randomBytes(32).toString("base64url");
const databaseUrl = process.env.TEST_DATABASE_URL,
  mode = "isolated-development";
const frontendUrl = "http://127.0.0.1:5173",
  staffOrigin = "http://127.0.0.1:5174";

test("staff configuration is explicit, distinct, bounded and fails closed", () => {
  const base = {
    DATABASE_URL: "postgresql://localhost/rio_test",
    FRONTEND_URL: frontendUrl,
  };
  assert.equal(readEnvironment(base).staff, null);
  const enabled = {
    ...base,
    STAFF_FRONTEND_URL: staffOrigin,
    STAFF_SESSION_SECRET: key(),
  };
  assert.equal(readEnvironment(enabled).staff.secureCookies, false);
  for (const change of [
    { STAFF_SESSION_SECRET: "" },
    { STAFF_SESSION_SECRET: "weak" },
    { STAFF_FRONTEND_URL: frontendUrl },
    { STAFF_FRONTEND_URL: "*" },
    { STAFF_FRONTEND_URL: "http://staff.example.invalid" },
    { STAFF_TRUST_PROXY_HOPS: "true" },
    { NODE_ENV: "production" },
  ])
    assert.throws(() => readEnvironment({ ...enabled, ...change }));
  const secure = readEnvironment({
    ...enabled,
    STAFF_FRONTEND_URL: "https://staff.example.invalid",
    NODE_ENV: "production",
    STAFF_TRUST_PROXY_HOPS: "1",
  }).staff;
  assert.equal(secure.secureCookies, true);
  assert.equal(secure.trustProxyHops, 1);
});

test("a plain caller-supplied actor cannot invoke booking services", async () => {
  let queried = false;
  const service = createBookingsService({
    listBookings: async () => {
      queried = true;
      return [];
    },
  });
  for (const actor of [
    undefined,
    { role: "administrator", userId: 1 },
    { role: "cashier", cityId: 1 },
  ])
    await assert.rejects(service.listBookings({}, actor), {
      code: "STAFF_FORBIDDEN",
    });
  assert.equal(queried, false);
});

test("password verification has bounded in-flight work", async () => {
  const service = createStaffAuthService(
    {
      consumeAttempt: async () => true,
      pruneAttempts: async () => {},
      canonicalEmail: async (email) => email,
      credentials: async () => undefined,
    },
    { secret: key() },
  );
  const results = await Promise.allSettled(
    [1, 2, 3].map((i) =>
      service.login(
        { email: `unknown${i}@example.invalid`, password: key() },
        "127.0.0.1",
      ),
    ),
  );
  assert.deepEqual(
    results.map((r) => r.reason.code).sort(),
    ["INVALID_CREDENTIALS", "INVALID_CREDENTIALS", "LOGIN_BUSY"].sort(),
  );
});

test(
  "real PostgreSQL staff sessions, authorization, CSRF, revocation and guest compatibility",
  { skip: !databaseUrl, timeout: 150000 },
  async (t) => {
    const source = assertIsolatedDevelopment(databaseUrl, mode),
      admin = createClient(databaseUrl);
    await admin.connect();
    await assertConnectedLocalTarget(admin, source);
    const name = `rio_test_auth_${process.pid}`,
      url = new URL(databaseUrl);
    url.pathname = "/" + name;
    let c, runtime, secureRuntime, untrustedRuntime;
    t.after(async () => {
      await untrustedRuntime?.shutdown();
      await secureRuntime?.shutdown();
      await runtime?.shutdown();
      await c?.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    });
    await admin.query(`CREATE DATABASE ${name}`);
    const target = { databaseUrl: url.href, mode };
    await migrateDatabase(target);
    await seedBrowsing(target);
    await seedInventory(target);
    await seedDemoPrices(target);
    c = createClient(url.href);
    await c.connect();
    const sessionSecret = key(),
      config = {
        databaseUrl: url.href,
        frontendUrl,
        port: 0,
        staff: {
          origin: staffOrigin,
          secret: sessionSecret,
          secureCookies: false,
          trustProxyHops: 0,
        },
      };
    const accounts = {};
    for (const [label, role, city] of [
      ["admin", "administrator"],
      ["oulu", "cashier", "Oulu"],
      ["tampere", "cashier", "Tampere"],
      ["disabled", "administrator"],
    ]) {
      const password = key(),
        email = `${label}@example.invalid`;
      const account = await manageStaff({
        ...target,
        input: { action: "provision", role, email, ...(city ? { city } : {}) },
        readPassword: async () => password,
      });
      accounts[label] = { ...account, password, email };
    }
    await manageStaff({
      ...target,
      input: { action: "disable", email: accounts.disabled.email },
    });
    const customerPassword = key();
    await c.query(
      "INSERT INTO users(email,password_hash) VALUES('customer@example.invalid',$1)",
      [await hashStaffPassword(customerPassword)],
    );
    await c.query(
      "INSERT INTO users(role,email,password_hash) VALUES('administrator','legacy@example.invalid','not-a-login')",
    );
    const shows = (
      await c.query(
        "SELECT sc.id,sc.screen_id,s.city_id,c.name AS city,s.capacity FROM screenings sc JOIN screens s ON s.id=sc.screen_id JOIN cities c ON c.id=s.city_id ORDER BY sc.id",
      )
    ).rows;
    const oulu = shows.find((s) => s.city === "Oulu"),
      tampere = shows.find((s) => s.city === "Tampere");
    runtime = await startServer({ config, host: "127.0.0.1" });
    const evidence = {
      date: "2026-11-21",
      database: "disposable PostgreSQL",
      checks: [],
      secretsRecorded: false,
    };
    const base = () => `http://127.0.0.1:${runtime.server.address().port}`;
    async function request(
      path,
      {
        method = "GET",
        body,
        cookie,
        headers = {},
        origin = staffOrigin,
        server = base(),
      } = {},
    ) {
      const response = await fetch(server + path, {
        method,
        headers: {
          ...(origin === null ? {} : { Origin: origin }),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(cookie ? { Cookie: cookie } : {}),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return {
        status: response.status,
        body: await response.json(),
        headers: response.headers,
        cookie: response.headers.get("set-cookie")?.split(";")[0],
      };
    }
    const clearAttempts = () => c.query("DELETE FROM staff_login_attempts");
    async function login(label = "admin", extra = {}) {
      const a = accounts[label];
      const result = await request("/api/staff/login", {
        method: "POST",
        body: { email: a.email, password: a.password },
        headers: { "X-RIO-Staff": "1" },
        ...extra,
      });
      assert.equal(result.status, 200, "fixture login succeeds");
      return result;
    }
    const stored = async (id) =>
      (
        await c.query(
          "SELECT sid,sess,expire FROM staff_sessions WHERE (sess->'staff'->>'userId')::int=$1 ORDER BY expire DESC LIMIT 1",
          [id],
        )
      ).rows[0];
    const current = (cookie, extra = {}) =>
      request("/api/staff/session", { cookie, ...extra });
    await t.test(
      "anonymous, forged cookies and generic credential failures reveal no staff data",
      async () => {
        await clearAttempts();
        for (const path of [
          "/api/staff/session",
          "/api/bookings",
          "/api/bookings?screeningId=" + oulu.id,
        ])
          assert.equal((await request(path)).status, 401);
        assert.equal(
          (await current("rio.staff=forged-administrator")).status,
          401,
        );
        const attempts = [
          { email: "unknown@example.invalid", password: key() },
          { email: accounts.admin.email, password: key() },
          {
            email: accounts.disabled.email,
            password: accounts.disabled.password,
          },
          { email: "customer@example.invalid", password: customerPassword },
          { email: "legacy@example.invalid", password: key() },
        ];
        let expected;
        for (const body of attempts) {
          const result = await request("/api/staff/login", {
            method: "POST",
            body,
            headers: { "X-RIO-Staff": "1" },
          });
          assert.equal(result.status, 401);
          expected ??= result.body;
          assert.deepEqual(result.body, expected);
          assert.equal(result.cookie, undefined);
        }
        assert.equal(
          (await c.query("SELECT count(*)::int AS n FROM staff_sessions"))
            .rows[0].n,
          0,
        );
        evidence.checks.push(
          "anonymous/customer/disabled/legacy/unknown/spoofed cookie denied with generic credential failures",
        );
      },
    );
    await t.test(
      "server-owned session identity, cookies, absolute deadline and rotation",
      async () => {
        await clearAttempts();
        const first = await login();
        const cookie = first.headers.get("set-cookie");
        assert.ok(
          /HttpOnly/i.test(cookie) &&
            /SameSite=Lax/i.test(cookie) &&
            /Path=\//i.test(cookie),
          "local cookie protections",
        );
        assert.ok(!/Domain=/i.test(cookie), "host-only cookie");
        assert.deepEqual(
          Object.keys(first.body.data).sort(),
          ["csrfToken", "expiresAt", "user"].sort(),
        );
        assert.deepEqual(first.body.data.user, {
          id: accounts.admin.userId,
          role: "administrator",
          cityId: null,
        });
        const before = await stored(accounts.admin.userId);
        assert.equal(
          before.sess.staff.expiresAt - before.sess.staff.issuedAt,
          STAFF_SESSION_MS,
        );
        const check = await current(first.cookie);
        assert.equal(check.status, 200);
        assert.equal(check.headers.get("cache-control"), "no-store");
        assert.equal(check.cookie, undefined);
        const after = await stored(accounts.admin.userId);
        assert.ok(
          before.expire.getTime() === after.expire.getTime() &&
            before.sess.staff.expiresAt === after.sess.staff.expiresAt,
          "session reads do not renew expiry",
        );
        const second = await login("admin", { cookie: first.cookie });
        assert.ok(
          second.cookie !== first.cookie,
          "successful login rotates opaque cookie",
        );
        assert.equal((await current(first.cookie)).status, 401);
        assert.equal((await current(second.cookie)).status, 200);
        for (const value of [
          sessionSecret,
          accounts.admin.password,
          before.sid,
        ])
          assert.ok(
            !JSON.stringify(second.body).includes(value),
            "body excludes credentials and session ID",
          );
        evidence.checks.push(
          "HttpOnly host-only cookie, minimal identity, eight-hour absolute expiry, no read renewal, session fixation rotation",
        );
      },
    );
    await t.test(
      "both cashiers are scoped by actual screening city, administrator can read both",
      async () => {
        await clearAttempts();
        for (const [label, own, other] of [
          ["oulu", oulu, tampere],
          ["tampere", tampere, oulu],
        ]) {
          const a = accounts[label];
          const signed = await login(label, {
            body: {
              email: a.email,
              password: a.password,
              role: "administrator",
              cityId: other.city_id,
            },
          });
          assert.equal(signed.body.data.user.role, "cashier");
          assert.equal(signed.body.data.user.cityId, own.city_id);
          const all = await request(
            "/api/bookings?cityId=" + other.city_id + "&role=administrator",
            { cookie: signed.cookie },
          );
          assert.equal(all.status, 200);
          assert.ok(all.body.data.length > 0, "nonempty scoped list");
          const expected = (
            await c.query(
              "SELECT b.id FROM bookings b JOIN screenings sc ON sc.id=b.screening_id JOIN screens s ON s.id=sc.screen_id WHERE s.city_id=$1 ORDER BY b.id DESC",
              [own.city_id],
            )
          ).rows.map((r) => r.id);
          assert.deepEqual(
            all.body.data.map((r) => r.booking_id),
            expected,
          );
          assert.equal(
            (
              await request("/api/bookings?screeningId=" + own.id, {
                cookie: signed.cookie,
              })
            ).status,
            200,
          );
          assert.equal(
            (
              await request("/api/bookings?screeningId=" + other.id, {
                cookie: signed.cookie,
              })
            ).status,
            403,
          );
          assert.equal(
            (
              await request("/api/bookings?screeningId[]=1", {
                cookie: signed.cookie,
              })
            ).status,
            400,
          );
          const row = await stored(a.userId),
            service = createStaffAuthService(createStaffAuthRepository(c), {
              secret: sessionSecret,
            }),
            actor = await service.current(row.sess.staff);
          assert.ok(actor.checkedAt instanceof Date);
          requireStaffPermission(actor, "reservations:create", {
            cityId: own.city_id,
          });
          for (const permission of [
            "films:write",
            "screenings:write",
            "prices:write",
            "ceo:release",
          ])
            assert.throws(() => requireStaffPermission(actor, permission), {
              code: "STAFF_FORBIDDEN",
            });
        }
        const signed = await login();
        const listing = await request("/api/bookings", {
          cookie: signed.cookie,
        });
        assert.equal(listing.status, 200);
        assert.equal(
          listing.body.data.length,
          (await c.query("SELECT count(*)::int AS n FROM bookings")).rows[0].n,
        );
        assert.ok(listing.body.data.some((b) => b.booking_type === "ceo"));
        assert.ok(
          !/guest_email|password_hash|hold_token_hash|csrfToken/.test(
            JSON.stringify(listing.body),
          ),
          "operational list has no private credential/contact fields",
        );
        const row = await stored(accounts.admin.userId),
          service = createStaffAuthService(createStaffAuthRepository(c), {
            secret: sessionSecret,
          }),
          actor = await service.current(row.sess.staff);
        for (const permission of [
          "films:write",
          "screenings:write",
          "prices:write",
        ])
          requireStaffPermission(actor, permission);
        assert.throws(() => requireStaffPermission(actor, "ceo:release"), {
          code: "STAFF_FORBIDDEN",
        });
        assert.equal(
          (
            await request("/api/bookings?screeningId=2147483647", {
              cookie: signed.cookie,
            })
          ).status,
          404,
        );
        evidence.checks.push(
          "actual-city scoped cashier lists/filters, body/query spoofing denied, administrator both cities, trusted actor matrix and CEO denial",
        );
      },
    );
    await t.test(
      "origin/custom-header login protection and synchronized logout CSRF",
      async () => {
        await clearAttempts();
        const signed = await login();
        for (const origin of [
          null,
          frontendUrl,
          "https://attacker.invalid",
          "null",
        ]) {
          assert.equal(
            (
              await request("/api/staff/login", {
                method: "POST",
                body: {
                  email: accounts.admin.email,
                  password: accounts.admin.password,
                },
                headers: { "X-RIO-Staff": "1" },
                origin,
              })
            ).status,
            403,
          );
          assert.equal(
            (
              await request("/api/staff/logout", {
                method: "POST",
                cookie: signed.cookie,
                headers: { "X-CSRF-Token": signed.body.data.csrfToken },
                origin,
              })
            ).status,
            403,
          );
        }
        assert.equal(
          (
            await request("/api/staff/login", {
              method: "POST",
              body: {
                email: accounts.admin.email,
                password: accounts.admin.password,
              },
            })
          ).status,
          403,
        );
        for (const token of [undefined, "wrong", "é".repeat(43)]) {
          const result = await request("/api/staff/logout", {
            method: "POST",
            cookie: signed.cookie,
            headers: token ? { "X-CSRF-Token": token } : {},
          });
          assert.equal(result.status, 403);
        }
        assert.equal((await current(signed.cookie)).status, 200);
        assert.equal(
          (
            await request("/api/bookings", {
              cookie: signed.cookie,
              origin: frontendUrl,
            })
          ).status,
          403,
        );
        assert.equal(
          (await current(signed.cookie, { origin: null })).status,
          403,
        );
        assert.equal(
          (
            await current(signed.cookie, {
              origin: null,
              headers: { Referer: staffOrigin + "/screenings" },
            })
          ).status,
          200,
        );
        assert.equal(
          (
            await current(signed.cookie, {
              origin: null,
              headers: { Referer: frontendUrl + "/" },
            })
          ).status,
          403,
        );
        const logout = await request("/api/staff/logout", {
          method: "POST",
          cookie: signed.cookie,
          headers: { "X-CSRF-Token": signed.body.data.csrfToken },
        });
        assert.equal(logout.status, 200);
        assert.equal((await current(signed.cookie)).status, 401);
        const events = (
          await c.query(
            "SELECT actor_user_id,event_type,occurred_at FROM staff_auth_events ORDER BY id",
          )
        ).rows;
        assert.ok(
          events.some(
            (e) =>
              e.actor_user_id === accounts.admin.userId &&
              e.event_type === "logout" &&
              e.occurred_at instanceof Date,
          ),
        );
        evidence.checks.push(
          "exact staff origin, custom JSON login header, synchronized CSRF, hostile/non-ASCII tokens denied, logout revocation and actor/time events",
        );
      },
    );
    await t.test(
      "password reset, disable and role/city changes revoke subsequent requests",
      async () => {
        await clearAttempts();
        let signed = await login("oulu");
        const replacement = key();
        await manageStaff({
          ...target,
          input: { action: "reset-password", email: accounts.oulu.email },
          readPassword: () => replacement,
        });
        accounts.oulu.password = replacement;
        assert.equal((await current(signed.cookie)).status, 401);
        signed = await login("oulu");
        await manageStaff({
          ...target,
          input: { action: "disable", email: accounts.oulu.email },
        });
        assert.equal((await current(signed.cookie)).status, 401);
        signed = await login("tampere");
        await c.query("UPDATE users SET permitted_city_id=$2 WHERE id=$1", [
          accounts.tampere.userId,
          oulu.city_id,
        ]);
        assert.equal((await current(signed.cookie)).status, 401);
        await c.query("UPDATE users SET permitted_city_id=$2 WHERE id=$1", [
          accounts.tampere.userId,
          tampere.city_id,
        ]);
        signed = await login("admin");
        await c.query("UPDATE users SET role='customer' WHERE id=$1", [
          accounts.admin.userId,
        ]);
        assert.equal((await current(signed.cookie)).status, 401);
        await c.query("UPDATE users SET role='administrator' WHERE id=$1", [
          accounts.admin.userId,
        ]);
        evidence.checks.push(
          "real provisioning reset/disable and direct role/city changes invalidate stored sessions on next request",
        );
      },
    );
    await t.test(
      "expiry boundary is enforced even when the session-store row remains readable",
      async () => {
        await clearAttempts();
        const signed = await login(),
          row = await stored(accounts.admin.userId);
        async function deadline(offset) {
          await c.query(
            `WITH t AS (SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint+$2::bigint AS n)
      UPDATE staff_sessions SET sess=jsonb_set(jsonb_set(sess::jsonb,'{staff,issuedAt}',to_jsonb(t.n-$3::bigint)),'{staff,expiresAt}',to_jsonb(t.n))::json,expire=clock_timestamp()+interval '1 minute' FROM t WHERE sid=$1`,
            [row.sid, offset, STAFF_SESSION_MS],
          );
        }
        await deadline(5000);
        assert.equal((await current(signed.cookie)).status, 200);
        await deadline(0);
        assert.equal((await current(signed.cookie)).status, 401);
        evidence.checks.push(
          "session valid before deadline and denied at/past absolute deadline independently of store pruning",
        );
      },
    );
    await t.test(
      "sessions survive a local backend restart and database failures fail closed",
      async () => {
        await clearAttempts();
        const signed = await login();
        await runtime.shutdown();
        runtime = await startServer({ config, host: "127.0.0.1" });
        assert.equal((await current(signed.cookie)).status, 200);
        await c.query(
          "ALTER TABLE staff_sessions RENAME TO staff_sessions_unavailable",
        );
        try {
          const failed = await current(signed.cookie);
          assert.equal(failed.status, 503);
          assert.ok(
            !/SELECT|relation|sid|postgresql:/.test(
              JSON.stringify(failed.body),
            ),
          );
        } finally {
          await c.query(
            "ALTER TABLE staff_sessions_unavailable RENAME TO staff_sessions",
          );
        }
        assert.equal((await current(signed.cookie)).status, 200);
        evidence.checks.push(
          "PostgreSQL session survives process restart; actual unavailable session table gives safe 503, recovery retains valid session",
        );
      },
    );
    await t.test(
      "persistent account and IP throttle resist case/space and forwarded-IP spoofing",
      async () => {
        await clearAttempts();
        for (let i = 0; i < 6; i++) {
          const result = await request("/api/staff/login", {
            method: "POST",
            body: {
              email: i % 2 ? " ADMIN@EXAMPLE.INVALID " : accounts.admin.email,
              password: key(),
            },
            headers: { "X-RIO-Staff": "1" },
          });
          assert.equal(result.status, i < 5 ? 401 : 429);
          if (i === 5) assert.equal(result.headers.get("retry-after"), "900");
        }
        await c.query(
          "UPDATE staff_login_attempts SET window_start=clock_timestamp()-interval '16 minutes'",
        );
        assert.equal((await login()).status, 200);
        await clearAttempts();
        for (let i = 0; i < 26; i++) {
          const result = await request("/api/staff/login", {
            method: "POST",
            body: { email: `unknown${i}@example.invalid`, password: key() },
            headers: {
              "X-RIO-Staff": "1",
              "X-Forwarded-For": `203.0.113.${i + 1}`,
            },
          });
          assert.equal(result.status, i < 25 ? 401 : 429);
        }
        const ips = (
          await c.query(
            "SELECT attempts FROM staff_login_attempts WHERE bucket LIKE 'ip:%'",
          )
        ).rows;
        assert.equal(ips.length, 1);
        assert.equal(ips[0].attempts, 26);
        await runtime.shutdown();
        runtime = await startServer({ config, host: "127.0.0.1" });
        assert.equal(
          (
            await request("/api/staff/login", {
              method: "POST",
              body: {
                email: accounts.admin.email,
                password: accounts.admin.password,
              },
              headers: { "X-RIO-Staff": "1" },
            })
          ).status,
          429,
        );
        evidence.checks.push(
          "durable 5/login and 25/IP limits per 15 minutes; normalized identities, ignored untrusted forwarding and restart persistence; elapsed window resets",
        );
      },
    );
    await t.test(
      "HTTPS cookie/proxy configuration and explicit credentialed CORS",
      async () => {
        await clearAttempts();
        const secureOrigin = "https://staff.example.invalid",
          secureConfig = {
            ...config,
            staff: {
              ...config.staff,
              origin: secureOrigin,
              secureCookies: true,
              trustProxyHops: 1,
            },
          };
        secureRuntime = await startServer({
          config: secureConfig,
          host: "127.0.0.1",
        });
        untrustedRuntime = await startServer({
          config: {
            ...secureConfig,
            staff: { ...secureConfig.staff, trustProxyHops: 0 },
          },
          host: "127.0.0.1",
        });
        const secureBase = `http://127.0.0.1:${secureRuntime.server.address().port}`,
          untrustedBase = `http://127.0.0.1:${untrustedRuntime.server.address().port}`;
        const options = {
          method: "POST",
          body: {
            email: accounts.admin.email,
            password: accounts.admin.password,
          },
          origin: secureOrigin,
          headers: { "X-RIO-Staff": "1", "X-Forwarded-Proto": "https" },
        };
        assert.equal(
          (
            await request("/api/staff/login", {
              ...options,
              server: untrustedBase,
            })
          ).status,
          403,
        );
        const signed = await request("/api/staff/login", {
          ...options,
          server: secureBase,
        });
        assert.equal(signed.status, 200);
        const header = signed.headers.get("set-cookie");
        assert.ok(
          header.startsWith("__Host-rio.staff=") &&
            /Secure/i.test(header) &&
            /HttpOnly/i.test(header) &&
            /SameSite=None/i.test(header) &&
            !/Domain=/i.test(header),
          "HTTPS cookie attributes",
        );
        for (const origin of [staffOrigin, frontendUrl]) {
          const response = await fetch(base() + "/api/cities", {
            headers: { Origin: origin },
          });
          assert.equal(
            response.headers.get("access-control-allow-origin"),
            origin,
          );
          assert.equal(
            response.headers.get("access-control-allow-credentials"),
            "true",
          );
        }
        const response = await fetch(base() + "/api/cities", {
          headers: { Origin: "https://attacker.invalid" },
        });
        assert.equal(response.headers.get("access-control-allow-origin"), null);
        const preflight = await fetch(base() + "/api/staff/logout", {
          method: "OPTIONS",
          headers: {
            Origin: staffOrigin,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type,x-csrf-token",
          },
        });
        assert.equal(preflight.status, 204);
        assert.equal(
          preflight.headers.get("access-control-allow-origin"),
          staffOrigin,
        );
        evidence.checks.push(
          "Secure HttpOnly host cookie/SameSite=None with simulated verified TLS proxy, no untrusted proxy bypass, separate explicit origins and credentialed preflight",
        );
      },
    );
    await t.test(
      "guest browsing, selection quote, owned hold and release remain independent of staff cookies",
      async () => {
        await clearAttempts();
        const signed = await login();
        for (const path of [
          "/api/cities",
          "/api/screens",
          "/api/films",
          "/api/screenings",
        ])
          assert.equal(
            (
              await request(path, {
                origin: frontendUrl,
                cookie: signed.cookie,
              })
            ).status,
            200,
          );
        const seats = (
          await c.query(
            "SELECT id,display_label FROM seats WHERE screen_id=$1 AND display_label IN ('2','W3')",
            [oulu.screen_id],
          )
        ).rows;
        const seatId = [
          {
            seatId: seats.find((s) => s.display_label === "2").id,
            category: "adult",
          },
          {
            seatId: seats.find((s) => s.display_label === "W3").id,
            category: "child",
          },
        ];
        const preview = await request("/api/seats/validate", {
          method: "POST",
          body: {
            screenId: oulu.screen_id,
            screeningId: oulu.id,
            seatIds: seatId.map((s) => s.seatId),
          },
          origin: frontendUrl,
        });
        assert.equal(preview.status, 200);
        assert.equal(preview.body.data.valid, true);
        const quote = await request("/api/bookings/quote", {
          method: "POST",
          body: { screeningId: oulu.id, seatId },
          origin: frontendUrl,
          cookie: signed.cookie,
        });
        assert.equal(quote.status, 200);
        assert.equal(quote.body.data.totalCents, 1800);
        const hold = await request("/api/bookings", {
          method: "POST",
          body: {
            screeningId: oulu.id,
            seatId,
            clientEmail: "guest@example.invalid",
            expectedQuote: quote.body.data.quoteFingerprint,
          },
          headers: { "Idempotency-Key": key() },
          origin: frontendUrl,
        });
        assert.equal(hold.status, 201);
        const released = await request(
          "/api/bookings/" + hold.body.data.bookingId,
          {
            method: "DELETE",
            headers: { Authorization: "Bearer " + hold.body.data.holdToken },
            origin: frontendUrl,
          },
        );
        assert.equal(released.status, 200);
        const history = (
          await c.query(
            "SELECT b.status,sum(t.amount_charged)::int AS charged FROM bookings b JOIN tickets t ON t.booking_id=b.id WHERE b.id=$1 GROUP BY b.id",
            [hold.body.data.bookingId],
          )
        ).rows[0];
        assert.deepEqual(history, { status: "expired", charged: 1800 });
        evidence.checks.push(
          "public customer browse/preview/quote and owned retry-key hold/release preserved with authoritative charged history while staff auth is enabled",
        );
      },
    );
    if (process.env.RIO_STAFF_AUTH_EVIDENCE_PATH)
      await writeFile(
        process.env.RIO_STAFF_AUTH_EVIDENCE_PATH,
        JSON.stringify(evidence, null, 2) + "\n",
      );
  },
);
