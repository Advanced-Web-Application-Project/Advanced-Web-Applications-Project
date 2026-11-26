import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createSessionModel } from "../src/features/session/services/sessionModel.js";
import { validateSession } from "../src/features/session/services/sessionService.js";
import { safeReturnPath } from "../src/routes/returnPath.js";
import { identity, response, deferred } from "./fixtures/sessionData.js";

test("only the delivered internal return destination is accepted", () => {
  for (const path of [
    undefined,
    null,
    "/",
    "https://attacker.invalid",
    "//attacker.invalid",
    "/\\attacker.invalid",
    "javascript:alert(1)",
    "/films",
    "/screenings?returnTo=https://attacker.invalid",
  ])
    assert.equal(safeReturnPath(path), "/screenings");
  assert.equal(safeReturnPath("/screenings"), "/screenings");
});
test("identity validation accepts both staff roles and rejects inconsistent or malformed identities", () => {
  assert.equal(validateSession(identity()).user.role, "administrator");
  assert.equal(validateSession(identity("cashier")).user.cityId, 7);
  for (const data of [
    null,
    { ...identity(), csrfToken: "invalid" },
    { ...identity(), expiresAt: "invalid" },
    { ...identity(), user: { id: 1, role: "customer", cityId: null } },
    { ...identity(), user: { id: 1, role: "cashier", cityId: null } },
    { ...identity(), user: { id: 1, role: "administrator", cityId: 7 } },
  ])
    assert.throws(() => validateSession(data));
});
test("bootstrap distinguishes anonymous, forbidden and offline without fetching protected data", async () => {
  for (const [status, expected] of [
    [401, "anonymous"],
    [403, "forbidden"],
    [503, "error"],
  ]) {
    let calls = 0;
    const model = createSessionModel({
      fetchImpl: async () => {
        calls++;
        return response(null, status);
      },
    });
    await assert.rejects(model.request("/bookings"));
    assert.equal(calls, 0);
    await model.check();
    assert.equal(model.getSnapshot().status, expected);
    assert.equal(model.getSnapshot().session, null);
    assert.equal(calls, 1);
    model.stop();
  }
});
test("an invalid API origin produces a recoverable blocked state rather than a render exception", async () => {
  const model = createSessionModel({
    baseUrl: "https://private:password@invalid/api",
  });
  await model.check();
  assert.equal(model.getSnapshot().status, "error");
  assert.equal(model.getSnapshot().session, null);
});
test("late session replies cannot restore a prior identity", async () => {
  const old = deferred();
  let calls = 0;
  const model = createSessionModel({
    fetchImpl: async () =>
      ++calls === 1 ? old.promise : response(identity("cashier", 2, 8)),
  });
  const previous = model.check();
  await model.check();
  old.resolve(response(identity()));
  await previous;
  assert.equal(model.getSnapshot().session.user.id, 2);
  model.stop();
});
test("suspension clears identity, aborts in-flight reads and discards a late result", async () => {
  const slow = deferred();
  let signal;
  const model = createSessionModel({
    fetchImpl: async (path, options) => {
      if (path.endsWith("/staff/session")) return response(identity());
      signal = options.signal;
      return slow.promise;
    },
  });
  await model.check();
  const read = model.request("/bookings");
  model.pause();
  assert.equal(model.getSnapshot().session, null);
  assert.equal(signal.aborted, true);
  slow.resolve(response([{ id: 99 }]));
  await assert.rejects(read, { name: "AbortError" });
  model.stop();
});
test("protected 401 clears staff data and never replays the mutation after sign-in", async () => {
  let writes = 0;
  const password = randomBytes(24).toString("base64url");
  const model = createSessionModel({
    fetchImpl: async (path) => {
      if (path.endsWith("/bookings")) {
        writes++;
        return response(null, 401);
      }
      return response(identity());
    },
  });
  await model.check();
  await assert.rejects(
    model.request("/bookings", { method: "POST", body: { screeningId: 3 } }),
  );
  assert.equal(model.getSnapshot().status, "anonymous");
  assert.equal(model.getSnapshot().session, null);
  assert.match(model.getSnapshot().notice, /review your action/);
  await model.signIn("staff@example.invalid", password);
  assert.equal(writes, 1);
  assert.ok(!JSON.stringify(model.getSnapshot()).includes(password));
  model.stop();
});
test("a protected 403 is not misreported as session expiry", async () => {
  const model = createSessionModel({
    fetchImpl: async (path) =>
      path.endsWith("/staff/session")
        ? response(identity())
        : response(null, 403),
  });
  await model.check();
  await assert.rejects(model.request("/bookings"), (e) => e.status === 403);
  assert.equal(model.getSnapshot().status, "authenticated");
  model.stop();
});
test("logout clears staff data before network completion and retries only when explicitly requested", async () => {
  let calls = 0,
    token;
  const model = createSessionModel({
    fetchImpl: async (path, options) => {
      if (path.endsWith("/staff/session")) return response(identity());
      calls++;
      token = options.headers["X-CSRF-Token"];
      if (calls === 1) throw Error("network unavailable");
      return response({ signedOut: true });
    },
  });
  await model.check();
  const pending = model.signOut();
  assert.equal(model.getSnapshot().session, null);
  await pending;
  assert.equal(model.getSnapshot().status, "signOutError");
  assert.equal(calls, 1);
  assert.ok(token === "a".repeat(43));
  await model.signOut();
  assert.equal(calls, 2);
  assert.equal(model.getSnapshot().status, "anonymous");
  model.stop();
});
test("failed logout can be reconciled with server-owned session state", async () => {
  let checks = 0;
  const model = createSessionModel({
    fetchImpl: async (path) => {
      if (path.endsWith("/staff/session"))
        return ++checks === 1 ? response(identity()) : response(null, 401);
      throw Error("lost logout reply");
    },
  });
  await model.check();
  await model.signOut();
  assert.equal(model.getSnapshot().status, "signOutError");
  await model.check();
  assert.equal(model.getSnapshot().status, "anonymous");
  model.stop();
});

test("safe return destinations retain delivered detail/list filters and reject redirect injection", () => {
  for (const path of [
    "/screenings?dateFrom=2030-01-15&dateTo=2030-01-16&cityId=1&screenId=2",
    "/screenings/123?dateFrom=2030-01-15&cityId=1",
  ])
    assert.equal(safeReturnPath(path), path);
  for (const path of [
    "/screenings/0",
    "/screenings/2147483648",
    "/screenings/123/other",
    "/screenings/123?redirect=https://invalid",
    "/screenings?cityId=1&cityId=2",
    "/screenings?cityId=javascript:evil",
    "/screenings#https://invalid",
    "//evil/screenings/1",
  ])
    assert.equal(safeReturnPath(path), "/screenings");
});
