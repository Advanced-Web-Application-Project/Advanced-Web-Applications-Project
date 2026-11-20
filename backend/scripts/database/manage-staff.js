import { createDatabasePool } from "../../src/config/database.js";
import { createStaffProvisioningRepository } from "../../src/features/staff/staffProvisioningRepository.js";
import {
  createStaffProvisioningService,
  validateStaffCommand,
} from "../../src/features/staff/staffProvisioningService.js";
import { STAFF_PASSWORD_PATTERN } from "../../src/features/staff/staffPassword.js";
import { assertIsolatedDevelopment, createClient } from "./connection.js";

export async function manageStaff({ databaseUrl, mode, input, readPassword }) {
  const request = validateStaffCommand(input);
  const database = assertIsolatedDevelopment(databaseUrl, mode);
  const pool = createDatabasePool({ databaseUrl });
  try {
    const repository = createStaffProvisioningRepository(pool, { database });
    return await createStaffProvisioningService(repository).manage(
      request,
      readPassword,
    );
  } finally {
    await pool.end();
  }
}

// This audit also works before migration 0009 and never returns contacts/hashes.
export async function auditStaff({ databaseUrl }) {
  const client = createClient(databaseUrl);
  try {
    await client.connect();
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL statement_timeout='10s'");
    await client.query("SET LOCAL search_path=public,pg_catalog");
    const invalidScope = (
      await client.query(`SELECT id FROM users
      WHERE NOT ((role='cashier' AND permitted_city_id IS NOT NULL)
      OR (role IN ('administrator','customer') AND permitted_city_id IS NULL)) ORDER BY id`)
    ).rows;
    const invalidEmail = (
      await client.query(`SELECT id FROM users WHERE length(lower(btrim(email)))>254
      OR lower(btrim(email)) !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' ORDER BY id`)
    ).rows;
    const duplicates = (
      await client.query(`SELECT array_agg(id ORDER BY id) AS user_ids FROM users
      GROUP BY lower(btrim(email)) HAVING count(*)>1 ORDER BY min(id)`)
    ).rows;
    const needsCredentialReset = (
      await client.query(
        "SELECT id FROM users WHERE role IN ('administrator','cashier') AND password_hash !~ $1 ORDER BY id",
        [STAFF_PASSWORD_PATTERN.source],
      )
    ).rows;
    const settings = (
      await client.query(
        "SELECT current_setting('transaction_read_only') AS read_only",
      )
    ).rows[0];
    const ledger = (
      await client.query(
        "SELECT to_regclass('public.rio_schema_migrations') AS name",
      )
    ).rows[0].name;
    const migrations = ledger
      ? (
          await client.query(
            "SELECT name FROM rio_schema_migrations ORDER BY name",
          )
        ).rows.map((r) => r.name)
      : [];
    await client.query("COMMIT");
    return {
      readOnly: settings.read_only === "on",
      migrations,
      invalidScopeUserIds: invalidScope.map((r) => r.id),
      invalidEmailUserIds: invalidEmail.map((r) => r.id),
      duplicateLoginGroups: duplicates.map((r) => r.user_ids),
      staffNeedingCredentialResetIds: needsCredentialReset.map((r) => r.id),
    };
  } finally {
    await client.end();
  }
}
