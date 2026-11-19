# Seat-selection validation (#27)

## Endpoint

```http
POST /api/seats/validate
Content-Type: application/json

{"screenId":1,"screeningId":9,"seatIds":[2,3]}
```

All IDs are positive JSON integers through 2147483647. Unlike GET query strings,
JSON body IDs are numbers, not strings. `seatIds` is a non-empty list with no
duplicates and at most 210 entries (200 seated plus ten wheelchair places).
Only these three body keys are accepted. IDs identify database places, not
printed seat labels. There is no six-place limit on selection; the payment
requirement for large orders belongs to checkout.

A checked selection returns HTTP 200, including a rejected customer choice:

```json
{
  "success": true,
  "data": {
    "screen_id": 1,
    "screening_id": 9,
    "as_of": "2026-11-16T12:00:00.000Z",
    "seat_ids": [2, 3],
    "valid": true,
    "errors": []
  }
}
```

A rejection keeps `success:true` (the check ran), sets `valid:false` and explains
it in `errors`. For example, choosing seat 3 while seat 1 is CEO-reserved leaves
seat 2 isolated. The error uses the **unselected gap place's database ID**, not
its display number:

```json
{
  "code": "ISOLATED_SEAT_GAP",
  "message": "This selection leaves seat 2 alone in row 1. Choose an adjacent place or change the selection.",
  "seat_ids": [2],
  "row_label": 1
}
```

These IDs are illustrative. Actual captured responses are in
[seat-selection.json](../database/verification/seat-selection.json).

| Condition                                                     | HTTP / result                                                              |
| ------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Malformed/empty/duplicate request IDs or unexpected body keys | 400; `success:false`, `code:INVALID_SELECTION_REQUEST`, `error`.           |
| Unknown or mismatched screen/screening pair                   | 400; `code:INVALID_SCREENING`, existing membership message.                |
| Unknown or foreign-screen place IDs                           | 200; `valid:false`, `SEATS_NOT_IN_SCREEN`.                                 |
| CEO-reserved place                                            | 200; `valid:false`, `CEO_RESERVED`.                                        |
| Other occupied/held places                                    | 200; `valid:false`, `SEATS_UNAVAILABLE`.                                   |
| Missing/duplicate/invalid physical positions                  | 200; `valid:false`, `INVENTORY_INCOMPLETE`.                                |
| New internal single-place gap                                 | 200; `valid:false`, `ISOLATED_SEAT_GAP`, affected gap IDs and display row. |
| Unexpected database failure                                   | Safe 500; `code:VALIDATION_FAILED`, retry message, no private SQL details. |

The existing application middleware handles invalid JSON and primitive JSON
bodies (400), and oversized JSON bodies (413). These errors use the generic
application error envelope, without the validation-specific codes above. Existing
GET routes and their envelopes are unchanged.
Public responses never include customer contacts, ownership or hold credentials.

## Agreed gap policy

- Evaluate the complete selection together, not each click separately.
- Occupied means the screening-specific state from #55: active checkout holds
  count until their stored deadline; expired allocations do not.
- Reject a newly created single available place between unavailable neighbours
  in the same physical row. Side hallways are outside the ten-seat block.
- Single available places at either row end and runs of two or more are allowed.
- Customers are not responsible for pre-existing gaps. Compare the before and
  after states; do not require an existing isolated place to be filled.
- Wheelchair spaces W1–W10 follow membership/availability checks only. They are
  a separate zone and do not participate in the isolated-seat rule.

Examples with CEO seat 1 unavailable:

| Existing seated occupancy     | Complete selection | Result                                                          |
| ----------------------------- | ------------------ | --------------------------------------------------------------- |
| Seat 1                        | 3                  | Reject: creates gap at 2.                                       |
| Seat 1                        | 2 and 3            | Allow.                                                          |
| Seats 1, 5 and 6              | 7                  | Allow.                                                          |
| Seats 1, 5 and 6              | 8                  | Reject: creates gap at 7.                                       |
| Seats 1, 5 and 6              | 7 and 8            | Allow: whole-selection evaluation.                              |
| Seats 1, 5 and 6              | 9                  | Allow: 7/8 stay together and 10 is an edge.                     |
| Seats 1 and 3                 | 9                  | Allow: pre-existing gap 2 is not the customer's responsibility. |
| Seats 1 and 3                 | 5                  | Reject only new gap 4, not existing gap 2.                      |
| Empty row 2                   | 14 and 11          | Reject: physically isolates label 12 despite skipped label 13.  |
| Empty row 2                   | 14 and 12          | Allow; label 11 remains at the row edge.                        |
| Wheelchair W2 and W4 occupied | W3                 | Allow; no wheelchair adjacency rule.                            |

Screening reads honour the system CEO ticket, not global seat ID 1 or an
unconditional inventory flag. Future authorised CEO release remains #76; this
validator will follow released screening allocation state. It adds no release
endpoint or administrative override.

## Reuse and consistency

The service parses the request and obtains one server-owned availability snapshot
through the existing repository. It checks complete physical positions, screen
membership, protected/occupied places and then gaps. An invalid place list is
reported before adjacency feedback, avoiding misleading secondary gap errors.

`seatSelectionValidation.js` contains pure rules. `parseSelectionRequest` checks
request shape/IDs; `validateSeatSelection` accepts already parsed IDs and a
server-owned snapshot. It neither reads a database nor writes anything. Rows are
ordered by `physical_row`/`physical_column`; snake labels, skipped 13 and database
ID order do not define adjacency. Returned display labels are for feedback only.

Database, availability API, validator and UI must agree on screening/place
IDs, physical positions, active allocation states and the gap policy. Module
names, grouping and internal sets/maps are implementation choices. No new tables,
columns, dependencies, seed copies or allocation routes are needed for this task.
The existing inventory and availability implementations remain authoritative.

A valid preview **does not secure places**. Another customer or hold expiry can
change the state immediately afterward. The booking route, corrected in #82 and
merged in PR #83, already repeats the same pure validation **inside the allocation
transaction** before creating an owned five-minute unpaid hold. See
[booking safeguards](BOOKING-SAFEGUARDS.md). Other future allocation writers under
#62 must follow the same rules and lock order. A browser-supplied hold ID cannot
exempt occupancy. Payment/expiry races, account ownership and idempotency remain
separate tasks. Previews return `Cache-Control: no-store`.

## Verification

Verified on 18 November 2026 against merged PR #83: all 98 backend tests pass
with no skips. The recorded local HTTP walkthrough checks 24 previews across
both cities and all four screens, with database-enforced read-only access and
matching before/after hashes for seats, screenings, bookings and tickets. The
PostgreSQL tests also cover 5/6 occupied and 8 versus 7+8 in disposable fixtures.

From `backend/`, with the existing isolated local configuration:

```bash
npm run test:postgres
npm start
```

Fetch a matching screen, screening and inventory using the existing GET routes,
then send their actual numeric IDs, for example:

```bash
curl -sS http://localhost:3000/api/seats/validate \
  -H 'Content-Type: application/json' \
  -d '{"screenId":1,"screeningId":9,"seatIds":[2,3]}'
```

Replace these sample IDs with those returned by your database. Plain `npm test`
runs independent unit/HTTP checks and skips PostgreSQL tests unless configured;
`test:postgres` enables all suites using disposable test databases.

| #27 acceptance criterion                                          | Verification                                                                                                          |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Reject empty, malformed and duplicate selections                  | Request parser and HTTP tests; invalid bodies make no database query.                                                 |
| Reject unknown, foreign, protected and occupied places            | HTTP/PostgreSQL checks across both cities and capacities.                                                             |
| Use physical adjacency                                            | Reversed input order, snake row 2 and skipped label/row 13 tests.                                                     |
| Reject only new internal single gaps; allow edges and larger runs | Explicit product examples plus an independent run-length oracle across all 59,049 row arrangements.                   |
| Both capacities and combined-selection examples                   | 100/200 layouts, 8 versus 7+8, physical row 13/display row 14.                                                        |
| Preview writes no booking or hold                                 | Before/after snapshots of places, screenings, bookings and tickets for successful/rejected requests and expiry cases. |
| Document contract, errors and commands                            | This guide and recorded real city → screen → movie/showtime → places → validation examples.                           |

Frontend seat maps/listing integration, other allocation workflows, payment handling,
CEO release and shared/CSC deployment remain separate work. Only isolated local
PostgreSQL and the local Express workflow are verified here.

## Frontend consumer — #56

The [accessible seat map](SEAT-MAP.md) now builds complete selections and displays
this endpoint's validation feedback. Selection edits/availability refreshes
invalidate its checked result, and only a current valid response opens its
optional downstream callback. #57 still owns full summary/navigation integration;
this preview never secures places.
