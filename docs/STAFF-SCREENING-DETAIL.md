# Staff screening detail and occupancy — #65 second milestone

## Delivered scope

The staff screening list now opens a read-only screening detail and physical
occupancy map. Back navigation retains the list's normalized city/screen/date
filters; direct links, refresh and sign-in recovery retain the supported context.
Both capacities and the ten wheelchair places use authoritative existing IDs,
labels and geometry. Available, active hold, unpaid reservation, paid,
company-secured and protected CEO states are distinct in text and color.

This continues #13 → #32 → #65 and the staff integration under #15. It is partial
progress: use **Refs #65**, not Closes. Booking/contact list/detail is still the
next #65 slice. Manual reservations remain #66. No seat-selection, allocation,
release, pricing, account-management or CEO override control is introduced.

## Shared backend contract

```http
GET /api/staff/screenings/:screeningId
```

Requires the existing real staff session/origin protection and a current branded
actor with `screenings:read`. Administrators can read both cities. The actor's
current cashier city is enforced inside the snapshot SQL, not read from query
parameters or browser state. A nonexistent or foreign screening returns the same
404 `SCREENING_NOT_FOUND` and no metadata/map. Forged `cityId` query parameters
cannot broaden access. Malformed/out-of-range IDs return 400; anonymous sessions
return 401. All responses use the existing safe error envelopes and `no-store`.

Response `data` contains:

- `screening`: `id`, `screen_id`, `city_id`, `city_name`, `film_id`, `film_title`,
  and UTC ISO `screening_time`, explicitly interpreted from stored Helsinki time.
- `availability`: existing `summarizeAvailability` response with IDs, database
  `as_of`, `inventory_complete`, and separate seated/wheelchair total/available
  counts. Counts are null if either inventory zone is incomplete.
- `places`: `id`, `screen_id`, `display_label`, `physical_row`, `physical_column`,
  `row_label`, `is_wheelchair`, and `occupancy_state`. No contact, account,
  booking ID, password, CSRF token, private request key or hold token is returned.

| `occupancy_state` | Meaning |
| --- | --- |
| `available` | No currently blocking allocation for this screening/place. |
| `hold` | Active temporary hold under the shared stored-deadline rule. |
| `reserved` | Active unpaid reservation under the shared rule. |
| `paid` | Stored paid allocation. |
| `company_secured` | Stored `company_invoiced` allocation, which blocks the place. |
| `ceo` | Protected system CEO reservation; no ordinary staff release. |

The shared seats repository now has an internal staff-only snapshot projection.
It obtains metadata, physical inventory, active allocations and a single database
clock in one statement, including the cashier city predicate. It reuses
`public.booking_blocks_place` and the existing availability summarizer. Elapsed
holds/reservations and expired status become available without deleting history.
CEO classification takes precedence. There is no independent staff availability
or allocation implementation and no new migration.

Customer seat routes continue using the original projection: their response
fields exclude `occupancy_state` and staff metadata. Public customer browsing,
selection, quote and hold/release behavior is preserved. Existing stored charged
amounts, IDs and deadlines are never rewritten by this read.

## Frontend boundaries and behavior

`features/screenings/` owns the detail component, map, layout/response validation
and shared request hook. `ScreeningDetailPage`/routes compose the feature; the
existing session-aware shared transport owns credentialed requests. The shared
`useScreeningRead` hook now serves both list and detail: path changes cancel old
reads, immediately hide previous results and reject late replies; manual and
visible-page 30-second refresh update the snapshot. The list's obsolete private
request effect was removed rather than copied into another page.

The map now uses local copies of the customer seat shapes, with the approved state-code/label structure,
wheelchair frame and screen styling under the confirmed [UI consistency policy](UI-CONSISTENCY.md).
Staff-only occupancy colours/letters and read-only semantics are retained.
The map places every cell using returned physical columns/rows and display labels,
including snake numbering, row-label 13 omission, seat-label 13 omission, protected
seat 1 inside the seated capacity, and W1–W10 between row 1 and the screen. It
introduces no numbering algorithm. Read-only grid semantics, labels plus state
letters, a text legend, and one tab stop per zone support keyboard inspection.
Arrows follow physical neighbors; Home/End follow the current row. Place focus
pauses the 30-second availability refresh. The existing security session gate
still revalidates identity on focus/cache transitions and periodically; those
checks clear/remount the private view and can return focus to its heading.

The map scrolls horizontally inside its panel on narrow screens. Loading,
not-found/forbidden/error retry, freshness and incomplete-inventory states are
explicit. The frontend checks response identity, state names, geometry uniqueness
and agreement between counts and available cells before rendering. Incomplete
inventory withholds the map, rather than presenting unknown places as available.
A view or focused cell never holds/releases a place and has no write handler.

`safeReturnPath` now accepts only the delivered list/detail paths with bounded
IDs and the four supported list filter keys. External/protocol-relative paths,
backslashes, unknown/duplicate keys and fragments fall back to `/screenings`.
The backend validates the actual dates and scope again. A return destination is
navigation context, never permission. This deliberately extends #97's old
list-only return allowlist for the newly delivered detail feature.

## Subsequent presentation alignment

The user then requested that staff reuse the customer UI through local code
copies. That approved update is implemented and recorded in [UI consistency](UI-CONSISTENCY.md),
including the current wordmark/seat/control measurements and browser evidence.
The original detail measurements below describe the pre-alignment presentation;
its backend contract, permissions and read-only behavior remain current.

## Original detail verification — 24 November 2026

Started on the user's clean `feature/65-staff-screening-detail`, with remote main
`03375bd` / PR #103 verified first. Commands from the repository:

```bash
cd backend
npm run test:postgres
cd ../admin-frontend
npm test
npm run lint
npm run format:check
npm run build
```

The full backend PostgreSQL regression suite passes **172 tests, no skips**.
The existing disposable staff integration suite now exercises the detail API:
all six states, both capacities, strict IDs, anonymous access, both cashiers'
foreign-ID denial (including forged query scope), missing IDs, expiry transition,
incomplete inventory, customer availability agreement and exclusion of private
fields/staff-only state from customer responses. Those checks use real
Express/PostgreSQL sessions. Other unit tests/doubles are not relabeled as real
integration. The suite retains guest quote/allocation/release and inventory
regression coverage; it never resets retained developer data.

Staff tests pass **51 tests: 16 Node and 35 React**. The new React tests use mocked
fetch/jsdom: six text states, 100/200 layouts plus W1–W10, physical keyboard
movement, back filters, detail retry, changed-route cancellation, invalid response
rejection, incomplete layout and manual/paused automatic refresh. Return-path
unit tests cover delivered detail/list filters and redirect injection. No new
dependency or TypeScript is introduced. Lint/format/build/diff checks pass.

A separate real browser → Vite 5186 → Express 3186 → disposable PostgreSQL 18.7
workflow verified:

- Anonymous direct detail → real administrator sign-in → same detail and filters.
- 100-seat map with all six states, 110 cells and W1–W10; seat 1 is CEO.
  A real guest quote/hold allocated seats 2/3 and W1. Paid seat 4, unpaid reserved
  seat 5 and company-invoiced seat 6 are explicitly isolated read fixtures, not
  external-provider or completed business-workflow verification. Summary was
  94/100 seated and 9/10 wheelchair places available.
- Back to the same Oulu/date/screen-filtered list, then the actual View occupancy
  link for the 200-seat screen. Its map had 210 cells, the retained row 21/seat 201
  and W10; direct reload retained the detail/filter return link.
- Keyboard ArrowRight moved from row 10 seat 101 to seat 100; End reached seat 92,
  preserving physical direction across snake numbering.
- At 390 × 844, document width was 375 ≤ 390, while the map had its own horizontal
  scrolling region (333-pixel viewport, 626-pixel content). It did not widen the page.
- Real Oulu and Tampere cashier detail reads. Oulu's forged foreign detail returned
  a safe unavailable message with zero maps/film headings. All three logged out.

Backend integration verifies real expired deadlines becoming available; React
refresh tests verify the changed state rendering. The browser scenario used an
active guest hold rather than pretending to wait out its deadline. No external
provider verification, container execution or deployed Rahti behavior is claimed.

Snapshots of cities/screens/films/screenings/seats/bookings/tickets/prices matched
before/after browser reads. The initial guest hold/read fixtures were part of the
fixture baseline. The disposable database, servers and private credential file
were removed; retained local accounts/configuration/data and CSC were untouched.
See [sanitized evidence](../admin-frontend/verification/staff-screening-detail.json).

| Agreed criterion | Result |
| --- | --- |
| Detail and same-filter return | Implemented; direct sign-in/reload/back/list-link browser checks pass. |
| Six occupancy states, expiry and physical inventory | Implemented; both-capacity real API/customer parity plus map/browser checks pass. |
| Backend city scope and safe failures | SQL-enforced; both cashiers/forged IDs/anonymous/missing/invalid cases tested. |
| Freshness, stale replies and safe refresh | Shared cancellation hook; component route/race/refresh checks, existing focus/session gate. |
| Keyboard/mobile and documentation | Physical navigation, scoped mobile scrolling and actual screenshots verified. |

The remaining #65 acceptance gap is narrowly scoped booking/contact reads and UI,
with stored reference/categories/charged totals/status/deadline and list/detail
context. #66 creation remains separate. No GitHub fields, branches, commits,
pushes or deployments were changed by this implementation agent.
