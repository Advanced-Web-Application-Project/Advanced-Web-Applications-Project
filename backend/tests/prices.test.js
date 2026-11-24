import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateChildAmountCents,
  parcePriceUpdateInput,
  assertAuthorizedPriceManager,
  createPricesService,
} from "../src/features/prices/pricesService.js";

test("calculateChildAmountCents rounds odd adult cents up to half", () => {
  assert.equal(calculateChildAmountCents(1201), 601);
  assert.equal(calculateChildAmountCents(1), 1);
  assert.equal(calculateChildAmountCents(1200), 600);
});

test("parcePriceUpdateInput accepts valid categories and integer cents within bounds", () => {
  for (const category of ["adult", "child", "company"]) {
    assert.deepEqual(parcePriceUpdateInput({ category, amountCents: 1201 }), {
      category,
      amountCents: 1201,
      expectedVersion: undefined,
    });
  }
  assert.deepEqual(
    parcePriceUpdateInput({ category: "adult", amountCents: 2147483647 }),
    { category: "adult", amountCents: 2147483647, expectedVersion: undefined },
  );
  assert.deepEqual(
    parcePriceUpdateInput({
      category: "adult",
      amountCents: 1201,
      expectedVersion: 2,
    }),
    { category: "adult", amountCents: 1201, expectedVersion: 2 },
  );
});

test("parcePriceUpdateInput rejects malformed inputs, invalid categories and out-of-range amounts", () => {
  const invalidBodies = [
    null,
    undefined,
    [],
    "adult",
    1200,
    {},
    { category: "adult" },
    { amountCents: 1200 },
    { category: "adult", amountCents: 1200, extra: true },
    { category: "student", amountCents: 1200 },
    { category: "ADULT", amountCents: 1200 },
    { category: "", amountCents: 1200 },
    { category: "adult", amountCents: 0 },
    { category: "adult", amountCents: -100 },
    { category: "adult", amountCents: 12.5 },
    { category: "adult", amountCents: "1200" },
    { category: "adult", amountCents: null },
    { category: "adult", amountCents: NaN },
    { category: "adult", amountCents: Infinity },
    { category: "adult", amountCents: 2147483648 },
  ];

  for (const body of invalidBodies) {
    assert.throws(() => parcePriceUpdateInput(body), {
      status: 400,
    });
  }
});

test("assertAuthorizedPriceManager allows only active administrator without role override", () => {
  assert.doesNotThrow(() =>
    assertAuthorizedPriceManager({
      user: { role: "administrator", is_enabled: true },
      body: { category: "adult", amountCents: 1201 },
    }),
  );

  for (const req of [
    undefined,
    null,
    {},
    { user: null },
    { user: { role: "cashier", is_enabled: true } },
    { user: { role: "customer", is_enabled: true } },
    { user: { role: "administrator", is_enabled: false } },
    {
      user: { role: "administrator", is_enabled: true },
      body: { category: "adult", amountCents: 1201, role: "administrator" },
    },
    {
      staffActor: {
        userId: 2,
        email: "cashier@example.invalid",
        role: "cashier",
        is_enabled: true,
        permissions: ["prices:write"],
      },
      body: { category: "adult", amountCents: 1201 },
    },
    {
      staffActor: {
        userId: 3,
        email: "customer@example.invalid",
        role: "customer",
        is_enabled: true,
      },
      body: { category: "adult", amountCents: 1201 },
    },
    {
      staffActor: {
        userId: 1,
        email: "admin@example.invalid",
        role: "administrator",
        is_enabled: false,
      },
      body: { category: "adult", amountCents: 1201 },
    },
  ]) {
    assert.throws(() => assertAuthorizedPriceManager(req), {
      status: 403,
    });
  }
});

test("createPricesService updates adult price and derives child price (1201 -> 601) inside a transaction", async () => {
  const rows = new Map([
    ["adult", { id: 1, category: "adult", amount_cents: 1200, version: 1 }],
    ["child", { id: 2, category: "child", amount_cents: 600, version: 1 }],
  ]);
  let txCount = 0;

  const repo = {
    async listPrices() {
      return [...rows.values()];
    },
    async transaction(fn) {
      txCount += 1;
      const tx = {
        async findByCategoryForUpdate(category) {
          return rows.get(category) ?? null;
        },
        async upsertCategoryPrice(category, amountCents, actor) {
          const current = rows.get(category) ?? {
            id: rows.size + 1,
            category,
            version: 0,
          };
          const next = {
            ...current,
            amount_cents: amountCents,
            version: current.version + 1,
            updated_at: "2026-11-24T13:00:00.000Z",
            updated_by_user_id: actor?.userId ?? null,
            updated_by_email: actor?.email ?? null,
          };
          rows.set(category, next);
          return next;
        },
      };
      return fn(tx);
    },
  };

  const service = createPricesService(repo);
  const adminReq = {
    user: {
      id: 10,
      email: "admin@example.invalid",
      role: "administrator",
      is_enabled: true,
    },
  };

  const result = await service.setPrice(
    { category: "adult", amountCents: 1201 },
    adminReq,
  );

  assert.equal(txCount, 1);
  assert.equal(result.category, "adult");
  assert.equal(result.amountCents, 1201);
  assert.equal(result.version, 2);
  assert.deepEqual(result.updatedBy, {
    userId: 10,
    email: "admin@example.invalid",
  });
  assert.equal(result.updated[0].amount_cents, 1201);
  assert.equal(result.updated[1].amount_cents, 601);
});

test("createPricesService rejects stale expectedVersion with 409 STALE_PRICE_EDIT", async () => {
  const rows = new Map([
    [
      "adult",
      {
        id: 1,
        category: "adult",
        amount_cents: 1200,
        version: 2,
        updated_at: "2026-11-24T12:00:00.000Z",
        updated_by_user_id: 10,
        updated_by_email: "admin@example.invalid",
      },
    ],
  ]);

  const repo = {
    async listPrices() {
      return [...rows.values()];
    },
    async transaction(fn) {
      const tx = {
        async findByCategoryForUpdate(category) {
          return rows.get(category) ?? null;
        },
        async upsertCategoryPrice(category, amountCents, actor) {
          const current = rows.get(category) ?? {
            id: rows.size + 1,
            category,
            version: 0,
          };
          const next = {
            ...current,
            amount_cents: amountCents,
            version: current.version + 1,
            updated_at: "2026-11-24T13:00:00.000Z",
            updated_by_user_id: actor?.userId ?? null,
            updated_by_email: actor?.email ?? null,
          };
          rows.set(category, next);
          return next;
        },
      };
      return fn(tx);
    },
  };

  const service = createPricesService(repo);
  const adminReq = {
    user: {
      id: 10,
      email: "admin@example.invalid",
      role: "administrator",
      is_enabled: true,
    },
  };

  await assert.rejects(
    () =>
      service.setPrice(
        { category: "adult", amountCents: 1500, expectedVersion: 1 },
        adminReq,
      ),
    (error) => error?.status === 409 && error?.code === "STALE_PRICE_EDIT",
  );
});