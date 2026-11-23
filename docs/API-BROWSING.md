# Customer browsing contracts — #40 / #18 / #8

## Delivered scope

Cities/screens and retained films now follow feature routes → controllers →
services → repositories. Screening reads retain their existing feature. The
replaced inline handlers were removed from `backend/api.js`, which now composes
features and retains only the legacy price read. The TMDB importer remains a
separate operation within films; browsing does not call TMDB.

The customer app displays Movie details automatically after a movie is chosen.
It requests `GET /api/films/:id` through the shared client, verifies the returned
identity/title/description, and renders plain text. Loading, retryable failure
and missing-description states are distinct. A detail failure does not clear
screening choices or block seat selection. Changing movies cancels the previous
request; late responses cannot replace the current description. There are no
poster/trailer requests in this view. Persistent media remains #59.

## HTTP responses

Successful reads retain `{ "success": true, "data": ... }`; errors retain
`{ "success": false, "error": "..." }`. Field names are unchanged.

| Route                       | Public fields / result                                                                         | Empty or missing                                 |
| --------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `GET /api/cities`           | Array of `id`, `name`, ordered by ID                                                           | **404** `No cities found` (legacy compatibility) |
| `GET /api/cities/:id`       | One city with the same fields                                                                  | **404** `City not found`                         |
| `GET /api/screens?cityId=…` | Array of `id`, `capacity`, `wheelchair_capacity`, `city_id`, `city_name`, ordered by ID        | **200** with `[]`                                |
| `GET /api/screens/:id`      | One screen with the same fields                                                                | **404** `Screen not found`                       |
| `GET /api/films`            | Array of `id`, `title`, `metadata_api_id`, `description`, `artwork_url`, ordered by ID         | **200** with `[]`                                |
| `GET /api/films/:id`        | One film with the same fields                                                                  | **404** `Film not found`                         |
| `GET /api/screenings`       | Existing screening fields and city/screen/film filters; see [screening API](API-SCREENINGS.md) | **200** with `[]`                                |

There is no screening detail endpoint in this baseline. Valid IDs that identify
no records are not malformed input. Unknown query keys remain ignored for
compatibility. Optional filters apply only to routes that document them.
Explicit projections prevent future private schema columns from accidentally
becoming public via `SELECT *`.

`id`, `city_id`, `screen_id` and `film_id` are stored identities, not list offsets.
`metadata_api_id` is the retained provider identity or development fixture marker;
it is not a credential. Film description and artwork URL may be null. A retained
external artwork URL does not prove that an image has been downloaded into RIO
storage; this detail view deliberately uses title/description only.

### Identifier policy

City/screen/film detail IDs, optional screen `cityId`, and the existing screening
filters accept decimal integers **1–2147483647**. Leading zeros normalize to the
same ID. Signs, whitespace, decimal/exponent notation, out-of-range values,
repeated filter values and bracket notation are rejected with **400**, before
querying PostgreSQL. Screen filtering with `cityId=` is invalid rather than an
unfiltered read. Unknown valid city filters return `[]`.

This deliberately improves malformed city/screen/film requests that previously
relied on PostgreSQL casts (often yielding 500 or treating an empty city filter
as absent). Valid routes, fields, filters and empty/missing responses remain
compatible. `/api/layouts` is obsolete and is not introduced as an alias.

### Failures and data meanings

Unexpected database errors return **500** with the existing route-specific error
message. The historical wording, including the leading space in the single-film
error, is retained. SQL, driver codes, database roles and connection details do
not appear in public errors or route logs. A 500 response is never an empty list.

Screen `capacity` means **100/200 physical seated places including CEO seat 1**;
`wheelchair_capacity` is ten additional places. These are static capacities, not
bookable counts. Static `GET /api/seats?screenId=…` inventory is not a screening
availability check. For live counts use
`GET /api/seats/availability?screenId=…&screeningId=…`; for the map use the same
IDs with `/api/seats`. CEO-only initial availability is 99/100 or 199/200 seated
plus 10/10 wheelchair. Reads and validation do not create holds. Stored deadlines
and backend allocation remain authoritative.

The unfiltered screening API includes historical shows; the customer selector
filters to future shows. Dates shown to customers use Europe/Helsinki. The
existing timezone-less database convention still needs `TZ=Europe/Helsinki` in
the backend; see the screening API's timestamp limitations.

## Reproduce verification

Use the existing isolated PostgreSQL 18 setup in [the database guide](../database/README.md).
From the repository root:

```bash
npm run test:postgres --prefix backend
npm test --prefix frontend
npm run lint --prefix frontend
npm run format:check --prefix frontend
npm run build --prefix frontend
git diff --check
```

The new PostgreSQL contract suite is enabled by `test:postgres` through
`TEST_BROWSING_DATABASE_URL`. It creates/drops a dedicated `rio_test_*` database
and a unique **NOLOGIN** test role to produce real permission-denied errors.
The local test role therefore needs `CREATEDB` and `CREATEROLE` (or superuser).
Do not run against CSC/shared data. The target guard requires loopback and
`RIO_DATABASE_MODE=isolated-development`. No migration/seed is applied to the
retained database by this suite.

To regenerate nonsecret API evidence:

```bash
cd backend
RIO_BROWSING_CONTRACT_EVIDENCE_PATH=../database/verification/browsing-contracts.json npm run test:postgres
```

For manual customer verification, use a disposable database with migrations,
browsing fixtures, inventory and approved demo prices; run the backend and Vite
against it. Choose each city/capacity, choose a movie, read Movie details, select a
showtime, select seat 2 and W3, Check selection, then Continue to guest checkout.
Verify the retained context and current server quote. Change W3 to Child to check
€12 + €6 = €18 with the approved demo prices. Return before starting a hold.
This validates browsing/quote integration without creating customer allocations.
Do not seed or reset shared data to reproduce this check.

## Verification — 20 November 2026

- **143 backend tests passed**, no failures/skips, on PostgreSQL **18.7**.
  The added suite verifies real empty/success/not-found/filter responses, exact
  public field sets, leading-zero IDs, safe PostgreSQL permission failures and
  unchanged row fingerprints. A separate database-double test proves malformed
  identifiers reach no SQL; it is not claimed as real PostgreSQL evidence.
- **80 frontend tests passed**: 27 Node/real-HTTP transport tests and 53 React
  tests. The added detail checks cover loading, plain-text rendering, absent
  descriptions, malformed/wrong-identity data, network/404 failure and retry,
  stale replies, and selected-screening preservation during detail failure.
  React fetch responses are doubles; they do not verify a live backend.
- Frontend lint, formatting and build passed in an exact temporary source/config/
  fixture copy with a fresh cached dependency installation. The original install
  initially stalled on lint and Vitest workers timed out, matching the previously
  documented machine problem. Actual repository production build also passed.
- Real browser → React → Express → PostgreSQL used disposable synthetic browsing
  fixtures across **Oulu/Tampere × 100/200**. Each reached validated selection
  and checkout with seat 2 + W3. Current quotes were €24 for two adults; Oulu
  100 additionally verified adult+child at €18. No customer hold was created.
- After the details addition, the real browser verified both movie descriptions
  and switching between them, Oulu 100 keyboard seat selection/validation and
  checkout with retained context, and Tampere 200 movie details. At 390×844 the
  detail panel was 335px wide and page width 375px, with no horizontal overflow.
  The temporary viewport was reset. Before/after fingerprints match across
  cities, screens, films, screenings, seats, bookings, tickets and prices.
- Dedicated servers stopped; both disposable browser databases and the test role/
  database were removed. Retained development data was inspected read-only and
  was not seeded/migrated. Shared/CSC data was not accessed.

See [API evidence](../database/verification/browsing-contracts.json) and
[browser/data-preservation evidence](../database/verification/browsing-workflow.json).
These checks do not verify Rahti deployment or any external provider. Synthetic
film descriptions/showtimes are fixtures, not live cinema listings or TMDB results.

## Closure assessment

| Issue criterion                                        | Evidence / disposition                                                                   |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| #40 success, empty, not-found, real DB failures        | Real PostgreSQL contract suite across cities/screens/films/screenings                    |
| #40 identifiers, public fields and safe errors         | Exact field assertions, malformed-input/no-SQL check and actual permission errors        |
| #40 routes/filters/examples remain compatible          | Full backend regression suite; `api.http` and this contract updated                      |
| #40 static inventory versus availability               | Explicit contract plus real 99/100 and 199/200 comparisons                               |
| #18 compatible public read APIs with recorded commands | Same verified #40 contract and feature layers; no duplicate read handlers                |
| #8 both cities and upcoming screenings                 | Real workflows cover both capacities in each city; existing future-filter tests retained |
| #8 reachable film details and clear empty results      | Retained title/description panel; React detail and browsing empty/error tests            |
| #8 film/city/screen/date/start/prices before booking   | Summary plus server quote before hold creation, verified in browser                      |
| #8 screening context through seats and checkout        | Existing integrated component tests and real workflow                                    |

The scoped local acceptance criteria for #40, #18 and #8 are satisfied. Review and
merge are still user-controlled; no issue is closed by this document. Broader
film/scheduling/pricing administration dependencies remain separate issues.
Unconfirmed doors/advertising copy is not introduced. Media persistence #59,
trailers, staff/session enforcement #35 and deployment remain separate scopes.
The former anonymous booking-list prototype is now protected by [the staff
session feature](API-STAFF-AUTH.md). Its local and remaining hosted verification
are separate from this public browsing milestone.
