import assert from "node:assert/strict";
import {
  CITY_NAMES,
  SCREEN_CAPACITIES,
} from "../../../database/seeds/browsing.js";
import { generateScreenInventory } from "../../../database/seeds/inventory.js";
import { createClient, DatabaseCommandError } from "./connection.js";

export async function verifyInventory({ databaseUrl, baseUrl }) {
  const origin = new URL(baseUrl);
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== "/"
  )
    throw new DatabaseCommandError("API_BASE_URL must be an HTTP(S) origin");
  const client = createClient(databaseUrl);
  try {
    await client.connect();
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL statement_timeout = '10s'");
    await client.query("SET LOCAL TIME ZONE 'Europe/Helsinki'");
    const screens = (
      await client.query(
        `
      SELECT s.id, s.capacity, c.id AS city_id, c.name AS city
      FROM public.screens s JOIN public.cities c ON c.id=s.city_id
      WHERE c.name=ANY($1::text[]) ORDER BY s.id
    `,
        [CITY_NAMES],
      )
    ).rows;
    for (const city of CITY_NAMES)
      for (const capacity of SCREEN_CAPACITIES)
        assert.equal(
          screens.filter((s) => s.city === city && s.capacity === capacity)
            .length,
          1,
        );
    const result = [];
    async function get(path) {
      const response = await fetch(origin.origin + path, {
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(response.status, 200, path);
      const body = await response.json();
      assert.equal(body.success, true);
      return body.data;
    }
    for (const screen of screens) {
      const show = (
        await client.query(
          `
        SELECT sc.id, sc.film_id, f.title AS film_title FROM public.screenings sc
        JOIN public.films f ON f.id=sc.film_id
        WHERE sc.screen_id=$1 AND sc.screening_time > localtimestamp ORDER BY sc.screening_time,sc.id LIMIT 1
      `,
          [screen.id],
        )
      ).rows[0];
      assert.ok(
        show,
        "Every screen needs a future screening; run db:seed:browsing",
      );
      const cities = await get("/api/cities");
      assert.ok(
        cities.some((c) => c.id === screen.city_id && c.name === screen.city),
      );
      const rooms = await get(`/api/screens?cityId=${screen.city_id}`);
      assert.ok(
        rooms.some((s) => s.id === screen.id && s.capacity === screen.capacity),
      );
      const shows = await get(
        `/api/screenings?cityId=${screen.city_id}&screenId=${screen.id}&filmId=${show.film_id}`,
      );
      assert.ok(shows.some((s) => s.id === show.id));
      const rows = await get(
        `/api/seats?screenId=${screen.id}&screeningId=${show.id}`,
      );
      const stored = (
        await client.query(
          "SELECT * FROM public.seats WHERE screen_id=$1 ORDER BY id",
          [screen.id],
        )
      ).rows;
      assert.deepEqual(
        rows.map(({ isBooked, isReservedByCeo, ...seat }) => seat),
        stored,
      );
      const expected = generateScreenInventory(screen.capacity);
      assert.equal(rows.length, expected.length);
      for (const place of expected) {
        const found = rows.find(
          (s) =>
            s.is_wheelchair === place.is_wheelchair &&
            s.seat_label === place.seat_label,
        );
        assert.ok(found);
        for (const key of Object.keys(place))
          assert.equal(found[key], place[key], key);
      }
      const counts = await get(
        `/api/seats/availability?screenId=${screen.id}&screeningId=${show.id}`,
      );
      assert.equal(counts.inventory_complete, true);
      assert.deepEqual(counts.seated, {
        total: screen.capacity,
        available: rows.filter((s) => !s.is_wheelchair && !s.isBooked).length,
      });
      assert.deepEqual(counts.wheelchair, {
        total: 10,
        available: rows.filter((s) => s.is_wheelchair && !s.isBooked).length,
      });
      const ceo = (
        await client.query(
          `SELECT b.id AS booking_id,t.seat_id FROM public.bookings b
        JOIN public.tickets t ON t.booking_id=b.id WHERE b.screening_id=$1 AND b.booking_type='ceo'`,
          [show.id],
        )
      ).rows;
      assert.equal(ceo.length, 1);
      assert.ok(
        rows.some(
          (s) =>
            s.id === ceo[0].seat_id &&
            s.display_label === "1" &&
            s.isBooked &&
            s.isReservedByCeo,
        ),
      );
      const seated = rows.filter((s) => !s.is_wheelchair);
      const wheelchair = rows.filter((s) => s.is_wheelchair);
      result.push({
        ...screen,
        screening_id: show.id,
        film_id: show.film_id,
        film_title: show.film_title,
        ceo: ceo[0],
        seated: {
          total: seated.length,
          available: seated.filter((s) => !s.isBooked).length,
        },
        wheelchair: {
          total: wheelchair.length,
          available: wheelchair.filter((s) => !s.isBooked).length,
        },
        row2: seated
          .filter((s) => s.physical_row === 2)
          .sort((a, b) => a.physical_column - b.physical_column)
          .map((s) => s.display_label),
        row13_label:
          seated.find((s) => s.physical_row === 13)?.row_label ?? null,
      });
    }
    await client.query("COMMIT");
    return { readOnly: true, screens: result };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}
