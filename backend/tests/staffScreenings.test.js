import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  parseStaffScreeningFilters,
  helsinkiDate,
  createStaffScreeningsService,
} from "../src/features/screenings/staffScreeningsService.js";
import { createStaffActor } from "../src/features/staff/staffAccess.js";
import {
  createClient,
  assertIsolatedDevelopment,
  assertConnectedLocalTarget,
} from "../scripts/database/connection.js";
import { migrateDatabase } from "../scripts/database/migrate.js";
import { seedBrowsing } from "../scripts/database/seed-browsing.js";
import { seedInventory } from "../scripts/database/seed-inventory.js";
import { manageStaff } from "../scripts/database/manage-staff.js";
import { startServer } from "../src/server.js";

test("staff dates are strict, inclusive, bounded and default to Helsinki today", () => {
  assert.equal(helsinkiDate(new Date("2030-01-15T22:30:00Z")), "2030-01-16");
  assert.equal(helsinkiDate(new Date("2030-07-15T21:30:00Z")), "2030-07-16");
  assert.deepEqual(parseStaffScreeningFilters({}, "2030-01-15"), {
    cityId: undefined,
    screenId: undefined,
    dateFrom: "2030-01-15",
    dateTo: "2030-01-15",
  });
  for (const q of [
    { dateFrom: "2030-02-30" },
    { dateFrom: ["2030-01-15"] },
    { "dateFrom[]": "2030-01-15" },
    { dateFrom: "2030-01-01", dateTo: "2030-02-01" },
    { dateFrom: "2030-01-15", dateTo: "2030-01-14" },
    { cityId: ["1", "2"] },
    { "cityId[x]": "1" },
    { screenId: "0" },
    { typo: "1" },
  ])
    assert.throws(() => parseStaffScreeningFilters(q));
  assert.equal(
    parseStaffScreeningFilters({ dateFrom: "2030-01-01", dateTo: "2030-01-31" })
      .dateTo,
    "2030-01-31",
  );
});
test("staff screening service rejects spoofed actors and scopes at the repository boundary", async () => {
  let args;
  const service = createStaffScreeningsService(
    {
      listStaffScreenings: async (...values) => {
        args = values;
        return { screenings: [] };
      },
    },
    { findScreen: async () => ({ city_id: 2 }) },
  );
  await assert.rejects(service.list({}, { role: "administrator" }), {
    code: "STAFF_FORBIDDEN",
  });
  const actor = createStaffActor({
    id: 1,
    role: "cashier",
    permitted_city_id: 1,
  });
  await assert.rejects(service.list({ cityId: "2" }, actor), { status: 403 });
  await assert.rejects(service.list({ screenId: "2" }, actor), { status: 403 });
  await service.list({}, actor);
  assert.equal(args[0].cityId, 1);
  assert.equal(args[1], 1);
});
const databaseUrl = process.env.TEST_DATABASE_URL;
test(
  "real staff screening filters, authorization and shared customer counts",
  { skip: !databaseUrl, timeout: 60000 },
  async (t) => {
    const mode = "isolated-development",
      parent = assertIsolatedDevelopment(databaseUrl, mode),
      admin = createClient(databaseUrl);
    await admin.connect();
    await assertConnectedLocalTarget(admin, parent);
    const name = `rio_test_staff_list_${process.pid}`,
      url = new URL(databaseUrl);
    url.pathname = "/" + name;
    let c, runtime;
    t.after(async () => {
      await runtime?.shutdown();
      await c?.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    });
    await admin.query(`CREATE DATABASE ${name}`);
    const target = { databaseUrl: url.href, mode };
    await migrateDatabase(target);
    await seedBrowsing(target);
    await seedInventory(target);
    c = createClient(url.href);
    await c.connect();
    await c.query(
      "UPDATE screenings SET screening_time='2030-01-15 18:00:00'::timestamp + id * interval '1 minute'",
    );
    const staffOrigin = "http://127.0.0.1:5174",
      accounts = {};
    for (const [label, role, city] of [
      ["admin", "administrator"],
      ["oulu", "cashier", "Oulu"],
      ["tampere", "cashier", "Tampere"],
    ]) {
      const password = randomBytes(24).toString("base64url"),
        email = label + "@example.invalid";
      await manageStaff({
        ...target,
        input: { action: "provision", role, email, ...(city ? { city } : {}) },
        readPassword: () => password,
      });
      accounts[label] = { email, password };
    }
    runtime = await startServer({
      config: {
        databaseUrl: url.href,
        frontendUrl: "http://127.0.0.1:5173",
        port: 0,
        staff: {
          origin: staffOrigin,
          secret: randomBytes(32).toString("base64url"),
          secureCookies: false,
          trustProxyHops: 0,
        },
      },
      host: "127.0.0.1",
    });
    const base = `http://127.0.0.1:${runtime.server.address().port}`;
    async function get(path, cookie) {
      const r = await fetch(base + path, {
        headers: { Origin: staffOrigin, ...(cookie ? { Cookie: cookie } : {}) },
      });
      return {
        status: r.status,
        body: await r.json(),
        cache: r.headers.get("cache-control"),
      };
    }
    const cookies = {};
    for (const label of Object.keys(accounts)) {
      const response = await fetch(base + "/api/staff/login", {
        method: "POST",
        headers: {
          Origin: staffOrigin,
          "Content-Type": "application/json",
          "X-RIO-Staff": "1",
        },
        body: JSON.stringify(accounts[label]),
      });
      assert.equal(response.status, 200);
      cookies[label] = response.headers.get("set-cookie").split(";")[0];
    }
    const path = "/api/staff/screenings?dateFrom=2030-01-15";
    assert.equal((await get(path)).status, 401);
    const all = await get(path, cookies.admin);
    assert.equal(all.status, 200);
    assert.equal(all.cache, "no-store");
    assert.equal(all.body.data.screenings.length, 8);
    for (const label of ["oulu", "tampere"]) {
      const result = await get(path, cookies[label]);
      assert.equal(result.status, 200);
      assert.equal(result.body.data.screenings.length, 4);
      assert.equal(result.body.data.cities.length, 1);
      const city = result.body.data.cities[0];
      assert.equal(city.name.toLowerCase(), label);
      assert.ok(
        result.body.data.screenings.every((x) => x.city_id === city.id),
      );
      const foreign = all.body.data.screenings.find(
        (x) => x.city_id !== city.id,
      );
      assert.equal(
        (await get(path + `&cityId=${foreign.city_id}`, cookies[label])).status,
        403,
      );
      assert.equal(
        (await get(path + `&screenId=${foreign.screen_id}`, cookies[label]))
          .status,
        403,
      );
    }
    for (const row of all.body.data.screenings) {
      const filtered = await get(
        path + `&cityId=${row.city_id}&screenId=${row.screen_id}`,
        cookies.admin,
      );
      assert.equal(filtered.status, 200);
      assert.ok(
        filtered.body.data.screenings.every(
          (x) => x.screen_id === row.screen_id,
        ),
      );
      assert.match(row.screening_time, /Z|[+]00:00/);
    }
    assert.deepEqual(
      (await get("/api/staff/screenings?dateFrom=2030-01-16", cookies.admin))
        .body.data.screenings,
      [],
    );
    for (const q of [
      "dateFrom=2030-02-30",
      "dateFrom=2030-01-15&dateTo=2030-03-01",
      "cityId=1&cityId=2",
      "dateFrom[]=2030-01-15",
    ])
      assert.equal(
        (await get("/api/staff/screenings?" + q, cookies.admin)).status,
        400,
      );
    assert.equal((await get("/api/staff/screenings/1")).status, 401);
    for (const malformed of ["0", "-1", "abc", "2147483648", "1.2"])
      assert.equal(
        (await get("/api/staff/screenings/" + malformed, cookies.admin)).status,
        400,
      );
    assert.equal(
      (await get("/api/staff/screenings/2147483647", cookies.admin)).status,
      404,
    );
    for (const label of ["oulu", "tampere"]) {
      const own = all.body.data.screenings.find(
          (row) => row.city_name.toLowerCase() === label,
        ),
        foreign = all.body.data.screenings.find(
          (row) => row.city_name.toLowerCase() !== label,
        );
      assert.equal(
        (await get(`/api/staff/screenings/${own.id}`, cookies[label])).status,
        200,
      );
      const denied = await get(
        `/api/staff/screenings/${foreign.id}?cityId=${own.city_id}`,
        cookies[label],
      );
      assert.equal(denied.status, 404);
      assert.equal(denied.body.data, undefined);
    }
    for (const capacity of [100, 200]) {
      const show = all.body.data.screenings.find(
        (x) => x.availability.seated.total === capacity,
      );
      const seats = (
        await c.query(
          "SELECT id,is_wheelchair,seat_label FROM seats WHERE screen_id=$1 ORDER BY id",
          [show.screen_id],
        )
      ).rows;
      const statuses = [
        ["paid", null],
        ["company_invoiced", null],
        ["hold", "2099-01-01"],
        ["reserved", "2099-01-01"],
        ["hold", "2000-01-01"],
        ["reserved", "2000-01-01"],
        ["expired", null],
      ];
      for (let i = 0; i < statuses.length; i++) {
        const [status, expiry] = statuses[i];
        const b = (
          await c.query(
            "INSERT INTO bookings(screening_id,status,expiry_time,guest_email) VALUES($1,$2,$3,'fixture@example.invalid') RETURNING id",
            [show.id, status, expiry],
          )
        ).rows[0].id;
        const seat = seats.find(
          (s) => !s.is_wheelchair && s.seat_label === i + 2,
        );
        await c.query(
          "INSERT INTO tickets(booking_id,seat_id,amount_charged) VALUES($1,$2,1200)",
          [b, seat.id],
        );
        if (i === 2)
          await c.query(
            "INSERT INTO tickets(booking_id,seat_id,amount_charged) VALUES($1,$2,600)",
            [b, seats.find((s) => s.is_wheelchair && s.seat_label === 1).id],
          );
      }
      const staff = (
        await get(path + `&screenId=${show.screen_id}`, cookies.admin)
      ).body.data.screenings.find((x) => x.id === show.id);
      const detailResponse = await get(
        `/api/staff/screenings/${show.id}`,
        cookies.admin,
      );
      assert.equal(detailResponse.status, 200);
      assert.equal(detailResponse.cache, "no-store");
      const detail = detailResponse.body.data;
      assert.equal(detail.places.length, capacity + 10);
      assert.equal(detail.screening.id, show.id);
      assert.deepEqual(detail.availability.seated, staff.availability.seated);
      const byLabel = (label) =>
        detail.places.find((place) => place.display_label === label)
          ?.occupancy_state;
      for (const [label, state] of [
        ["1", "ceo"],
        ["2", "paid"],
        ["3", "company_secured"],
        ["4", "hold"],
        ["5", "reserved"],
        ["6", "available"],
        ["7", "available"],
        ["8", "available"],
        ["W1", "hold"],
        ["W10", "available"],
      ])
        assert.equal(byLabel(label), state, label);
      const publicSeats = (
        await get(
          `/api/seats?screenId=${show.screen_id}&screeningId=${show.id}`,
        )
      ).body.data;
      assert.ok(
        publicSeats.every((place) => !Object.hasOwn(place, "occupancy_state")),
        "Staff states are absent from customer seat responses",
      );
      for (const field of [
        "guest_email",
        "password",
        "csrfToken",
        "hold_token",
        "request_key",
        "booking_id",
      ])
        assert.ok(!JSON.stringify(detail).includes(field));
      const customer = (
        await get(
          `/api/seats/availability?screenId=${show.screen_id}&screeningId=${show.id}`,
        )
      ).body.data;
      assert.deepEqual(staff.availability.seated, customer.seated);
      assert.deepEqual(staff.availability.wheelchair, customer.wheelchair);
      assert.equal(staff.availability.seated.available, capacity - 5);
      assert.equal(staff.availability.wheelchair.available, 9);
      const other = (
        await get(path + `&screenId=${show.screen_id}`, cookies.admin)
      ).body.data.screenings.find((x) => x.id !== show.id);
      assert.equal(other.availability.seated.available, capacity - 1);
      // A real clock-relative expired hold stops blocking without changing history.
      await c.query(
        "UPDATE bookings SET expiry_time=clock_timestamp() AT TIME ZONE 'Europe/Helsinki'-interval '1 second' WHERE screening_id=$1 AND status='hold'",
        [show.id],
      );
      const expired = (
        await get(path + `&screenId=${show.screen_id}`, cookies.admin)
      ).body.data.screenings.find((x) => x.id === show.id);
      assert.equal(expired.availability.seated.available, capacity - 4);
      assert.equal(expired.availability.wheelchair.available, 10);
      const expiredDetail = (
        await get(`/api/staff/screenings/${show.id}`, cookies.admin)
      ).body.data;
      assert.equal(
        expiredDetail.places.find((place) => place.display_label === "4")
          .occupancy_state,
        "available",
      );
      assert.equal(
        expiredDetail.places.find((place) => place.display_label === "W1")
          .occupancy_state,
        "available",
      );
      assert.deepEqual(
        expiredDetail.availability.seated,
        expired.availability.seated,
      );
    }
    const sample = all.body.data.screenings[0];
    assert.equal(
      (await get(path + "&screenId=2147483647", cookies.admin)).status,
      404,
    );
    const foreign = all.body.data.screenings.find(
      (row) => row.city_id !== sample.city_id,
    );
    assert.equal(
      (
        await get(
          path + `&cityId=${sample.city_id}&screenId=${foreign.screen_id}`,
          cookies.admin,
        )
      ).status,
      400,
    );
    // Explicit SQL timezone conversion must retain the summer offset too.
    await c.query(
      "INSERT INTO screenings(film_id,screen_id,screening_time) VALUES($1,$2,'2030-07-15 18:00:00')",
      [sample.film_id, sample.screen_id],
    );
    const summer = (
      await get("/api/staff/screenings?dateFrom=2030-07-15", cookies.admin)
    ).body.data.screenings;
    assert.equal(summer[0].screening_time, "2030-07-15T15:00:00.000Z");
    await c.query(
      "INSERT INTO screenings(film_id,screen_id,screening_time) SELECT $1,$2,'2030-01-16 00:00:00'::timestamp+n*interval '1 minute' FROM generate_series(1,501) n",
      [sample.film_id, sample.screen_id],
    );
    const capped = (
      await get("/api/staff/screenings?dateFrom=2030-01-16", cookies.admin)
    ).body.data;
    assert.equal(capped.truncated, true);
    assert.equal(capped.screenings.length, 500);
    // Missing inventory is unknown, never falsely advertised as available.
    await c.query(
      "DELETE FROM seats WHERE screen_id=$1 AND is_wheelchair AND seat_label=10",
      [sample.screen_id],
    );
    const incomplete = (
      await get(path + `&screenId=${sample.screen_id}`, cookies.admin)
    ).body.data.screenings[0].availability;
    assert.equal(incomplete.inventory_complete, false);
    assert.equal(incomplete.seated.available, null);
    assert.equal(incomplete.wheelchair.available, null);
    const partial = (
      await get(`/api/staff/screenings/${sample.id}`, cookies.admin)
    ).body.data;
    assert.equal(partial.availability.inventory_complete, false);
    assert.equal(partial.availability.seated.available, null);
    const body = JSON.stringify((await get(path, cookies.admin)).body);
    for (const field of [
      "guest_email",
      "password",
      "csrfToken",
      "hold_token",
      "request_key",
    ])
      assert.ok(!body.includes(field));
  },
);
