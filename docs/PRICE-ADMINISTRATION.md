# Price administration — corrective follow-up #106

## Confirmed contract

The 20 November 2026 decisions supersede older open pricing proposals: one global
adult price in EUR; child age 12 or under costs half, rounded to the nearest cent
with positive half cents rounded up. Thus 1201 adult cents gives 601 child cents.
Wheelchair places use the same categories. There is no premiere surcharge or
independent child/company price editing in this MVP. €12/€6 are local demo values.

Only a current, server-validated administrator can read audit/revision settings
or change the price. Cashiers cannot. Every write requires the configured staff
Origin, current session cookie and its X-CSRF-Token. The shared auth check is also
used by logout; a plain role object is not a trusted actor.

- `GET /api/prices` remains public and returns `{success:true,data:[...]}` with
  only `id`, `category`, `amount_cents`. Adult and derived child are the only
  categories. No current adult setting returns an empty list.
- `GET /api/staff/prices` has the same rows plus `version`, `updated_at`,
  `updated_by_user_id`, `updated_by_email`; it requires administrator permission.
  Actor email is read from the current users row, not accepted from a client.
  For legacy prices, 0011 initialized `updated_at` at migration time; that timestamp
  is not evidence of the original business price-change date.
- `PUT /api/prices` accepts exactly `{category:"adult",amountCents:1201,
  expectedVersion:3}`. Amount is a positive integer up to 2147483647 cents.
  Revision is mandatory. Zero explicitly initializes an absent setting; it never
  overwrites an existing one. Stale revisions return `409 STALE_PRICE_EDIT`.
  The response data contains `category`, `amountCents`, `version`, `updatedAt`,
  `updatedBy`, and the two derived public/staff rows in `updated`.

A child response row refers to the same adult base-price ID and revision. It is
a calculated category view, not an independently persisted editable price. Old
child/company rows remain historical data and are not new checkout price sources.

Price writes serialize under the existing price advisory lock, lock the adult
row and compare its revision inside one transaction. A partial unique index
allows at most one current row per category while retaining older referenced
rows. Checkout reads only the current adult price under its existing shared row
lock. Changing settings preserves ticket IDs, price references and stored
`amount_charged`; existing holds/retries keep their original expiry and amounts.
A changed customer quote requires a fresh review before allocation.

## Staff editor

The draft stays mounted and focused during typing; reads are triggered on entry
or an explicit refresh, never by a keystroke. The adult row supplies the revision
regardless of response order. Empty settings explicitly initialize at revision
zero. Conflict, failed read, forbidden save and unconfirmed write outcomes are
visible. An unconfirmed save blocks further writes until a read succeeds; the
staff member compares the retained draft with current settings and explicitly
saves again. No write is replayed automatically. The price panels collapse to
one column on small screens, wrap long actor text and keep keyboard focus visible.
Customer form/panel styles are copied locally; applications retain independent
builds. The broader #65 UI alignment remains separate work.

## Migration 0011 safety and forward adoption

Do not edit applied `0011_price_administration.sql`. Its original deduplication
rewrites ticket price references and removes duplicate price rows. Migration
`0012_preserve_price_history.sql` replaces category uniqueness with uniqueness
only for current rows, retains positive amounts/revisions and marks the lowest
retained ID in each category current. This retains the canonical selection made
by 0011; it does not guess a latest price from duplicate row order.

For a database still before 0011, the guarded migration runner locks prices and
tickets and snapshots their exact IDs/references in temporary tables before
executing 0011. Migration 0012 restores duplicates/references inside that same
transaction, before commit. Temporary snapshots disappear on commit/rollback.
Use the complete current migration set through `npm run db:migrate:dev`; running
0011 SQL manually bypasses this protection. The runner refuses a pending 0011
without 0012. Nonpositive legacy amounts fail safely and roll back; review them
rather than silently repricing history. The runner's existing local target,
checksum and advisory-lock safeguards remain in force.

For a database that already committed 0011, 0012 preserves what is currently
retained, but **cannot recover removed IDs or references without evidence**.
Before adoption, inspect migration history read-only and retain a backup. Compare
against a reliable pre-0011 backup/audit if duplicates existed; any restoration
requires an environment-specific reviewed plan. Never invent mappings, reset a
shared database, or rewrite the migration ledger. Whether a teammate/CSC/hosted
database ran 0011 is currently unknown. The user's assumption that none did is
not verification. No shared database upgrade or deployment is performed here.

From `backend/`, for an explicitly isolated local target only:

```bash
npm run db:inspect
npm run db:migrate:dev
npm run db:seed:demo-prices
npm run test:postgres
```

The seed remains optional, repeatable €12/€6 demo setup and refuses differing
current settings. Historical rows do not create duplicate-current settings.
Create staff accounts through the existing guarded provisioning CLI; no default
credentials or public registration are introduced.

## Verification

`backend/tests/prices.test.js` covers service input/permissions/projections.
`prices.postgres.test.js` uses disposable PostgreSQL databases and real HTTP to
verify pre-0011 duplicate reference preservation, already-applied 0011 limits,
initialization, concurrent revision conflicts, CSRF, public redaction, cashier/
anonymous/revoked-session denial, administrator edit → customer quote change →
re-review → persisted hold → original idempotent replay after a later edit.
Existing allocation/quote/session suites remain required. Staff component tests
use mocked transport and realistic typing to verify focus, revision and recovery;
they do not prove real HTTP or deployed cookies. Actual Rahti ingress/session
behavior remains outside this local corrective milestone.

Track this work under #7 → #23 → #106, following the original #61 implementation.
Use `Refs #106` for partial progress. Close only after all corrective criteria and
verification are satisfied; merged earlier PRs alone are not acceptance evidence.

## Local verification — 26 November 2026

- Full `npm run test:postgres`: 178 tests passed, zero failures/skips, PostgreSQL 18.
- Staff `npm test`: 27 Node tests and 34 mocked React tests passed; lint,
  formatting check and production build passed.
- Real browser against a separate disposable PostgreSQL database: administrator
  sign-in → Prices → save adult €12.01 → child €6.01 / adult revision 2 and actor
  displayed → type a new draft without losing focus → sign out. Responsive checks
  at 390px and 320px found no horizontal overflow. Browser artifacts used only
  synthetic account data; the fixture database and credentials were removed.
- Customer `npm test`: all 80 tests passed (27 Node and 53 React component tests).
  The initial component run stalled while importing jsdom, before test execution.
  A clean `npm ci --ignore-scripts --no-audit --no-fund` using the unchanged
  lockfile resolved the local installation problem; dependency versions and test
  assertions were not changed. Real customer quote/review/hold/replay integration
  is also covered by the backend suite.
- Read-only cleanup check: the retained database remains at 0010, and zero pricing
  fixture databases remain. Apply the complete guarded local migration set before
  running this branch against the retained development database.
- No retained local migration, teammate/shared database change, external provider
  check or Rahti deployment is claimed. Other environments' 0011 adoption remains
  unknown; use the preflight/recovery procedure above before rollout.
