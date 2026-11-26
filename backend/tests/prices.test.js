import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateChildAmountCents,
  parsePriceUpdateInput,
  assertAuthorizedPriceManager,
  createPricesService,
} from "../src/features/prices/pricesService.js";
import { createStaffActor } from "../src/features/staff/staffAccess.js";

const admin = {
  staffActor: createStaffActor({ id: 10, role: "administrator" }),
};
test("adult-only EUR cents require an explicit revision, including initialization zero", () => {
  for (const amountCents of [1, 1201, 2147483647]) {
    assert.deepEqual(
      parsePriceUpdateInput({
        category: "adult",
        amountCents,
        expectedVersion: 0,
      }),
      { category: "adult", amountCents, expectedVersion: 0 },
    );
  }
  assert.equal(calculateChildAmountCents(1201), 601);
  assert.equal(calculateChildAmountCents(1), 1);
  for (const body of [
    null,
    [],
    {},
    { category: "child", amountCents: 1, expectedVersion: 1 },
    { category: "company", amountCents: 1, expectedVersion: 1 },
    ...[0, -1, 1.5, "1200", null, NaN, Infinity, 2147483648].map(
      (amountCents) => ({ category: "adult", amountCents, expectedVersion: 1 }),
    ),
    ...[undefined, null, -1, 1.5, "1", 2147483648].map((expectedVersion) => ({
      category: "adult",
      amountCents: 1200,
      expectedVersion,
    })),
    {
      category: "adult",
      amountCents: 1200,
      expectedVersion: 1,
      currency: "USD",
    },
  ]) {
    assert.throws(() => parsePriceUpdateInput(body), { status: 400 });
  }
});
test("only trusted administrator actors can read or write administrative settings", () => {
  assert.doesNotThrow(() => assertAuthorizedPriceManager(admin));
  for (const req of [
    undefined,
    {},
    { user: { role: "administrator" } },
    { staffActor: { role: "administrator", userId: 10 } },
    {
      staffActor: createStaffActor({
        id: 11,
        role: "cashier",
        permitted_city_id: 1,
      }),
    },
    { staffActor: createStaffActor({ id: 12, role: "customer" }) },
  ]) {
    assert.throws(() => assertAuthorizedPriceManager(req), { status: 403 });
  }
});
test("public and protected reads derive child prices from the adult row and redact public audits", async () => {
  const service = createPricesService({
    listPrices: async () => [
      { id: 3, category: "company", amount_cents: 10, version: 9 },
      {
        id: 1,
        category: "adult",
        amount_cents: 1201,
        version: 4,
        updated_by_user_id: 10,
        updated_by_email: "fixture@example.invalid",
      },
      { id: 2, category: "child", amount_cents: 1, version: 2 },
    ],
  });
  assert.deepEqual(await service.listPrices(), [
    { id: 1, category: "adult", amount_cents: 1201 },
    { id: 1, category: "child", amount_cents: 601 },
  ]);
  const staff = await service.listStaffPrices(admin);
  assert.equal(staff[0].version, 4);
  assert.equal(staff[1].amount_cents, 601);
  await assert.rejects(service.listStaffPrices({}), { status: 403 });
});
test("updates check adult revision under transaction and initialize only when unconfigured", async () => {
  let row = null,
    writes = 0;
  const service = createPricesService({
    transaction: async (run) =>
      run({
        findByCategoryForUpdate: async (category) => {
          assert.equal(category, "adult");
          return row;
        },
        upsertCategoryPrice: async (category, amount, actor) => {
          writes++;
          assert.equal(actor.userId, 10);
          row = {
            id: 1,
            category,
            amount_cents: amount,
            version: (row?.version ?? 0) + 1,
            updated_by_user_id: actor.userId,
          };
          return row;
        },
      }),
  });
  const first = await service.setPrice(
    { category: "adult", amountCents: 1201, expectedVersion: 0 },
    admin,
  );
  assert.equal(first.updated[1].amount_cents, 601);
  for (const expectedVersion of [0, 2])
    await assert.rejects(
      service.setPrice(
        { category: "adult", amountCents: 1400, expectedVersion },
        admin,
      ),
      { code: "STALE_PRICE_EDIT" },
    );
  assert.equal(writes, 1);
  const next = await service.setPrice(
    { category: "adult", amountCents: 1400, expectedVersion: 1 },
    admin,
  );
  assert.equal(next.version, 2);
});
