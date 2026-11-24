import {
  parseOptionalDatabaseId,
  DatabaseIdError,
} from "../../utils/databaseId.js";
import { requireStaffPermission } from "../staff/staffAccess.js";
import { StaffAuthError } from "../staff/staffAuthError.js";

export function helsinkiDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Helsinki",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type) => parts.find((part) => part.type === type).value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}
function bad(message) {
  return new StaffAuthError(400, "INVALID_SCREENING_FILTER", message);
}
function date(query, key, fallback) {
  if (Object.keys(query).some((name) => name.startsWith(`${key}[`)))
    throw bad(`${key} must be a calendar date (YYYY-MM-DD).`);
  const value = query[key] === undefined ? fallback : query[key];
  if (
    typeof value !== "string" ||
    !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 10) !== value
  )
    throw bad(`${key} must be a calendar date (YYYY-MM-DD).`);
  return value;
}
export function parseStaffScreeningFilters(query, today = helsinkiDate()) {
  if (
    Object.keys(query).some(
      (key) =>
        !["cityId", "screenId", "dateFrom", "dateTo"].includes(
          key.split("[")[0],
        ),
    )
  )
    throw bad("Unknown screening filter.");
  let cityId, screenId;
  try {
    cityId = parseOptionalDatabaseId(query, "cityId");
    screenId = parseOptionalDatabaseId(query, "screenId");
  } catch (error) {
    if (error instanceof DatabaseIdError) throw bad(error.message);
    throw error;
  }
  const dateFrom = date(query, "dateFrom", today),
    dateTo = date(query, "dateTo", dateFrom);
  const days = (Date.parse(dateTo) - Date.parse(dateFrom)) / 86400000;
  if (days < 0 || days > 30)
    throw bad("Choose an ordered date range of at most 31 days.");
  return { cityId, screenId, dateFrom, dateTo };
}
export function createStaffScreeningsService(repository, cinemas) {
  return {
    async list(query, actor) {
      requireStaffPermission(actor, "screenings:read");
      const filters = parseStaffScreeningFilters(query);
      if (filters.cityId !== undefined)
        requireStaffPermission(actor, "screenings:read", {
          cityId: filters.cityId,
        });
      if (filters.screenId !== undefined) {
        const screen = await cinemas.findScreen(filters.screenId);
        if (!screen)
          throw new StaffAuthError(
            404,
            "SCREEN_NOT_FOUND",
            "Screen was not found.",
          );
        requireStaffPermission(actor, "screenings:read", {
          cityId: screen.city_id,
        });
        if (filters.cityId !== undefined && filters.cityId !== screen.city_id)
          throw bad("Screen must belong to the selected city.");
      }
      if (actor.role === "cashier") filters.cityId = actor.cityId;
      const data = await repository.listStaffScreenings(
        filters,
        actor.role === "cashier" ? actor.cityId : null,
      );
      return {
        ...data,
        filters: {
          ...filters,
          cityId: filters.cityId ?? null,
          screenId: filters.screenId ?? null,
        },
      };
    },
  };
}
