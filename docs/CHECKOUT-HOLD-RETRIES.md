# Retry-safe guest checkout holds — #62 slice

A successful hold used to be unrecoverable if the creation response was lost:
its server-generated private release token was returned only once. The existing
atomic allocation service now supports an optional **private** `Idempotency-Key`.
A customer can repeat the same meaningful request and recover the original active
unpaid hold without reallocating places, extending expiry or changing its price.

## Request and ownership contract

```http
POST /api/bookings
Content-Type: application/json
Idempotency-Key: <private cryptographically random 32-byte base64url key>

{
  "screeningId": 25,
  "seatId": [2, {"seatId": 103, "category": "child"}],
  "clientEmail": "customer@example.invalid"
}
```

IDs are illustrative: obtain current IDs from browsing/seat APIs. Existing adult
price configuration is still required; this change does not invent a local price.

- The client generates and privately retains **32 cryptographic random bytes**,
  encoded as canonical unpadded base64url (43 characters), before the first request.
  UUIDs, email addresses, sequential IDs and public correlation IDs are unsuitable.
  The same key must survive a network retry; a newly generated key is a new hold
  attempt. A future checkout UI must implement this transport before relying on it.
- This header is deliberately a **bearer credential**: the returned `holdToken`
  equals the private key, and `DELETE /api/bookings/:id` accepts it in the existing
  Authorization header. Possession authorises the guest hold, not payment, account
  access or CEO administration. Never put it in URLs, logs, analytics, tracked
  REST-client files or evidence. Remote requests require the normal HTTPS deployment.
- The database stores only its SHA256 hash. No reversible/encrypted token storage
  or new application secret is needed. The raw key is returned only to its caller.
- The first successful allocation binds the key to screening ID, trimmed contact
  email, the seat/category set and an optional reviewed-quote fingerprint. Seat order, adult integer shorthand, category
  case and outer email whitespace normalize; actual email case remains significant.
  Ignored client amounts/status/roles do not affect server meaning or pricing.
- Repeating an active matching request returns the same HTTP **201** success
  envelope: original booking ID, token, ticket order/categories/charged amounts,
  total and deadline. It uses persisted tickets rather than current price settings.
  It does not revalidate its own already-allocated seats as if they were a new choice.
- Missing headers retain legacy behaviour: fresh server-generated random token
  and the existing response shape. Such calls cannot recover a lost creation
  response. Supplying a legacy token as a new request key is rejected.
- Failed/rolled-back attempts do not consume a key. After an error that is known
  to have rolled back, corrected choices can use it; a successful allocation
  permanently binds it through retained booking history.

| Case                                                       | HTTP / code                              | Effect                                                       |
| ---------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------ |
| Matching active retry                                      | 201, original response                   | No new booking/tickets; no renewed deadline                  |
| Malformed/noncanonical key                                 | 400 `INVALID_IDEMPOTENCY_KEY`            | No database connection/allocation                            |
| Key reused for different meaningful input or a legacy hold | 409 `IDEMPOTENCY_KEY_CONFLICT`           | Original hold unchanged                                      |
| Deadline passed or explicitly released                     | 409 `HOLD_EXPIRED`                       | No recreation; review current availability and use a new key |
| Paid/other no-longer-active hold                           | 409 `HOLD_NOT_ACTIVE`                    | No conversion, release or second allocation                  |
| Competing different key for occupied places                | Existing 409 selection/conflict response | No partial allocation                                        |

Booking-controller responses, including controlled failures, use `Cache-Control:
no-store`. Keys, key hashes, request fingerprints and guest contacts are excluded
from public booking lists. Malformed JSON is still handled by Express before the
booking controller. No frontend or GET browsing response contract is changed.

## Transaction and migration behaviour

Apply the append-only `0008_checkout_request_identity.sql` with the existing
migration runner. It adds nullable `bookings.hold_request_fingerprint`, a customer/
credential-format check and a partial unique index on all nonnull hold-token hashes.
Existing legacy rows retain null fingerprints and their prior data and ownership.
Duplicate legacy credentials fail migration preflight for manual review; nothing
is deleted, merged, rekeyed or silently made bookable.

Keyed requests first acquire a transaction-scoped advisory lock derived from the
hashed credential, then follow the established screen → screening → booking order.
This serializes same-key attempts, even with different screening IDs. The unique
index supplies a database backstop. Different keys still use existing screen locks,
whole-selection validation, authoritative pricing and atomic booking/ticket writes.

A replay locks the existing hold before checking its status and current server
clock. Expiry is checked in a fresh statement **after lock acquisition** so waiting
on a row cannot replay a hold whose deadline passed during the wait. Replay performs
no writes. Clock passage immediately after a successful check remains possible;
clients must respect the original deadline, and payment must independently recheck.
Existing five-minute hold deadlines remain stored and authoritative. No heartbeat,
renewal, expiry cleanup job or payment transition is introduced.

## Verification and acceptance

From `backend/`, using the configured isolated local PostgreSQL 18 database:

```bash
npm run db:migrate:dev
npm run test:postgres
# Regenerate the nonsecret linked workflow examples:
RIO_HOLD_RETRY_EVIDENCE_PATH=../database/verification/hold-retries.json npm run test:postgres
```

Verified on 20 November 2026: **130 tests passed, zero failed or skipped**.
Formatting and whitespace checks passed. The isolated local `rio_dev` database
was upgraded from seven to eight migrations; fingerprints confirmed all original
rows were preserved (12 films, 640 seats, 144 screenings/bookings/tickets and no
configured prices). The presentation screening still returned 99/100 seated and
10/10 wheelchair availability. No customer prices or holds were added there.

Tests create and remove their own disposable databases and use actual Express HTTP
requests. No price or customer hold is added to the retained presentation database.
The tests include four city/capacity preview → hold → replay → competing request →
release examples; [recorded evidence](../database/verification/hold-retries.json)
contains IDs, prices, statuses and matching deadlines, never credentials or contacts.

| Agreed small-milestone criterion             | Evidence                                                                                                                                            |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Same request returns the same owned hold     | Real HTTP across four screens; equivalent normalized requests; stable stored ticket prices after base-price changes                                 |
| Lost response is recoverable                 | A local HTTP proxy commits creation then drops its response; direct retry recovers the exact original response and one booking                      |
| Different input cannot reuse its key         | Screening, email, place and category mismatch checks; public lists exclude credentials/fingerprints/contact                                         |
| No duplicate allocations or deadline renewal | Six concurrent identical calls return one hold/ticket set; release/natural expiry/paid states reject replay; original deadlines match               |
| Atomic failure and safe schema adoption      | Late ticket failure rolls back booking/tickets/request identity; retry succeeds; duplicate-credential preflight and repaired legacy adoption tested |
| Expiry is authoritative after waits          | Actual booking-row contention spans its stored deadline; the waiting replay returns `HOLD_EXPIRED`                                                  |
| Existing behaviour survives                  | Full migration/CEO/browsing/TMDB/inventory/selection/booking regression suite; missing-key legacy create/release remains compatible                 |

## Boundaries

This completes the agreed **guest retry** milestone, not all of #62 or its parent
#28. Account authentication/ownership and additional staff/company allocation
writers remain separate acceptance gaps. The [guest checkout UI](GUEST-CHECKOUT.md) now generates,
retains in memory and transmits the private key; Stripe/webhooks, payment/expiry races (#63),
account pay-later reservations, pricing administration (#61), production migration
execution and deployment remain deferred. Selection preview still creates no hold.
No obsolete feature files or duplicate application directories are introduced.
