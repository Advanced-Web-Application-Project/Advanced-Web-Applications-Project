import {
  CITY_NAMES,
  SCREEN_CAPACITIES,
} from "../../../database/seeds/browsing.js";
import {
  PRESENTATION_MOVIES,
  PRESENTATION_HOURS,
  PRESENTATION_START_DATE,
} from "../../../database/seeds/presentation.js";
import {
  assertIsolatedDevelopment,
  assertConnectedLocalTarget,
  createClient,
  DatabaseCommandError,
} from "./connection.js";

export function planPresentation(startDate = PRESENTATION_START_DATE) {
  if (typeof startDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(startDate))
    throw new DatabaseCommandError(
      "Start date must be a real YYYY-MM-DD calendar date",
    );
  const start = new Date(`${startDate}T00:00:00Z`);
  if (
    !Number.isFinite(start.getTime()) ||
    start.toISOString().slice(0, 10) !== startDate
  )
    throw new DatabaseCommandError(
      "Start date must be a real YYYY-MM-DD calendar date",
    );
  return PRESENTATION_MOVIES.flatMap((film, index) => {
    // Calendar arithmetic only: SQL interprets the resulting wall-clock times in Helsinki.
    const day = new Date(start.getTime() + index * 86400000)
      .toISOString()
      .slice(0, 10);
    if (
      !Number.isInteger(film.runtimeMinutes) ||
      film.runtimeMinutes <= 0 ||
      film.runtimeMinutes + 30 > 240
    )
      throw new DatabaseCommandError(
        "Movie runtime does not fit the four-hour demo slots",
      );
    return PRESENTATION_HOURS.map((hour) => ({
      providerId: `tmdb:${film.tmdbId}`,
      time: `${day}T${String(hour).padStart(2, "0")}:00:00`,
    }));
  });
}

export async function seedPresentationScreenings({
  databaseUrl,
  mode,
  startDate = PRESENTATION_START_DATE,
}) {
  const database = assertIsolatedDevelopment(databaseUrl, mode);
  const plan = planPresentation(startDate);
  const client = createClient(databaseUrl);
  try {
    await client.connect();
    await assertConnectedLocalTarget(client, database);
    await client.query("BEGIN");
    await client.query("SET LOCAL search_path = public, pg_catalog");
    await client.query("SET LOCAL TIME ZONE 'Europe/Helsinki'");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SELECT pg_advisory_xact_lock(7420839)");
    if (
      !(
        await client.query("SELECT $1::timestamp > localtimestamp AS future", [
          plan[0].time,
        ])
      ).rows[0].future
    )
      throw new DatabaseCommandError(
        "Presentation screenings must start in the future; choose a later --start-date",
      );
    const screens = (
      await client.query(
        `SELECT s.id, s.capacity, s.wheelchair_capacity, c.name AS city
      FROM public.screens s JOIN public.cities c ON c.id=s.city_id
      WHERE c.name=ANY($1::text[]) ORDER BY s.id FOR NO KEY UPDATE OF s`,
        [CITY_NAMES],
      )
    ).rows;
    if (
      screens.length !== 4 ||
      CITY_NAMES.some((city) =>
        SCREEN_CAPACITIES.some(
          (capacity) =>
            screens.filter(
              (s) =>
                s.city === city &&
                s.capacity === capacity &&
                s.wheelchair_capacity === 10,
            ).length !== 1,
        ),
      )
    )
      throw new DatabaseCommandError(
        "Expected the four configured Oulu/Tampere screens; run browsing and inventory setup first",
      );
    const films = (
      await client.query(
        "SELECT id,title,metadata_api_id FROM public.films WHERE metadata_api_id=ANY($1::text[]) ORDER BY id",
        [PRESENTATION_MOVIES.map((f) => `tmdb:${f.tmdbId}`)],
      )
    ).rows;
    if (
      films.length !== PRESENTATION_MOVIES.length ||
      new Set(films.map((f) => f.metadata_api_id)).size !== films.length
    )
      throw new DatabaseCommandError(
        "Import all ten presentation films before adding screenings",
      );
    const byProvider = new Map(films.map((f) => [f.metadata_api_id, f]));
    const existing = (
      await client.query(
        `SELECT id,screen_id,film_id,to_char(screening_time,'YYYY-MM-DD"T"HH24:MI:SS') AS time
      FROM public.screenings WHERE screen_id=ANY($1::int[])
      AND screening_time BETWEEN $2::timestamp-INTERVAL '4 hours' AND $3::timestamp+INTERVAL '4 hours' ORDER BY id`,
        [screens.map((s) => s.id), plan[0].time, plan.at(-1).time],
      )
    ).rows;
    const targets = [];
    for (const screen of screens)
      for (const slot of plan) {
        const film = byProvider.get(slot.providerId);
        const nearby = existing.filter(
          (s) =>
            s.screen_id === screen.id &&
            Math.abs(Date.parse(s.time + "Z") - Date.parse(slot.time + "Z")) <
              4 * 3600000,
        );
        if (
          nearby.length > 1 ||
          nearby.some((s) => s.time !== slot.time || s.film_id !== film.id)
        )
          throw new DatabaseCommandError(
            "Presentation slot conflicts with an existing screening; choose a different start date. Existing data was not changed",
          );
        targets.push({ screen, film, time: slot.time, existing: nearby[0] });
      }
    let created = 0;
    const screenings = [];
    for (const target of targets) {
      const id =
        target.existing?.id ??
        (
          await client.query(
            "INSERT INTO public.screenings(film_id,screen_id,screening_time) VALUES ($1,$2,$3::timestamp) RETURNING id",
            [target.film.id, target.screen.id, target.time],
          )
        ).rows[0].id;
      if (!target.existing) created++;
      screenings.push({
        id,
        screenId: target.screen.id,
        city: target.screen.city,
        capacity: target.screen.capacity,
        filmId: target.film.id,
        time: target.time,
      });
    }
    await client.query("COMMIT");
    return {
      startDate,
      timezone: "Europe/Helsinki",
      createdScreenings: created,
      retainedScreenings: screenings.length - created,
      films,
      screenings,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}
