# Customer selection workflow — #57 / #77

## Guest-checkout integration — 20 November 2026

The summary now offers Continue to guest checkout. [The #29 guest milestone](GUEST-CHECKOUT.md)
adds email/categories, server pricing and a retryable unpaid hold. Browsing/map
components unmount while checkout is active, so polling cannot erase its private
state. After release/back navigation the screening context reloads with fresh,
empty seat choices. The #57/#77 evidence below describes its earlier slice.

The functional MVP is city → screen → movie → showtime → places → validated
selection review. It uses the existing gold/red/black theme. This milestone does
not redesign the later customer journey or connect checkout/payment.

## Behaviour and boundaries

- Each future showtime for the chosen movie lists server-reported available/total
  seated places separately from wheelchair places. CEO seat 1 belongs in the
  seated denominator; wheelchairs remain a separate ten-place zone.
- `GET /api/seats/availability?screenId=…&screeningId=…` supplies counts. IDs,
  capacities, snapshot time and completeness are checked before display. Missing,
  malformed or incomplete counts show an unavailable message and retry, never
  misleading zero counts. Counts refresh every 30 seconds and on window focus.
- The map still uses `GET /api/seats`; Check selection uses read-only
  `POST /api/seats/validate`. Only a current successful complete-selection result
  renders review. The validated response must match the requested ID set.
- Review displays the city, screen capacity, movie, Helsinki showtime, selected
  server labels/rows and the last validation time. Database IDs remain internal
  metadata for integration verification, rather than customer-facing labels.
- Back to seats clears validation, preserves choices and focuses the seat-map
  heading. Check selection again to return to review. Change screening clears
  the showtime and places, retains the browsing filters, and focuses City.
- Editing places or manual/periodic/focus availability refresh clears review.
  Newly unavailable choices are removed. Changing city/screen/movie/showtime
  unmounts the previous map and review. Cancellation and revision guards reject
  late inventory/validation replies; availability owns the same keyed boundary.
- No selection action creates a hold or booking. Separate count/map/preview reads
  may have different snapshot times as customers book. Identical counts across
  reads are not promised; IDs and meaning must agree, and allocation must recheck
  current availability atomically. A valid review does not secure places.

Pages compose the screening and seat features through a render callback. The
seat feature owns review eligibility and current labels. No router, global state,
new dependency or backend contract change is needed for this small MVP. Layout,
component structure and polling implementation can change in a future redesign;
ID consistency, server authority, resets and truthful availability must remain.

## Verification — 20 November 2026

Commands from the repository root:

```bash
npm test --prefix frontend
npm run lint --prefix frontend
npm run build --prefix frontend
npm run format:check --prefix frontend
git diff --check
```

26 Node unit/real-HTTP transport tests plus 34 React component tests passed (60
in total, no skips), alongside lint, production build and formatting. Initial
checks stalled reading existing installed dependency files and Vitest workers
failed to start. Tests/lint/format then passed against an exact temporary copy of
frontend source/tests/config with a fresh `npm ci --offline` lockfile installation.
The real repository production build passed. No tracked dependency/config changes
were made to work around the machine issue.

One background browser tab exercised React → Express → PostgreSQL 18 with fresh,
disposable fixtures and a database-enforced read-only backend pool:

| Acceptance criterion              | Verified evidence                                                                                                                                                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Validated real summary            | All four city/capacity combinations reached review. Oulu 100: selected seat IDs 8, 7 and 103 displayed seats 8, 7 and W3. Tampere 200: IDs 432 and 633 displayed seat 2 and W3.                                                 |
| Context and navigation            | City/screen/movie/showtime changes discarded choices. Back preserved choices and focused the map heading; Change screening cleared showtime and focused City. Both component and real browser checks passed.                    |
| Separate correct totals           | Real CEO-only 100/200 examples showed 99/100 or 199/200 seated plus 10/10 wheelchair. Oulu 100 with paid seats 5/6 showed 97/100. Tests cover changed server counts after focus/polling, malformed/incomplete counts and retry. |
| Invalid/protected/occupied places | Real Oulu seat 8 alone failed for new gap 7; 7+8+W3 passed. Seat 1 and occupied 5/6 were unavailable. Existing map tests verify guarded activation, keyboard behaviour and both capacities.                                     |
| Empty data and failures           | Focused existing browsing/map tests distinguish pending, empty and failure states, retries and invalid previews. New workflow tests verify validation failure cannot produce review.                                            |
| Late responses and refresh        | Existing inventory/validation guards plus new late-showtime validation and stale count tests passed. Focus refresh removes review; polling updates counts.                                                                      |
| Mobile and no allocation          | At 390×844 the page stayed within the viewport; map scrolling remained contained. Keyboard selection and back navigation passed. Identical before/after database hashes cover seats, screenings, bookings and tickets.          |

See [fixture IDs and machine-readable evidence](../database/verification/selection-summary.json).
The disposable database was dropped and dedicated test servers stopped. Shared
and retained development data were untouched. These checks do not verify Rahti.

## Incomplete and deliberately deferred

The #57/#77 selection slice is implemented and verified locally, pending user
commit, PR review and merge. GitHub tasks must remain open until merge.

Checkout UI, billing/Stripe, account pay-later reservations, prices in review,
CEO release administration, staff UI, TMDB import and live deployment are outside
this slice. The existing backend hold API remains separate; review never calls
it. Broader product stories remain open. A new frontend design, push availability
updates, roving-grid optimisation and manual screen-reader assessment can follow
without blocking this functional MVP. No obsolete files required removal in this slice; no duplicate application
directories were introduced.
