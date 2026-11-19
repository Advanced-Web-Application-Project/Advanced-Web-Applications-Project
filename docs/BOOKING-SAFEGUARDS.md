# Booking API safeguards (#82)

This corrects the prototype merged in #80. It does not complete checkout,
Stripe or account reservations. The read-only #27 preview endpoint is documented
separately in [seat-selection validation](API-SEAT-SELECTION.md).

## Setup and verification

From `backend/`, with the isolated local database configured as described in
[the database guide](../database/README.md):

```bash
npm run db:migrate:dev
npm run test:postgres
npm start
```

Apply migrations through `0006_allocation_isolation.sql` before starting this version: seat
availability and allocation now share its active-state SQL function. The local
`rio_dev` database had sixteen CEO reservations and no price rows when inspected
on 18 November 2026. No customer prices are invented by migration or seeds.
Checkout returns 503 until exactly one positive integer adult base price is
configured. Authorised price administration remains #61.

The PostgreSQL tests create uniquely named disposable databases, migrate and
seed them, start actual Express servers, then drop those databases. They need a
local development role with `CREATEDB`. Database suites run serially to avoid
resource contention; explicit HTTP/SQL race tests still use concurrent requests
and connections. Synthetic test prices are adult 1200 cents
and a deliberately inconsistent historical child row of 500 cents; checkout must
charge 600 cents for a child. These are test fixtures, not approved live prices.
To regenerate the nonsecret workflow evidence from `backend/`:

```bash
RIO_BOOKING_EVIDENCE_PATH=../database/verification/booking-safeguards.json npm run test:postgres
```

The [recorded workflow](../database/verification/booking-safeguards.json) follows
actual HTTP city → screen → movie → screening → hold → conflict → release for
Oulu and Tampere, with both capacities. It records IDs, counts, amounts and
statuses, never a hold token, hash, contact address or connection URL.

## Customer API

All responses retain `{success,data}` on success or `{success:false,error}` on
failure. Booking failures add a stable `code`; selection conflicts also include
`details` from the shared rules. Successful booking responses use `Cache-Control:
no-store`. Examples below illustrate shapes; obtain actual IDs from browsing and
seat endpoints, rather than assuming display labels are database IDs.

```http
POST /api/bookings
Content-Type: application/json

{
  "screeningId": 9,
  "seatId": [42, {"seatId": 43, "category": "child"}],
  "clientEmail": "customer@example.test"
}
```

The existing `seatId` array name and integer/adult shorthand remain supported.
IDs must be JSON integers from 1 to 2147483647, with 1–210 unique place IDs.
Contact email is required; there is no fabricated default. Categories are adult
or child, case-insensitive. Company requests require their future authorised
workflow and are rejected here. Client amounts, status and role are ignored.

A successful request returns 201 and `data` containing:

```json
{
  "bookingId": 123,
  "screeningid": 9,
  "status": "hold",
  "paymentStatus": "unpaid",
  "expiresAt": "2026-11-18T18:05:00.000Z",
  "holdToken": "<private bearer token returned only on creation>",
  "totalCents": 1800,
  "tickets": [
    { "seatId": 42, "category": "adult", "amountCharged": 1200 },
    { "seatId": 43, "category": "child", "amountCharged": 600 }
  ]
}
```

`bookingId`, `screeningid`, and the ticket amount fields preserve the prototype
response names. This is an unpaid hold, not a paid booking or ticket confirmation.
`expiry_time` stores its five-minute deadline. Each ticket stores its chosen
category and charged amount, referring to the authoritative adult base price.
Child price is exactly half of adult price; conflicting historical child rows
are ignored. An odd adult cent amount with child tickets returns 503 until a
rounding policy is agreed. Missing or duplicate adult base prices also return
503, without partial allocation. The legacy `GET /api/prices` remains a raw
configuration read; it is not an authoritative checkout quote.

Wheelchair places use the same adult/child prices as seated places, confirmed
18 November 2026. Their availability is checked, but the isolated-seat rule does
not apply in that separate zone.

```http
DELETE /api/bookings/123
Authorization: Bearer <holdToken from creation>
```

This releases only the owned customer hold, by changing status to `expired`.
Tickets and booking history remain. Repeating an owned release succeeds without
further changes. No token returns 401; wrong token or unknown hold returns 404.
Paid/company records return 409 even with a previously valid hold token. Legacy
bookings without ownership credentials cannot be released through this route.
CEO release stays disabled. There is no general cancellation API in this fix.

Hold tokens use 32 random bytes, are returned only once and stored only as SHA256
hashes. Send them in the Authorization header, never URLs or logs. The future
checkout UI must keep them private. Tokens do not grant payment or CEO authority.

`GET /api/bookings` and its optional `?screeningId=9` preserve the list envelope,
booking ID, film title, screening time and `seat_id` array. `booking_type` is
restored; status and stored expiry are additive. Lists expose no guest email,
ownership token or hash. Staff/account access control remains future work.

## Allocation guarantees and integration

- Parse input before obtaining a connection. Unknown screenings return 404;
  started screenings and invalid selections return 409. Malformed input returns 400. Unexpected database errors return a generic 500 without SQL/secrets.
- Lock the screen, then screening, before reading availability and validating the
  complete selection. Hold and tickets commit together. Every error rolls back
  and returns the connection. A screening relocation cannot silently change the
  inventory used for validation.
- The pure `seats/seatSelectionValidation.js` module is shared with #27. This fix
  takes only that module from the preserved #27 work; its preview route remains
  separate. Validate physical rows/columns, not arithmetic on skipped display
  labels or global database IDs.
- Active holds count until the stored deadline. Reject only newly created
  internal single free gaps. Pre-existing gaps are not this customer's
  responsibility; edge singles and two or more consecutive free places pass.
- Inventory must contain all configured positions. Unknown, foreign-screen,
  CEO-reserved or currently occupied places fail without partial writes.
- Availability and database guards share `booking_blocks_place`: CEO, paid and
  company-invoiced allocations block; hold/reserved block until their stored
  deadline; missing legacy deadlines fail closed; explicit expired records free
  places while retaining history. One screening never occupies another's places.
- Database triggers reject duplicate active tickets and conflicting booking
  reactivation, including deadline extension. Conflicts use SQLSTATE 23505;
  deadlock, serialization and lock-timeout errors become retryable HTTP 409.
  Existing CEO protections continue to own seat 1 and their error contracts.
- Migration preflight refuses pre-existing active duplicates and rolls back all
  pending DDL. It never guesses which paid record to cancel. Inactive history is
  preserved, with unknown legacy ticket categories left NULL.

Current locking is deliberately conservative: shows sharing a screen serialize
allocation on that screen. The API contract and rules must remain consistent;
lock granularity, module layout and token hashing are implementation choices.
Future account, staff, company and payment writers must use the same lock order
and transactional validation, not just rely on ticket exclusion triggers. The
triggers prevent duplicate active allocations; they are not a general gap-rule
engine for arbitrary manual SQL.

Migration 0006 requires READ COMMITTED for booking/ticket inserts and updates.
The HTTP repository explicitly selects it, independently of database defaults.
Other isolation modes return SQLSTATE 40001 before writes; callers must retry
with the supported isolation and revalidate. This prevents a stale snapshot from
bypassing lock-then-read guards. Schema inspection/read-only transactions may
still use repeatable read. Existing migration 0005 is preserved unchanged.

## Acceptance evidence and deferred work

`backend/tests/bookings.test.js` reproduces all eight #82 findings, tests private
release and retained history, rollback after the first ticket, concurrent same
place and jointly invalid same-row selections, direct SQL races/reactivation,
missing pricing and conflict-safe migration adoption. Pure tests cover both
capacities, snake rows, skipped labels/physical row 13, old gaps, edges and
wheelchair exemptions. Existing migration, inventory, availability and CEO suites
remain part of `npm run test:postgres`.

The #27 public preview exposes the same rules without allocation. The #56
[seat map](SEAT-MAP.md) consumes it; full summary and checkout integration remain
separate. Remaining work belongs to existing tasks:
#62 account ownership/idempotency and all other allocation writers;
#63 verified payment versus expiry races; #41 Stripe; #61 authorised price
settings and rounding; #76 CEO-only release; full summary and checkout UI. No paid
state or payment simulation is exposed by this patch. A checkout hold itself is
not a pay-later reservation: the latter still requires an account, eligibility
at least three hours before showtime and a stored billing deadline two hours
before it. The immediate-payment requirement for six or more remains unchanged.

The legacy timestamps are Helsinki local `timestamp without time zone`; this
patch returns the derived hold deadline as an ISO instant but does not migrate
all stored timestamps. Ambiguous clock-change hours need a separate timestamp
migration. Shared/CSC databases and deployment remain unverified and untouched.
