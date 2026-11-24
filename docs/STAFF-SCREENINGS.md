# Staff screening list — #65 first milestone

## Scope

The staff landing page now lists screenings with permitted city, inclusive
Helsinki date/range and screen filters. It replaces the #58/#97 landing shell.
Film/start/city/screen and separate seated/wheelchair availability are real backend
reads. This is partial progress under #13 → #32 → #65; use **Refs #65**, not Closes.

Booking/contact details, individual occupancy states/maps, detail navigation and
manual reservations are deliberately absent. They remain later #65 slices and
#66 respectively. There are no dead detail links or simulated operational data.
Films/Prices navigation stays with their delivered administrator features.

No schema migration is needed: current migrations through 0010 provide the data,
shared occupancy predicate and authentication. Customer browsing/checkout
contracts and source remain unchanged. The pre-existing uncommitted provisioning
guide correction is preserved: the staff frontend is now implemented.

## Protected API

```http
GET /api/staff/screenings?dateFrom=2026-11-25&dateTo=2026-11-26&cityId=1&screenId=1
```

Requires the existing #35 current staff session and approved staff origin/referrer.
Every response has `Cache-Control: no-store`. No new bearer token or permissions
store is introduced. A current server-branded actor must have `screenings:read`.
The feature's route/service/repository live in `backend/src/features/screenings/`.
`GET /api/screenings` retains its existing public/customer behavior and filters.

| Filter | Meaning |
| --- | --- |
| `dateFrom` | YYYY-MM-DD, defaults to the server's current Europe/Helsinki date. |
| `dateTo` | Inclusive date, defaults to `dateFrom`. At most 31 calendar days including both endpoints. |
| `cityId` | Optional database ID. Administrator can choose either city or all; cashier's assigned city is always enforced. |
| `screenId` | Optional database ID, validated against current screen/city and actor scope. |

Reject malformed/repeated/array/bracketed filters, invalid real calendar dates,
reversed/oversized ranges and unknown filter keys with 400
`INVALID_SCREENING_FILTER`. Foreign city or screen filters return 403
`STAFF_FORBIDDEN`; unknown screen returns 404 `SCREEN_NOT_FOUND`. Conflicting
administrator city/screen filters return 400. Unauthenticated requests return 401;
missing staff configuration and controlled service failures retain existing
staff-error behavior. Errors expose no driver details or booking contacts.

Response `data` contains:

- `filters`: normalized `dateFrom`, `dateTo`, `cityId`, `screenId` (nullable IDs).
- `cities` and `screens`: permitted filter options; cashier receives only their
  city/screens, administrator receives both cities' options even when filtering.
- `as_of`: database snapshot time, including on empty results.
- `truncated`: true when more than 500 rows match. The UI asks the user to narrow
  filters; it never presents the first 500 as the entire matching programme.
- `screenings`: stable chronological order, then screening ID; at most 500.
  Each has `id`, `film_id`, `film_title`, ISO UTC `screening_time`, `screen_id`,
  `city_id`, `city_name`, and `availability`.

`availability` has `as_of`, `inventory_complete`, `seated: {total, available}` and
`wheelchair: {total, available}`. IDs retain their existing meaning; no synthetic
screen numbers or reindexed records are introduced. Screen labels use actual
screen IDs and capacity because the current schema has no separate screen name.
No booking references/contact, credentials, CSRF token or private guest key is
included. The endpoint does not write, allocate or refresh a deadline.

## Availability and time consistency

A single parameterized SQL statement scopes screenings and filter options and
counts places under one database snapshot/clock. It calls the existing
`public.booking_blocks_place` predicate used by customer seat reads and allocation
safeguards. CEO, paid/company-secured bookings and active holds/reservations count
as occupied according to that shared rule; elapsed stored deadlines stop
blocking. Each place is counted once via EXISTS, regardless of retained ticket
history. Another screening on the same screen has independent availability.

Totals remain 100/200 seated including protected seat 1, plus ten W1–W10 spaces.
If either inventory count is incomplete, both available counts are null and the
UI reports that availability cannot be confirmed. Stored charged amounts and
booking/expiry history are never recalculated or changed by this read.

The schema's screening timestamp remains Helsinki wall time. SQL filters the
half-open interval from `dateFrom` midnight through the day after `dateTo`, then
explicitly interprets screening timestamps with `AT TIME ZONE 'Europe/Helsinki'`
before producing ISO UTC instants. The browser formats them explicitly in Helsinki.
This introduces no scheduling/DST-input policy or schema conversion; scheduling
ambiguity handling remains #60. Actual midnight/DST boundaries use calendar days,
not a fixed 24-hour duration added to a UTC instant.

## Frontend behavior

The feature lives in `admin-frontend/src/features/screenings/`; its page composes
the feature through the existing protected routes. It uses the shared
session-aware client and never authorizes from a form value. Cashier City is
fixed; foreign URL manipulation still fails at the backend.

Filters are URL parameters and survive refresh/back navigation. Apply submits the
whole chosen filter set; changing city clears a conflicting screen. Query changes
hide previous results immediately, abort old requests and discard late replies.
Manual refresh and a visible-page 30-second refresh update counts/freshness.
Automatic list refresh pauses while focus is in the filter form. Existing staff
focus/page-restore revalidation clears stale identity before refetching the list;
background timers can be throttled. A read never promises that places are held.

Loading, empty, retry/reset, forbidden, incomplete-inventory and truncated states
are explicit. Keyboard labels/Tab/Enter and responsive cards work at narrow
widths. macOS/WebKit selects and date fields use scoped appearance normalization,
matching 52-pixel control heights and visible dark-theme picker icons. Native
menus, date pickers and keyboard focus remain available. Booking details and
allocation controls are absent until implemented.

## Verification — 24 November 2026

Base remote main `d44bc9a` / PR #102 was verified before branching. Commands:

```bash
cd backend
npm run test:postgres
cd ../admin-frontend
npm test
npm run lint
npm run format:check
npm run build
```

Backend tests use the configured isolated local connection only as a control
connection, creating/dropping their own databases; they never seed/reset retained
records. The existing test command now discovers `staffScreenings.test.js`.
It includes real sessions for all three roles, direct unauthorized/wrong-city
reads, combined filters and comparison with the public customer availability API.
Both capacities cover CEO, paid, company-invoiced, hold, unpaid reservation,
expired state and elapsed deadlines. Paid/company entries are isolated read
fixtures; no provider/payment processing is claimed. Separate unit checks cover
strict calendar/ID/range parsing, Helsinki day rollover and spoofed actor denial.

React tests use mocked fetch/jsdom to check loading, combined filters, fixed
cashier city, empty/incomplete/truncated results, retry, aborted/stale replies and
timed refresh. Existing session tests now mock the new delivered list read; they
continue to check privacy, expiry/revocation and logout. These are distinguished
from the real local workflow below.

Real browser → Vite 5185 → Express 3185 → disposable PostgreSQL 18.7 checks passed:

- Default today/empty state, administrator both-city list, combined city/date/screen
  filters, URL-preserving reload, and both city cashier lists.
- A guest quote and three-place hold (two seated plus W1) were created through the
  real shared booking API before staff reads. Staff and customer API both reported
  seated 97/100 and wheelchair 9/10 for that screening; another screening on that
  screen remained 99/100 and 10/10. A 200-seat screen reported 199/200 plus 10/10.
- Oulu cashier's city was fixed and a direct Tampere URL was denied without
  results. Tampere's real cashier date-range list and logout also passed.
- Mobile 390 × 844 viewport had no horizontal overflow (document width 375 ≤ 390
  including native scrollbar); Tab focused Apply filters and Enter submitted it.

All 172 backend tests pass with no skips; staff tests total 40 (15 Node, 25 React).
Lint, format check, production build and diff whitespace checks pass. Existing
customer frontend source is untouched; backend regression checks include actual
customer browsing/selection/quote/hold/release compatibility. No external provider,
container/image execution or deployed Rahti behavior is claimed.

Snapshot hashes for cities/screens/films/screenings/seats/bookings/tickets/prices
matched before/after staff browser reads (the initial real guest hold is part of
that fixture baseline). The disposable database/servers and private generated
credential file were removed. Your retained local database/accounts/configuration
were not altered by this milestone. See [sanitized evidence](../admin-frontend/verification/staff-screenings.json).

| Agreed milestone criterion | Result |
| --- | --- |
| Today and permitted city/date/range/screen filters | Implemented; parser, real role/filter API and browser checks pass. |
| Film/start/screen and separate availability counts | Implemented; both capacities and customer parity verified. |
| Backend city authorization | Enforced in service and SQL; forged filters/direct reads rejected. |
| Loading/error/empty/freshness/refresh and stale reply handling | Component checks plus real empty/refresh/filter/browser workflow pass. |
| Representative real layers, keyboard/mobile and docs | Verified as above, fixtures cleaned up, commands/contracts recorded. |

Next concrete slice: screening detail with a protected occupancy map and narrowly
scoped booking/contact reads, preserving the list/filter return context. #65
remains open until all its criteria pass. #66 reservation writes and #47/#67 hosted
checks remain separate. No GitHub fields, commits, pushes or branches were changed
by the implementation agent.
