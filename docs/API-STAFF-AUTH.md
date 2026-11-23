# Staff session API — #35 local backend milestone

## Scope and status

The backend now provides real email/password sign-in, current-session recovery,
logout and city-scoped booking reads. PostgreSQL owns the session store and
revocation/expiry state; browsers receive an opaque signed HttpOnly cookie.
Customer browsing, selection, quotes and owned guest hold/release stay public
under their existing rules. No customer sign-in or separate staff frontend is
introduced here. Staff app foundation is #58 and session UI is #97.

This is verified local backend behavior, not a deployed Rahti result. The #35
criterion covering actual separate Rahti sites still needs #67 evidence. Keep
#35 linked with **Refs** until that acceptance is verified or explicitly refined;
do not close #19/#4 from this backend milestone alone.

## Configuration and local setup

Apply current migrations through `0010_staff_sessions.sql` to an explicitly
selected isolated database. Migration 0010 only adds session, attempt-counter and
auth-event tables. It does not rewrite users, existing bookings or charged amounts.
Runtime never creates its own session table or falls back to a memory store.
Use [#33 provisioning](STAFF-PROVISIONING.md) for real staff accounts and hidden
password entry. No account/password is hardcoded or self-registered via HTTP.

| Variable                 | Meaning                                                                                                                                         |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `FRONTEND_URL`           | Existing single public customer origin; still required.                                                                                         |
| `STAFF_FRONTEND_URL`     | Separate exact staff origin, no path/list/wildcard. HTTP is permitted only for loopback development, never production.                          |
| `STAFF_SESSION_SECRET`   | Private random 32-byte canonical base64url value, kept only in ignored environment/deployment secret configuration.                             |
| `STAFF_TRUST_PROXY_HOPS` | `0` by default. Set `1` only for a verified single trusted ingress hop with direct untrusted access prevented and forwarding headers sanitized. |

If both staff origin and secret are absent/empty, staff endpoints return 503 and
booking reads remain protected with 401. A partial/invalid staff configuration
fails startup. Customer development still starts with its existing configuration.
With staff enabled, customer and staff origins must differ.

For HTTP development use the **same hostname** for the API and staff browser site,
for example API `http://127.0.0.1:3000`, staff `http://127.0.0.1:5174`. Do not mix
`localhost` and `127.0.0.1` for this cookie flow. Ports may differ. The staff site
is not implemented yet; these are configuration examples, not an existing UI.

From `backend/`, with the existing private local database configuration:

```bash
npm ci
npm run staff:manage -- audit
npm run db:migrate:dev
# Provision the intended local accounts with the #33 guide's hidden prompts.
```

Set `STAFF_FRONTEND_URL` in ignored `.env`. Generate the secret **directly into
that ignored file** without printing it or including it in shell arguments:

```bash
node --input-type=module <<'JS'
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
const path = '.env';
const text = readFileSync(path, 'utf8');
const pattern = /^STAFF_SESSION_SECRET=(.*)$/m;
if (pattern.exec(text)?.[1].trim()) {
  throw new Error('An existing staff secret is set; do not rotate it implicitly.');
}
const entry = 'STAFF_SESSION_SECRET=' + randomBytes(32).toString('base64url');
writeFileSync(path, pattern.test(text) ? text.replace(pattern, entry) : text + '\n' + entry + '\n', { mode: 0o600 });
JS
npm start
```

Do not copy actual credentials, cookies, CSRF tokens or secret values into
`api.http`, source, URLs, logs, screenshots or evidence. Changing the signing
secret invalidates cookies; it is not a routine startup-generated value.
The tests generate their own transient secrets and accounts in disposable databases.
The retained local database was inspected read-only and remains at migration 0008
with no users; this milestone did not migrate/provision it or access CSC.

## Request contract

Staff browser requests use `credentials: "include"`. Do not store a staff bearer
token in local/session storage. Successful identity responses contain only:

```text
{ success: true, data: {
  user: { id, role, cityId },
  expiresAt: <ISO instant>,
  csrfToken: <session-bound request-verification value>
} }
```

The CSRF value is not an authentication credential by itself. It requires the
HttpOnly cookie and allowed origin; keep it in memory and recover it through the
session endpoint after refresh. Password hashes, session IDs, signing secrets,
user email and revocation versions are excluded from this JSON identity.

### POST /api/staff/login

Required headers: exact staff `Origin`, `Content-Type: application/json`,
`X-RIO-Staff: 1`. Body contains `email` and `password`. Extra role/city fields do
not influence identity. Email lookup uses the same PostgreSQL `lower(btrim(...))`
normalization as #33. Passwords are verified by its existing Node scrypt utility.

- 200: verified enabled staff account, new opaque cookie, minimal identity above.
- 401 `INVALID_CREDENTIALS`: same message for unknown login, wrong password,
  customer role, disabled account or unsupported legacy credential.
- 403: unapproved/missing origin or invalid sign-in transport/header.
- 429 `LOGIN_THROTTLED` / `LOGIN_BUSY`: bounded attempt/computation limit; retry
  information is in `Retry-After` (conservative 900 seconds or busy retry 5 seconds).
- 503: service/store failure; no raw database details are returned.

Successful sign-in regenerates the session ID and invalidates the previous one.
Password verification is followed by a fresh account/version check, so a reset
or disable during verification cannot silently authenticate stale credentials.
Cookie flags in HTTPS configuration are Secure, HttpOnly, SameSite=None, Path=/,
with `__Host-rio.staff` and no Domain. Local loopback HTTP uses `rio.staff`,
HttpOnly, SameSite=Lax. HTTP staff access from non-loopback peers is refused.
HTTPS mode also requires `req.secure`, with only explicitly configured proxy trust.

### GET /api/staff/session

Returns 200 with current identity/CSRF value or 401 `STAFF_AUTH_REQUIRED`.
It does not renew the deadline. Staff reads require the configured Origin, or
that origin derived from Referer when a same-origin browser GET omits Origin.
Missing/malformed/unapproved Origin/Referer yields 403. Public reads are unaffected.

### POST /api/staff/logout

Requires a valid session, exact staff `Origin` and `X-CSRF-Token` matching the
session-bound value. Successful response is 200 `{success:true,data:{signedOut:true}}`;
the store row is destroyed and cookie cleared. Missing/wrong/noncanonical CSRF
values produce 403 without signing the user out. Expired/revoked sessions produce 401. A storage/audit failure produces 503; recover state through current-session
rather than treating an interrupted logout as a confirmed outcome.

All staff/session and booking-list responses use `Cache-Control: no-store`.
Malformed JSON and bodies above the staff 4 KiB limit retain the global safe
400/413 parser response, without echoing input. Login/logout are the only current
staff writes; there is no public registration, password reset, role editor or CEO action.

## Absolute expiry, revocation, attempts and audit data

- Deadline is **eight hours from sign-in**, based on the database clock. The
  server-held session records user ID, account version, issue time and deadline.
  Account checks enforce the exact duration and deadline independently of store
  cleanup. Repeated reads do not extend database expiry or send a renewed cookie.
- Every authenticated request checks the live user: enabled staff role, valid city
  scope and matching `session_version`. #33 reset/disable, role/city/email changes
  therefore revoke subsequent requests. Requests already authorized may finish;
  future business-write transactions must recheck their actor before committing.
- PostgreSQL `staff_sessions(sid,sess,expire)` is the maintained store's private
  representation, not a public API. Expired rows are periodically pruned by the
  store (roughly 15 minutes); authorization does not wait for cleanup. Shutdown
  closes the store timer and shared pool cleanly.
- `staff_login_attempts` contains domain-separated HMAC keys, window start and
  count, not plaintext email/IP. Atomic fixed windows permit at most **5 attempts
  per normalized login** and **25 per client IP** in 15 minutes, including successful
  sign-ins. They survive process restart and cannot be bypassed by changing case,
  outer whitespace or untrusted forwarding headers. Allowed-IP attempts perform
  bounded cleanup of buckets older than one day. At most two password checks per
  application instance run concurrently. Unknown/unsupported identities consume
  equivalent scrypt work using a transient server-only dummy hash.
- `staff_auth_events` records authenticated user ID, `login`/`logout`, and a database
  `timestamptz`; no cookie, password, CSRF value or contact is recorded. Login is
  acknowledged only after session persistence and audit recording. Successful
  logout destroys the session before its audit write. These two operations are
  not one database transaction; errors give 503 and can require session recovery.
  This is authentication evidence, not a complete cinema management audit trail.

The maintained packages are pinned with a lockfile: `express-session` 1.19.0 and
`connect-pg-simple` 10.0.0. Runtime table creation is disabled. See the
[session middleware](https://github.com/expressjs/session),
[PostgreSQL store](https://github.com/voxpelli/node-connect-pg-simple) and
[OWASP CSRF guidance](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html).

## Booking reads and shared actor contract

`GET /api/bookings[?screeningId=…]` intentionally replaces its former anonymous
behavior. The existing successful list envelope/fields remain compatible, but
callers need a current staff session and allowed origin/referrer.

- Administrator: both-city list or an existing screening filter.
- Cashier: repository SQL always joins the screening's actual screen/city and
  filters to the assigned city. A supplied other-city screening gives 403.
  Unfiltered lists cannot expose another city. Client role/city values cannot
  broaden scope. A nonexistent valid screening gives 404; malformed/repeated/
  bracket-form screening filters give 400.
- No hashes, private hold credentials/fingerprints or customer contacts are added
  to this baseline read. #65 owns richer operational views and their minimal contact needs.

Middleware supplies `req.staffActor`, frozen and branded in server memory from a
current database identity. Booking service requires that trusted actor and checks
`bookings:read`; passing a JSON/body-shaped administrator object fails before SQL.
`requireStaffPermission` is the deliberate interface for future feature services:
administrators get films/screenings/prices writes and eligible reservations;
cashiers get operational reads and reservations only for their actual city.
Unknown permissions, including CEO release, are denied. Endpoint CSRF/origin
checks must accompany every future cookie-authenticated write.

#59/#60/#61/#66 must accept this server actor, revalidate its live version/scope
inside their write transaction, and store actor user ID plus database action time
separately from customer contact/booking ownership. These features are not
implemented by the permission helper; no dummy write routes or audit actors were
invented for them. Keep the established allocation lock order when those writers
are implemented. Current authentication events demonstrate actor/time storage.

## Verification and acceptance — 21 November 2026

From `backend/`:

```bash
npm ci
npm run test:postgres
npm audit --omit=dev
# Regenerate nonsecret HTTP workflow evidence:
RIO_STAFF_AUTH_EVIDENCE_PATH=../database/verification/staff-auth.json npm run test:postgres
```

**169 backend tests passed, no failures/skips**, against PostgreSQL 18.7, including
all existing migrations/CEO/browsing/quote/hold regressions. No frontend source
changed; frontend tests/build were not rerun for this backend-only milestone.
Changed JavaScript formatting and Git whitespace checks pass. Production
`npm audit --omit=dev` reports zero vulnerabilities; the full audit still reports
the pre-existing nodemon/minimatch development advisory, outside this change.

The real **HTTP → Express → PostgreSQL** auth workflow verifies administrator,
both city cashiers, unknown/customer/disabled/legacy identities, forged role/city/
cookie input, exact public identity, cookie rotation, read-only deadline stability,
logout CSRF, account reset/disable and role/city revocation. It verifies just-before
versus at/past expiry by adjusting only disposable test session timestamps, without
waiting eight hours. Persistent throttles and sessions survive local server restart.
Renaming only the disposable session table produces an actual safe 503 and recovery.
The customer path browses, validates seat 2 + W3, quotes €18 adult+child, creates
and releases its owned unpaid hold with charged history retained while staff auth
is enabled. The protected list is verified against actual city joins.

Unit checks separately verify invalid configuration, refusal of unbranded service
actors and bounded concurrent scrypt work (repository doubles). They are not real
PostgreSQL evidence. HTTPS cookie flags and forwarding behavior use simulated
trusted TLS termination over local HTTP; credentialed CORS/preflight is verified
with actual HTTP headers. This does **not** prove browser cookie acceptance on
Rahti or any real ingress/TLS setup. No external provider verification is relevant
or claimed. All fixture databases/servers are removed/stopped; retained `rio_dev`
and CSC data are untouched. See [machine-readable evidence](../database/verification/staff-auth.json).

| #35 criterion                                                           | Local result / remaining acceptance                                                                                                                           |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Login/current/logout, finite expiry and revocation                      | Verified real PostgreSQL/HTTP and provisioning-driven revocation                                                                                              |
| Secure cookies, CSRF, credentialed requests and explicit origins        | Local HTTP plus simulated TLS/proxy/CORS verified; **actual separate Rahti sites remain unverified under #67**                                                |
| Generic failures and bounded attempts without secret disclosure         | Real identities/counters/restart plus bounded-work unit check; no secrets in evidence                                                                         |
| Current staff routes and service authorization                          | Booking reads scoped by actual screening city; spoofing and CEO denial tested; public guest path retained                                                     |
| Anonymous/customer/cashier/admin/expiry/revocation/logout/CSRF examples | Real HTTP/PostgreSQL scenarios, including actual store failure/recovery                                                                                       |
| Trusted actor/time integration interface                                | Booking service and permission interface verified; auth events persist actor/time. Future business writes remain their own #59/#60/#61/#65/#66 implementation |

The agreed local backend milestone is ready for review. Staff UI #58/#97, real
Rahti/TLS/cookie/ingress verification #67 and later domain writers remain deferred.
No deployment, GitHub issue closure, commit or push is implied by these checks.
