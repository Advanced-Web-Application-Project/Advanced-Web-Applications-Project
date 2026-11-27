# Customer session API

This feature adds optional sign-in and registration for customer-role accounts
to the customer website. Anonymous browsing and guest checkout remain available.
Registration collects email and password only; accounts are active immediately
without email verification. Password reset and account reservation pages are
not included.

## Configuration and migration

Apply current migrations through `0011_customer_sessions.sql` to the explicitly
selected isolated development database. Migration 0011 adds only customer
session and attempt-counter tables; it does not rewrite user or booking data.
Runtime does not create these tables automatically.

| Variable                    | Meaning                                                                                                                                                                                                                 |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CUSTOMER_SESSION_SECRET`   | Optional private random 32-byte canonical base64url value. When absent, customer auth endpoints return 503 while public/guest routes remain available.                                                                  |
| `CUSTOMER_TRUST_PROXY_HOPS` | `0` by default. Set `1` only for a verified trusted ingress hop with direct untrusted access prevented and forwarding headers sanitized. If staff and customer auth are enabled, both must use the same proxy boundary. |

`FRONTEND_URL` is the exact customer browser origin. HTTPS is required in
production; HTTP is accepted only for loopback development. Generate secrets
directly into ignored backend `.env` files; do not print, commit, or expose them
through Vite configuration. Customer and staff session secrets are independent.

## API contract

All responses use `Cache-Control: no-store`. Browser requests use
`credentials: "include"`. Login/logout writes require the exact configured
customer `Origin`; the session read accepts that `Origin`, or a matching
same-origin `Referer` when `Origin` is absent. The customer-specific
`X-RIO-Customer: 1` header is required on login and registration. A successful
identity response is:

```text
{ success: true, data: {
  user: { id, email },
  expiresAt: <ISO instant>,
  csrfToken: <session-bound request-verification value>
} }
```

`GET /api/customer/session` returns the current identity or `401
CUSTOMER_AUTH_REQUIRED`. It does not extend the session deadline. The session
cookie is opaque, HttpOnly, host-only, and limited to eight hours. HTTPS uses
Secure and SameSite=None; loopback HTTP uses SameSite=Lax. Session state and
throttle records are stored in the separate `customer_sessions` and
`customer_login_attempts` tables.

`POST /api/customer/login` accepts JSON `{ email, password }`. Email lookup uses
the normalized login email; only enabled `customer` users with no staff city
scope can authenticate. Unknown emails, invalid passwords, disabled accounts,
staff accounts, and unsupported password hashes receive the same
`401 INVALID_CREDENTIALS` response. A successful login rotates the session ID.
Attempt limits are five per normalized login and 25 per client IP in a
15-minute window. `429` responses include `Retry-After`.

`POST /api/customer/register` accepts JSON `{ email, password }`. Passwords must
be 15–128 characters and are never trimmed or truncated. The server hashes the
password with scrypt, normalizes email for uniqueness, creates only a customer
role with no staff city scope, and immediately establishes the same eight-hour
session. The endpoint returns `201` with the minimal identity response. An
already-used normalized email returns `409 EMAIL_IN_USE`. Registration attempts
are limited to ten per client IP and three per normalized email in a 15-minute
window; password hashing shares the bounded concurrency limit with sign-in.

`POST /api/customer/logout` requires the exact customer `Origin` and the current
`X-CSRF-Token`. It destroys the server-side session and clears the cookie. CSRF
failure returns 403 without signing the user out.

Each current-session check confirms the live database identity, enabled state,
customer role, session version, and absolute deadline. Password/role/enabled
changes revoke existing sessions through the current user version.

Existing customer rows must have a supported scrypt password hash. Password
recovery is not provided; contact the cinema administrator about account access.

## Verification

From `backend/`, run `npm test`; customer auth unit/config tests need no
database, while the HTTP registration/session and schema integration tests run
only when configured with isolated `TEST_DATABASE_URL` and
`TEST_MIGRATION_DATABASE_URL` values. From `frontend/`, run `npm test`,
`npm run lint`, `npm run format:check`, and `npm run build`.
