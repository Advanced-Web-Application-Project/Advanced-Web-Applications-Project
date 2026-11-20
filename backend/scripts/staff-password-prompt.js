import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { StaffProvisioningError } from "../src/features/staff/staffProvisioningError.js";
import { validateStaffPassword } from "../src/features/staff/staffPassword.js";

export async function readStaffPassword({
  input = process.stdin,
  output = process.stderr,
} = {}) {
  if (!input.isTTY || !output.isTTY)
    throw new StaffProvisioningError(
      "Password entry requires a real terminal. Password arguments, environment variables and piped input are not supported.",
    );
  const hidden = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  const reader = createInterface({
    input,
    output: hidden,
    terminal: true,
    historySize: 0,
  });
  const controller = new AbortController();
  reader.once("SIGINT", () => controller.abort());
  reader.once("close", () => controller.abort());
  async function ask(label) {
    output.write(label);
    try {
      return await reader.question("", { signal: controller.signal });
    } catch {
      throw new StaffProvisioningError(
        "Password entry cancelled; no credentials were changed.",
      );
    } finally {
      output.write("\n");
    }
  }
  try {
    const password = await ask("New password (hidden, 15–128 characters): ");
    validateStaffPassword(password);
    const confirmation = await ask("Confirm password (hidden): ");
    if (password !== confirmation)
      throw new StaffProvisioningError(
        "Passwords did not match; no credentials were changed.",
      );
    return password;
  } finally {
    reader.close();
    hidden.end();
  }
}
