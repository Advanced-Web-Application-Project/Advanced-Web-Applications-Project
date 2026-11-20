import { StaffProvisioningError } from "./staffProvisioningError.js";
import { hashStaffPassword } from "./staffPassword.js";

export function parseStaffCommand(args) {
  if (args.length === 1 && args[0] === "--help") return { action: "help" };
  const [action, ...rest] = args;
  if (!["audit", "provision", "reset-password", "disable"].includes(action))
    throw new StaffProvisioningError(
      "Choose audit, provision, reset-password or disable; use --help for syntax.",
    );
  const input = { action };
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]?.slice(2);
    if (
      !rest[i]?.startsWith("--") ||
      !["email", "role", "city"].includes(key) ||
      Object.hasOwn(input, key) ||
      !rest[i + 1] ||
      rest[i + 1].startsWith("--")
    )
      throw new StaffProvisioningError(
        "Unknown, repeated or incomplete option. Password arguments are not accepted.",
      );
    input[key] = rest[i + 1];
  }
  return validateStaffCommand(input);
}

export function validateStaffCommand(input) {
  const { action } = input;
  if (action === "audit" && Object.keys(input).length === 1) return input;
  if (!["provision", "reset-password", "disable"].includes(action))
    throw new StaffProvisioningError("Invalid staff command options.");
  if (
    typeof input.email !== "string" ||
    input.email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim())
  )
    throw new StaffProvisioningError(
      "A valid email of at most 254 characters is required.",
    );
  if (action === "provision") {
    if (!["administrator", "cashier"].includes(input.role))
      throw new StaffProvisioningError(
        "Provision only administrator or cashier accounts.",
      );
    if (
      input.role === "cashier" &&
      (typeof input.city !== "string" ||
        !input.city.trim() ||
        input.city.length > 255)
    )
      throw new StaffProvisioningError(
        "Cashiers require one existing city name.",
      );
    if (input.role === "administrator" && input.city !== undefined)
      throw new StaffProvisioningError(
        "Administrators have both-city scope and cannot carry a city restriction.",
      );
  } else if (input.role !== undefined || input.city !== undefined) {
    throw new StaffProvisioningError(
      "Role and city options apply only to provisioning; existing scope is never silently changed.",
    );
  }
  return {
    ...input,
    email: input.email.trim(),
    ...(input.city === undefined ? {} : { city: input.city.trim() }),
  };
}

function summary(row, result) {
  return {
    result,
    userId: row.id,
    role: row.role,
    cityId: row.permitted_city_id,
    enabled: row.is_enabled,
    sessionVersion: row.session_version,
  };
}

export function createStaffProvisioningService(repository) {
  return {
    async manage(input, readPassword) {
      const request = validateStaffCommand(input);
      return repository.transaction(async (transaction) => {
        const user = await transaction.findByEmail(request.email);
        if (request.action === "provision") {
          const cityId =
            request.role === "cashier"
              ? await transaction.findCityId(request.city)
              : null;
          if (request.role === "cashier" && cityId === null)
            throw new StaffProvisioningError(
              "Selected city does not exist; seed or inspect locations first.",
            );
          if (user) {
            if (user.role !== request.role || user.permitted_city_id !== cityId)
              throw new StaffProvisioningError(
                "An existing login has a different role or city. Review it manually; nothing was changed.",
              );
            return summary(user, "unchanged");
          }
          const hash = await hashStaffPassword(await readPassword());
          return summary(
            await transaction.insertStaff(
              request.email,
              request.role,
              cityId,
              hash,
            ),
            "provisioned",
          );
        }
        if (!user || !["administrator", "cashier"].includes(user.role))
          throw new StaffProvisioningError(
            "No staff account matches this login; customer accounts cannot be managed here.",
          );
        if (request.action === "disable") {
          return summary(
            user.is_enabled ? await transaction.disable(user.id) : user,
            user.is_enabled ? "disabled" : "unchanged",
          );
        }
        const hash = await hashStaffPassword(await readPassword());
        return summary(
          await transaction.resetPassword(user.id, hash),
          "password-reset",
        );
      });
    },
  };
}
