import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, copyFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { parseStaffCommand } from "../src/features/staff/staffProvisioningService.js";
import {
  hashStaffPassword,
  verifyStaffPassword,
} from "../src/features/staff/staffPassword.js";
import { StaffProvisioningError } from "../src/features/staff/staffProvisioningError.js";
import { manageStaff, auditStaff } from "../scripts/database/manage-staff.js";
import { readStaffPassword } from "../scripts/staff-password-prompt.js";
import {
  assertIsolatedDevelopment,
  assertConnectedLocalTarget,
  createClient,
} from "../scripts/database/connection.js";
import { migrateDatabase } from "../scripts/database/migrate.js";
import { seedBrowsing } from "../scripts/database/seed-browsing.js";
import { seedInventory } from "../scripts/database/seed-inventory.js";

const mode = "isolated-development";
const databaseUrl = process.env.TEST_DATABASE_URL;
const secret = () => randomBytes(24).toString("base64url");
const migrations = new URL("../../database/migrations/", import.meta.url);

test("staff commands reject invalid scope, secret arguments and repeated/unknown options", () => {
  assert.deepEqual(
    parseStaffCommand([
      "provision",
      "--email",
      "a@example.invalid",
      "--role",
      "administrator",
    ]),
    { action: "provision", email: "a@example.invalid", role: "administrator" },
  );
  for (const args of [
    [],
    ["register"],
    ["audit", "--email", "a@example.invalid"],
    ["provision", "--email", "not-an-email", "--role", "administrator"],
    ["provision", "--email", "a@example.invalid", "--role", "customer"],
    ["provision", "--email", "a@example.invalid", "--role", "cashier"],
    [
      "provision",
      "--email",
      "a@example.invalid",
      "--role",
      "administrator",
      "--city",
      "Oulu",
    ],
    ["disable", "--email", "a@example.invalid", "--city", "Oulu"],
    ["disable", "--email", "a@example.invalid", "--email", "b@example.invalid"],
    ["provision", "--password"],
    ["reset-password", "--email"],
  ])
    assert.throws(() => parseStaffCommand(args), StaffProvisioningError);
});

test("the maintained Node crypto library salts and verifies bounded scrypt passwords", async () => {
  const password = secret(),
    wrong = secret();
  const first = await hashStaffPassword(password),
    second = await hashStaffPassword(password);
  assert.ok(first !== second, "independent random salts");
  assert.ok(
    first.length <= 255 && !first.includes(password),
    "only bounded encoded hashes are stored",
  );
  assert.ok(await verifyStaffPassword(password, first));
  assert.ok(!(await verifyStaffPassword(wrong, first)));
  for (const encoded of [
    null,
    "legacy-not-a-login",
    first.replace("131072", "2147483648"),
    first + "x",
  ])
    assert.ok(!(await verifyStaffPassword(password, encoded)));
  for (const value of [
    "",
    randomBytes(3).toString("hex"),
    "x".repeat(129),
    null,
  ])
    await assert.rejects(hashStaffPassword(value), StaffProvisioningError);
  const unicode = secret() + "🎬".repeat(15),
    hash = await hashStaffPassword(unicode);
  assert.ok(await verifyStaffPassword(unicode, hash));
});

test("secret entry refuses non-TTY input and local writes reject unsafe targets before prompting", async () => {
  await assert.rejects(
    readStaffPassword({ input: { isTTY: false }, output: { isTTY: false } }),
    /real terminal/,
  );
  let prompted = false;
  for (const [target, targetMode] of [
    ["postgresql://shared.invalid/rio_dev", mode],
    ["postgresql://127.0.0.1/production", mode],
    ["postgresql://127.0.0.1/rio_dev", undefined],
  ])
    await assert.rejects(
      manageStaff({
        databaseUrl: target,
        mode: targetMode,
        input: {
          action: "provision",
          email: "a@example.invalid",
          role: "administrator",
        },
        readPassword: () => {
          prompted = true;
          return secret();
        },
      }),
      /Migration requires/,
    );
  assert.equal(prompted, false);
  const result = spawnSync(
    process.execPath,
    ["scripts/staff-manage.js", "--help"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0);
  assert.match(result.stdout, /reset-password/);
});

test(
  "real PostgreSQL staff identity adoption and management",
  { skip: !databaseUrl, timeout: 90000 },
  async (t) => {
    const source = assertIsolatedDevelopment(databaseUrl, mode),
      admin = createClient(databaseUrl);
    await admin.connect();
    await assertConnectedLocalTarget(admin, source);
    t.after(() => admin.end());
    let serial = 0;
    const evidence = {
      provider: "local PostgreSQL",
      checks: [],
      privateValuesRecorded: false,
    };
    async function withDatabase(run, legacy = false) {
      const name = `rio_test_staff_${process.pid}_${++serial}`,
        url = new URL(databaseUrl);
      url.pathname = `/${name}`;
      await admin.query(`CREATE DATABASE ${name}`);
      const c = createClient(url.href);
      let directory;
      try {
        if (legacy) {
          directory = await mkdtemp(join(tmpdir(), "rio-staff-legacy-"));
          for (const file of (await readdir(migrations)).filter(
            (name) => name.endsWith(".sql") && name < "0009",
          ))
            await copyFile(new URL(file, migrations), join(directory, file));
        }
        await migrateDatabase({
          databaseUrl: url.href,
          mode,
          ...(directory ? { directory: pathToFileURL(directory + "/") } : {}),
        });
        await c.connect();
        await run(url.href, c);
      } finally {
        await c.end();
        await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
        if (directory) await rm(directory, { recursive: true, force: true });
      }
    }
    const manage = (url, input, password = secret()) =>
      manageStaff({
        databaseUrl: url,
        mode,
        input,
        readPassword: async () => password,
      });
    const provision = (email, role = "administrator", city) => ({
      action: "provision",
      email,
      role,
      ...(city ? { city } : {}),
    });
    await t.test(
      "fresh constraints enforce roles, valid cashier city and normalized unique login",
      async () =>
        withDatabase(async (url, c) => {
          await c.query(
            "INSERT INTO cities(name) VALUES('Oulu'),('Tampere'),('Disposable city')",
          );
          const cases = [
            ["owner", null, "x@example.invalid", "23514"],
            ["cashier", null, "x@example.invalid", "23514"],
            ["cashier", 99999, "x@example.invalid", "23503"],
            ["administrator", 1, "x@example.invalid", "23514"],
            ["customer", 1, "x@example.invalid", "23514"],
            ["customer", null, "invalid", "23514"],
          ];
          for (const [role, city, email, code] of cases)
            await assert.rejects(
              c.query(
                "INSERT INTO users(role,permitted_city_id,email,password_hash) VALUES($1,$2,$3,'not-a-credential')",
                [role, city, email],
              ),
              { code },
            );
          const account = await manage(url, provision("Admin@Example.Invalid"));
          await assert.rejects(
            c.query(
              "INSERT INTO users(email,password_hash) VALUES(' admin@example.invalid ','not-a-credential')",
            ),
            { code: "23505" },
          );
          assert.equal(
            (
              await c.query("SELECT login_email FROM users WHERE id=$1", [
                account.userId,
              ])
            ).rows[0].login_email,
            "admin@example.invalid",
          );
          await assert.rejects(
            c.query("UPDATE users SET session_version=0 WHERE id=$1", [
              account.userId,
            ]),
            { code: "23514" },
          );
          await c.query(
            "INSERT INTO users(role,permitted_city_id,email,password_hash) VALUES('cashier',3,'disposable@example.invalid','not-a-credential')",
          );
          await assert.rejects(c.query("DELETE FROM cities WHERE id=3"), {
            code: "23514",
          });
          evidence.checks.push(
            "fresh role/city/normalized email constraints and protected city membership",
          );
        }),
    );
    for (const kind of ["scope", "email", "duplicate"]) {
      await t.test(
        `legacy ${kind} preflight reports IDs and rolls back without rewriting identities`,
        async () =>
          withDatabase(async (url, c) => {
            await c.query("INSERT INTO cities(name) VALUES('Oulu')");
            if (kind === "scope")
              await c.query(
                "INSERT INTO users(role,email,password_hash) VALUES('cashier','cashier@example.invalid','not-a-credential')",
              );
            if (kind === "email")
              await c.query(
                "INSERT INTO users(email,password_hash) VALUES('not-an-email','not-a-credential')",
              );
            if (kind === "duplicate")
              await c.query(
                "INSERT INTO users(email,password_hash) VALUES('Mixed@Example.Invalid','not-a-credential'),(' mixed@example.invalid ','not-a-credential')",
              );
            const before = (
              await c.query(
                "SELECT to_jsonb(u) AS record FROM users u ORDER BY id",
              )
            ).rows;
            const audit = await auditStaff({ databaseUrl: url });
            assert.equal(audit.readOnly, true);
            assert.ok(
              kind === "scope"
                ? audit.invalidScopeUserIds.length === 1
                : kind === "email"
                  ? audit.invalidEmailUserIds.length === 1
                  : audit.duplicateLoginGroups[0].length === 2,
            );
            await assert.rejects(
              migrateDatabase({ databaseUrl: url, mode }),
              (error) =>
                /Staff identity preflight:/.test(error.message) &&
                /user IDs: 1/.test(error.message) &&
                !error.message.includes("@"),
            );
            assert.ok(
              JSON.stringify(
                (
                  await c.query(
                    "SELECT to_jsonb(u) AS record FROM users u ORDER BY id",
                  )
                ).rows,
              ) === JSON.stringify(before),
              "original records preserved",
            );
            assert.equal(
              (
                await c.query(
                  "SELECT count(*)::int AS n FROM rio_schema_migrations",
                )
              ).rows[0].n,
              8,
            );
            assert.equal(
              (
                await c.query(
                  "SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='users' AND column_name='login_email'",
                )
              ).rows[0].n,
              0,
            );
            evidence.checks.push(
              `legacy ${kind} rejection preserves records and eight-migration ledger`,
            );
          }, true),
      );
    }
    await t.test(
      "valid legacy adoption preserves IDs, stored contact/hash, bookings and charged amounts",
      async () =>
        withDatabase(async (url, c) => {
          const target = { databaseUrl: url, mode };
          await seedBrowsing(target);
          await seedInventory(target);
          const show = (
            await c.query(
              "SELECT id,screen_id FROM screenings ORDER BY id LIMIT 1",
            )
          ).rows[0];
          const seat = (
            await c.query(
              "SELECT id FROM seats WHERE screen_id=$1 AND display_label='2'",
              [show.screen_id],
            )
          ).rows[0].id;
          const user = (
            await c.query(
              "INSERT INTO users(email,password_hash,loyalty_progress) VALUES(' Legacy@Example.Invalid ','legacy-not-a-login',7) RETURNING id",
            )
          ).rows[0].id;
          const booking = (
            await c.query(
              "INSERT INTO bookings(user_id,screening_id,status) VALUES($1,$2,'paid') RETURNING id",
              [user, show.id],
            )
          ).rows[0].id;
          await c.query(
            "INSERT INTO tickets(booking_id,seat_id,amount_charged) VALUES($1,$2,1357)",
            [booking, seat],
          );
          const original = (
            await c.query(
              "SELECT id,email,password_hash,loyalty_progress FROM users WHERE id=$1",
              [user],
            )
          ).rows[0];
          await migrateDatabase(target);
          const kept = (
            await c.query(
              "SELECT id,email,password_hash,loyalty_progress FROM users WHERE id=$1",
              [user],
            )
          ).rows[0];
          assert.ok(
            JSON.stringify(kept) === JSON.stringify(original),
            "legacy identity and credential unchanged",
          );
          const added = (
            await c.query(
              "SELECT login_email,is_enabled,session_version,provisioned_at,credentials_changed_at FROM users WHERE id=$1",
              [user],
            )
          ).rows[0];
          assert.deepEqual(added, {
            login_email: "legacy@example.invalid",
            is_enabled: true,
            session_version: 1,
            provisioned_at: null,
            credentials_changed_at: null,
          });
          assert.equal(
            (
              await c.query(
                "SELECT amount_charged FROM tickets WHERE booking_id=$1",
                [booking],
              )
            ).rows[0].amount_charged,
            1357,
          );
          assert.deepEqual(await migrateDatabase(target), {
            applied: [],
            previouslyApplied: 12,
          });
          await assert.rejects(
            manage(url, provision("legacy@example.invalid")),
            /different role or city/,
          );
          await assert.rejects(
            manage(url, { action: "disable", email: "legacy@example.invalid" }),
            /customer accounts/,
          );
          evidence.checks.push(
            "valid adoption preserves customer ID/contact/hash/loyalty, referenced paid tickets and charged snapshots",
          );
        }, true),
    );
    await t.test(
      "administrator and both cashiers provision, rerun, reset and disable with revocation versions",
      async () =>
        withDatabase(async (url, c) => {
          await c.query("INSERT INTO cities(name) VALUES('Oulu'),('Tampere')");
          const passwords = [secret(), secret(), secret()];
          const inputs = [
            provision("admin@example.invalid"),
            provision("oulu@example.invalid", "cashier", "Oulu"),
            provision("tampere@example.invalid", "cashier", "Tampere"),
          ];
          const accounts = [];
          for (let i = 0; i < inputs.length; i++)
            accounts.push(await manage(url, inputs[i], passwords[i]));
          assert.deepEqual(
            accounts.map((a) => [a.role, a.cityId, a.sessionVersion]),
            [
              ["administrator", null, 1],
              ["cashier", 1, 1],
              ["cashier", 2, 1],
            ],
          );
          const stored = async (id) =>
            (await c.query("SELECT * FROM users WHERE id=$1", [id])).rows[0];
          for (let i = 0; i < accounts.length; i++) {
            const before = await stored(accounts[i].userId);
            assert.ok(
              await verifyStaffPassword(passwords[i], before.password_hash),
            );
            const again = await manageStaff({
              databaseUrl: url,
              mode,
              input: { ...inputs[i], email: inputs[i].email.toUpperCase() },
              readPassword: () => {
                throw Error("A rerun must never ask for a password");
              },
            });
            assert.equal(again.result, "unchanged");
            assert.ok(
              JSON.stringify(await stored(again.userId)) ===
                JSON.stringify(before),
              "rerun preserves all fields",
            );
            assert.ok(
              before.provisioned_at instanceof Date &&
                before.credentials_changed_at instanceof Date,
            );
            assert.deepEqual(
              Object.keys(again).sort(),
              [
                "result",
                "userId",
                "role",
                "cityId",
                "enabled",
                "sessionVersion",
              ].sort(),
            );
          }
          const id = accounts[1].userId,
            replacement = secret();
          const reset = await manage(
            url,
            { action: "reset-password", email: inputs[1].email },
            replacement,
          );
          assert.equal(reset.sessionVersion, 2);
          const row = await stored(id);
          assert.ok(await verifyStaffPassword(replacement, row.password_hash));
          assert.ok(
            !(await verifyStaffPassword(passwords[1], row.password_hash)),
          );
          const disabled = await manage(url, {
            action: "disable",
            email: inputs[1].email,
          });
          assert.equal(disabled.enabled, false);
          assert.equal(disabled.sessionVersion, 3);
          const disabledAt = (await stored(id)).disabled_at;
          assert.ok(disabledAt instanceof Date);
          const rerun = await manage(url, inputs[1]);
          assert.equal(rerun.enabled, false);
          assert.equal(rerun.sessionVersion, 3);
          const repeated = await manage(url, {
            action: "disable",
            email: inputs[1].email,
          });
          assert.equal(repeated.sessionVersion, 3);
          const disabledReset = await manage(url, {
            action: "reset-password",
            email: inputs[1].email,
          });
          assert.equal(disabledReset.enabled, false);
          assert.equal(disabledReset.sessionVersion, 4);
          assert.equal(
            (await stored(id)).disabled_at.getTime(),
            disabledAt.getTime(),
          );
          await assert.rejects(
            manage(url, provision(inputs[1].email, "cashier", "Tampere")),
            /different role or city/,
          );
          await assert.rejects(
            manage(
              url,
              provision("new@example.invalid", "cashier", "Missing city"),
            ),
            /does not exist/,
          );
          await assert.rejects(
            manageStaff({
              databaseUrl: url,
              mode,
              input: provision("cancelled@example.invalid"),
              readPassword: () => {
                throw new StaffProvisioningError("Password entry cancelled");
              },
            }),
            /cancelled/,
          );
          assert.equal(
            (await c.query("SELECT count(*)::int AS n FROM users")).rows[0].n,
            3,
          );
          const audit = await auditStaff({ databaseUrl: url });
          assert.deepEqual(audit.invalidScopeUserIds, []);
          assert.deepEqual(audit.duplicateLoginGroups, []);
          assert.deepEqual(audit.staffNeedingCredentialResetIds, []);
          evidence.checks.push(
            "three staff roles, real password verification, unchanged reruns, reset, disable and retained disabled state",
          );
        }),
    );
    await t.test(
      "concurrent normalized provisioning produces one identity and one password prompt",
      async () =>
        withDatabase(async (url, c) => {
          let prompts = 0;
          const password = secret();
          const call = (email) =>
            manageStaff({
              databaseUrl: url,
              mode,
              input: provision(email),
              readPassword: () => {
                prompts++;
                return password;
              },
            });
          const outcomes = await Promise.all([
            call("Concurrent@Example.Invalid"),
            call(" concurrent@example.invalid "),
          ]);
          assert.equal(outcomes[0].userId, outcomes[1].userId);
          assert.equal(prompts, 1);
          assert.deepEqual(outcomes.map((o) => o.result).sort(), [
            "provisioned",
            "unchanged",
          ]);
          assert.equal(
            (await c.query("SELECT count(*)::int AS n FROM users")).rows[0].n,
            1,
          );
          evidence.checks.push(
            "concurrent case/space-equivalent requests create one account without credential reset",
          );
        }),
    );
    await t.test(
      "direct authority changes invalidate versions while loyalty writes do not",
      async () =>
        withDatabase(async (url, c) => {
          await c.query("INSERT INTO cities(name) VALUES('Oulu'),('Tampere')");
          const account = await manage(
              url,
              provision("version@example.invalid"),
            ),
            id = account.userId;
          const version = async () =>
            (
              await c.query("SELECT session_version FROM users WHERE id=$1", [
                id,
              ])
            ).rows[0].session_version;
          await c.query(
            "UPDATE users SET role='cashier',permitted_city_id=1 WHERE id=$1",
            [id],
          );
          assert.equal(await version(), 2);
          await c.query("UPDATE users SET permitted_city_id=2 WHERE id=$1", [
            id,
          ]);
          assert.equal(await version(), 3);
          await c.query(
            "UPDATE users SET email='changed@example.invalid' WHERE id=$1",
            [id],
          );
          assert.equal(await version(), 4);
          await c.query("UPDATE users SET is_enabled=false WHERE id=$1", [id]);
          assert.equal(await version(), 5);
          await c.query("UPDATE users SET is_enabled=true WHERE id=$1", [id]);
          assert.equal(await version(), 6);
          await c.query("UPDATE users SET loyalty_progress=1 WHERE id=$1", [
            id,
          ]);
          assert.equal(await version(), 6);
          await assert.rejects(
            c.query("UPDATE users SET session_version=1 WHERE id=$1", [id]),
            { code: "23514" },
          );
          evidence.checks.push(
            "database trigger revokes by monotonically increasing version after scope/contact/enabled changes; loyalty is independent",
          );
        }),
    );
    if (process.env.RIO_STAFF_PROVISIONING_EVIDENCE_PATH)
      await writeFile(
        process.env.RIO_STAFF_PROVISIONING_EVIDENCE_PATH,
        JSON.stringify(evidence, null, 2) + "\n",
      );
  },
);
