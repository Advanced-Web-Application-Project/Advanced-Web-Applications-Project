import { ApiError } from "../../../shared/services/apiClient.js";
export function validateSession(data) {
  const user = data?.user;
  if (
    !user ||
    !Number.isInteger(user.id) ||
    user.id < 1 ||
    !["administrator", "cashier"].includes(user.role) ||
    (user.role === "administrator"
      ? user.cityId !== null
      : !Number.isInteger(user.cityId) || user.cityId < 1) ||
    typeof data.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(data.expiresAt)) ||
    typeof data.csrfToken !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(data.csrfToken)
  )
    throw new ApiError(
      "The staff service returned an unexpected identity.",
      0,
      "INVALID_IDENTITY",
    );
  return {
    user: { id: user.id, role: user.role, cityId: user.cityId },
    expiresAt: data.expiresAt,
    csrfToken: data.csrfToken,
  };
}
export function createSessionService(request) {
  return {
    current: async (signal) =>
      validateSession(
        await request("/staff/session", { signal, ignoreUnauthorized: true }),
      ),
    login: async (email, password, signal) =>
      validateSession(
        await request("/staff/login", {
          method: "POST",
          body: { email, password },
          signal,
          ignoreUnauthorized: true,
          csrf: false,
        }),
      ),
    logout: (token, signal) =>
      request("/staff/logout", {
        method: "POST",
        csrfToken: token,
        signal,
        ignoreUnauthorized: true,
      }),
  };
}
