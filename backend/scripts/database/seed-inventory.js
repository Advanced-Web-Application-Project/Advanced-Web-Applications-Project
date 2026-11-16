import {
  CITY_NAMES,
  SCREEN_CAPACITIES,
} from "../../../database/seeds/browsing.js";
import { generateScreenInventory } from "../../../database/seeds/inventory.js";
import {
  assertIsolatedDevelopment,
  assertConnectedLocalTarget,
  createClient,
  DatabaseCommandError,
} from "./connection.js";

export async function seedInventory({ databaseUrl, mode }) {
  const database = assertIsolatedDevelopment(databaseUrl, mode);
  const client = createClient(databaseUrl);
  try {
    await client.connect();
    await assertConnectedLocalTarget(client, database);
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SET LOCAL search_path = public, pg_catalog");
    await client.query("SELECT pg_advisory_xact_lock(7420839)");
    const ledger = (
      await client.query(
        "SELECT to_regclass('public.rio_schema_migrations') AS name",
      )
    ).rows[0].name;
    if (
      !ledger ||
      !(
        await client.query(
          "SELECT 1 FROM public.rio_schema_migrations WHERE name = '0004_screen_inventory.sql'",
        )
      ).rowCount
    )
      throw new DatabaseCommandError(
        "Apply db:migrate:dev before seeding inventory",
      );
    const screens = (
      await client.query(
        `
      SELECT s.id, s.capacity, s.wheelchair_capacity, c.name AS city
      FROM public.screens s JOIN public.cities c ON c.id = s.city_id
      WHERE c.name = ANY($1::text[]) ORDER BY s.id FOR NO KEY UPDATE OF s
    `,
        [CITY_NAMES],
      )
    ).rows;
    for (const city of CITY_NAMES)
      for (const capacity of SCREEN_CAPACITIES)
        if (
          screens.filter((s) => s.city === city && s.capacity === capacity)
            .length !== 1
        )
          throw new DatabaseCommandError(
            "Expected exactly one screen per city/capacity; inspect browsing fixtures before seeding inventory",
          );
    const result = [];
    for (const screen of screens) {
      if (screen.wheelchair_capacity !== 10)
        throw new DatabaseCommandError(
          "Expected ten separate wheelchair spaces",
        );
      const expected = generateScreenInventory(screen.capacity);
      const existing = (
        await client.query(
          "SELECT * FROM public.seats WHERE screen_id = $1 ORDER BY id FOR UPDATE",
          [screen.id],
        )
      ).rows;
      // Never repair conflicting identities or overwrite booked place meanings.
      for (const place of existing) {
        const target = expected.find(
          (e) =>
            e.is_wheelchair === place.is_wheelchair &&
            e.seat_label === place.seat_label,
        );
        if (
          !target ||
          Object.keys(target).some((key) => target[key] !== place[key])
        )
          throw new DatabaseCommandError(
            "Existing inventory conflicts with approved layout; no inventory was changed",
          );
      }
      for (const place of expected) {
        if (
          existing.some(
            (e) =>
              e.is_wheelchair === place.is_wheelchair &&
              e.seat_label === place.seat_label,
          )
        )
          continue;
        await client.query(
          `
          INSERT INTO public.seats (screen_id, physical_row, row_label, seat_label, is_wheelchair, is_ceo_reserved)
          VALUES ($1,$2,$3,$4,$5,$6)
        `,
          [
            screen.id,
            place.physical_row,
            place.row_label,
            place.seat_label,
            place.is_wheelchair,
            place.is_ceo_reserved,
          ],
        );
      }
      const count = (
        await client.query(
          "SELECT count(*)::int AS count FROM public.seats WHERE screen_id = $1",
          [screen.id],
        )
      ).rows[0].count;
      if (count !== screen.capacity + 10)
        throw new DatabaseCommandError(
          "Inventory verification failed; transaction rolled back",
        );
      result.push({
        ...screen,
        seated: screen.capacity,
        wheelchair: 10,
        inserted: count - existing.length,
      });
    }
    await client.query("COMMIT");
    return { screens: result };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}
