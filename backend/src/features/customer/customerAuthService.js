import { createHmac, randomBytes } from "node:crypto";
import {
  hashStaffPassword,
  STAFF_PASSWORD_PATTERN,
  verifyStaffPassword,
} from "../staff/staffPassword.js";
import { CustomerAuthError } from "./customerAuthError.js";

export const CUSTOMER_SESSION_MS = 8 * 60 * 60 * 1000;
const denied = () =>
  new CustomerAuthError(
    401,
    "INVALID_CREDENTIALS",
    "Email or password is incorrect.",
  );

export function createCustomerAuthService(repository, { secret }) {
  let dummyHash, active = 0;
  const bucket = (type, value) =>
    type +
    ":" +
    createHmac("sha256", secret)
      .update(type + "\0" + value)
      .digest("hex");
  const sessionFor = (row) => ({
    userId: row.id,
    version: row.session_version,
    issuedAt: row.now_ms,
    expiresAt: row.now_ms + CUSTOMER_SESSION_MS,
  });
  return {
    async login(body, ip) {
      if (!(await repository.consumeAttempt(bucket("ip", ip), 25)))
        throw new CustomerAuthError(
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
        throw new CustomerAuthError(
          429,
          "LOGIN_THROTTLED",
          "Too many sign-in attempts. Try again later.",
        );
      if (!valid) throw denied();
      if (active >= 2)
        throw new CustomerAuthError(
          429,
          "LOGIN_BUSY",
          "Sign-in is busy. Try again shortly.",
        );
      active++;
      try {
        dummyHash ??= hashStaffPassword(
          randomBytes(32).toString("base64url"),
        );
        const fallback = await dummyHash;
        const account = await repository.credentials(email);
        const supported =
          account && STAFF_PASSWORD_PATTERN.test(account.password_hash);
        const matches = await verifyStaffPassword(
          body.password,
          supported ? account.password_hash : fallback,
        );
        if (!supported || !matches) throw denied();
        const row = await repository.current(
          account.id,
          account.session_version,
        );
        if (!row) throw denied();
        return sessionFor(row);
      } finally {
        active--;
      }
    },
    async register(body, ip) {
      if (!(await repository.consumeAttempt(bucket("registration-ip", ip), 10)))
        throw new CustomerAuthError(
          429,
          "REGISTRATION_THROTTLED",
          "Too many registration attempts. Try again later.",
        );
      await repository.pruneAttempts();
      const validEmail =
        body &&
        typeof body.email === "string" &&
        body.email.length <= 254 &&
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim());
      const email = await repository.canonicalEmail(
        validEmail ? body.email.trim() : "",
      );
      if (
        !(await repository.consumeAttempt(
          bucket("registration-email", email),
          3,
        ))
      )
        throw new CustomerAuthError(
          429,
          "REGISTRATION_THROTTLED",
          "Too many registration attempts. Try again later.",
        );
      const validPassword =
        typeof body?.password === "string" &&
        [...body.password].length >= 15 &&
        [...body.password].length <= 128;
      if (!validEmail || !validPassword)
        throw new CustomerAuthError(
          400,
          "INVALID_REGISTRATION",
          "Enter a valid email and a password of 15 to 128 characters.",
        );
      if (active >= 2)
        throw new CustomerAuthError(
          429,
          "LOGIN_BUSY",
          "Sign-in is busy. Try again shortly.",
        );
      active++;
      try {
        const passwordHash = await hashStaffPassword(body.password);
        let row;
        try {
          row = await repository.register(email, passwordHash);
        } catch (error) {
          if (error.code === "23505")
            throw new CustomerAuthError(
              409,
              "EMAIL_IN_USE",
              "An account with this email already exists. Sign in instead.",
            );
          throw error;
        }
        return sessionFor(row);
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
        session.expiresAt - session.issuedAt !== CUSTOMER_SESSION_MS
      )
        throw new CustomerAuthError(
          401,
          "CUSTOMER_AUTH_REQUIRED",
          "Customer sign-in is required.",
        );
      const row = await repository.current(
        session.userId,
        session.version,
        session.expiresAt,
      );
      if (!row)
        throw new CustomerAuthError(
          401,
          "CUSTOMER_AUTH_REQUIRED",
          "Customer sign-in is required.",
        );
      return { id: row.id, email: row.login_email };
    },
  };
}
