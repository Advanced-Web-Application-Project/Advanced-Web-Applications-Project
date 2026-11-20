export const MAX_DATABASE_ID = 2147483647;

export class DatabaseIdError extends Error {}

export function parseDatabaseId(value, name = "id") {
  if (
    typeof value !== "string" ||
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < 1 ||
    Number(value) > MAX_DATABASE_ID
  ) {
    throw new DatabaseIdError(
      `${name} must be a positive integer between 1 and ${MAX_DATABASE_ID}`,
    );
  }
  return Number(value);
}

export function parseOptionalDatabaseId(query, name) {
  if (Object.keys(query).some((key) => key.startsWith(`${name}[`))) {
    throw new DatabaseIdError(
      `${name} must be a positive integer between 1 and ${MAX_DATABASE_ID}`,
    );
  }
  return query[name] === undefined
    ? undefined
    : parseDatabaseId(query[name], name);
}
