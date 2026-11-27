import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CustomerAccount from "../src/features/account/components/CustomerAccount.jsx";
import CustomerSessionProvider from "../src/features/account/components/CustomerSessionProvider.jsx";
import { createCustomerSessionModel } from "../src/features/account/services/customerSessionModel.js";
import { ApiError, createApiClient } from "../src/shared/services/apiClient.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function install() {
  const calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, options = {}) => {
      calls.push({ url, options });
      if (url === "/api/customer/session")
        return {
          ok: false,
          status: 401,
          json: async () => ({
            success: false,
            code: "CUSTOMER_AUTH_REQUIRED",
            error: "Customer sign-in is required.",
          }),
        };
      if (url === "/api/customer/login") {
        expect(JSON.parse(options.body)).toEqual({
          email: "customer@example.invalid",
          password: "customer-password",
        });
      }
      if (url === "/api/customer/login" || url === "/api/customer/register") {
        return {
          ok: true,
          status: url.endsWith("/register") ? 201 : 200,
          json: async () => ({
            success: true,
            data: {
              user: { id: 8, email: "customer@example.invalid" },
              expiresAt: "2030-01-01T00:00:00.000Z",
              csrfToken: "a".repeat(43),
            },
          }),
        };
      }
      if (url === "/api/customer/logout")
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: { signedOut: true },
          }),
        };
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  const model = createApiClient("/api");
  render(
    <CustomerSessionProvider
      model={createCustomerSessionModel({ request: model })}
    >
      <CustomerAccount />
    </CustomerSessionProvider>,
  );
  return calls;
}

test("customer can sign in and out with a cookie-backed session while guest checkout stays available", async () => {
  const user = userEvent.setup();
  const calls = install();
  await user.click(
    await screen.findByRole("button", { name: "Customer sign in" }),
  );
  expect(screen.getByText(/continue as a guest/i)).toBeTruthy();
  await user.type(
    await screen.findByLabelText("Email address"),
    "customer@example.invalid",
  );
  await user.type(screen.getByLabelText("Password"), "customer-password");
  await user.click(screen.getByRole("button", { name: "Sign in" }));
  expect(
    await screen.findByText("Signed in as customer@example.invalid"),
  ).toBeTruthy();

  await user.click(screen.getByRole("button", { name: "Sign out" }));
  expect(
    await screen.findByRole("button", { name: "Customer sign in" }),
  ).toBeTruthy();

  await waitFor(() => expect(calls).toHaveLength(3));
  expect(calls.map(({ url }) => url)).toEqual([
    "/api/customer/session",
    "/api/customer/login",
    "/api/customer/logout",
  ]);
  expect(calls.every(({ options }) => options.credentials === "include")).toBe(
    true,
  );
  expect(calls[1].options.headers["X-RIO-Customer"]).toBe("1");
  expect(calls[2].options.headers["X-CSRF-Token"]).toBe("a".repeat(43));
});

test("expired customer sessions are treated as signed out", async () => {
  const model = createCustomerSessionModel({
    request: async (path) => {
      if (path === "/customer/session")
        return {
          user: { id: 8, email: "customer@example.invalid" },
          expiresAt: "2030-01-01T00:00:00.000Z",
          csrfToken: "a".repeat(43),
        };
      throw new ApiError("Customer sign-in is required.", 401);
    },
  });
  await model.check();
  await model.signOut();
  expect(model.getSnapshot().status).toBe("anonymous");
});

test("customer can create an immediately active email account with password confirmation", async () => {
  const user = userEvent.setup();
  const calls = install();
  await user.click(
    await screen.findByRole("button", { name: "Customer sign in" }),
  );
  await user.click(screen.getByRole("button", { name: "Create an account" }));
  await user.type(
    await screen.findByLabelText("Email address"),
    "customer@example.invalid",
  );
  await user.type(
    screen.getByLabelText("Password (15 to 128 characters)"),
    "very-strong-customer-password",
  );
  const confirmation = screen.getByLabelText("Confirm password");
  await user.type(confirmation, "different-password");
  await user.click(screen.getByRole("button", { name: "Create account" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Passwords do not match.",
  );
  expect(document.activeElement).toBe(confirmation);
  expect(calls).toHaveLength(1);

  await user.clear(confirmation);
  await user.type(confirmation, "very-strong-customer-password");
  await user.click(screen.getByRole("button", { name: "Create account" }));
  expect(
    await screen.findByText("Signed in as customer@example.invalid"),
  ).toBeTruthy();
  expect(calls.map(({ url }) => url)).toEqual([
    "/api/customer/session",
    "/api/customer/register",
  ]);
  expect(JSON.parse(calls[1].options.body)).toEqual({
    email: "customer@example.invalid",
    password: "very-strong-customer-password",
  });
  expect(calls[1].options.headers["X-RIO-Customer"]).toBe("1");
  expect(calls[1].options.credentials).toBe("include");
});
