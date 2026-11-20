import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { StaffProvisioningError } from "./staffProvisioningError.js";

const derive = promisify(scrypt);
const options = { N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 };
const prefix = "$scrypt$v1$131072$8$1$";
export const STAFF_PASSWORD_PATTERN =
  /^\$scrypt\$v1\$131072\$8\$1\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{86})$/;

export function validateStaffPassword(password) {
  if (
    typeof password !== "string" ||
    [...password].length < 15 ||
    [...password].length > 128
  )
    throw new StaffProvisioningError(
      "Use a password of 15–128 characters. It is never trimmed or truncated.",
    );
}

export async function hashStaffPassword(password) {
  validateStaffPassword(password);
  const salt = randomBytes(16);
  const key = await derive(password, salt, 64, options);
  return `${prefix}${salt.toString("base64url")}$${key.toString("base64url")}`;
}

// Bound the encoded cost and input before invoking the expensive library operation.
export async function verifyStaffPassword(password, encoded) {
  if (
    typeof password !== "string" ||
    [...password].length > 128 ||
    typeof encoded !== "string"
  )
    return false;
  const match = STAFF_PASSWORD_PATTERN.exec(encoded);
  if (!match) return false;
  const salt = Buffer.from(match[1], "base64url"),
    expected = Buffer.from(match[2], "base64url");
  if (
    salt.toString("base64url") !== match[1] ||
    expected.toString("base64url") !== match[2]
  )
    return false;
  const actual = await derive(password, salt, 64, options);
  return timingSafeEqual(actual, expected);
}
