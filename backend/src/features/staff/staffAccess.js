import { StaffAuthError } from "./staffAuthError.js";

const actors = new WeakSet();
const administrator = new Set([
  "bookings:read",
  "screenings:read",
  "films:write",
  "screenings:write",
  "prices:write",
  "reservations:create",
]);
const cashier = new Set([
  "bookings:read",
  "screenings:read",
  "reservations:create",
]);

// Call only with a current, server-loaded and session-validated identity.
export function createStaffActor(row) {
  const actor = Object.freeze({
    userId: row.id,
    role: row.role,
    cityId: row.permitted_city_id,
    sessionVersion: row.session_version,
    checkedAt: row.as_of,
  });
  actors.add(actor);
  return actor;
}

export function requireStaffPermission(actor, permission, { cityId } = {}) {
  const permissions = actor?.role === "administrator" ? administrator : cashier;
  if (
    !actor ||
    !actors.has(actor) ||
    !permissions.has(permission) ||
    (actor.role !== "administrator" &&
      (actor.role !== "cashier" || !Number.isInteger(actor.cityId))) ||
    (actor.role === "cashier" &&
      cityId !== undefined &&
      cityId !== actor.cityId)
  )
    throw new StaffAuthError(
      403,
      "STAFF_FORBIDDEN",
      "This staff action is not permitted.",
    );
  return actor;
}
