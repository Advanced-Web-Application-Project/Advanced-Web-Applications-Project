# Screening seat availability (#55)

## Requests and compatibility

```http
GET /api/seats?screenId=1&screeningId=9
GET /api/seats/availability?screenId=1&screeningId=9
```

The first request retains `{success:true,data:[...]}`, all inventory fields,
`isBooked` and `isReservedByCeo`, ordered by database place ID. It now excludes
expired allocations from occupancy. Inventory-only `GET /api/seats?screenId=1`
keeps `isBooked=false`; its CEO flag means designation, not occupancy.

The additive availability endpoint requires both IDs and returns:

```json
{
  "success": true,
  "data": {
    "screen_id": 1,
    "screening_id": 9,
    "as_of": "2026-11-16T12:00:00.000Z",
    "inventory_complete": true,
    "seated": { "total": 100, "available": 99 },
    "wheelchair": { "total": 10, "available": 10 }
  }
}
```

This is an illustrative shape. Captured examples are in
[availability.json](../database/verification/availability.json).
Seated totals include seat 1; wheelchair capacity is separate. Counts use unique
physical places, not ticket count, so duplicate historical tickets cannot make
availability negative. Incomplete inventory sets `inventory_complete=false`
and both available counts to `null`; configured totals remain 100/200 and 10.
Missing positions are never advertised as available places.

IDs must be individual decimal integer strings from 1 to 2147483647. Leading
zeros are accepted. Empty, fractional, signed, malformed, repeated and bracketed
values return 400 before database reads. Missing required IDs return 400 with
`<name> query parameter required`. Unknown or mismatched screening/screen pairs
return 400 with `screeningId must belong to screenId`. For compatibility,
unknown inventory-only screen IDs still return 200 with `[]`.

Handled errors keep `{success:false,error:"..."}`. Unexpected database failures
return the existing safe 500 seat error envelope without database details.
Public responses include no guest contacts, booking ownership or hold credentials.

## Stored deadline is the source of truth

Confirmed user decisions on 16 November 2026:

1. Choosing seats changes only local UI state; it does not allocate seats.
   The future UI refreshes availability and reports conflicts.
2. Confirmation must revalidate the complete selection and atomically create
   a five-minute checkout hold. Store its deadline in `bookings.expiry_time`.
3. Pay-later reservations require an account, are allowed at least three hours
   before showtime, and expire two hours before showtime. Store that payment
   deadline in `expiry_time` when creating the reservation. At exactly three
   hours ahead, there is one hour to pay; earlier reservations allow longer.
4. The existing immediate-payment requirement for six or more places remains.
5. Paid tickets stay secured. Company-invoiced bookings remain secured while
   their invoices are outstanding. Default CEO reservations do not expire.

This milestone implements **reads**, not the above future writes. Availability
compares the stored expiry with the database clock. It does not recalculate a
reservation deadline from the screening time or calculate remaining minutes.
Checkout may display a countdown using its own stored deadline and server time.

| Allocation                                    | Blocks a place?                                |
| --------------------------------------------- | ---------------------------------------------- |
| CEO system reservation                        | Yes, when its ticket exists; no expiry.        |
| Paid or company-invoiced booking              | Yes, regardless of a stale expiry field.       |
| Explicitly expired booking                    | No, even if tickets or a future expiry remain. |
| Hold or unpaid reservation with future expiry | Yes.                                           |
| Hold or unpaid reservation at/past expiry     | No. Equality means expired.                    |
| Hold or unpaid reservation missing expiry     | Yes, conservatively; requires data review.     |

Missing deadlines are malformed data, not a promise of unlimited valid hold time.
Future hold/reservation creation must require valid deadlines. Legacy malformed
rows must be corrected through an explicit reviewed change; read requests never
invent a deadline or modify booking history. In particular, a wrongly stored
17:00 reservation deadline is not silently replaced with 16:00 during a read:
creation/rescheduling must enforce the correct two-hour-before-showtime deadline.

Current timestamps are `timestamp without time zone`, interpreted as Helsinki
wall time under the existing application convention. Comparisons explicitly
use `statement_timestamp() AT TIME ZONE 'Europe/Helsinki'`, independent of the
PostgreSQL session timezone. Winter and summer boundaries are tested.

## Consistency and implementation boundaries

A single PostgreSQL statement reads the screen/screening membership, places,
active booking states and one database clock. Both seat rows and count summaries
use that same repository operation. `as_of` identifies the summary's snapshot;
separate HTTP requests can legitimately observe different states as deadlines
pass or allocations change. Every response is observational, never a hold.

Availability belongs to a screening; another screening using the same physical
inventory has independent occupancy. CEO flags for screening reads come from
system booking tickets, not global seat ID 1 or an unconditional inventory flag.
A future authorised release in #76 must remove the screening allocation through
its protected service; reads will then follow allocation state. No release
endpoint, account or authorization bypass is added here.

There is no schema migration, expiry worker, status rewrite or deletion in #55.
Expired ticket history remains. The old unfiltered `findTicketOccupancy` and
separate membership query are replaced by the snapshot operation. Historical
`backend/db.sql` remains a historical baseline, not an additional setup command.

## Verification and remaining work

From `backend/`, after the documented local database/inventory setup:

```bash
npm run test:postgres
npm start
```

In another terminal:

```bash
npm run verify:browsing
npm run verify:inventory
```

The inventory verifier now checks the availability endpoint against returned
seat flags instead of treating every historical ticket as occupied. Run it on a
stable development fixture; concurrent changes between HTTP reads can require
a rerun. Integration tests independently check the state/deadline rules.

Focused tests cover malformed/missing/unknown IDs, all booking states, exact
expiry, five-minute stored holds, missing deadlines, duplicate ticket counts,
screening/city isolation, both capacities, incomplete inventory, privacy, safe
errors, future-release flag semantics and Helsinki winter/summer deadlines.
Real PostgreSQL HTTP examples are recorded in the linked evidence.

#62/#63 own atomic hold creation, deadline validation, expiry/write races and
payment reconciliation; registered pay-later creation belongs to its future
account/reservation scope. #27 owns complete selection validation, #56 the map,
#77 listing count display, #57 the full selection summary, and #76 CEO release.
These writes must reuse the same deadline/state meanings and recheck availability
inside the allocation transaction. Prices, ownership, payment and concurrency
safeguards are not implemented merely by adding a read endpoint.
