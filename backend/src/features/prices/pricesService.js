import { PriceAdministrationError } from "./pricesError.js";
import { requireStaffPermission } from "../staff/staffAccess.js";
import { StaffAuthError } from "../staff/staffAuthError.js";

export const PRICE_CATEGORIES = ["adult", "child", "company"];

const MAX_AMOUNT_CENTS = 2147483647;

export function calculateChildAmountCents(adultAmountCents) {
  return Math.ceil(adultAmountCents / 2);
}

export function parsePriceUpdateInput(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new PriceAdministrationError(
      400,
      "INVALID_PRICE_REQUEST",
      "Request must be a JSON object with category and amountCents",
    );
  }

  const unexpectedKeys = Object.keys(body).filter(
    (key) => !["category", "amountCents", "expectedVersion"].includes(key),
  );
  if (unexpectedKeys.length > 0) {
    throw new PriceAdministrationError(
      400,
      "INVALID_PRICE_REQUEST",
      "Only category, amountCents and expectedVersion are allowed",
    );
  }

  if (
    typeof body.category !== "string" ||
    !PRICE_CATEGORIES.includes(body.category)
  ) {
    throw new PriceAdministrationError(
      400,
      "INVALID_PRICE_CATEGORY",
      "Category must be one of adult, child or company",
    );
  }

  if (
    typeof body.amountCents !== "number" ||
    !Number.isInteger(body.amountCents) ||
    body.amountCents <= 0 ||
    body.amountCents > MAX_AMOUNT_CENTS
  ) {
    throw new PriceAdministrationError(
      400,
      "INVALID_PRICE_REQUEST",
      `amountCents must be a positive integer between 1 and ${MAX_AMOUNT_CENTS}`,
    );
  }

  if (
    body.expectedVersion !== undefined &&
    (typeof body.expectedVersion !== "number" ||
      !Number.isInteger(body.expectedVersion) ||
      body.expectedVersion <= 0)
  ) {
    throw new PriceAdministrationError(
      400,
      "INVALID_PRICE_REQUEST",
      "expectedVersion must be a positive integer",
    );
  }

  return {
    category: body.category,
    amountCents: body.amountCents,
    expectedVersion: body.expectedVersion,
  };
}

export const parcePriceUpdateInput = parsePriceUpdateInput;

export function assertAuthorizedPriceManager(req) {
  if (req?.body && Object.hasOwn(req.body, "role")) {
    throw new PriceAdministrationError(
      403,
      "FORBIDDEN_ROLE_OVERRIDE",
      "Role cannot be supplied in the request body",
    );
  }

  if (req?.staffActor) {
    if (req.staffActor.is_enabled === false || req.staffActor.isEnabled === false) {
      throw new PriceAdministrationError(
        403,
        "PRICE_ADMIN_REQUIRED",
        "Administrator authorization is required to manage prices",
      );
    }
    try {
      requireStaffPermission(req.staffActor, "prices:write");
    } catch (error) {
      if (error instanceof StaffAuthError) {
        throw new PriceAdministrationError(
          error.status,
          error.code,
          error.message,
        );
      }
      throw error;
    }
    if (req.staffActor.role !== "administrator") {
      throw new PriceAdministrationError(
        403,
        "PRICE_ADMIN_REQUIRED",
        "Administrator authorization is required to manage prices",
      );
    }
    return;
  }

  if (
    !req?.user ||
    req.user.is_enabled === false ||
    req.user.role !== "administrator"
  ) {
    throw new PriceAdministrationError(
      403,
      "PRICE_ADMIN_REQUIRED",
      "Administrator authorization is required to manage prices",
    );
  }
}

export function createPricesService(repository) {
  return {
    async listPrices() {
      return repository.listPrices();
    },

    async setPrice(body, req) {
      assertAuthorizedPriceManager(req);
      const input = parsePriceUpdateInput(body);
      const actor = {
        userId: req?.staffActor?.userId ?? req?.user?.id ?? null,
        email: req?.staffActor?.email ?? req?.user?.email ?? null,
      };

      return repository.transaction(async (tx) => {
        if (input.expectedVersion !== undefined) {
          const current = await tx.findByCategoryForUpdate(input.category);
          if (!current || current.version !== input.expectedVersion) {
            throw new PriceAdministrationError(
              409,
              "STALE_PRICE_EDIT",
              "Price was modified by another update. Reload and retry",
            );
          }
        }

        const updated = [];
        const primary = await tx.upsertCategoryPrice(
          input.category,
          input.amountCents,
          actor,
        );
        updated.push(primary);

        if (input.category === "adult") {
          const childPriceCents = calculateChildAmountCents(input.amountCents);
          const childRow = await tx.upsertCategoryPrice(
            "child",
            childPriceCents,
            actor,
          );
          updated.push(childRow);
        }

        return {
          category: primary.category,
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