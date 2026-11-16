# CEO screening reservations

## Confirmed policy — 16 November 2026

This records the user's revised direction and supersedes the older unconditional
“no CEO release” wording in the backlog and seating integration review:

- Each screen has 100 or 200 seated places, **including** displayed seat 1.
- Wheelchair capacity is separate: ten additional spaces labelled W1–W10.
- Each screening starts with one default CEO reservation for its own screen's
  seated place 1. A film can have many screenings; reservation ownership is by
  screening, not by film or global seat database ID.
- With no other bookings, initial seated availability is 99/100 or 199/200.
  These are available/total seated places, not a change to screen capacity.
- Only a future authenticated CEO administrator may explicitly release a
  particular screening's CEO reservation to customers. Ordinary administrators,
  cashiers and customers have no such override.

There is no staff authentication implementation or CEO account capability yet.
Consequently **release is disabled for everyone in this milestone**. There is no
release endpoint, no fake CEO identity and no request-body role override. CEO
account provisioning, authentication, audited release and its UI require later
implementation. A future release must update screening-specific occupancy; it
must not clear the physical seat's designation for all screenings.

## Implemented in #36

Migration `0002_ceo_reservations.sql` adds `bookings.booking_type`:

| Type       | Meaning                                                                |
| ---------- | ---------------------------------------------------------------------- |
| `customer` | Existing/default bookings; still require a user or guest contact.      |
| `ceo`      | System allocation; `status=reserved`, no expiry, no customer identity. |

One partial unique index permits only one CEO booking per screening. Each
reservation has exactly one zero-charge ticket for the screen's seated label 1
once inventory exists. The ticket has no price or loyalty reward; it represents
occupancy, not a sale, attendee purchase or payment. Reporting, customer booking
lists, pricing, expiry workers and loyalty must distinguish system rows from
customer rows. Expiry logic must not treat these reservations as expiring holds.

A screening insert creates its reservation in the same transaction. If its seat
inventory is not provisioned yet, the booking exists without a ticket; inserting
seat 1 later attaches the ticket to every existing screening on that screen.
This explicitly supports the current M0 setup without pretending seats exist.
Screen-row locks serialize concurrent inventory and screening creation; screening
and booking checks make repeated provisioning idempotent. See PostgreSQL's
[locking](https://www.postgresql.org/docs/17/explicit-locking.html) and
[transactional trigger](https://www.postgresql.org/docs/17/trigger-definition.html)
documentation.

Database safeguards:

- Seated label 1 must be in physical/display row 1, with its CEO flag set. Ordinary
  and wheelchair places cannot carry that flag; wheelchair W1 is not CEO seat 1.
- There can be only one designated seated label 1 per screen. Its ID, screen,
  existing row/label fields, zone and flag cannot be changed or deleted.
- Customer ticket inserts and updates cannot take a designated CEO place, even
  when their associated user has administrator/cashier roles.
- CEO booking/ticket changes and deletion are blocked. Normal unreferenced seat
  deletion returns the deleted row correctly instead of silently suppressing it.
- Tickets must belong to the booking screening's screen. Moving a screening to a
  different screen is blocked while its CEO allocation exists; coordinated
  rescheduling is separate work.
- Deleting an entire screening cascades its own system booking/ticket away. It
  does not release a place in a surviving screening or remove physical inventory.

Follow-up migration `0003_guard_ceo_seat_conversion.sql` prevents an existing
referenced ordinary place from being relabelled into the CEO place. It keeps the
already-applied migration immutable and preserves ticket meaning.

Migration preserves IDs and ordinary customer tickets. It refuses conflicting
legacy sales of seat 1, invalid CEO flags/positions or duplicate designated
places rather than cancelling history or guessing a repair. It normalizes an
unprotected seated label 1 to its required flag when there is no conflicting
customer ticket. `0001_initial_schema.sql` and `backend/db.sql` remain unchanged
historical sources; use the migration runner, not both setup paths.

## Read API integration

Seat reads now follow feature layers in `backend/src/features/seats/`.
Existing envelopes/seat fields are retained:

```http
GET /api/seats?screenId=1&screeningId=9
```

For a screening, `isBooked` includes the real CEO ticket and `isReservedByCeo`
identifies its `booking_type=ceo` provenance. Neither uses database seat ID 1.
A mismatched/unknown screening for the chosen screen returns 400 with
`screeningId must belong to screenId`.

Without `screeningId`, this endpoint is inventory: `isBooked=false` and the CEO
flag indicates designation. It is not screening availability. The prototype
`GET /api/bookings` adds `booking_type` so system reservations are distinguishable;
its existing fields remain. A pending system booking may still have the
prototype's `[null]` seat aggregation until inventory is provisioned.

General booking-state/expiry filtering, comprehensive seat-request ID validation
and authoritative availability/selection remain #55/#27. This change does not
claim that expired customer tickets are already handled correctly.

## Commands and evidence

From `backend/`, with the explicitly isolated local development configuration:

```bash
npm run test:postgres
npm run db:inspect
npm run db:migrate:dev
npm run db:seed:browsing
npm start
```

`db:migrate:dev` remains restricted to a local `rio_dev`/`rio_test` target with
`RIO_DATABASE_MODE=isolated-development`. No shared/CSC migration is performed.
Do not reset an existing schema. Rerunning the migration skips applied versions;
reservation provisioning reuses the existing booking/ticket identities.

[Recorded verification](../database/verification/ceo-reservations.json) captures
47 passing backend tests, no skips, and local before/after inspection. Tests cover
multiple screens, a normal place with database ID 1, malformed flags, protected
relocation/deletion, customer/staff write rejection, booking/ticket tampering,
concurrent creation in both orders, reruns, cascade cleanup and safe upgrades.
Complete disposable test layouts produce 99/100 and 199/200 seated availability,
plus ten separate unoccupied wheelchair spaces each, through real HTTP/SQL.

The retained local development database currently has sixteen screenings and
sixteen CEO booking rows, **zero physical seats and zero tickets**. Eight future
demo screenings were appended by the existing browsing fixture command because
the old November 14 fixtures were past. #51 will generate the real inventories,
attach the pending tickets, introduce physical columns and extend protected
position checks to those new fields. W1–W10 labels are agreed, not yet generated.

Frontend seat maps and availability-count display are later seating tasks. No
production/shared verification, CEO login/release, pricing, holds or payments
are claimed complete here.
