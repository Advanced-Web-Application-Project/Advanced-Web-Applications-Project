# Staff identity and local provisioning — #33

## Confirmed policy and implementation boundary

The user confirmed email/password sign-in with server-managed sessions on
20 November 2026. This milestone implements the database identity constraints,
password hashing/verification utility and explicit local account-management CLI.
That original slice added no HTTP routes or frontend. The subsequent
[staff session feature](API-STAFF-AUTH.md) now uses these credentials and account
versions for local backend authentication/revocation and city-scoped booking reads.
The separate [staff session shell](STAFF-APP.md) now consumes this identity
foundation. Customer account integration and operational staff features remain later work.

| Role            | `permitted_city_id` | Required staff permission policy for #35 and later features                                    |
| --------------- | ------------------- | ---------------------------------------------------------------------------------------------- |
| `administrator` | NULL                | Both cities; operational reads, films, schedule, prices and eligible manual reservations       |
| `cashier`       | One existing city   | Operational reads and eligible manual reservations in that city; no film/schedule/price writes |
| `customer`      | NULL                | No staff functions; not provisioned or managed by this CLI                                     |

Ordinary staff have no CEO release capability. A schema role or separate website
is not authorization. `GET /api/bookings` is now protected by the
[staff session API](API-STAFF-AUTH.md); that guide separates verified local
behavior from remaining hosted checks. Staff sign-in/navigation is #97; app
foundation is #58.

## Schema and migration adoption

`0009_staff_identity.sql` is append-only. The first eight migrations are unchanged.
A locked preflight rejects invalid role/city combinations, malformed login email
values or case/outer-space duplicate identities, reporting **user IDs only**.
Nothing is merged, reassigned, deleted or silently normalized in the stored
contact field. Failed adoption rolls back the migration and its ledger entry.
Use the read-only audit below for actionable diagnostics; CLI migration failures
omit arbitrary driver details by design.

Existing IDs, `email`, `password_hash`, loyalty progress and referenced booking/
ticket history remain intact. The prior case-sensitive email unique constraint
remains, supplemented by uniqueness across the normalized login field, including
disabled accounts. Existing cashier city foreign keys remain authoritative;
a city deletion that would null a cashier's scope now fails rather than silently
making the cashier unscoped.

| Field                    | Meaning                                                                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `login_email`            | Stored generated `lower(btrim(email))`; database normalization is authoritative. Lookup uses the same SQL expression. Original contact case/spacing is preserved on migration. |
| `is_enabled`             | Account enabled state, initially true; not proof of a supported credential or permission to enter staff operations.                                                            |
| `session_version`        | Positive monotonically increasing integer, initially 1. A database trigger increments it on password, role, city, email or enabled-state changes. It cannot decrease.          |
| `provisioned_at`         | Database timestamp for new CLI accounts; NULL for legacy records because their original provisioning time is unknown.                                                          |
| `credentials_changed_at` | Database timestamp at CLI provisioning/password replacement; NULL for untouched legacy credentials.                                                                            |
| `disabled_at`            | Database timestamp when enabled becomes false; retained across repeated disable and password reset. NULL while enabled.                                                        |

The three timestamps use `timestamptz`. Loyalty-only updates do not invalidate
sessions. Repeated provisioning performs no UPDATE, so it changes no timestamps,
credential or version. No timestamp or historical identity is fabricated for
legacy users. Unsupported legacy password formats are preserved; audit reports
staff IDs needing an explicit password reset. They are rejected by the verifier.

## Local commands

Requires Node.js 22, the existing local PostgreSQL 18 setup and migrations. Use
real terminals for password entry. Keep the database connection only in ignored
`backend/.env`; no staff password is read from arguments, environment variables,
fixtures, files or piped input. CLI diagnostics/results include no login emails,
password hashes or passwords.

From the repository root:

```bash
cd backend
npm run staff:manage -- --help
npm run staff:manage -- audit
```

Audit works with the pre-0009 baseline too. It runs in a repeatable-read,
**read-only transaction**, returning applied migration names and only IDs for
invalid scope/email, duplicate login groups and unsupported staff hash formats.
It does not connect to an additional/shared target automatically. A configured
shared connection can be audited read-only; local write commands refuse it.
An empty database without the baseline users table must first be inspected with
`npm run db:inspect` rather than being treated as a valid account schema.

On the explicitly selected isolated local database only:

```bash
npm run db:migrate:dev
npm run staff:manage -- audit
npm run staff:manage -- provision --email admin@example.invalid --role administrator
npm run staff:manage -- provision --email oulu@example.invalid --role cashier --city Oulu
npm run staff:manage -- provision --email tampere@example.invalid --role cashier --city Tampere
```

These are example login addresses; choose the intended local identities. Cities
must already exist. Each new account asks for a hidden password and confirmation.
Passwords must contain 15–128 Unicode code points; they are not trimmed,
normalized or truncated. Cancellation, invalid length or mismatch writes no account.
Readline history/echo are disabled for entry; Ctrl+C restores terminal state.

Rerun the same role/city/email command to inspect its safe summary without
entering a password. Case and outer-space-equivalent login emails identify the
same record. A conflicting role/city or an existing customer login causes refusal.
A disabled matching account stays disabled. Commands serialize with one another
and with local migrations/fixtures using the existing management advisory lock.
A prompt holds this local management transaction; complete or cancel it before
running another account-management/migration command.

Explicit credential and account changes:

```bash
npm run staff:manage -- reset-password --email oulu@example.invalid
npm run staff:manage -- disable --email oulu@example.invalid
```

Reset replaces the credential and advances its version, but does not re-enable a
disabled account. Disable preserves the user ID and history; repeating disable
is a no-op. There is no role/city reassignment, re-enable or deletion command in
this milestone. Provisioning cannot be used to bypass those boundaries.

All writes enforce the existing `RIO_DATABASE_MODE=isolated-development` guard,
loopback host, explicit `rio_dev`/`rio_test_*` name and connected-database/address
check. No production provisioning, shared migration or reset is performed here.
The migration runner remains a separate explicit command; provisioning does not
apply schema or seed cities automatically.

## Password library and #35 integration

The implementation uses Node 22's maintained built-in `node:crypto` library,
with asynchronous scrypt at **N=131072, r=8, p=1**, a random 16-byte salt and a
64-byte derived key. `maxmem` is bounded to 192 MiB per operation (scrypt needs
roughly 128 MiB at these parameters). Node 22 has no built-in Argon2; this uses
its available scrypt implementation without adding a native dependency.
See [Node 22 crypto documentation](https://nodejs.org/download/release/v22.14.0/docs/api/crypto.html)
and [OWASP password storage settings](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#scrypt).

A versioned encoded value contains the algorithm, fixed cost parameters, salt
and derived key. Verification rejects unsupported parameters, malformed or
noncanonical encoding and oversized input before deriving; comparison uses
`timingSafeEqual`. The function is exported from `staff/staffPassword.js` for #35.
This utility does not authorize an account by itself. Deployment still needs
resource/latency verification with authentication throttling under #35.

#35 must look up logins with the same database normalization, require a supported
verified credential, an enabled staff role and valid city scope, and create a
revocable server session tied to the user ID and current `session_version`.
Every session use must reject disabled accounts, version mismatch and expiry;
logout/rotation/CSRF/origin controls and finite lifetime are now implemented by
[the local #35 backend](API-STAFF-AUTH.md). Its account checks enforce version
changes on subsequent requests. Migration 0010 adds its real session store;
no placeholder login or staff frontend is claimed.

Staff writes in #59/#60/#61/#66 must retain the authenticated actor user ID and
a database timestamp separately from customer contact and booking ownership.
Their services must receive trusted actor context from #35 and enforce related
record city scope. An assisted reservation's contact remains the customer email;
`bookings.user_id` must not be repurposed to mean the staff actor. Exact audit
column/event layouts belong to the feature migrations; existing history is not
backfilled with invented actors. This CLI is operated through local database
operator access; it does not claim an authenticated staff actor or a full audit log.

## Verification — 21 November 2026

From `backend/`, with the isolated local development cluster reachable:

```bash
npm run test:postgres
# Optional nonsecret test evidence:
RIO_STAFF_PROVISIONING_EVIDENCE_PATH=../database/verification/staff-provisioning.json npm run test:postgres
```

**155 backend tests passed, zero failures/skips**, including real PostgreSQL 18.7
migration, browsing, quote/hold and CEO regressions. New tests verify:

- Fresh role/city/email/version constraints, valid city membership and normalized
  duplicate prevention, including concurrent case/space-equivalent provisioning.
- Pre-0009 malformed scopes, emails and duplicates: ID-only audit and migration
  refusal preserve all legacy rows and the eight-entry migration ledger.
- Valid legacy adoption: IDs, original contact/hash, loyalty, referenced paid
  tickets and stored charged amount remain unchanged. Unknown legacy times stay NULL.
- Administrator and both-city cashier provisioning, real hash verification,
  unchanged reruns, reset, disable and disabled-state preservation.
- Monotonic version invalidation after direct scope/contact/enabled changes and
  independence from ordinary loyalty updates. Existing CEO regression fixtures
  now supply a valid cashier city; CEO restrictions remain covered.
- Unit checks use runtime-generated secrets, actual Node cryptography and command
  validation/target guards. They do not verify future authentication/session HTTP.

A separate **real pseudo-terminal → CLI → feature service → repository → PostgreSQL**
workflow passed 11 command cases using disposable runtime-generated credentials:
three staff accounts, no-prompt rerun, reset with old-secret rejection, disable,
reset/rerun while disabled, mismatched confirmation, Ctrl+C cancellation and
non-TTY refusal. Captured terminal output contained none of the generated secrets.
The final database contained exactly three staff records; its read-only audit
reported no identity or unsupported-credential problems. The database was dropped.
No browser, provider or deployed behavior is claimed by this CLI workflow.

The retained local database was inspected/audited **read-only**: PostgreSQL 18.7,
eight applied migrations, no users, Oulu/Tampere present. Migration 0009 and the
accounts above were applied/created only in disposable tests, not retained
`rio_dev` or CSC. Frontend files are unchanged; no frontend checks were rerun for
this backend/database-only milestone. Changed JavaScript formatting and Git
whitespace checks pass.

See [test evidence](../database/verification/staff-provisioning.json) and
[terminal workflow evidence](../database/verification/staff-provisioning-terminal.json).

## Acceptance and remaining work

| #33 criterion                                                       | Verified result                                                                                  |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Inspect users/history before append-only schema work                | Read-only PostgreSQL inspection plus fresh and legacy migration tests                            |
| Role/city and normalized unique email constraints                   | Fresh invalid/duplicate cases, adoption preflight and real concurrent requests                   |
| Repeatable secret-free provisioning with maintained hashing library | Three roles in actual PostgreSQL and real hidden-terminal workflow; no credential reset on rerun |
| Permission matrix, reset/disable and actor/time requirements        | Documented here; schema version/timestamps are ready for #35                                     |
| Isolated verification and no silent shared writes                   | Disposable database/terminal evidence; retained local database read-only; CSC untouched          |

The #33 implementation merged in PR #100. The [#35 local backend milestone](API-STAFF-AUTH.md)
now supplies sessions and protected booking reads. #58 staff app, #97 sign-in UI,
actual hosted verification and production provisioning remain incomplete.
No parent issue is completed by the identity foundation alone.
No unused frontend/auth scaffolding or duplicate account store was introduced.
