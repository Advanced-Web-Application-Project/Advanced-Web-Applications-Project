# Development database schema

Schema setup for #39 uses a small Node.js migration runner built on the existing
`pg` dependency. It adds no runtime dependencies. Ordered SQL files live in
`database/migrations/`; commands run from `backend/`.

## Current version — PostgreSQL 18

PostgreSQL 18 is the current development/container target (confirmed 19 November
2026). The retained local cluster is already version 18 and uses the installed
`/Library/PostgreSQL/18/bin` tools. Historical PostgreSQL 17 verification and the
ignored `.local/postgres-pg17-backup` remain historical records; do not relabel or
reuse them as version 18 data.

Existing data from another major version needs a reviewed `pg_upgrade` or logical
dump/restore into a separate 18 cluster. Updating a binary/image path alone is not
a major-version data migration. Preserve the source/backup and validate linked
records before adopting the new target. See
[PostgreSQL's upgrade guide](https://www.postgresql.org/docs/18/upgrading.html).
No shared/CSC upgrade is performed by this repository update.

## Commands and target

Set `DATABASE_URL` in your local `backend/.env`, or export it in your shell.
Inspection needs only this variable; it does not require frontend configuration.

```bash
cd backend
npm run db:inspect
```

Inspection runs in a repeatable-read, read-only transaction. JSON output includes
public tables, columns/defaults, keys/check constraints, indexes, function and
trigger definitions, application row counts, PostgreSQL version and session
timezone. `missingTables` compares names with the eleven baseline application
tables. This is an inspection report, not an automatic proof of full schema
compatibility. Save a before/after report when applying a schema change.
It lists structure and counts, without retrieving customer records or printing
the connection URL. Large or inaccessible tables may make inspection fail; the
command makes no corrective writes.

To apply migrations, explicitly select an isolated **local development** target:

```bash
export RIO_DATABASE_MODE=isolated-development
npm run db:migrate:dev
npm run db:inspect
```

The write command requires a loopback host (`127.0.0.1`, `localhost`, or `::1`),
a database named `rio_dev` or `rio_test` (optionally followed by an underscore
and a lowercase letters/digits/underscores suffix), and no URL query or fragment.
Example: `postgresql://rio_dev:your-local-password@127.0.0.1:5432/rio_dev`.
It also checks the actual connected server address and database name before DDL.
The caller must ensure this is a dedicated development database. The command
does not create a database, provision roles or enable writes to the CSC database.

## Migration behavior

- `0001_initial_schema.sql` preserves the existing `backend/db.sql` definitions.
  The original file remains a historical source for existing links; use the
  migration command for new isolated databases. Do not run both setup paths.
- First application requires an empty `public` schema. An existing untracked
  schema is refused, even if its table names appear compatible. Inspect it;
  adoption of an existing database needs a separately reviewed migration plan.
- `public.rio_schema_migrations` records filenames, SHA-256 checksums and applied
  times. A rerun skips applied files, preserving records, IDs and sequences.
- Applied SQL files are immutable, including whitespace. Add the next unique
  four-digit version, such as `0002_description.sql`, for a schema change.
  Edited, removed or reordered history is rejected.
- An advisory transaction lock serializes runners for the database. All pending
  SQL and history records commit together; any SQL failure rolls back that batch.
  Lock waits are limited to five seconds and statements to thirty seconds.
- Files must contain transaction-compatible SQL. Do not include `BEGIN`, `COMMIT`,
  or operations such as `CREATE INDEX CONCURRENTLY`. There is no reset, automatic
  downgrade or production deployment migration command in this milestone.
- Checksums protect migration history. They do not detect manual changes to
  tables or triggers; use inspection and focused database checks for that.

## Reproduce verification with PostgreSQL 18

The following macOS recipe creates a new disposable local cluster. It does not
use an existing PostgreSQL service. Choose another unused port if 55439 is busy.
Run from `backend/`; if PostgreSQL is installed elsewhere, adjust `RIO_PG_BIN`.
The `trust` authentication here is only for this temporary loopback test cluster.

```bash
export RIO_PG_BIN=/Library/PostgreSQL/18/bin
export RIO_PG_DATA="$(mktemp -d /tmp/rio-schema.XXXXXX)"
"$RIO_PG_BIN/initdb" -D "$RIO_PG_DATA" -U rio_test -A trust --no-locale --encoding=UTF8
"$RIO_PG_BIN/pg_ctl" -D "$RIO_PG_DATA" -l "$RIO_PG_DATA/server.log" -o "-h 127.0.0.1 -p 55439 -k $RIO_PG_DATA" -w start
"$RIO_PG_BIN/createdb" -h 127.0.0.1 -p 55439 -U rio_test rio_test_migrations
export DATABASE_URL=postgresql://rio_test@127.0.0.1:55439/rio_test_migrations
export RIO_DATABASE_MODE=isolated-development
npm run db:inspect
npm run db:migrate:dev
npm run db:inspect
npm run db:migrate:dev
TEST_DATABASE_URL="$DATABASE_URL" TEST_MIGRATION_DATABASE_URL="$DATABASE_URL" npm test
"$RIO_PG_BIN/pg_ctl" -D "$RIO_PG_DATA" -m fast -w stop
```

After stopping it, the cluster files remain in the newly created `RIO_PG_DATA`
directory and may be removed when no longer needed. No real credentials are
needed for this disposable recipe. Keep real development credentials in ignored
`.env` files. Without the test connection variables, `npm test` runs the checks
that do not need PostgreSQL and explicitly skips the integration checks.

The migration integration test creates uniquely named `rio_test_schema_*`
databases, applies SQL, exercises constraints and drops only those test databases.
Its role needs `CREATEDB`; the temporary cluster role above has that permission.
Do not point test variables at a shared database.

## Historical baseline verification — PostgreSQL 17

[Recorded verification](verification/initial-schema.json) contains the read-only
before/after summary for a disposable PostgreSQL 17.0 cluster on 13 November 2026.
All 18 tests passed, with no skips. The checks verified all baseline columns,
13 foreign keys, nine check constraints, unique indexes and two enabled triggers.
A linked city → screen → screening → film example, with a booking/ticket,
survived a rerun with its records and IDs unchanged. Concurrent runners applied
once; failed SQL rolled back; altered history and untracked legacy schemas were
refused. The cluster used for that verification was stopped and removed.

This baseline is the existing schema, not the final seating design:

- Screening/booking timestamps remain `timestamp without time zone`; a session
  timezone does not turn them into unambiguous instants.
- Existing CEO triggers are present, and flagged-seat rejection is tested. Their
  known gaps (including ordinary-seat deletion suppression and seat relocation)
  remain for #36. Trigger presence does not prove the final CEO requirement.
- Physical columns, complete inventories and their safeguards remain #51/#36.
- The initial schema migration installs no browsing records. The separate #52
  fixture command below supplies synthetic development data.
- Shared/CSC schema state has not been inspected or changed. Production adoption,
  rollout and database roles remain separate work.

## Browsing fixtures and running the backend (#52)

The configured development machine now has a dedicated PostgreSQL cluster in
ignored `.local/postgres`, listening on loopback port 55452, with database and
role `rio_dev`. Its current PG_VERSION is 18 and it uses password authentication. Its generated connection URL is
stored only in ignored `backend/.env`, alongside `FRONTEND_URL`,
`RIO_DATABASE_MODE=isolated-development`, and `TZ=Europe/Helsinki`.
It was created separately from the installed PostgreSQL service and from CSC.

From the repository root, check/start/stop this cluster with:

```bash
/Library/PostgreSQL/18/bin/pg_ctl -D "$PWD/.local/postgres" status
/Library/PostgreSQL/18/bin/pg_ctl -D "$PWD/.local/postgres" -l "$PWD/.local/postgres.log" -w start
/Library/PostgreSQL/18/bin/pg_ctl -D "$PWD/.local/postgres" -m fast -w stop
```

Use `start` only when it is stopped. Data survives stopping the server.
Start the database before running the backend or PostgreSQL checks. After an
interrupted shutdown, startup may take longer while PostgreSQL performs crash
recovery. Wait for readiness instead of deleting lock files or running `initdb`
over the retained data. Restart `npm run dev` if it exited while the database was
unavailable. `pg_ctl` status checks do not reset data.

For a new checkout, provision a separate local database. On macOS with the same
PostgreSQL installation, run the following from the repository root, choosing
an unused port if 55452 is occupied. `initdb` refuses to overwrite a nonempty
cluster directory. The commands prompt for the development role password;
choose a password and put its URL-encoded value in your ignored `.env`.

```bash
mkdir -p .local
/Library/PostgreSQL/18/bin/initdb -D "$PWD/.local/postgres" -U rio_dev -A scram-sha-256 -W --no-locale --encoding=UTF8
cat >> .local/postgres/postgresql.conf <<'CONFIG'
listen_addresses = '127.0.0.1'
port = 55452
unix_socket_directories = ''
CONFIG
/Library/PostgreSQL/18/bin/pg_ctl -D "$PWD/.local/postgres" -l "$PWD/.local/postgres.log" -w start
/Library/PostgreSQL/18/bin/createdb -h 127.0.0.1 -p 55452 -U rio_dev -W rio_dev
cd backend
cp -n .env.example .env
```

Edit `.env` to use the new database and password, for example
`DATABASE_URL=postgresql://rio_dev:your-url-encoded-password@127.0.0.1:55452/rio_dev`.
Keep the frontend origin `http://localhost:5173`, the isolated-development mode,
and the Helsinki timezone. Then, from `backend/`:

```bash
npm ci
npm run db:inspect
npm run db:migrate:dev
npm run db:seed:browsing
npm run db:inspect
npm run test:postgres
npm start
```

With the backend running, open another terminal in `backend/` and run:

```bash
npm run verify:browsing
```

The verifier uses `API_BASE_URL` when provided; otherwise it uses localhost and
`PORT` from `.env` (3000 by default). It makes GET requests and compares returned
IDs with a read-only PostgreSQL snapshot. It checks city/screen/film detail and
list routes plus existing city, film and combined screening filters. All four
screens must have both future demo films. It does not generate records or seats.

`npm run test:postgres` reads the ignored local configuration, enforces the same
isolated-target guard, and enables all PostgreSQL test suites. The development
role must have `CREATEDB` for uniquely named disposable test databases. The local
cluster role created by `initdb` has this permission. The test databases are
removed at the end; browsing records in `rio_dev` are retained. Plain `npm test`
still runs checks without a database and skips integration tests unless their
explicit connection variables are provided.

### Fixture meanings and reruns

Fixture definitions live in `database/seeds/browsing.js`:

- Oulu and Tampere each have one 100-seat screen and one 200-seat screen.
- `wheelchair_capacity=10` is screen metadata; it is not proof of ten generated
  wheelchair places. Seat inventory remains empty until #51.
- Two synthetic movies have `metadata_api_id` markers beginning with
  `rio-dev:browsing:`. These markers are fixture identifiers, not external movie
  provider identifiers or real cinema listings.
- Each screen gets both demo films. Newly needed screenings are tomorrow at
  18:00/20:00 in Europe/Helsinki, calculated from PostgreSQL's clock.
- Existing cities are matched by unique name, screens by city/capacity, and demo
  films by marker. Database-generated IDs are used throughout; ID 1 is not assumed.
- Reruns reuse the earliest future screening for each screen/demo film. They do
  not rewrite titles, move showtimes, delete old screenings or alter bookings.
  When all matching shows are past, a new future show is appended. History grows
  deliberately; there is no automatic cleanup or reset command.
- Duplicate city/capacity screens, duplicate film markers, or incompatible
  wheelchair metadata cause the whole seed transaction to roll back for review.
  Schema setup must already be applied. The local write guard and advisory lock
  are shared with migrations. Existing unrelated records are preserved.

The stored timestamps still lack a timezone. Fixture values represent Helsinki
wall time; run the current backend with `TZ=Europe/Helsinki` so its existing
PostgreSQL parser produces matching API instants. The verifier checks this
conversion. This local convention does not resolve the permanent timestamp
migration/API contract, which remains #53. No API response shape changes here.

[Browsing verification evidence](verification/browsing.json) records the actual
read-only before/after inspection, a real CLI backend check for all eight future
screenings, and 25 passing tests with no skips on 13 November 2026. Repeatable
fixtures, database startup/shutdown and the complete current browsing path are
verified. The local database remains available for development; the verification
backend process was stopped.

M0 did not include the React application, seats/availability/validation, prices,
holds or payment. Screening `screenId` filtering and stable `film_id` responses
were subsequently added in #53; see the [screening API contract](../docs/API-SCREENINGS.md).
No shared/CSC database or deployed application was verified.

## CEO-reservation migration (#36)

`0002_ceo_reservations.sql` adds `bookings.booking_type`, default system
reservations, per-screen seat-1 constraints and corrected guards. Follow-up
`0003_guard_ceo_seat_conversion.sql` protects referenced ordinary places from
conversion into CEO inventory. The approved
16 November policy replaces the old unconditional permanent-lock requirement.
See [CEO reservations](../docs/CEO-RESERVATIONS.md) for the full contract and
[verification evidence](verification/ceo-reservations.json).

The migration has been applied only to the isolated local development database.
It does not generate physical inventory or a CEO account. Default reservations
remain unavailable for release until proper CEO authentication is implemented.
Before #51, local CEO bookings have no tickets because there are no seat rows;
inserting each screen's designated seat 1 later attaches those tickets without
recreating screenings or bookings. Do not interpret absent inventory as available
physical places. Existing migration files and IDs are preserved.

## Physical inventory (#51)

After applying migrations and browsing fixtures, run `npm run db:seed:inventory`
from `backend/`. Reruns preserve IDs/bookings and report zero inserted rows.
With the backend running, `npm run verify:inventory` verifies all four layouts
and the city/screen/movie/screening/seat API path using read-only queries.

Migration `0004_screen_inventory.sql` adds stored physical columns/display labels,
unique positions/zone labels, bounds and preservation guards. The local inventory
now contains 600 seated plus 40 separate wheelchair places; earlier empty-inventory
statements above describe the historical #39/#52/#36 verification stages. See
[the inventory guide](../docs/SCREEN-INVENTORY.md) and
[recorded verification](verification/inventory.json) for current behavior.

## Booking safeguards update — #82

`0005_booking_safeguards.sql` adds private hold-token hashes, ticket-category
snapshots and active allocation guards shared with availability reads. Apply it
before running the updated backend. It refuses active duplicate allocations
without changing booking history; resolve such records through a separate review.
No prices, contacts or paid records are invented. Legacy categories stay NULL.
See [the current booking contract and acceptance evidence](../docs/BOOKING-SAFEGUARDS.md).

`0006_allocation_isolation.sql` requires READ COMMITTED for booking/ticket writes
so waiting writers obtain fresh availability snapshots. The API selects that
isolation explicitly. Read-only inspection may still use repeatable read.

## Rahti application hosting

Rahti is the confirmed application target as of 18 November 2026. PostgreSQL
remains at CSC; the exact deployed database endpoint/ownership must be recorded
under #67. This decision authorises no database relocation, reset or automatic
production migration. Existing `k8s/postgres_*` examples are unverified against
that target and must not be applied or deleted by assumption. See
[deployment configuration and verification](../docs/DEPLOYMENT.md).

## Current PostgreSQL 18 verification — 19 November 2026

The retained native cluster reports PostgreSQL 18.7 on loopback port 55452. All 98
backend tests pass with no skips using disposable databases on that server, and
a fresh Express startup/cities request passed. The user's running backend also
returns future demo screenings after rerunning the existing browsing seed. See
[the current verification record](verification/postgresql-18.json).

## PostgreSQL 18 container examples

`k8s/postgres_deployment.yaml` targets `postgres:18-alpine`. The official image uses `POSTGRES_DB`, `POSTGRES_USER` and
`POSTGRES_PASSWORD`, with `PGDATA=/var/lib/postgresql/18/docker` inside a volume
mounted at `/var/lib/postgresql`. See the
[official image documentation](https://hub.docker.com/_/postgres).

The Kubernetes PVC uses the distinct name `postgres18-data`
so old data is not mounted as if it were already upgraded. Keep any existing
`postgres-data` PVC/old volume until backup, upgrade/restore and record verification
are complete. These are fresh-target examples, not an in-place upgrade procedure.

Container/Rahti execution remains unverified under #67. A PostgreSQL image update
does not complete application deployment. The guarded native-local
migration commands do not automatically adopt a container/shared server: retain
the existing target checks and use a separately reviewed setup path. No Docker,
Rahti or shared database is started, replaced or reset by these source changes.


## Real-movie presentation fixtures

For the 21 November presentation, [the dedicated setup](../docs/PRESENTATION-DATA.md)
imports ten TMDB movies and adds three showtimes per movie per screen. From `backend/`:

```bash
npm run db:seed:presentation -- --start-date 2026-11-21
# With the backend running:
npm run verify:presentation
```

The command enforces isolated local targets, applies migrations through the
existing runner, ensures locations/inventory without adding new synthetic-film
screenings, imports the pinned TMDB IDs, then transactionally adds the schedule.
Existing data is retained. Repeat with the same date to keep screening IDs; no
reset is needed. Do not use this local fixture command on CSC/shared databases.


## Approved guest checkout demo prices

The user confirmed email-only guest checkout and EUR on 20 November 2026.
From `backend/`, `npm run db:seed:demo-prices` adds adult 1200 and child 600 cents
only to a guarded isolated local database. Reruns keep matching settings; different
or duplicate existing prices cause rollback instead of overwriting them. Runtime
child quotes still derive exactly half the authoritative adult base price.
This is explicit demo setup, not a production price-administration feature.
See [guest checkout verification](../docs/GUEST-CHECKOUT.md).
