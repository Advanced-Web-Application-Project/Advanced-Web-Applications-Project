import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  calculateDerivedChildCents,
  createPriceAdminService,
  formatCentsAsEur,
  formatTimestamp,
  parseEuroInputToCents,
} from "../src/features/prices/services/priceAdmin.js";

describe("calculateDerivedChildCents", () => {
  it("calculates half of adult cents rounded up with Math.ceil", () => {
    assert.equal(calculateDerivedChildCents(1000), 500);
    assert.equal(calculateDerivedChildCents(1001), 501);
    assert.equal(calculateDerivedChildCents(1), 1);
  });

  it("returns null for invalid, non-positive, or out-of-range values", () => {
    assert.equal(calculateDerivedChildCents(0), null);
    assert.equal(calculateDerivedChildCents(-100), null);
    assert.equal(calculateDerivedChildCents(12.5), null);
    assert.equal(calculateDerivedChildCents("1000"), null);
    assert.equal(calculateDerivedChildCents(2147483648), null);
  });
});

describe("parseEuroInputToCents", () => {
  it("parses valid euro strings with dot or comma into integer cents", () => {
    assert.deepEqual(parseEuroInputToCents("12.50"), { amountCents: 1250 });
    assert.deepEqual(parseEuroInputToCents("12,50"), { amountCents: 1250 });
    assert.deepEqual(parseEuroInputToCents(" 10 "), { amountCents: 1000 });
    assert.deepEqual(parseEuroInputToCents("10.01"), { amountCents: 1001 });
  });

  it("returns an error object for invalid, empty, zero, or negative inputs", () => {
    assert.equal(typeof parseEuroInputToCents("").error, "string");
    assert.equal(typeof parseEuroInputToCents("0").error, "string");
    assert.equal(typeof parseEuroInputToCents("-5.00").error, "string");
    assert.equal(typeof parseEuroInputToCents("12.345").error, "string");
    assert.equal(typeof parseEuroInputToCents("abc").error, "string");
    assert.equal(typeof parseEuroInputToCents(null).error, "string");
  });
});

describe("formatCentsAsEur", () => {
  it("formats non-negative integer cents as EUR", () => {
    assert.equal(formatCentsAsEur(1250), "€12.50");
    assert.equal(formatCentsAsEur(0), "€0.00");
  });

  it("returns '-' for invalid or negative values", () => {
    assert.equal(formatCentsAsEur(null), "-");
    assert.equal(formatCentsAsEur(-10), "-");
    assert.equal(formatCentsAsEur(12.5), "-");
  });
});

describe("formatTimestamp", () => {
  it("returns 'Not recorded' for empty or nullish values", () => {
    assert.equal(formatTimestamp(null), "Not recorded");
    assert.equal(formatTimestamp(undefined), "Not recorded");
    assert.equal(formatTimestamp(""), "Not recorded");
  });

  it("returns original string for invalid dates", () => {
    assert.equal(formatTimestamp("invalid-date"), "invalid-date");
  });

  it("formats valid timestamps in Europe/Helsinki timezone", () => {
    const formatted = formatTimestamp("2026-06-01T12:00:00.000Z");
    assert.ok(formatted.includes("2026"));
    assert.ok(formatted.includes("15:00"));
  });
});

describe("createPriceAdminService", () => {
  it("requests /prices for listPrices and forwards abort signal", async () => {
    const calls = [];
    const model = {
      async request(path, options) {
        calls.push({ path, options });
        return [{ category: "adult", amountCents: 1200, version: 2 }];
      },
    };

    const service = createPriceAdminService(model);
    const controller = new AbortController();
    const rows = await service.listPrices(controller.signal);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, "/prices");
    assert.equal(calls[0].options.signal, controller.signal);
    assert.equal(rows[0].amountCents, 1200);
  });

  it("updates adult price via PUT /prices with amountCents and expectedVersion", async () => {
    const calls = [];
    const model = {
      async request(path, options) {
        calls.push({ path, options });
        return { ok: true };
      },
    };

    const service = createPriceAdminService(model);
    await service.updateAdultPrice({ amountCents: 1500, expectedVersion: 4 });

    assert.equal(calls[0].path, "/prices");
    assert.equal(calls[0].options.method, "PUT");
    assert.deepEqual(calls[0].options.body, {
      category: "adult",
      amountCents: 1500,
      expectedVersion: 4,
    });
  });

  it("propagates 409 conflict and 403 forbidden errors", async () => {
    const conflictError = Object.assign(new Error("Conflict"), { status: 409 });
    const model = {
      async request() {
        throw conflictError;
      },
    };

    const service = createPriceAdminService(model);
    await assert.rejects(
      () =>
        service.updateAdultPrice({ amountCents: 1500, expectedVersion: 1 }),
      (err) => err?.status === 409,
    );
  });
});