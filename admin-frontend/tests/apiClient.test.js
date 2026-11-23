import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import {
  createApiClient,
  validateApiBase,
} from "../src/shared/services/apiClient.js";
import { response } from "./fixtures/sessionData.js";

test("API origin validation rejects credentials, fragments, overrides and remote plain HTTP", () => {
  assert.equal(validateApiBase("/api"), "/api");
  assert.equal(
    validateApiBase("https://api.example.invalid/api/"),
    "https://api.example.invalid/api",
  );
  for (const value of [
    "//attacker.invalid/api",
    "https://name:secret@example.invalid/api",
    "https://example.invalid/api?token=x",
    "https://example.invalid/api#x",
    "http://remote.invalid/api",
    "/other",
    null,
  ])
    assert.throws(() => validateApiBase(value));
});
test("credentialed JSON transport uses no-store, prevents redirects and sends proper private headers", async () => {
  let captured;
  const secret = randomBytes(24).toString("base64url");
  const client = createApiClient("/api", {
    fetchImpl: async (path, options) => {
      captured = { path, ...options };
      return response({ ok: true });
    },
    getCsrfToken: () => "b".repeat(43),
  });
  await client("/staff/login", {
    method: "POST",
    body: { email: "staff@example.invalid", password: secret },
    csrf: false,
  });
  assert.equal(captured.credentials, "include");
  assert.equal(captured.cache, "no-store");
  assert.equal(captured.redirect, "error");
  assert.equal(captured.headers["X-RIO-Staff"], "1");
  assert.equal(captured.headers["X-CSRF-Token"], undefined);
  assert.ok(JSON.parse(captured.body).password === secret);
  await client("/staff/logout", { method: "POST" });
  assert.ok(captured.headers["X-CSRF-Token"] === "b".repeat(43));
});
test("real HTTP request retains method, JSON and request-verification header semantics", async (t) => {
  let observed;
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    observed = {
      method: req.method,
      body: JSON.parse(text),
      csrf: req.headers["x-csrf-token"],
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, data: { ok: true } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const client = createApiClient(
    `http://127.0.0.1:${server.address().port}/api`,
    { getCsrfToken: () => "c".repeat(43) },
  );
  assert.deepEqual(
    await client("/staff/logout", { method: "POST", body: { reviewed: true } }),
    { ok: true },
  );
  assert.equal(observed.method, "POST");
  assert.deepEqual(observed.body, { reviewed: true });
  assert.ok(observed.csrf === "c".repeat(43));
});
test("401 invalidates identity even for malformed response bodies; 403 does not", async () => {
  let invalidations = 0;
  const client = createApiClient("/api", {
    onUnauthorized: () => invalidations++,
    fetchImpl: async () => ({
      status: 401,
      ok: false,
      json: async () => {
        throw Error("bad JSON");
      },
    }),
  });
  await assert.rejects(client("/bookings"));
  assert.equal(invalidations, 1);
  const forbidden = createApiClient("/api", {
    onUnauthorized: () => invalidations++,
    fetchImpl: async () => response(null, 403),
  });
  await assert.rejects(forbidden("/bookings"), (e) => e.status === 403);
  assert.equal(invalidations, 1);
});
test("timeouts are bounded and cancellation is supported", async () => {
  const client = createApiClient("/api", {
    timeoutMs: 5,
    fetchImpl: async (_path, { signal }) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        ),
      ),
  });
  await assert.rejects(client("/staff/session"), (e) => e.code === "TIMEOUT");
});
