import { ApiError } from "../../../shared/services/apiClient.js";

export function validateCustomerSession(data) {
  const user = data?.user;
  if (
    !user ||
    !Number.isInteger(user.id) ||
    user.id < 1 ||
    typeof user.email !== "string" ||
    typeof data.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(data.expiresAt)) ||
    typeof data.csrfToken !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(data.csrfToken)
  )
    throw new ApiError(
      "The customer service returned an unexpected identity.",
      0,
      "INVALID_IDENTITY",
    );
  return {
    user: { id: user.id, email: user.email },
    expiresAt: data.expiresAt,
    csrfToken: data.csrfToken,
  };
}

export function createCustomerSessionService(request) {
  return {
    current: async (signal) =>
      validateCustomerSession(
        await request("/customer/session", {
          signal,
          cache: "no-store",
          credentials: "include",
        }),
      ),
    login: async (email, password, signal) =>
      validateCustomerSession(
        await request("/customer/login", {
          method: "POST",
          body: { email, password },
          signal,
          cache: "no-store",
          credentials: "include",
          headers: { "X-RIO-Customer": "1" },
        }),
      ),
    register: async (email, password, signal) =>
      validateCustomerSession(
        await request("/customer/register", {
          method: "POST",
          body: { email, password },
          signal,
          cache: "no-store",
          credentials: "include",
          headers: { "X-RIO-Customer": "1" },
        }),
      ),
    logout: (token, signal) =>
      request("/customer/logout", {
        method: "POST",
        signal,
        cache: "no-store",
        credentials: "include",
        headers: { "X-CSRF-Token": token },
      }),
  };
}
