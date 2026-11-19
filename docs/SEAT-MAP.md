# Accessible seat map (#56)

Current integration: #57/#77 now compose this map with listing counts and a
validated review. See [selection workflow](SELECTION-SUMMARY.md). The #56
verification and scope below describe that earlier milestone.

## Delivered scope

After choosing a city, screen, movie and future showtime, customers can inspect
and select seated/wheelchair places, then check the complete selection against
`POST /api/seats/validate`. The map uses gold, red and black with explicit labels,
checkmarks and unavailable crosses; colour is not the only state signal.

This milestone supplies the reusable map and its validation gate. #57 owns the
complete visit/selected-place review, back navigation and broader journey
verification. Listing availability counts remain #77. This UI creates no booking,
hold or payment; the booking route must still revalidate during allocation.

## Integration and data meanings

- `HomePage` composes the screenings and seats features through
  `ScreeningSelection`'s optional `renderSeatSelection` prop. Existing browsing
  consumers can render without seats. Shared transport imports no feature code.
- `SeatSelection` owns a child keyed by screen/screening IDs. A changed city,
  screen, movie or showtime unmounts old state and aborts obsolete requests.
- `GET /api/seats?screenId=…&screeningId=…` supplies places. The feature service
  validates complete physical positions and matching screen IDs before enabling
  selection. Empty inventory is reported separately from a failed/incomplete map.
- The frontend displays server `display_label`/`row_label` and sorts by physical
  positions. Highest physical rows render first; row 1 is nearest the bottom
  screen. Wheelchair row 0 lies between row 1 and the screen. No client numbering
  generator or gap-rule copy is used in production.
- `isBooked` or screening-specific `isReservedByCeo` makes a place unavailable.
  The inventory designation alone does not override a future authorised CEO
  release. IDs sent for validation are database IDs, never printed labels.
- Customers can build a multi-place selection before checking it. No speculative
  per-click gap rejection prevents selecting 7+8 together. Backend feedback names
  the actual unselected gap place when appropriate.
- Validation requires a response matching the exact requested screening and ID
  set. The optional `onValidatedSelection` callback receives the checked IDs and
  server snapshot time only after a current valid result; edits/refreshes clear
  that gate with `null`. #57 must consume this gate and clear its own downstream
  state when screening context changes. This signal is not allocation authority.
- The shared API client now accepts JSON POST requests while retaining `apiGet`
  compatibility. Seat/preview requests use `cache: no-store` and abort signals.

Availability refreshes every 30 seconds, on window focus and through **Refresh
seats**. During refresh, map activation and validation are disabled. Newly
unavailable selected IDs are removed and announced; any refresh invalidates the
previous check. Read failures disable the map/validation and offer retry, retaining
choices only for reconciliation against a later successful read. Pending
validation is cancelled on edit, refresh, context change or unmount. Request
version/revision checks reject late responses even if a transport ignores abort.

## Keyboard and responsive layout

Each place is a native toggle button with its zone/row/label/state in the
accessible name, `aria-pressed` and unavailable `aria-disabled`. Unavailable
places remain focusable for reading their label/state but cannot activate.

Tab traverses controls. Arrow keys move between physical columns/rows within a
zone; Home/End move to row edges. Enter/Space toggle an available place. Focus has
a visible gold outline. Status updates announce selection, checks and changed
availability; backend errors use alert feedback.

The ten-place block remains intact on narrow viewports. Horizontal scrolling is
contained inside the map rather than the page, preserving legible controls and
physical adjacency. The verified mobile viewport measured minimum place targets
of about 30×44 pixels. Browser keyboard checks supplement interaction tests;
manual screen-reader testing has not been performed.

## Commands and representative verification

From `frontend/`:

```bash
npm test
npm run lint
npm run build
npm run format:check
```

For normal local use, start PostgreSQL/backend using the README/database guide,
then run `npm run dev` from `frontend/`. The default `/api` base uses Vite's local
backend proxy. For a separate test backend, set `VITE_API_BASE_URL` when starting
Vite; production API routing remains deployment work in #67.

Verified on 19 November 2026:

- 26 Node unit/real-HTTP transport tests and 28 component tests passed, with no
  skips. Existing browsing checks remain included. Tests cover both capacities,
  keyboard toggles/navigation, unavailable places, backend gaps, read/validation
  failures/retry, refresh conflicts, empty/incomplete data and late replies across
  edits and screening changes. The shared JSON POST transport has a real local
  HTTP test.
- One local browser tab exercised all four synthetic screens through the actual
  React→Express→PostgreSQL stack. Oulu 100 had synthetic seats 5/6 occupied: choosing
  8 was rejected for gap 7, while 7+8 passed. Both 200 layouts rendered 210 places,
  including 10 wheelchairs and 20 physical seated rows, with skipped labels/rows.
  Keyboard selection, wheelchair selection and city/screen resets passed.
- A mobile check found no page overflow; horizontal overflow stayed in the map.
- The backend used database-enforced read-only pool connections to a newly
  created disposable database. Matching before/after hashes prove seats,
  screenings, bookings and tickets stayed unchanged during browser use. The
  disposable database and both local test servers were removed/stopped afterward.

See [recorded verification](../database/verification/seat-map.json). Screenshot
artifacts are supplied with the implementation review, rather than production
assets. IDs belong to disposable fixtures and are not production identifiers.
The frontend checks do not establish a live Rahti deployment or a completed #57.

## Acceptance checklist and deferrals

| #56 criterion                                                                              | Evidence                                                                                                             |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Both capacities preserve physical positions, snake/skipped labels and wheelchair placement | Geometry/unit tests, 110/210-button interaction tests, real four-screen walkthrough.                                 |
| Protected/occupied places cannot be selected                                               | Native button guards/ARIA; component tests and real CEO/occupied fixture states.                                     |
| Keyboard and non-colour labels work                                                        | Arrow/Home/End/Enter/Space tests; real arrow/Enter checks; explicit labels/checkmarks/crosses/focus.                 |
| Backend validation explains errors and gates progression                                   | Whole-selection HTTP flow; invalid gap feedback; only current valid results invoke the optional downstream callback. |
| Multi-place selection and announcements                                                    | No per-click backend gap rejection; selection/status/alert tests and refresh removal example.                        |
| Switching clears choices and stale replies cannot restore them                             | Keyed context, cancellation/revision guards, late-read/late-validation tests, real city/screen reset.                |
| Interaction regressions are verified                                                       | Full frontend suite, lint, production build, formatting and browser/database evidence.                               |

Remaining outside this milestone: #57 review/back navigation, #77 listing counts,
checkout/Stripe, staff UI, live deployment and manual screen-reader assessment.
Optimising tab order with a roving grid or adding push updates may be considered
later; native buttons and periodic/focus refresh satisfy this slice without new
UI dependencies. Those optional improvements do not change backend authority.
