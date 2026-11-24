# RIO staff application

Independent React/JavaScript/Vite website for #58/#97. Customer `frontend/` stays
separate; both websites use the same Express services and PostgreSQL records.
The app delivers real staff sign-in/session recovery and a [city-scoped screening
list](../docs/STAFF-SCREENINGS.md). Screening detail/occupancy maps remain #65. Film, schedule,
price and manual reservation controls remain #59/#60/#61/#66.

## Local setup

Use Node.js 22.13 or newer (verified with 22.14.0) and npm. From the repository root:

```bash
cd admin-frontend
npm ci
cp -n .env.example .env
npm run dev
```

Open `http://127.0.0.1:5174/screenings`. The strict port prevents silently opening
an origin that the backend has not approved. Keep the customer app on 5173.
Vite forwards `/api` to `http://127.0.0.1:3000`, preserving the browser origin.
Use the same loopback hostname throughout; do not mix localhost and 127.0.0.1.

The backend needs a deliberately selected isolated PostgreSQL database migrated
through 0010, real CLI-provisioned staff accounts, distinct customer/staff origins
and a private session secret. Follow the [database guide](../database/README.md),
[provisioning guide](../docs/STAFF-PROVISIONING.md) and
[session configuration](../docs/API-STAFF-AUTH.md#configuration-and-local-setup).
Set backend `STAFF_FRONTEND_URL=http://127.0.0.1:5174`, keep the existing customer
`FRONTEND_URL`, then run `npm start` from `backend/`. Do not migrate or provision a
shared database with development commands. The app supplies no default account
or password. Initial browser verification used disposable data; see the
[approved retained-local setup follow-up](../docs/STAFF-APP.md#approved-retained-local-setup-follow-up--24-november-2026)
for the subsequent local migration/configuration adoption.

## Configuration and commands

`VITE_API_BASE_URL` is public build-time configuration: `/api` for the development
proxy or an absolute HTTPS API URL ending in `/api`. HTTP absolute URLs are
accepted only for loopback development. Credentials/query strings/fragments are
rejected. Put no database URLs, passwords, signing secrets or TMDB keys in Vite
configuration. Rebuild after changing the production API address.

Run independently from `admin-frontend/`:

```bash
npm run lint
npm run format:check
npm test
npm run build
npm run preview
```

`npm run format` formats this app. `npm test` runs Node transport/model tests and
React component tests. Preview serves the built SPA at `http://127.0.0.1:4174`;
it has no API proxy. Use an explicit absolute local API build URL and configure
the backend staff origin for 4174 when testing authenticated preview behavior.
Do not point an unauthorised preview origin at shared data.

## Production artifact

`npm run build` creates this app's own ignored `dist/`. The Dockerfile uses only
this directory as its build context and serves it through unprivileged nginx on
8080 with SPA history fallback. Example for a separately verified API address:

```bash
docker build --build-arg VITE_API_BASE_URL=https://<approved-api-host>/api -t rio-staff .
```

Replace the host before executing. `/api` needs a separately configured production
reverse proxy; this image does not supply one. Vite's development proxy is absent
in production. Environment files, tests and verification artifacts are excluded
from the image context. Docker was unavailable during local verification, so no
image/container execution is claimed. CI integration is #47; separate Rahti
routes, real cross-site cookies, ingress and runtime verification remain #67.

See [behavior, contracts and acceptance evidence](../docs/STAFF-APP.md).
