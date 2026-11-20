# Real-movie presentation data

## Delivered scope

Selected ten movies from TMDB `movie/now_playing`, region `FI`, on 20 November 2026. English titles, descriptions and artwork are retained using the existing
#87 importer. The pinned IDs and checked runtimes are in
`database/seeds/presentation.js`; reruns do not change the selected catalog.

Each movie has three screenings (12:00, 16:00, 20:00) on **each** of the four
Oulu/Tampere 100/200-seat screens: 120 new screenings altogether. One movie is
shown per day, from 21–30 November. Runtimes are at most 195 minutes, leaving at
least 45 minutes within each four-hour slot. This is a synthetic presentation
schedule, not a claim about actual Finnish cinema screenings.

The first demonstration is **Hope → 21 November → 12:00/16:00/20:00** in either
city and either capacity. Each of the other nine movies has its own following
day. All ten are reachable in the movie selector before the presentation.

| Movie                                    | Demo date  | Runtime |
| ---------------------------------------- | ---------- | ------- |
| Hope                                     | 2026-11-21 | 157 min |
| The Hunger Games: Sunrise on the Reaping | 2026-11-22 | 159 min |
| Ramayana: Rise of a Legend               | 2026-11-23 | 195 min |
| Ebenezer                                 | 2026-11-24 | 115 min |
| Godzilla Minus Zero                      | 2026-11-25 | 135 min |
| LA BOLA NEGRA                            | 2026-11-26 | 159 min |
| Street Fighter                           | 2026-11-27 | 120 min |
| How to Rob a Bank                        | 2026-11-28 | 122 min |
| Clayface                                 | 2026-11-29 | 109 min |
| You Can See Everything                   | 2026-11-30 | 175 min |

## Commands

Requires the ignored backend `.env`, isolated local PostgreSQL 18, Node.js 22
and `TMDB_API_READ_ACCESS_TOKEN`. From `backend/`:

```bash
npm run db:seed:presentation -- --start-date 2026-11-21
npm run dev
```

In another terminal, from `frontend/`, run `npm run dev` and open
`http://127.0.0.1:5173/`. Existing running servers can read the new data; reload the
page or change city/screen to load the refreshed screening list.

With the backend running, from `backend/`:

```bash
npm run verify:presentation
# Override only when deliberately building a later demo schedule:
npm run db:seed:presentation -- --start-date YYYY-MM-DD
npm run verify:presentation -- YYYY-MM-DD
```

Keep the same start date when rerunning. A later date is a new additional demo
schedule, not a reschedule or cleanup of existing bookings. Expired start dates
are rejected by scheduling. Fixed 12:00/16:00/20:00 wall-clock times use Helsinki
calendar days; runtime data is a pinned fixture, not a production scheduling API.

## Data safety and integration

- URL and connected-server checks restrict writes to the configured isolated
  local `rio_dev`/`rio_test` databases; shared deployment targets are rejected.
- The command uses the existing migration runner, then browsing setup with
  `includeDemoScreenings: false`, followed by inventory setup and the existing
  TMDB importer. The original browsing seeder's default behaviour is unchanged.
- These setup phases have their existing transaction boundaries. They are not
  one all-or-nothing import-plus-schema transaction. If scheduling fails, imported
  metadata/setup may remain, but no partial presentation schedule is committed.
- All 120 schedule writes share one guarded transaction. The seeder locks the
  configured screens, checks the whole plan for nearby/conflicting or duplicate
  screenings, and preserves any exact existing film/screen/time identity.
  It rejects conflicts rather than moving/deleting existing screenings. The
  conservative four-hour clearance also protects against unknown legacy runtimes.
- Repeat and concurrent runs share the seed advisory lock and keep existing IDs.
  New screenings get CEO seat-1 reservations through existing database triggers.
  Total inventory remains 100/200 seated plus ten wheelchair spaces per screen.
- No customer bookings, prices, payments or holds are invented. Existing synthetic
  movies and their screening/booking history remain intact. The presentation
  command does not require their screenings to be visible in the upcoming list.
- TMDB authentication stays server-side. No new frontend API or provider request
  is needed for browsing retained records. Poster/description display and TMDB
  frontend credits remain the separate UI work documented in [TMDB import](TMDB-IMPORT.md).

## Verification — 20 November 2026

- Full `npm run test:postgres`: **118 passed, zero failed/skipped**. The three new
  tests cover calendar/slot validation, target guards and real PostgreSQL setup.
  Database checks include missing films, conflict preflight, late-insert rollback,
  concurrent setup, stable reruns, old-row preservation, 120 CEO reservations and
  actual seat-availability HTTP responses for both capacities.
- Real local `rio_dev` setup: first run added 120 screenings, second added zero
  and retained all 120. Ten TMDB movies were imported with descriptions/artwork.
- Before/after fingerprints confirmed all existing film, seat, screening, booking
  and ticket rows stayed unchanged. Films grew 2→12, screenings 24→144 and
  bookings/tickets 24→144 (the additional allocations are system CEO reservations).
  Seat inventory stayed at 640 places. There were no new customer allocations.
- `verify:presentation` checks every film/screen/time identity through PostgreSQL
  and the real browsing API, then availability and valid seat previews in both
  cities and capacities. Its read-only verification compares row fingerprints.
- Browser checks exercise real imported titles, three showtimes, both capacities,
  wheelchair selection and the validated summary. Browser selection creates no
  hold. Evidence: [presentation-movies.json](../database/verification/presentation-movies.json).

Commands for independent checks:

```bash
# backend/
node --import dotenv/config --input-type=module -e 'process.env.TEST_DATABASE_URL=process.env.DATABASE_URL; await import("./tests/presentation.test.js");'
npm run test:postgres
npm run verify:presentation
```

The agreed local presentation-data slice is complete after these checks. Rahti/
CSC synchronization, production migration automation, staff scheduling, pricing,
checkout retries (#62) and payment remain separate. Movie metadata alone does not
create screenings; use the explicit presentation command for this demo schedule.
