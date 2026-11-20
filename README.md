# RIO

RIO is a cinema booking web application being developed for Oulu University of Applied Sciences (OAMK)'s Advanced Web Applications Project (ID00CS47-3007).

The project aims to help customers browse screenings, choose seats, and purchase tickets, while providing staff with tools to manage cinema operations.

## Tech Stack

Planned technologies:

| Area                | Technology                                                 |
| ------------------- | ---------------------------------------------------------- |
| Frontend            | React, JavaScript                                          |
| Backend             | Node.js, Express                                           |
| Database            | PostgreSQL 18 target, hosted at [CSC](https://www.csc.fi/) |
| Application hosting | Rahti (CSC), confirmed 18 November 2026                    |

## Deployment

Rahti is the confirmed target for the customer frontend, future separate staff
frontend and Express backend. PostgreSQL remains at CSC. See the
[deployment guide](docs/DEPLOYMENT.md) for the current source/configuration audit,
remaining runtime/CI work and required live verification. The merged deployment
prototype is partial progress; live completion has not yet been demonstrated.

## Contributing

Start with the [Contributing Guidelines](CONTRIBUTING.md) for contributor expectations and a checklist for submitting changes.

## Architecture

The [Architecture guide](docs/ARCHITECTURE.md) explains the planned application structure, component responsibilities, and data flow.

## Product Backlog

Explore the [Product Backlog](docs/PRODUCT-BACKLOG.md) for planned features, priorities, acceptance criteria, and open decisions.

## Communication

Join the [RIO Discord server](https://discord.gg/jJTps5kC9F) for team discussions and coordination.

## Status

In development. Customers can choose a city, screen, movie and showtime using
live data. Customers can read retained movie titles/descriptions, inspect/select seats and check the complete selection.
Customers can review a validated selection with back navigation and separate
seated/wheelchair availability counts, then enter guest checkout with ticket
categories, a server quote and an owned five-minute unpaid hold. See [the selection workflow](docs/SELECTION-SUMMARY.md)
for selection verification. See [guest checkout](docs/GUEST-CHECKOUT.md) for its
current scope, local price setup and tests. Stripe payment and the later frontend
redesign remain future work.

## Booking allocation safeguards

The corrected booking API creates owned five-minute unpaid holds and retains
history on release. The booking API requires migrations through 0008; local staff
provisioning additionally requires 0009. Apply current migrations only to the
explicit development target described in the database guide.
See [the contract, verification and remaining work](docs/BOOKING-SAFEGUARDS.md).
Optional private request keys now support [retry-safe hold creation](docs/CHECKOUT-HOLD-RETRIES.md).

## Staff identity foundation

[Staff provisioning](docs/STAFF-PROVISIONING.md) adds role/city/email constraints
and hidden-terminal local account management through migration 0009. Commands
are repeatable without resetting credentials. HTTP sign-in, sessions and staff
route authorization remain #35; no staff frontend is introduced here.

## Presentation movie data

Ten real movies selected from TMDB's Finland now-playing list on 20 November 2026
are available through a repeatable local setup. Each has three showtimes on each
of the four screens, from 21–30 November. The schedule is synthetic demo data,
not actual cinema listings. See [presentation setup and verification](docs/PRESENTATION-DATA.md).

## Backend development

On the configured development machine, PostgreSQL data is retained in ignored
`.local/postgres` (PostgreSQL 18). Use `/Library/PostgreSQL/18/bin/pg_ctl`; start it using the [database guide](database/README.md), then
run `npm start` from `backend/`. In another terminal, run
`npm run verify:browsing` from `backend/` to verify both cities and all four
screens against the running API. These commands use your ignored `.env`.

Requires Node.js 22 and access to a PostgreSQL 18 development database. From the
repository root:

```bash
cd backend
npm ci
cp -n .env.example .env
# Edit .env with your development database connection and frontend origin.
npm test
npm run dev
```

`npm start` runs without the development watcher. `PORT` defaults to 3000.
`DATABASE_URL` must name a PostgreSQL database; `FRONTEND_URL` must be an
HTTP(S) origin such as `http://localhost:5173`. The old `CLIENT_URL` variable
is no longer used. Keep `.env` local and never commit real credentials.
Configuration is validated and database connectivity is checked before listening.
Stop with Ctrl+C; SIGINT/SIGTERM close HTTP connections and the database pool.

These commands do not create tables or seed records. An empty PostgreSQL database
can pass the connectivity check, but data endpoints require the schema and data.
For repeatable isolated schema setup, read the [database guide](database/README.md).
Install the synthetic browsing data with `npm run db:seed:browsing` after applying
the schema. Run `npm run test:postgres` for all tests against an explicitly
isolated local development connection. Do not apply `backend/db.sql` blindly
to a shared database.

`npm test` uses Node's built-in test runner and isolated HTTP servers with injected
database doubles. It checks configuration, existing route response contracts,
CORS, startup failures and shutdown; it does not prove a live schema is correct.
The two PostgreSQL integration checks run when `TEST_DATABASE_URL` is explicitly
set to a development connection URL before `npm test`; otherwise they are skipped.
They check real connectivity and a CLI request/shutdown without creating tables
or records. Schema migration tests additionally require
`TEST_MIGRATION_DATABASE_URL`; they create and remove dedicated test databases,
and require a local development role with `CREATEDB`. The database guide provides
a disposable PostgreSQL recipe and explains the migration target safeguards.

Application setup lives in `backend/src/app.js` and has no listening side effect.
Runtime orchestration lives in `backend/src/server.js`; `backend/server.js` loads
the environment and handles process signals. Shared configuration is in
`backend/src/config/`. `backend/api.js` composes the feature routes and retains the legacy price read.
City/screen reads, film reads, screenings, seats and bookings follow their feature
layers in `backend/src/features/`. See the [browsing contracts and closure evidence](docs/API-BROWSING.md). See the [screening API contract](docs/API-SCREENINGS.md). New business logic should follow the feature
boundaries in the architecture guide as those features are implemented.

The Dockerfiles and Kubernetes files remain deployment scaffolding; runtime
integration is tracked under #67. Local development uses the native commands
above, and Rahti deployment uses the `k8s/` manifests.

## Customer frontend

Start the backend, then run the following in another terminal from the repository
root:

```bash
cd frontend
npm ci
cp -n .env.example .env
npm run dev
```

Open `http://127.0.0.1:5173/`. See the [frontend guide](frontend/README.md) for
API configuration, build/lint/test commands and verified scope.

## CEO seat reservations

Each screening now receives a non-expiring system CEO booking. Seat 1 is included
in the 100/200 seated capacity; ten wheelchair places are additional. Repeatable
physical inventory is available through `npm run db:seed:inventory` from `backend/`; see
the [inventory setup and API fields](docs/SCREEN-INVENTORY.md). See the [CEO reservation policy](docs/CEO-RESERVATIONS.md)
for database/API behavior, verified scope and the deferred CEO-only release feature.

## Screening availability

`GET /api/seats?screenId=...&screeningId=...` now respects stored booking expiry
deadlines. `GET /api/seats/availability` with both IDs returns separate seated
and wheelchair available/total counts and a server snapshot time. See the
[availability contract](docs/API-SEAT-AVAILABILITY.md) for states, errors,
confirmed five-minute checkout policy and verification. Reads create no holds.

## Seat-selection preview

`POST /api/seats/validate` checks the complete selection against current screening
availability and physical gap rules, without creating a booking or hold. See
[the request contract and examples](docs/API-SEAT-SELECTION.md). Checkout hold
creation already repeats these shared rules transactionally; preview does not
secure places. Frontend integration remains separate.

## Accessible seat map

After selecting a showtime, the customer app renders the actual 100/200-seat
layout with a separate wheelchair zone and read-only backend validation. See
[seat-map behavior, verification and scope](docs/SEAT-MAP.md). Availability updates
on refresh/focus/every 30 seconds. A successful check does not reserve places.

## TMDB metadata import

See [TMDB import setup, retained field meanings and verification](docs/TMDB-IMPORT.md)
for the backend-only explicit movie-ID command.
