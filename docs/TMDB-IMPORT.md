# TMDB film import

The backend command imports explicit TMDB movie IDs into local PostgreSQL. It does
not create screenings or change the customer UI. Both existing film GET routes
read retained local rows; browsing needs no TMDB credentials or live connection.

## Setup and commands

Run commands from `backend/` using Node.js 22 and an isolated local PostgreSQL
instance. Follow [database setup](../database/README.md) first. Install dependencies
with `npm ci`, and place local values in the ignored `backend/.env`:

```dotenv
RIO_DATABASE_MODE=isolated-development
DATABASE_URL=postgresql://<user>:<password>@127.0.0.1:5432/rio_dev
TMDB_API_READ_ACCESS_TOKEN=<your-tmdb-api-read-access-token>
# Optional; integer 1000–30000, default 8000 milliseconds per request.
TMDB_TIMEOUT_MS=8000
```

Use the API Read Access Token, sent only in the Authorization Bearer header.
Do not use a query-string API key. The CLI uses the official HTTPS API endpoint;
`TMDB_API_BASE_URL` overrides are unsupported. Tokens belong outside source,
browser configuration, database rows and verification output.

```bash
npm run db:migrate:dev
npm run db:import:tmdb -- --help
npm run db:import:tmdb -- --ids 550,603
# Rerun the same IDs to refresh retained metadata:
npm run db:import:tmdb -- --ids 550,603
```

`--ids=550,603` also works. IDs must be safe positive integers; repeated values are
deduplicated. Specify the flag once. The command reports inserted/updated counts
and local/provider IDs; failures exit nonzero. Paths containing spaces work.
English (`en-US`) is fixed for this milestone.

The importer reuses the migration/seed target guard: explicit isolated-development
mode, loopback host, `rio_dev` or `rio_test` with an optional lowercase suffix, and
no URL query parameters or fragments. It also checks the actual connected server
and database before writes. It cannot import into shared/production targets.

## Retained data contract

| Value             | Meaning / update rule                                                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `films.id`        | Local primary key. Existing screening/booking references retain it. Never replace it with a TMDB ID.                                                                     |
| `metadata_api_id` | Provider identity `tmdb:<positive-integer>`. Reimports match this identity; `rio-demo` and other markers are untouched.                                                  |
| `title`           | Importer-owned English title. Required, trimmed, at most 255 Unicode characters. Refreshed on every import.                                                              |
| `description`     | Importer-owned overview. A usable incoming value replaces it; missing/null/blank values preserve retained text.                                                          |
| `artwork_url`     | Importer-owned poster URL from TMDB configuration plus size and poster path. Missing/null/blank values preserve retained artwork. New films without artwork retain null. |

No duration, release date, genres, screenings, prices or other records are imported.
All requested movies are fetched and validated before one database transaction.
The unique partial index in migration `0007` prevents duplicate TMDB identities;
ordered writes avoid opposite batch-order deadlocks. The append-only migration
reports duplicate/malformed existing TMDB markers and refuses ambiguous data.
It does not delete, merge or reassign existing films. Never modify an applied
migration to bypass its checksum.

Missing credentials, invalid required fields, 401/403, 404, exhausted 429/5xx,
network failures, timeouts and malformed responses fail the import. Retries are
bounded (one retry by default, at most two); retry delays are capped. Database
writes have a five-second lock timeout and 30-second statement timeout. Any failed
write rolls back the entire batch, including prior updates. Raw network/database
errors and upstream response bodies are omitted from CLI errors.

## Verification

```bash
node --test tests/tmdbImport.unit.test.js tests/tmdbImport.cli.test.js
npm run test:postgres
# Requires a real TMDB token and CREATEDB on the isolated local role:
npm run verify:tmdb
```

Plain `npm test` skips database suites without explicit test connection variables.
`test:postgres` loads `.env`, uses all migrations and exercises real PostgreSQL
idempotency, concurrent imports, actual late write rollback, migration preflight,
screening references and API response contracts. Import tests create their own
uniquely named database and fixtures; they do not update/delete fixed movie IDs
in your development database.

`verify:tmdb` creates a disposable local database, applies migrations, seeds demo
fixtures and runs the actual CLI twice for real movie IDs 550 and 603. It checks
row counts, local IDs, optional fields, a screening reference and unchanged demo
rows. It then removes the API process's token and blocks upstream fetches while
checking `GET /api/films` and both `GET /api/films/:id` responses. Credentials and
child output are omitted. Successful evidence is written to
`database/verification/tmdb-import-live.json`; the disposable database is removed.
A missing token/connectivity is incomplete live verification, not a passing mock.

To read normally retained development rows, start the backend (`npm start`) and
request `/api/films` and `/api/films/<local-id>`; existing `{success,data}` envelopes
and `artwork_url` column names are unchanged. A film only appears in screening
selection after scheduling, which is separate work.

## Provider references and attribution

See official TMDB [application authentication](https://developer.themoviedb.org/docs/authentication-application),
[movie details](https://developer.themoviedb.org/reference/movie-details),
[configuration/image URL construction](https://developer.themoviedb.org/docs/image-basics)
and [attribution guidance](https://developer.themoviedb.org/docs/faq).
Before presenting TMDB data/artwork in the UI, add an approved TMDB logo and the
required notice in an About/Credits section: “This product uses the TMDB API but
is not endorsed or certified by TMDB.” Keep TMDB branding less prominent than RIO
and do not imply endorsement. Frontend credits/artwork presentation, commercial
licensing review, staff editing, catalog sync and deployment are separate tasks.
