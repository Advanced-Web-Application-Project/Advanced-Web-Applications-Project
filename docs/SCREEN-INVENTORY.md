# Screen inventory (#51)

Each Oulu/Tampere screen has 100 or 200 seated places including seat 1, plus ten
separate wheelchair spaces. The four layouts contain 640 places in total.
Inventory belongs to a screen; occupancy belongs to a screening.

## Setup and verification

From `backend/`, using the existing isolated local development configuration:

```bash
npm run db:inspect
npm run db:migrate:dev
npm run db:seed:browsing
npm run db:seed:inventory
npm run db:seed:inventory
npm run test:postgres
npm start
```

In another terminal in `backend/`:

```bash
npm run verify:browsing
npm run verify:inventory
```

The second inventory seed must report `inserted: 0` for every screen. Migration
`0004_screen_inventory.sql` follows immutable versions 0001–0003. Never edit
applied migration files or use historical `backend/db.sql` as a second setup
path. Browsing fixtures create cities/screens/films/showtimes; the inventory
command fills only the four existing city/capacity screens. Missing or duplicate
target screens are refused rather than guessed or automatically deleted.

Both write commands require `RIO_DATABASE_MODE=isolated-development`, a loopback
connection and an approved `rio_dev`/`rio_test` database name. They also verify
the connected target. They do not provision or write the CSC/shared database.
`API_BASE_URL` optionally changes the verifier's API origin (default local PORT).

## Place meanings and compatibility

`GET /api/seats?screenId=<id>&screeningId=<id>` keeps its existing envelope,
integer fields, flags and database-ID ordering. Two additive fields are now
returned by the existing seat repository:

| Field                         | Meaning                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------ |
| `id`                          | Stable database place ID; use this for selection, never a display label.       |
| `is_wheelchair`               | Distinguishes the wheelchair zone from seated inventory.                       |
| `physical_row`                | Seated row 1 nearest the screen; wheelchair zone is row 0.                     |
| `physical_column`             | Stored left-to-right column 1–10 within the zone/row.                          |
| `row_label`                   | Seated row label skips 13; wheelchair zone keeps legacy sentinel 0.            |
| `seat_label`                  | Existing integer label; seated labels skip 13; wheelchair indices remain 1–10. |
| `display_label`               | Customer label: seated number or W1–W10.                                       |
| `is_ceo_reserved`             | Inventory designation; distinct from screening occupancy.                      |
| `isBooked`, `isReservedByCeo` | Existing screening-specific allocation flags; see #36 policy.                  |

`physical_column` and `display_label` are PostgreSQL stored generated columns.
The database derives them from the approved labels/row/zone, so legacy inserts
remain compatible while contradictory columns cannot be submitted. Consumers
use these explicit positions, not database-ID order or arithmetic on labels, to
render physical adjacency. Requests still use database IDs. Generated columns,
seed implementation and sentinel row 0 are implementation choices; physical
arrangement, customer labels, capacities and screening/place identities must
agree across database, API and UI.

Numbering examples, left to right:

- Row 1: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10.
- Row 2: 21, 20, 19, 18, 17, 16, 15, 14, 12, 11.
- Row 3: 22 through 31.
- Physical row 13 has display row 14; physical row 20 has display row 21.
- The 100/200 seated layouts end at labels 101/201; no physical row is omitted.

The future map places the screen at the bottom, wheelchair row in front of
seated row 1, and higher seated rows above. This milestone adds its inventory
contract; it does not render a seat map.

## Preservation and database safeguards

The migration adds columns/constraints without replacing place IDs. It refuses
invalid legacy layouts, duplicate zone labels, invalid wheelchair metadata or
inventory beyond screen capacity, rolling back instead of moving bookings.
Existing tables and historical migrations remain in use.

The seed validates existing rows and inserts missing positions only. It never
updates, deletes or renumbers existing places or customer tickets. A transaction
covers all four screens; any failure rolls back every inventory insert and any
CEO tickets created by those inserts. The existing database advisory lock
serializes migration/browsing/inventory commands. Screen locks also serialize
inventory with default CEO provisioning; concurrent seed commands create one
set of places. Unique position/zone-label indexes prevent duplicates.

Constraints/triggers enforce valid row labels, seat bounds and positions,
ten wheelchair spaces as the allowed zone inventory, and screen capacity.
They allow partial inventory during setup; exact completeness is established
by the seed and verifier. Referenced place identities cannot be moved or
relabelled, and capacity cannot shrink past existing inventory.

Adding each screen's designated seat 1 attaches the pending CEO reservation
tickets for existing screenings. A new screening after inventory receives its
own default ticket automatically. Otherwise empty screenings expose 99/100 or
199/200 available seated places and 10/10 wheelchair places through their seat
rows. No customer booking or hold is created by this seed.

## Verification and boundaries

`inventory.test.js` covers both layouts with explicit expected row examples,
invalid capacity/targets, migration upgrade/refusal, partial inventory,
referenced ticket preservation, reruns, concurrent cold seeds, late-failure
rollback, database bounds/unique constraints, and the real city → screen →
movie/screening → seat API journey for all four screens. Existing CEO/API tests
remain active. `test:postgres` enables these tests using disposable databases.

`verify:inventory` makes read-only database queries and real HTTP reads. It
compares persisted positions/IDs with responses, checks future screening
membership and CEO tickets, and reports separate seated/wheelchair counts. It
computes report counts from seat rows; it does not add an aggregate availability
endpoint or customer listing UI.

Recorded local evidence is [inventory.json](../database/verification/inventory.json).
Shared/CSC adoption and deployment are not verified. Booking status/expiry,
authoritative selection validation, aggregate availability/listing counts,
frontend seat maps, checkout holds and CEO-only release remain #55/#27/#77/
#56/#57/#76 and their related tasks. A successful selection does not secure seats.


## Availability follow-up (#55)

Deadline-aware reads and the separate seated/wheelchair counts endpoint are now
provided by [the availability feature](API-SEAT-AVAILABILITY.md). Inventory setup
still creates no customer hold; frontend count display and allocation writes
remain their separate tasks.
