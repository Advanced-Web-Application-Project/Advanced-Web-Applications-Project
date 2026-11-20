import "dotenv/config";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { PRESENTATION_START_DATE } from "../../database/seeds/presentation.js";
import { planPresentation } from "./database/seed-presentation.js";
import {
  assertIsolatedDevelopment,
  assertConnectedLocalTarget,
  createClient,
  DatabaseCommandError,
} from "./database/connection.js";

let client;
try {
  const database = assertIsolatedDevelopment(
    process.env.DATABASE_URL,
    process.env.RIO_DATABASE_MODE,
  );
  const startDate = process.argv[2] ?? PRESENTATION_START_DATE,
    plan = planPresentation(startDate);
  const base =
    process.env.API_BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`;
  const request = async (path, body) => {
    const response = await fetch(`${base}/api${path}`, {
      signal: AbortSignal.timeout(5000),
      ...(body
        ? {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }
        : {}),
    });
    assert.equal(response.status, 200);
    const envelope = await response.json();
    assert.equal(envelope.success, true);
    return envelope.data;
  };
  client = createClient(process.env.DATABASE_URL);
  await client.connect();
  await assertConnectedLocalTarget(client, database);
  await client.query("BEGIN READ ONLY");
  const fingerprint = async () => {
    const result = {};
    for (const table of ["films", "seats", "screenings", "bookings", "tickets"])
      result[table] = (
        await client.query(
          `SELECT id,md5(to_jsonb(t)::text) AS hash FROM public.${table} t ORDER BY id`,
        )
      ).rows;
    return result;
  };
  const before = await fingerprint();
  const providerIds = [...new Set(plan.map((s) => s.providerId))];
  const films = (
    await client.query(
      "SELECT id,title,metadata_api_id,description IS NOT NULL AS has_description,artwork_url IS NOT NULL AS has_artwork FROM public.films WHERE metadata_api_id=ANY($1::text[]) ORDER BY id",
      [providerIds],
    )
  ).rows;
  assert.equal(films.length, 10);
  assert.ok(films.every((f) => f.has_description && f.has_artwork));
  const apiFilms = await request("/films");
  for (const film of films)
    assert.equal(apiFilms.find((f) => f.id === film.id)?.title, film.title);
  const screens = (
    await client.query(
      "SELECT s.id,s.capacity,c.id AS city_id,c.name AS city FROM public.screens s JOIN public.cities c ON c.id=s.city_id WHERE c.name IN ('Oulu','Tampere') ORDER BY s.id",
    )
  ).rows;
  assert.equal(screens.length, 4);
  const examples = [];
  for (const screen of screens) {
    const shows = await request(
      `/screenings?cityId=${screen.city_id}&screenId=${screen.id}`,
    );
    for (const film of films)
      for (const slot of plan.filter(
        (s) => s.providerId === film.metadata_api_id,
      )) {
        const matching = (
          await client.query(
            "SELECT id FROM public.screenings WHERE film_id=$1 AND screen_id=$2 AND screening_time=$3::timestamp",
            [film.id, screen.id, slot.time],
          )
        ).rows;
        assert.equal(matching.length, 1);
        assert.ok(
          shows.some((s) => s.id === matching[0].id && s.film_id === film.id),
        );
      }
    const film = films.find((f) => f.metadata_api_id === plan[0].providerId),
      slot = plan[0];
    const show = (
      await client.query(
        "SELECT id,screening_time>localtimestamp AS future FROM public.screenings WHERE film_id=$1 AND screen_id=$2 AND screening_time=$3::timestamp",
        [film.id, screen.id, slot.time],
      )
    ).rows[0];
    assert.equal(show.future, true);
    const query = `screenId=${screen.id}&screeningId=${show.id}`;
    const availability = await request(`/seats/availability?${query}`);
    assert.deepEqual(availability.seated, {
      total: screen.capacity,
      available: screen.capacity - 1,
    });
    assert.deepEqual(availability.wheelchair, { total: 10, available: 10 });
    const seats = await request(`/seats?${query}`);
    assert.equal(seats.length, screen.capacity + 10);
    const selected = ["2", "W3"].map((label) =>
      seats.find((s) => s.display_label === label),
    );
    assert.ok(selected.every((s) => s && !s.isBooked && !s.isReservedByCeo));
    const validation = await request("/seats/validate", {
      screenId: screen.id,
      screeningId: show.id,
      seatIds: selected.map((s) => s.id),
    });
    assert.equal(validation.valid, true);
    examples.push({
      city: screen.city,
      cityId: screen.city_id,
      capacity: screen.capacity,
      screenId: screen.id,
      filmId: film.id,
      title: film.title,
      screeningId: show.id,
      localTime: slot.time,
      seated: availability.seated,
      wheelchair: availability.wheelchair,
      selected: selected.map((s) => ({ id: s.id, label: s.display_label })),
      previewValid: validation.valid,
    });
  }
  assert.deepEqual(await fingerprint(), before);
  await client.query("ROLLBACK");
  const evidence = {
    verifiedAt: new Date().toISOString(),
    database,
    startDate,
    source: {
      provider: "TMDB",
      endpoint: "movie/now_playing",
      region: "FI",
      selectedOn: "2026-11-20",
    },
    films,
    screenings: 120,
    screeningTimesPerMoviePerScreen: 3,
    timezone: "Europe/Helsinki",
    examples,
    verificationDidNotChangeRows: true,
  };
  await writeFile(
    new URL(
      "../../database/verification/presentation-movies.json",
      import.meta.url,
    ),
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.log(
    "Verified ten TMDB movies, 120 screening identities, both cities/capacities, availability and valid seat previews. No rows changed during verification.",
  );
} catch (error) {
  console.error(
    error instanceof DatabaseCommandError
      ? error.message
      : "Presentation verification failed; check the API, fixtures and expected seat availability. Sensitive details are omitted.",
  );
  process.exitCode = 1;
} finally {
  await client?.end();
}
