import { PriceAdministrationError } from "./pricesError.js";
import { requireStaffPermission } from "../staff/staffAccess.js";

const MAX_AMOUNT_CENTS = 2147483647;
export const calculateChildAmountCents = (adultAmountCents) =>
  Math.ceil(adultAmountCents / 2);

export function parsePriceUpdateInput(body) {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some(
      (key) => !["category", "amountCents", "expectedVersion"].includes(key),
    )
  ) {
    throw new PriceAdministrationError(
      400,
      "INVALID_PRICE_REQUEST",
      "Only category, amountCents and expectedVersion are allowed",
    );
  }
  if (body.category !== "adult") {
    throw new PriceAdministrationError(
      400,
      "INVALID_PRICE_CATEGORY",
      "Only the global adult price can be edited; child prices are derived",
    );
  }
  if (
    !Number.isInteger(body.amountCents) ||
    body.amountCents <= 0 ||
    body.amountCents > MAX_AMOUNT_CENTS
  ) {
    throw new PriceAdministrationError(
      400,
      "INVALID_PRICE_REQUEST",
      `amountCents must be a positive EUR integer between 1 and ${MAX_AMOUNT_CENTS}`,
    );
  }
  // Revision zero explicitly initializes an unconfigured adult setting.
  if (
    !Number.isInteger(body.expectedVersion) ||
    body.expectedVersion < 0 ||
    body.expectedVersion > MAX_AMOUNT_CENTS
  ) {
    throw new PriceAdministrationError(
      400,
      "INVALID_PRICE_REQUEST",
      "expectedVersion is required: use the current adult revision, or zero to initialize",
    );
  }
  return {
    category: "adult",
    amountCents: body.amountCents,
    expectedVersion: body.expectedVersion,
  };
}

export function assertAuthorizedPriceManager(req) {
  return requireStaffPermission(req?.staffActor, "prices:write");
}

export function createPricesService(repository) {
  function project(rows, staff = false) {
    const adult = rows.find((row) => row.category === "adult");
    if (!adult) return [];
    const data = [
      { ...adult, category: "adult" },
      {
        ...adult,
        category: "child",
        amount_cents: calculateChildAmountCents(adult.amount_cents),
      },
    ];
    return data.map((row) => ({
      id: row.id,
      category: row.category,
      amount_cents: row.amount_cents,
      ...(staff
        ? {
            version: row.version,
            updated_at: row.updated_at,
            updated_by_user_id: row.updated_by_user_id,
            updated_by_email: row.updated_by_email,
          }
        : {}),
    }));
  }
  return {
    async listPrices() {
      return project(await repository.listPrices());
    },
    async listStaffPrices(req) {
      assertAuthorizedPriceManager(req);
      return project(await repository.listPrices(), true);
    },
    async setPrice(body, req) {
      const actor = assertAuthorizedPriceManager(req);
      const input = parsePriceUpdateInput(body);
      return repository.transaction(async (tx) => {
        const current = await tx.findByCategoryForUpdate("adult");
        if ((current?.version ?? 0) !== input.expectedVersion) {
          throw new PriceAdministrationError(
            409,
            "STALE_PRICE_EDIT",
            "Price settings changed. Reload and review before saving again",
          );
        }
        const primary = await tx.upsertCategoryPrice(
          "adult",
          input.amountCents,
          { userId: actor.userId },
        );
        const updated = project([primary], true);
        return {
          category: "adult",
          amountCents: primary.amount_cents,
          version: primary.version,
          updatedAt: primary.updated_at,
          updatedBy: {
            userId: primary.updated_by_user_id,
            email: primary.updated_by_email,
          },
          updated,
        };
      });
    },
  };
}
