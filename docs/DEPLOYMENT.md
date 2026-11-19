# Rahti deployment direction and current status

## Confirmed decision

On 18 November 2026 the user confirmed Rahti as the application hosting target,
superseding the earlier Azure direction. This applies to the customer frontend,
future separate staff frontend and Express backend. PostgreSQL remains at CSC, with version 18 as the current target. Verify the actual
shared server version before a separately reviewed major-version upgrade.
Customer and staff websites require separate deployments and addresses; they may
share the backend and authoritative database.

The Rahti project/namespace, actual customer/staff/API addresses, intended
PostgreSQL endpoint and release arrangements still need recording. The choice of
hosting is resolved; these operational details and live verification remain open.

This is a documentation/source audit. No Rahti login, deployment, permissions,
secrets, DNS, shared database or running application was changed by this update.

## Ownership and task boundaries

| Level               | Issue        | Responsibility and completion boundary                                                                                               |
| ------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Product requirement | #14 — RIO-22 | Separate working customer/staff sites, required authorization and consistent booking data.                                           |
| Subtask             | #45          | Coordinate Rahti runtimes and CI/CD; remain open while either child or staff dependency is incomplete.                               |
| Actionable          | #47          | Build/lint/test automation, reviewed releases of verified artifacts, secret references and automated smoke/rollback integration.     |
| Actionable          | #67          | Images/manifests/routes, actual runtime variables/API origin, PostgreSQL connectivity, real browser/API smoke and rollback evidence. |

PR #81 is merged partial progress for #47/#67: Node.js 22/backend `server.js`,
image reference changes and OpenShift build examples. Its title, “Deployment
complete”, does not establish that either task's full acceptance criteria passed.
The source branch was renamed to `chore/47-deployment-workflows` without changing
its commit; follow-up implementation must start from current `main`.

Backend safeguards (#82/PR #83) and read-only selection validation (#27/PR #84)
are integrated. Their local PostgreSQL/HTTP evidence is not deployed Rahti
verification. The staff application remains future work under #15 and its child.

## Runtime and data contract

| Application / setting        | Meaning and current implementation                                                                                                                                                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend `DATABASE_URL`       | Required PostgreSQL connection URL including database name. Obtain credentials from approved secret storage; never place them in frontend configuration or commit them.                                                                  |
| Backend `FRONTEND_URL`       | Required allowed HTTP(S) browser origin. It accepts one origin today, not a comma-separated list. Verify the customer origin; the future distinct staff origin needs a reviewed CORS policy extension.                                   |
| Backend `PORT`               | Defaults to 3000; must match the deployed listener/service mapping.                                                                                                                                                                      |
| Backend timezone             | The current timestamp-without-time-zone schema relies on Helsinki local time; preserve `TZ=Europe/Helsinki` until a separately reviewed timestamp migration.                                                                             |
| Frontend `VITE_API_BASE_URL` | Public build-time configuration consumed by the API client; never a secret. Use the actual HTTPS backend origin with `/api`, or `/api` only when a verified production proxy handles it.                                                 |
| Frontend development proxy   | `frontend/vite.config.js` proxies `/api` to local port 3000 during development. It is absent from the production nginx image. Changing environment variables after building static assets does not rebuild their embedded configuration. |
| Current backend/startup      | `backend/Dockerfile` uses Node.js 22 and runs `node server.js`, listening on 3000 by default. Startup validates the configuration and connectivity.                                                                                      |
| Current frontend/runtime     | `frontend/Dockerfile` builds the Vite app, then serves `dist` through unprivileged nginx on 8080. No application API reverse-proxy configuration is supplied in this repository.                                                         |
| Database setup commands      | `db:migrate:dev`, browsing/inventory seeds and PostgreSQL tests require an isolated loopback development target. They are not shared/production deployment commands.                                                                     |

Existing `DB_HOST`, `DB_USER`, `DB_NAME`, `DB_PASSWORD` and historical `CLIENT_URL`
do not replace the current backend's `DATABASE_URL`/`FRONTEND_URL` contract.
A runtime configuration change must follow the application, not the obsolete
variable names in a manifest. API origins and CORS must agree end to end.

## Existing artifact classification

Files are retained. The table distinguishes current source updates from runtime
work still tracked in #47/#67; no entry claims that a configuration was deployed.

| Artifact                                                                     | Disposition / known gap                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backend/Dockerfile`                                                         | Retain and verify on Rahti. Entry point and Node version were corrected by #81. Check the image's build context, permissions and secret exclusion.                                                                                                                                                                                                   |
| `frontend/Dockerfile`                                                        | Retain and revise production API build configuration/routing; verify serving on 8080.                                                                                                                                                                                                                                                                |
| `k8s/backend_deployment.yaml`                                                | Revise: currently exports separate `DB_*` variables rather than the required backend connection/origin settings. Verify exact image identity and service mapping.                                                                                                                                                                                    |
| `k8s/frontend_deployment.yaml`                                               | Retain/revise: prove the image contains the intended API origin and works with its actual service/route.                                                                                                                                                                                                                                             |
| `k8s/backend_service.yaml`, `frontend_service.yaml`                          | Retain and verify selectors, listener/target ports and routes against the running images. Source presence alone proves no connectivity.                                                                                                                                                                                                              |
| `k8s/backend_route.yaml`, `frontend_route.yaml`                              | Retain and verify the actual HTTPS hostnames/TLS and service-port mappings; record resulting addresses.                                                                                                                                                                                                                                              |
| `k8s/buildconfig-docker-build-example.yaml`                                  | Example requiring revision: canonical organization Git source, reviewed branch/build trigger, secret references and verified artifact identity. Do not copy embedded webhook values into live configuration.                                                                                                                                         |
| `docker-compose.yaml`                                                        | PostgreSQL 18 fresh-volume example with required local password input. The backend `DATABASE_URL` and frontend production API routing still need revision; the complete Compose stack remains unverified.                                                                                                                                            |
| `k8s/configmap.yaml`                                                         | `DB_*` keys supply the PostgreSQL 18 image mappings, but do not configure the current Express runtime. Reconcile consumers with the intended database; do not blindly reuse these keys for Express.                                                                                                                                                  |
| `k8s/postgres_deployment.yaml`, `postgres_service.yaml`, `postgres_pvc.yaml` | Updated PostgreSQL 18 examples (`postgres:18-alpine`, official `POSTGRES_*` names, versioned PGDATA and distinct `postgres18-data` PVC), still unverified on Rahti. Confirm endpoint, image/UID policy, persistence, backups and tested upgrade/restore before application. Preserve existing PostgreSQL data/PVCs; this is not an in-place upgrade. |
| `k8s/secret.yaml`, local `.env` and real build configuration                 | Local/ignored secret-bearing configuration is not committed evidence. Review references without printing values. Verify Docker build contexts exclude local secrets; `.gitignore` alone does not define a Docker build context.                                                                                                                      |
| CI and staff app                                                             | No tracked `.github` workflow directory or staff app is present in the audited tree. #47 must implement relevant automation; staff checks/deployment remain dependent on staff initialization.                                                                                                                                                       |

Do not use a blanket `oc apply -f k8s/`: these files mix unverified database and
application examples, old variable names and build placeholders.

## Verification to attach before deployment tasks are Done

1. **Local source/build checks.** From `frontend/`, run `npm ci`, `npm run lint`,
   `npm test` and `npm run build`. From `backend/`, run `npm ci` and
   `npm run test:postgres` against the explicitly isolated development database.
   Backend has no configured lint script; do not claim it ran. CI must provide
   equivalent isolated data and preserve shared databases. Do not run build/test
   commands containing credentials in public logs.
2. **Rahti runtime inspection.** Record the approved project/namespace, immutable
   image references, rollout result and actual site/API addresses. Use the
   existing authorized console/CLI session; access is not expanded by these docs.
   Useful read-only commands, after replacing the project placeholder:

   ```bash
   oc -n <approved-project> get deployments,pods,services,routes
   oc -n <approved-project> rollout status deployment/backend
   oc -n <approved-project> rollout history deployment/backend
   ```

   Inspect relevant logs privately and record only redacted evidence. See CSC's
   [Rahti CLI guide](https://docs.csc.fi/cloud/rahti/get-started/cli/) and
   [Rahti usage guide](https://docs.csc.fi/cloud/rahti/usage/) for platform tools,
   images, networking and storage. No CLI command was executed against Rahti
   during this source audit.

3. **Real browser/API/database example.** On the actual customer HTTPS address,
   choose city → screen → movie/showtime. Verify matching screening/place IDs,
   configured API origin/CORS and database data. Exercise availability and
   `POST /api/seats/validate` with accepted and rejected selections. Use approved
   synthetic test data to verify hold → competing conflict → owned release and
   retained history when the affected checkout UI/API exists. Local examples in
   `database/verification/` are references, not live evidence. No payment/secure
   ticket claim is allowed from an unpaid hold.
4. **Separate staff site.** Once implemented, record its distinct address, staff
   sign-in, role/city restrictions, CORS and shared occupancy behavior. Until then
   explicitly report this required criterion incomplete.
5. **Release and rollback.** Document who approves/releases which verified image,
   the trigger, exact promotion/rollback procedure and the observed result.
   Demonstrate application-image rollback without resetting database data. Review
   database schema compatibility separately; the development migration runner
   supplies no production downgrade/reset path.

Store dates, commit/image IDs, nonsecret addresses, selected IDs, expected/actual
results and remaining gaps. Never attach tokens, database URLs with credentials,
raw customer records or secret values. These requirements implement existing
#47/#67 acceptance criteria, not proof that they have already been met.

## Verified versus incomplete on 18 November 2026

Verified: user hosting decision; current source settings/entry points; merged
#81/#83/#84 scope; known manifest/configuration gaps; updated task boundaries.
The core README, architecture and backlog now agree on Rahti.

Incomplete: actual namespace/addresses/database target, deployed runtime/API/CORS
verification, complete CI/release automation, separate staff delivery and an
executed application rollback. No live deployment completion is claimed.

Remaining work includes other runtime/build manifest repairs, CI, staff app
delivery, live deployment, secret/permission changes and shared PostgreSQL
migration. The PostgreSQL 18 source alignment below does not complete those tasks.

## PostgreSQL 18 source alignment — 19 November 2026

Current native commands and Compose/Kubernetes database examples now target
PostgreSQL 18. The retained local PG18 cluster was restarted and its Express cities
request verified. See [database setup and upgrade boundaries](../database/README.md).
Container/Rahti execution and the actual shared PostgreSQL version are not proven
by this source update; #67 still owns that verification. Historical evidence keeps
its recorded server version.
