import { createHmac, randomBytes } from "node:crypto";
import {
  hashStaffPassword,
  verifyStaffPassword,
  STAFF_PASSWORD_PATTERN,
} from "./staffPassword.js";
import { StaffAuthError } from "./staffAuthError.js";
import { createStaffActor } from "./staffAccess.js";

export const STAFF_SESSION_MS = 8 * 60 * 60 * 1000;
const denied = () =>
  new StaffAuthError(
    401,
    "INVALID_CREDENTIALS",
    "Email or password is incorrect.",
  );
const required = () =>
  new StaffAuthError(401, "STAFF_AUTH_REQUIRED", "Staff sign-in is required.");

export function createStaffAuthService(repository, { secret }) {
  let dummyHash,
    active = 0;
  const bucket = (type, value) =>
    type +
    ":" +
    createHmac("sha256", secret)
      .update(type + "\0" + value)
      .digest("hex");
  return {
    async login(body, ip) {
      if (!(await repository.consumeAttempt(bucket("ip", ip), 25)))
        throw new StaffAuthError(
          429,
          "LOGIN_THROTTLED",
          "Too many sign-in attempts. Try again later.",
        );
      await repository.pruneAttempts();
      const valid =
        body &&
        typeof body.email === "string" &&
        body.email.length <= 254 &&
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim()) &&
        typeof body.password === "string" &&
        [...body.password].length >= 1 &&
        [...body.password].length <= 128;
      const email = await repository.canonicalEmail(
        valid ? body.email.trim() : "",
      );
      if (!(await repository.consumeAttempt(bucket("login", email), 5)))
        throw new StaffAuthError(
          429,
          "LOGIN_THROTTLED",
          "Too many sign-in attempts. Try again later.",
        );
      if (!valid) throw denied();
      if (active >= 2)
        throw new StaffAuthError(
          429,
          "LOGIN_BUSY",
          "Sign-in is busy. Try again shortly.",
        );
      active++;
      try {
        // Both known and unknown accounts wait for the same one-time dummy setup.
        dummyHash ??= hashStaffPassword(randomBytes(32).toString("base64url"));
        const fallback = await dummyHash;
        const account = await repository.credentials(email);
        const supported =
          account && STAFF_PASSWORD_PATTERN.test(account.password_hash);
        const encoded = supported ? account.password_hash : fallback;
        const matches = await verifyStaffPassword(body.password, encoded);
        if (!supported || !matches) throw denied();
        // Recheck after expensive verification; concurrent reset/disable/scope changes win.
        const row = await repository.current(
          account.id,
          account.session_version,
        );
        if (!row) throw denied();
        return {
          userId: row.id,
          version: row.session_version,
          issuedAt: row.now_ms,
          expiresAt: row.now_ms + STAFF_SESSION_MS,
        };
      } finally {
        active--;
      }
    },
    async current(session) {
      if (
        !session ||
        !Number.isInteger(session.userId) ||
        !Number.isInteger(session.version) ||
        !Number.isSafeInteger(session.issuedAt) ||
        !Number.isSafeInteger(session.expiresAt) ||
        session.expiresAt - session.issuedAt !== STAFF_SESSION_MS
      )
        throw required();
      const row = await repository.current(
        session.userId,
        session.version,
        session.expiresAt,
      );
      if (!row) throw required();
      return createStaffActor(row);
    },
    recordEvent: (userId, event) => repository.recordEvent(userId, event),
  };
}
