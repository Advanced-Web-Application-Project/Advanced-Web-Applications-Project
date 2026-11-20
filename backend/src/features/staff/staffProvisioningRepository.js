import { assertConnectedLocalTarget } from "../../../scripts/database/connection.js";
import { StaffProvisioningError } from "./staffProvisioningError.js";

const fields = "id, role, permitted_city_id, is_enabled, session_version";

export function createStaffProvisioningRepository(pool, { database }) {
  return {
    async transaction(run) {
      const client = await pool.connect();
      try {
        await assertConnectedLocalTarget(client, database);
        await client.query("BEGIN");
        await client.query("SET LOCAL search_path = public, pg_catalog");
        await client.query("SET LOCAL lock_timeout = '5s'");
        await client.query("SET LOCAL statement_timeout = '10s'");
        // Same lock as migrations/fixture management; reruns and resets serialize.
        await client.query("SELECT pg_advisory_xact_lock(7420839)");
        const applied = await client.query(
          "SELECT name FROM rio_schema_migrations WHERE name='0009_staff_identity.sql'",
        );
        if (!applied.rows.length)
          throw new StaffProvisioningError(
            "Apply migration 0009_staff_identity.sql to the selected local database first.",
          );
        const result = await run({
          async findByEmail(email) {
            return (
              await client.query(
                `SELECT ${fields} FROM users WHERE login_email=lower(btrim($1)) FOR UPDATE`,
                [email],
              )
            ).rows[0];
          },
          async findCityId(name) {
            return (
              (
                await client.query(
                  "SELECT id FROM cities WHERE name=$1 FOR KEY SHARE",
                  [name],
                )
              ).rows[0]?.id ?? null
            );
          },
          async insertStaff(email, role, cityId, hash) {
            return (
              await client.query(
                `INSERT INTO users(email,role,permitted_city_id,password_hash,provisioned_at,credentials_changed_at)
              VALUES($1,$2,$3,$4,clock_timestamp(),clock_timestamp()) RETURNING ${fields}`,
                [email, role, cityId, hash],
              )
            ).rows[0];
          },
          async resetPassword(id, hash) {
            return (
              await client.query(
                `UPDATE users SET password_hash=$2 WHERE id=$1 RETURNING ${fields}`,
                [id, hash],
              )
            ).rows[0];
          },
          async disable(id) {
            return (
              await client.query(
                `UPDATE users SET is_enabled=false WHERE id=$1 RETURNING ${fields}`,
                [id],
              )
            ).rows[0];
          },
        });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
