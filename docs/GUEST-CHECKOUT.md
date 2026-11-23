# Guest checkout review and unpaid holds — #29 milestone

## Confirmed scope

Email is the only contact field. Currency is EUR, with approved isolated local
demo prices of €12 adult and €6 child (20 November 2026). Child means age 12 or
under, including wheelchair places. No login, premiere surcharge or paid state
is introduced. The milestone connects the existing validated summary to a server
quote and a retryable owned five-minute hold. Stripe handoff remains separate.

## Customer flow

1. Choose a screening and places; Check selection, then Continue to guest checkout.
2. Review movie/city/screen/showtime, choose each place's adult/child category and
   enter an email. Categories automatically request current server prices; email
   is not sent when quoting. Loading, pricing failure and retry have distinct states.
3. Start five-minute checkout explicitly creates the hold. Quoting/typing alone
   allocates nothing. The button prevents duplicate submission.
4. The hold shows original total, unpaid state, stored deadline and a countdown
   capped at five minutes. Inputs freeze so a retry cannot silently change the
   request. An uncertain response keeps the exact private key, contact and choices;
   Retry checkout recovers the existing hold. It never claims no hold exists while
   the outcome is uncertain.
5. Cancel checkout and return to seats releases the owned hold before returning.
   An uncertain creation is first reconciled with its original key, then released.
   Failed release keeps the checkout and permits retry. Return reloads the same
   screening with empty choices so customers explicitly review current availability.
6. After the deadline, the UI asks for reselection rather than silently renewing.
   Availability/allocation remain governed by the server clock and stored deadline.

The page owns the checkout snapshot separately from browsing/map state. Browsing
and the map unmount while checkout is active, so their 30-second/focus refreshes
cannot erase credentials or remove the customer's own held places. No other
screening can be selected until the controlled return. Returning before creating
anything preserves the screening filters but clears the selected places.

The countdown estimates server time from the quote's database timestamp plus a
monotonic elapsed clock; it does not rely on the browser wall clock. Display updates
once per second and is advisory around network/clock boundaries. The backend remains
authoritative. The timer has no per-second live announcement; status transitions
and errors are announced. Labels, keyboard controls, email-error focus and responsive
form layouts are included.

## Server quote and price-change contract

`POST /api/bookings/quote` accepts `screeningId` and the existing `seatId` array
(integer/adult shorthand or `{seatId,category}` entries). It requires no email,
private key or account. It shares the creation service's input/selection/pricing
logic, locks/read transaction and current availability rules, but writes no rows.
Quotes are not holds. Controlled responses use the existing envelope/no-store policy.

Successful data contains `screeningid`, `screenId`, `filmId`, `screeningTime`, `asOf`,
`currency: "EUR"`, `quoteFingerprint`, persisted-price-derived `totalCents`, and
`tickets: [{seatId,category,amountCharged}]`. The fingerprint is a nonsecret SHA256
version of screening identity/time and ordered ticket categories/amounts, excluding
contact and query time. The frontend verifies identities, ticket set/categories,
amounts/currency and total before rendering.

Creation optionally accepts `expectedQuote` (64 lowercase hex characters). The
new guest UI always supplies it. Creation recalculates the selection, price and
fingerprint under the existing allocation locks. Changes to prices, film, screen
or showtime produce 409 `QUOTE_CHANGED` with no partial allocation. The customer
must review a fresh quote and explicitly start again; there is no silent price
increase. Existing API callers may omit this optional field and retain their
previous authoritative-price contract.

The reviewed fingerprint becomes part of #62's meaningful request identity when
present. Unknown outcomes keep that exact request frozen. An active matching
replay returns its original stored ticket amounts/deadline, even if current
settings later change. A definitively rejected attempt can obtain a new quote
without consuming an allocation. Raw driver errors and private keys stay out of
public messages/evidence. HTTP code propagation and custom private request headers
are now supported by the shared frontend API client.

Private retry credentials are generated with Web Crypto and retained **in memory**,
never URLs, DOM, analytics or browser persistent storage. Requests time out after
15 seconds. Abort/timeout or malformed success cannot be treated as proof that no
hold was created. Full reload/tab-close recovery is deferred: closing/reloading
loses the in-memory checkout, while any committed hold expires server-side after
its original deadline. No best-effort unload request is presented as a confirmed
release. Payment is unavailable and never simulated as paid.

## Local setup and commands

Keep the existing ignored environment configured for isolated local PostgreSQL 18.
Apply all current migrations (0010 adds staff sessions; guest checkout depends
on 0008), then, from `backend/`:

```bash
npm run db:migrate:dev
npm run db:seed:demo-prices
npm run dev
```

From `frontend/`, run `npm run dev`; use existing presentation movies such as Hope
on 21 November. The price command refuses nonlocal/unapproved database targets,
is repeatable for matching values and rolls back rather than overwriting differing
or duplicate settings. This is approved demo configuration; production price
permissions/settings remain #61.

## Verification and acceptance — 20 November 2026

- **138 backend tests passed** with PostgreSQL, no failures/skips. New checks
  cover quotes without allocation/contact, all four screens, quote-bound creation
  and replay, changed prices/film/showtime, unavailable/gap/foreign selections,
  unconfigured pricing and safe local demo-price setup. Existing #62 migration,
  concurrency, lost-response, expiry and rollback tests remain included.
- **70 frontend tests passed** (27 Node/real-HTTP transport and 43 React tests).
  They cover custom credentials/error
  codes, both capacities, category/email validation, deferred/stale quotes, loading/
  retry/timeout, frozen exact-request recovery, unknown-outcome cancellation,
  release failures, explicit quote changes and deadline expiry without renewal.
  The integrated HomePage test confirms browsing/polling cannot erase checkout
  and return preserves screening context with fresh seat choices.
- Actual browser → Express → PostgreSQL checks used a disposable database with
  retained TMDB metadata. Hope/Oulu/100 and Hunger Games/Tampere/200 each selected
  seat 2 plus wheelchair W3, quoted adult+child at €18, created an unpaid hold,
  then cancelled and restored availability. Counts changed 99→98 / 199→198 seated
  and 10→9 wheelchair, then returned to 99/199 and 10. Both demo holds were expired
  with ticket history retained before the disposable database was dropped.
- Mobile verification at 390×844 found no page overflow; categories/contact were
  actually disabled while held. No private keys appeared in the rendered page.
  Dedicated test servers were stopped. Retained `rio_dev` got only the approved
  matching price setup, not these browser-test customer holds.

See [machine-readable evidence](../database/verification/guest-checkout.json).
Run `npm run test:postgres` from backend, and `npm test`, `npm run lint`,
`npm run format:check`, `npm run build` from frontend. Frontend checks used the
exact source/config temporary copy with a clean lockfile dependency installation,
as in the previous milestones. The actual repository production build also passes.

The small guest-review/hold milestone is complete locally. **#29 remains open**
for its Stripe/payment-orchestration handoff, alongside #41. Production pricing
administration, authenticated account/staff/company paths, email delivery/tickets,
payment/expiry reconciliation (#63), full-reload recovery, final frontend redesign
and Rahti deployment remain deliberately deferred. No merge/commit is implied by
passing local checks.
