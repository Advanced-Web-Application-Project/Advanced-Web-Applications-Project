import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readEnvironment } from "../src/config/environment.js";
import { createCustomerAuthService } from "../src/features/customer/customerAuthService.js";
import { createCustomerAuthRepository } from "../src/features/customer/customerAuthRepository.js";
import { createApp } from "../src/app.js";
import { startServer } from "../src/server.js";
import {
  hashStaffPassword,
  STAFF_PASSWORD_PATTERN,
} from "../src/features/staff/staffPassword.js";
import { migrateDatabase } from "../scripts/database/migrate.js";
import {
  assertConnectedLocalTarget,
  assertIsolatedDevelopment,
  createClient,
} from "../scripts/database/connection.js";

const key = () => randomBytes(32).toString("base64url");
const base = {
  DATABASE_URL: "postgresql://test:private-password@127.0.0.1/rio_test",
  FRONTEND_URL: "http://127.0.0.1:5173",
};

test("customer auth config enables secure loopback cookies and rejects unsafe production transport", () => {
  const secret = key();
  const config = readEnvironment({
    ...base,
    CUSTOMER_SESSION_SECRET: secret,
  });
  assert.equal(config.customer.origin, base.FRONTEND_URL);
  assert.equal(config.customer.secureCookies, false);
  assert.throws(() =>
    readEnvironment({
      ...base,
      CUSTOMER_SESSION_SECRET: "not-a-secret",
    }),
  );
  assert.throws(() =>
    readEnvironment({
      ...base,
      CUSTOMER_SESSION_SECRET: secret,
      FRONTEND_URL: "http://customer.example.invalid",
    }),
  );
  const secure = readEnvironment({
    ...base,
    CUSTOMER_SESSION_SECRET: secret,
    FRONTEND_URL: "https://customer.example.invalid",
    NODE_ENV: "production",
    CUSTOMER_TRUST_PROXY_HOPS: "1",
  });
  assert.equal(secure.customer.secureCookies, true);
  assert.equal(secure.customer.trustProxyHops, 1);
});

test("staff and customer cookies cannot disagree about the trusted proxy boundary", () => {
  const pool = { query: async () => ({ rows: [] }) };
  assert.throws(
    () =>
      createApp({
        pool,
        frontendUrl: base.FRONTEND_URL,
        staff: { trustProxyHops: 0 },
        customer: { trustProxyHops: 1 },
      }),
    /same trusted proxy boundary/,
  );
});

test("customer login hides unknown accounts and throttles before password work", async () => {
  let throttled = false;
  const repository = {
    consumeAttempt: async () => !throttled,
    pruneAttempts: async () => {},
    canonicalEmail: async (email) => email,
    credentials: async () => undefined,
  };
  const service = createCustomerAuthService(repository, { secret: key() });
  await assert.rejects(
    service.login(
      { email: "unknown@example.invalid", password: key() },
      "127.0.0.1",
    ),
    (error) =>
      error.status === 401 &&
      error.code === "INVALID_CREDENTIALS" &&
      error.message === "Email or password is incorrect.",
  );
  throttled = true;
  await assert.rejects(
    service.login(
      { email: "unknown@example.invalid", password: key() },
      "127.0.0.1",
    ),
    (error) => error.status === 429 && error.code === "LOGIN_THROTTLED",
  );
});

test("customer repository scopes credential and session queries to enabled customer identities", async () => {
  const queries = [];
  const repository = createCustomerAuthRepository({
    query: async (sql, parameters) => {
      queries.push({ sql, parameters });
      return { rows: [{ id: 8, login_email: "customer@example.invalid" }] };
    },
  });
  await repository.credentials("customer@example.invalid");
  await repository.current(8, 3, 1234);
  await repository.register("new@example.invalid", "encoded-password");
  assert.match(queries[0].sql, /role='customer'/);
  assert.match(queries[0].sql, /permitted_city_id IS NULL/);
  assert.match(queries[1].sql, /role='customer'/);
  assert.match(queries[1].sql, /is_enabled/);
  assert.match(queries[1].sql, /session_version=\$2/);
  assert.deepEqual(queries[1].parameters, [8, 3, 1234]);
  assert.match(queries[2].sql, /INSERT INTO users\(role,email,password_hash\)/);
  assert.match(queries[2].sql, /VALUES\('customer'/);
  assert.deepEqual(queries[2].parameters, [
    "new@example.invalid",
    "encoded-password",
  ]);
});

test("customer registration hashes valid passwords and enforces the password policy", async () => {
  const attempts = [];
  let created;
  const repository = {
    consumeAttempt: async (bucket, limit) => {
      attempts.push({ bucket, limit });
      return true;
    },
    pruneAttempts: async () => {},
    canonicalEmail: async (email) => email.toLowerCase(),
    register: async (email, passwordHash) => {
      created = { email, passwordHash };
      return {
        id: 15,
        login_email: email,
        session_version: 1,
        now_ms: 1000,
      };
    },
  };
  const service = createCustomerAuthService(repository, { secret: key() });
  const session = await service.register(
    {
      email: "New@Example.Invalid",
      password: "p".repeat(15),
    },
    "127.0.0.1",
  );
  assert.equal(created.email, "new@example.invalid");
  assert.equal(STAFF_PASSWORD_PATTERN.test(created.passwordHash), true);
  assert.deepEqual(session, {
    userId: 15,
    version: 1,
    issuedAt: 1000,
    expiresAt: 1000 + 8 * 60 * 60 * 1000,
  });
  assert.equal(attempts[0].limit, 10);
  assert.equal(attempts[1].limit, 3);
  assert.ok(
    attempts.every(({ bucket }) => !bucket.includes("example.invalid")),
  );
  await service.register(
    { email: "max@example.invalid", password: "p".repeat(128) },
    "127.0.0.1",
  );
  assert.equal(created.email, "max@example.invalid");
  assert.equal(STAFF_PASSWORD_PATTERN.test(created.passwordHash), true);
  await assert.rejects(
    service.register(
      { email: "short@example.invalid", password: "p".repeat(14) },
      "127.0.0.1",
    ),
    (error) => error.status === 400 && error.code === "INVALID_REGISTRATION",
  );
  await assert.rejects(
    service.register(
      { email: "long@example.invalid", password: "p".repeat(129) },
      "127.0.0.1",
    ),
    (error) => error.status === 400 && error.code === "INVALID_REGISTRATION",
  );
});

test(
  "HTTP customer login creates, recovers, and revokes an isolated customer session",
  { skip: !process.env.TEST_DATABASE_URL, timeout: 90000 },
  async (t) => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    const source = assertIsolatedDevelopment(
      databaseUrl,
      "isolated-development",
    );
    const admin = createClient(databaseUrl);
    await admin.connect();
    await assertConnectedLocalTarget(admin, source);
    const name = `rio_test_customer_${process.pid}_${randomBytes(3).toString("hex")}`;
    const url = new URL(databaseUrl);
    url.pathname = `/${name}`;
    let client, runtime;
    t.after(async () => {
      await runtime?.shutdown();
      await client?.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    });
    await admin.query(`CREATE DATABASE ${name}`);
    await migrateDatabase({
      databaseUrl: url.href,
      mode: "isolated-development",
    });
    client = createClient(url.href);
    await client.connect();
    const email = "customer@example.invalid";
    const password = key();
    const user = (
      await client.query(
        "INSERT INTO users(role,email,password_hash) VALUES('customer',$1,$2) RETURNING id",
        [email, await hashStaffPassword(password)],
      )
    ).rows[0];
    const config = {
      ...readEnvironment({
        DATABASE_URL: url.href,
        FRONTEND_URL: base.FRONTEND_URL,
        CUSTOMER_SESSION_SECRET: key(),
      }),
      port: 0,
    };
    runtime = await startServer({ config, host: "127.0.0.1" });
    const origin = base.FRONTEND_URL;
    const server = `http://127.0.0.1:${runtime.server.address().port}`;
    async function request(
      path,
      {
        method = "GET",
        body,
        cookie,
        headers = {},
        requestOrigin = origin,
      } = {},
    ) {
      const response = await fetch(server + path, {
        method,
        headers: {
          ...(requestOrigin === null ? {} : { Origin: requestOrigin }),
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

    const registration = await request("/api/customer/register", {
      method: "POST",
      body: {
        email: "newcustomer@example.invalid",
        password: "very-strong-customer-password",
        role: "administrator",
        permitted_city_id: 99,
      },
      headers: { "X-RIO-Customer": "1" },
    });
    assert.equal(registration.status, 201);
    assert.deepEqual(registration.body.data.user, {
      id: (
        await client.query(
          "SELECT id FROM users WHERE login_email='newcustomer@example.invalid'",
        )
      ).rows[0].id,
      email: "newcustomer@example.invalid",
    });
    assert.ok(/HttpOnly/i.test(registration.headers.get("set-cookie")));
    const registeredUser = (
      await client.query(
        "SELECT role,permitted_city_id,password_hash FROM users WHERE id=$1",
        [registration.body.data.user.id],
      )
    ).rows[0];
    assert.equal(registeredUser.role, "customer");
    assert.equal(registeredUser.permitted_city_id, null);
    assert.equal(
      STAFF_PASSWORD_PATTERN.test(registeredUser.password_hash),
      true,
    );
    assert.notEqual(
      registeredUser.password_hash,
      "very-strong-customer-password",
    );
    assert.equal(
      (
        await request("/api/customer/session", {
          cookie: registration.cookie,
        })
      ).status,
      200,
    );
    const duplicate = await request("/api/customer/register", {
      method: "POST",
      body: {
        email: "NEWCUSTOMER@example.invalid",
        password: "very-strong-customer-password",
      },
      headers: { "X-RIO-Customer": "1" },
    });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.code, "EMAIL_IN_USE");
    assert.equal(duplicate.cookie, undefined);
    assert.equal(
      (
        await request("/api/customer/logout", {
          method: "POST",
          cookie: registration.cookie,
          headers: { "X-CSRF-Token": registration.body.data.csrfToken },
        })
      ).status,
      200,
    );
    assert.equal((await request("/api/customer/session")).status, 401);
    assert.equal(
      (
        await request("/api/customer/login", {
          method: "POST",
          body: { email, password },
          headers: { "X-RIO-Customer": "1" },
          requestOrigin: "https://attacker.invalid",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request("/api/customer/login", {
          method: "POST",
          body: { email, password },
        })
      ).status,
      403,
    );
    const signed = await request("/api/customer/login", {
      method: "POST",
      body: { email, password },
      headers: { "X-RIO-Customer": "1" },
    });
    assert.equal(signed.status, 200);
    assert.deepEqual(Object.keys(signed.body.data).sort(), [
      "csrfToken",
      "expiresAt",
      "user",
    ]);
    assert.deepEqual(signed.body.data.user, { id: user.id, email });
    assert.match(signed.headers.get("set-cookie"), /HttpOnly/i);
    assert.match(signed.headers.get("set-cookie"), /SameSite=Lax/i);
    assert.equal(
      (await request("/api/customer/session", { cookie: signed.cookie }))
        .status,
      200,
    );
    assert.equal(
      (
        await request("/api/customer/logout", {
          method: "POST",
          cookie: signed.cookie,
          headers: { "X-CSRF-Token": "wrong" },
        })
      ).status,
      403,
    );
    assert.equal(
      (await request("/api/customer/session", { cookie: signed.cookie }))
        .status,
      200,
    );
    assert.equal(
      (
        await request("/api/customer/logout", {
          method: "POST",
          cookie: signed.cookie,
          headers: { "X-CSRF-Token": signed.body.data.csrfToken },
        })
      ).status,
      200,
    );
    assert.equal(
      (await request("/api/customer/session", { cookie: signed.cookie }))
        .status,
      401,
    );
  },
);
