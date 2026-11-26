# Customer and staff UI consistency

## Confirmed direction — 24 November 2026

The user explicitly requested a unified UI and directed future work to keep staff
UI similar to the existing customer frontend. The customer application is the
visual reference. Reuse its UI where applicable by **duplicating the relevant
presentation code into the staff application**, keeping separate application
builds. This supersedes choosing an independent staff visual style and qualifies
the general avoid-duplication guideline for deliberate UI copies.

Before adding/changing a staff screen, inspect the matching customer components
and styles. Match the RIO wordmark, font family/weight/spacing, colour palette,
buttons, inputs/selects, focus states, panels and seat presentation. Extend the
existing visual language for new staff features. Discuss consequential visual
departures before introducing another design direction.

Separate navigation/content and staff-only semantics may differ: a read-only
occupancy map needs six state labels and permissions rather than customer seat
selection. Such differences do not justify replacing the base seat silhouette,
wheelchair frame, physical arrangement or branding. Preserve keyboard/mobile
accessibility and explicit labels alongside colour. The user additionally
confirmed responsive UI as an ongoing requirement: use rem/clamp where suitable,
verify desktop and narrow screens, and contain necessary map overflow.

## Current copies and ownership

| Customer source | Staff local copy/adaptation |
| --- | --- |
| `frontend/src/styles/global.css` typography, wordmark, fields, seat map and icons | `admin-frontend/src/styles/customerUi.css` copies relevant declarations; `global.css` owns staff layout and documented staff-only state variants. |
| `frontend/src/shared/components/Icon.jsx` | Same local component in `admin-frontend/src/shared/components/Icon.jsx`. |
| Customer masked-icon presentation | Existing staff calendar/logout/lock paths use the same local mask component/styles under `admin-frontend/src/assets/icons/`. |
| Customer seat-row/seat-place/wheelchair/screen markup | Local adaptation in `OccupancyMap.jsx`, retaining read-only grid semantics, physical keyboard movement and staff state letters. |

The copied customer rules include Avenir Next/Avenir/Segoe UI, the bold 900-weight
RIO wordmark, red primary actions, gold focus/borders, rounded seat backs with a
thicker bottom border, the separate wheelchair frame and filled gold screen bar.
Staff available places use the customer's available-place presentation. Following
an explicit user refinement, every staff place shows its state code (CEO/A/H/R/P/C)
in the top slot and seat/W label below. Crosses, ticks and wheelchair pictograms
are omitted; no duplicate state badge appears below the label. This applies to
wheelchair places too, retaining their frame and W1–W10 labels. Staff occupied
places retain the additional state colours. Do not reintroduce place icons when
copying later customer UI changes without revisiting this approved distinction.

Use independent files/dependencies. Do not import the customer application's
source tree into staff builds, create a shared UI package/workspace, or copy
checkout/booking/authentication logic as part of visual reuse. Shared backend
services and data remain authoritative. Do not change the customer app solely to
make a staff-only feature fit.

When changing a copied visual rule, compare both copies and intentionally keep
the matching presentation aligned. Record necessary staff-only adaptations here
or in the feature guide. Verify desktop/narrow layouts, wordmark/control/seat
metrics and keyboard behavior. Existing behavior tests still apply; cosmetic
changes do not require artificial style-mirroring unit tests.

## Verified alignment — 24 November 2026

The customer and staff applications were opened against the same disposable
Express/PostgreSQL fixture. Customer source was read only. Actual browser styles
matched for the RIO wordmark: Avenir Next/Avenir/Segoe UI stack, 38 px, weight 900,
−3 px spacing and RGB 232/188/100. Available seats matched at 46 px actual height,
13 px label size, 8/8/3/3 px corner radii, 4 px bottom border, RGB 33/28/29 fill
and RGB 242/232/211 text. Their measured width was the same (60.60 px). Both
screen bars used the same gold fill and dark text.

The staff narrow-screen map uses the copied customer breakpoint: 44 px actual
seat height, 10 px labels and 5/5/2/2 px corner radii were verified at a 390 × 844
viewport. Document width was 375 px; the map scrolled internally (335 px viewport,
358 px content). The customer tab's live comparison was desktop; the mobile
reference is its copied CSS rule. Arrow-key inspection and keyboard return to
filters still worked. Selects and date fields all measured 48 px, preserving
native menu/picker semantics. Staff sign-in also retained the same 38 px,
900-weight RIO wordmark.

All 51 existing staff tests pass (16 Node, 35 React), with lint, formatting and
production build checked. No new style-mirroring unit tests or dependencies were
added. Backend behavior/tests from the detail milestone remain unchanged by this
presentation follow-up. Customer data hashes matched before/after; both Vite
servers, the disposable backend/database and generated private credentials were
removed. No retained data, customer source or deployment was changed.

## Occupancy label readability refinement

The user requested labels about 2px larger. Staff seat numbers now scale smoothly
from 12px on narrow screens to 15px on desktop; state codes use 0.75rem (12px at
the default root size). Row labels scale from 12–14px, legend badge letters grow
by about 2px, and legend descriptions use the responsive small-text scale plus
0.125rem. These are deliberate user-approved adaptations of the copied customer
presentation. Seat shapes and read-only/keyboard behavior remain the same.

The larger labels were checked in the real browser at desktop, 390px and 320px.
At 320px, document width was 305px; neither legend badge letters nor place text
overflowed. The map retained internal horizontal scrolling. Lint, formatting and
production build pass; retained data and customer source are unchanged.

The legend's state boxes were subsequently enlarged to a responsive 36–40px
square with no shrinking, keeping CEO readable inside its box. Legend labels
use title case: Active Hold, Unpaid Reservation, Company Secured and CEO Reserved.

On 26 November 2026 the user additionally confirmed uppercase text inside the
legend and seat boxes. State codes are explicitly styled uppercase (A/H/R/P/C/CEO);
the descriptive legend labels remain in title case. Responsive legend box sizes
remain 36–40px.
