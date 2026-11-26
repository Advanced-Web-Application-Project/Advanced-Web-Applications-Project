import {
  assertIsolatedDevelopment,
  assertConnectedLocalTarget,
  createClient,
  DatabaseCommandError,
} from "./connection.js";
export async function seedDemoPrices({ databaseUrl, mode }) {
  const database = assertIsolatedDevelopment(databaseUrl, mode),
    client = createClient(databaseUrl);
  try {
    await client.connect();
    await assertConnectedLocalTarget(client, database);
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(7420839)");
    for (const [category, amount] of [
      ["adult", 1200],
      ["child", 600],
    ]) {
      const rows = (
        await client.query(
          "SELECT id,amount_cents FROM prices WHERE category=$1 AND is_current ORDER BY id FOR UPDATE",
          [category],
        )
      ).rows;
      if (rows.length > 1 || rows.some((row) => row.amount_cents !== amount))
        throw new DatabaseCommandError(
          "Existing prices differ from the approved local demo defaults; no prices were changed",
        );
      if (!rows.length)
        await client.query(
          "INSERT INTO prices(category,amount_cents) VALUES($1,$2)",
          [category, amount],
        );
    }
    await client.query("COMMIT");
    return { currency: "EUR", adultCents: 1200, childCents: 600 };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}
