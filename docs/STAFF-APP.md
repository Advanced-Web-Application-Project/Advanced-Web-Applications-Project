# Staff application and sessions — #58/#97

## Delivered boundary

`admin-frontend/` is an independent React/JavaScript/Vite app with its own lockfile,
commands, styles and production output. `features/session/` owns identity state,
API operations, lifecycle and sign-in UI. `routes/`, `layouts/` and `pages/` compose
that feature; `shared/services/apiClient.js` owns credentialed JSON transport.
There is no copied customer application or second booking/data implementation.

Screenings is the protected landing page and the only navigation link. It states
that operational screening/reservation tools are not available yet. #65 supplies
the actual city-scoped list and occupancy. #59/#60/#61/#66 supply later business
controls. Revenue metrics, public registration/password recovery and customer
sign-in are outside this milestone.

#58 mentions administrator Films/Prices navigation and also requires working
links only for delivered pages, with no unused future pages. The latter governs
this foundation: add those administrator-only links with the corresponding real
features. Cashiers must never gain those permissions. This reconciles the issue's
target navigation with its present delivery boundary; no fake operational page
is counted as a finished feature. Existing documentation describing staff UI as
future work is superseded for this session shell only.

## Shared contracts

The app consumes the existing [#35 staff API](API-STAFF-AUTH.md) without changing
its schema or response format. Express/PostgreSQL own credentials, current
permissions, assigned city, revocation and eight-hour absolute expiry. The browser
checks `/api/staff/session` before rendering private content or requesting any
workspace metadata. Identity is limited to server-issued user ID, role, city ID,
expiry and an in-memory CSRF token. A cashier's display city name comes from the
existing `/api/cities` read after authentication; this label does not authorize
access. Backend services/SQL still enforce city boundaries.

Transport uses `credentials: include`, `cache: no-store`, bounded timeouts, no
redirect following and no automatic retry. Login sends JSON and `X-RIO-Staff: 1`;
logout sends the session CSRF token. HttpOnly cookies remain browser-managed.
No password, bearer credential or identity cache is written to browser storage.
Passwords leave form state before the request completes. API configuration is
public and contains no credentials. No external fonts, images or services are
required by this shell.

Future feature writers must use the shared session-aware transport, existing
backend services and authoritative IDs/prices/deadlines. A protected 401 clears
identity, cancels requests and returns to sign-in. Successful reauthentication
never replays a mutation; the user must review and submit it explicitly. Feature
403 responses remain permission failures, distinct from session expiry. Booking
idempotency and specific writer review screens belong to their actual features.

## Session recovery and accessibility

The form supports local validation, pending state, generic invalid-credential
errors, server throttling and an explicit session check when a login outcome is
unknown. Passwords are not retained for retry. Logout clears private UI before
its response; if the response fails, it offers explicit sign-out retry or a
server session check without claiming logout succeeded.

Blur, page hiding/cache transitions and cross-tab identity-change notifications
hide/clear private content and cancel old requests. Focus/visibility/page restore
rechecks the server before showing the workspace. Late replies cannot restore a
previous identity. BroadcastChannel carries only a change notification; receivers
read identity from the server. Visible authenticated pages also recheck every
60 seconds. Background timers may be throttled by browsers; focus revalidation
and backend enforcement remain authoritative. A restored page never authorizes
from a stored role. Future editors must account for revalidation unmounting the
workspace; no editor is delivered here.

Only `/screenings` is accepted as a return destination. External, protocol-relative
and undelivered paths fall back to it. Authenticated unknown URLs have a working
not-found screen. Labels, alerts, heading focus, skip link, keyboard submission,
visible focus styles and responsive navigation support keyboard/narrow screens.

## Verification — 24 November 2026

See [sanitized evidence](../admin-frontend/verification/session-ui.json) and
[setup/commands](../admin-frontend/README.md). The base is main `416c24b`; no commit,
push, deployment or GitHub field changes were performed by verification.

- Independent clean install, lint, formatting, 31 focused tests and production
  build pass. The built artifact also starts on preview port 4174 and serves
  `/screenings`, `/sign-in` and `/missing` as SPA entries (HTTP 200); authenticated
  browser checks used the development proxy, not preview. Node tests exercise the session model with controlled responses and
  transport through a real local HTTP fixture; React tests use mocked fetch in
  jsdom. They are not real PostgreSQL or deployed evidence.
- A real browser used Vite on loopback 5184, Express on 3184 and a newly created
  disposable PostgreSQL 18.7 database migrated through 0010. Existing browsing and
  inventory seed commands supplied repeatable fixtures. Three accounts were
  provisioned through the real staff provisioning service with transient random
  passwords: administrator, Oulu cashier and Tampere cashier. No simulated login
  or identity endpoint was used in this workflow.
- Browser checks passed: anonymous direct route; all three role/city displays;
  cookie-backed refresh; CSRF-protected logout; logged-out direct/back navigation;
  actual stored expiry rejection; CLI account disable/revocation; external return
  rejection; not-found navigation; and cross-tab administrator-to-cashier identity
  replacement. Initial sign-in once reached the unknown-outcome state; explicit
  session reconciliation/re-entry and subsequent role workflows passed. Its
  transient cause was not isolated; no automatic credential replay occurred.
- Keyboard Tab/Enter and a 390 × 844 viewport were verified. Document width was
  390 pixels, with no horizontal overflow. Screenshots contain no credentials.
- Snapshot hashes for cities, screens, films, screenings, seats, bookings, tickets
  and prices matched before/after. The disposable database, servers and private
  generated credential file were removed. Retained `rio_dev` and CSC were untouched.

To repeat against fresh data, use the database guide's disposable PostgreSQL
recipe with a unique `rio_test_staff_ui_*` database, apply current ordered
migrations, run browsing/inventory seeds and provision the three roles with hidden
CLI prompts. Configure the exact local staff origin and a private random backend
secret, then follow the browser checks above. Expiry verification may adjust only
that disposable fixture's stored session deadline; never alter shared sessions.
Drop only the named disposable database after verification. Unit tests reproduce
lost responses, 429, 403, cancellation, page-cache transitions and no-replay cases
without fault injection into any retained database.

| Criterion | Evidence / result |
| --- | --- |
| #58 independent tooling and artifact | Own package/lockfile, clean install, checks/build and real dev startup pass. Dockerfile/nginx supplied; image execution unverified. |
| #58 feature boundaries, public configuration | Session feature and shared transport; no backend/customer changes or secret configuration in browser code. |
| #58 navigation and presentation | Responsive gold/red/black Screenings shell; undelivered Films/Prices links intentionally wait for #59/#61. |
| #58 keyboard, states and protected integration | Browser keyboard/mobile/direct/not-found checks; component loading/failure tests; real backend identity bootstrap. |
| #97 form and private credentials | Component validation/pending/generic failure/throttling/unknown-outcome checks; real three-role sign-in; no persisted credentials. |
| #97 recovery, logout, expiry and revocation | Real browser/Express/PostgreSQL checks, cross-tab account change and controlled stale-reply/403/cache tests. |
| #97 no automatic mutation replay | Model test observes one submitted write across 401 and reauthentication; actual business write UIs remain their own features. |
| #97 refresh/back/direct/return/mobile | Real browser checks passed; external return stayed on internal Screenings. |

No Rahti deployment, actual TLS/ingress/browser third-party-cookie acceptance or
external-provider verification is claimed. #35 remains linked with Refs pending
its hosted criterion; #47/#67 own CI/runtime evidence. This foundation does not
complete #15/#14 or the staff operational MVP.

## Approved retained-local setup follow-up — 24 November 2026

The user's running app initially returned `503 STAFF_UNAVAILABLE`: the existing
backend had no staff origin or signing secret. This is a disabled service, not a
network failure. The UI now reports that staff access has not been enabled and
supports rechecking; a focused component test covers recovery to sign-in without
fetching/rendering private content. Other session-check failures use a neutral
verification message rather than asserting a network diagnosis.

After explicit user approval, migrations 0009 and 0010 were applied to the
existing isolated local database. Before/after row hashes matched for cities,
screens, films, screenings, seats, bookings, tickets, prices and existing users.
No records were reset, seeded, reassigned or deleted. Backend ignored `.env` now
contains the exact staff origin `http://127.0.0.1:5174` and a private generated
session secret; the existing customer origin was preserved. The local nodemon
backend was restarted to load these values. Real direct/proxied current-session
requests now return 401 `STAFF_AUTH_REQUIRED`, allowing the sign-in form.

No retained staff account was invented or provisioned. The user creates the
intended local account through the existing hidden terminal password prompt in
the provisioning guide. This is separate from the earlier disposable three-role
browser test and does not change the original evidence's data-preservation claim.
The follow-up suite passes 32 tests (15 Node, 17 React), lint, formatting and build.
