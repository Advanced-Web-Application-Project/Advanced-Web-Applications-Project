import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import App from "../src/App.jsx";
import { createSessionModel } from "../src/features/session/services/sessionModel.js";
import { identity, response, deferred } from "./fixtures/sessionData.js";

let models = [];
beforeEach(() => {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
});
afterEach(() => {
  cleanup();
  for (const model of models) model.stop();
  models = [];
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function install({
  initial = null,
  current,
  login,
  logout,
  path = "/screenings",
} = {}) {
  let session = initial;
  const calls = [];
  const fetch = vi.fn(async (url, options = {}) => {
    calls.push({ url, options });
    if (url === "/api/staff/session")
      return current
        ? current()
        : session
          ? response(session)
          : response(null, 401);
    if (url === "/api/staff/login") {
      const data = login
        ? await login(JSON.parse(options.body))
        : response(identity());
      if (data.ok) session = (await data.json()).data;
      return data;
    }
    if (url === "/api/staff/logout") {
      if (logout) return logout();
      session = null;
      return response({ signedOut: true });
    }
    if (url === "/api/cities")
      return response([
        { id: 7, name: "Oulu" },
        { id: 8, name: "Tampere" },
      ]);
    throw Error("Unexpected fixture request");
  });
  const model = createSessionModel({ fetchImpl: fetch });
  models.push(model);
  render(
    <MemoryRouter initialEntries={[path]}>
      <App model={model} />
    </MemoryRouter>,
  );
  return {
    model,
    calls,
    fetch,
    setSession: (value) => {
      session = value;
    },
  };
}
const password = () => crypto.randomUUID() + crypto.randomUUID();
async function signIn(user) {
  await screen.findByRole("heading", { name: "Sign in to RIO" });
  await user.type(
    screen.getByLabelText("Email address"),
    "staff@example.invalid",
  );
  await user.type(screen.getByLabelText("Password"), password());
  await user.click(
    screen.getByRole("button", { name: "Sign in", exact: true }),
  );
}

test("bootstrap shows no private content or data request before current-session resolves", async () => {
  const slow = deferred();
  const api = install({ current: () => slow.promise });
  expect(
    screen.getByRole("heading", { name: "Checking your session…" }),
  ).toBeTruthy();
  expect(screen.queryByRole("navigation")).toBe(null);
  expect(api.calls.length).toBe(1);
  await act(async () => slow.resolve(response(null, 401)));
  await screen.findByRole("heading", { name: "Sign in to RIO" });
  expect(api.calls.length).toBe(1);
});
test("form validates, announces submitting and clears the password before the response", async () => {
  const slow = deferred(),
    user = userEvent.setup();
  const api = install({ login: () => slow.promise });
  await screen.findByRole("heading", { name: "Sign in to RIO" });
  await user.click(
    screen.getByRole("button", { name: "Sign in", exact: true }),
  );
  expect(document.activeElement).toBe(screen.getByLabelText("Email address"));
  await user.type(
    screen.getByLabelText("Email address"),
    "staff@example.invalid",
  );
  await user.click(
    screen.getByRole("button", { name: "Sign in", exact: true }),
  );
  expect(document.activeElement).toBe(screen.getByLabelText("Password"));
  await user.type(screen.getByLabelText("Password"), password());
  await user.click(
    screen.getByRole("button", { name: "Sign in", exact: true }),
  );
  expect(screen.getByLabelText("Password").value.length).toBe(0);
  expect(screen.getByRole("button", { name: "Signing in…" }).disabled).toBe(
    true,
  );
  await act(async () => slow.resolve(response(null, 401)));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Email or password is incorrect",
  );
  expect(api.calls.filter((c) => c.url.endsWith("/login")).length).toBe(1);
});
test.each([
  ["administrator", null, "All cities"],
  ["cashier", 7, "Oulu"],
  ["cashier", 8, "Tampere"],
])(
  "server identity response controls %s scope %s",
  async (role, cityId, label) => {
    const user = userEvent.setup();
    install({ login: () => response(identity(role, 1, cityId)) });
    await signIn(user);
    await screen.findByRole("heading", { name: "Screenings" });
    await screen.findByText(label);
    expect(
      screen.getByRole("navigation", { name: "Staff navigation" }).textContent,
    ).toContain("Screenings");
    expect(screen.queryByRole("link", { name: "Films" })).toBe(null);
    expect(screen.queryByRole("link", { name: "Prices" })).toBe(null);
    expect(
      screen.getByText(
        "Screening lists and reservation tools are not available here yet.",
      ),
    ).toBeTruthy();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  },
);
test("throttle response disables resubmission without retaining password", async () => {
  const user = userEvent.setup();
  install({
    login: () => ({
      ...response(null, 429),
      headers: new Headers({ "Retry-After": "900" }),
    }),
  });
  await signIn(user);
  await screen.findByText(
    "Too many sign-in attempts. Please wait before trying again.",
  );
  expect(
    screen.getByRole("button", { name: "Sign in", exact: true }).disabled,
  ).toBe(true);
  expect(screen.getByLabelText("Password").value.length).toBe(0);
});
test("unknown sign-in outcome is reconciled with GET rather than replaying credentials", async () => {
  const user = userEvent.setup();
  let checks = 0;
  const api = install({
    current: () =>
      ++checks === 1 ? response(null, 401) : response(identity()),
    login: () => {
      throw Error("reply lost after commit");
    },
  });
  await signIn(user);
  await user.click(
    await screen.findByRole("button", { name: "Check sign-in status" }),
  );
  await screen.findByRole("heading", { name: "Screenings" });
  expect(api.calls.filter((c) => c.url.endsWith("/login")).length).toBe(1);
});
test("logout clears private content before its response and supports explicit failure retry", async () => {
  const pending = deferred(),
    user = userEvent.setup();
  let calls = 0;
  install({
    initial: identity(),
    logout: () =>
      ++calls === 1 ? pending.promise : response({ signedOut: true }),
  });
  await screen.findByRole("heading", { name: "Screenings" });
  await user.click(screen.getByRole("button", { name: "Sign out" }));
  expect(screen.queryByRole("navigation")).toBe(null);
  await act(async () => pending.reject(Error("offline")));
  await user.click(
    await screen.findByRole("button", { name: "Retry sign-out" }),
  );
  await screen.findByRole("heading", { name: "Sign in to RIO" });
  expect(calls).toBe(2);
});
test("blur hides/clears staff data; focus rechecks and cannot reuse a different account scope", async () => {
  const api = install({ initial: identity("cashier", 1, 7) });
  await screen.findByText("Oulu");
  await act(async () => window.dispatchEvent(new Event("blur")));
  expect(document.documentElement.classList.contains("staff-suspended")).toBe(
    true,
  );
  expect(screen.queryByRole("navigation")).toBe(null);
  api.setSession(identity("cashier", 2, 8));
  await act(async () => window.dispatchEvent(new Event("focus")));
  await screen.findByText("Tampere");
  expect(screen.queryByText("Oulu")).toBe(null);
  expect(document.documentElement.classList.contains("staff-suspended")).toBe(
    false,
  );
});
test("revoked session and page-cache restore return to sign-in without stale staff content", async () => {
  const api = install({ initial: identity() });
  await screen.findByRole("heading", { name: "Screenings" });
  api.setSession(null);
  await act(async () => window.dispatchEvent(new Event("pagehide")));
  expect(screen.queryByRole("navigation")).toBe(null);
  await act(async () => window.dispatchEvent(new Event("pageshow")));
  await screen.findByRole("heading", { name: "Sign in to RIO" });
  expect(screen.queryByText("Administrator")).toBe(null);
});
test("403 access denial is distinct from expired sign-in and supports rechecking", async () => {
  let checks = 0;
  const user = userEvent.setup();
  install({
    current: () => (++checks === 1 ? response(null, 403) : response(null, 401)),
  });
  await screen.findByRole("heading", { name: "Staff access denied" });
  expect(screen.queryByLabelText("Password")).toBe(null);
  await user.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByRole("heading", { name: "Sign in to RIO" });
});
test("network bootstrap failure has retry and no private content", async () => {
  let count = 0;
  const user = userEvent.setup();
  install({
    current: () => {
      if (++count === 1) throw Error("offline");
      return response(identity());
    },
  });
  await user.click(await screen.findByRole("button", { name: "Try again" }));
  await screen.findByRole("heading", { name: "Screenings" });
});
test("unknown protected route is accessible only after bootstrap and has working return navigation", async () => {
  const user = userEvent.setup();
  install({ initial: identity(), path: "/missing" });
  await screen.findByRole("heading", { name: "Page not found" });
  await user.click(screen.getByRole("link", { name: "Back to Screenings" }));
  await screen.findByRole("heading", { name: "Screenings" });
});
test("external return URL is discarded after sign-in", async () => {
  const user = userEvent.setup();
  install({ path: "/sign-in?returnTo=https%3A%2F%2Fattacker.invalid" });
  await signIn(user);
  await screen.findByRole("heading", { name: "Screenings" });
  expect(screen.queryByRole("heading", { name: "Page not found" })).toBe(null);
});

test("periodic server expiry clears staff content and returns to sign-in", async () => {
  vi.useFakeTimers();
  let checks = 0;
  await act(async () => {
    install({
      current: () =>
        ++checks === 1 ? response(identity()) : response(null, 401),
    });
  });
  expect(screen.getByRole("heading", { name: "Screenings" })).toBeTruthy();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60000);
  });
  expect(screen.getByRole("heading", { name: "Sign in to RIO" })).toBeTruthy();
  expect(screen.queryByRole("navigation")).toBe(null);
  expect(screen.getByText("Your session ended. Sign in again.")).toBeTruthy();
});

test("cross-tab notifications contain no credentials and always reload the real server identity", async () => {
  const previous = window.BroadcastChannel,
    channels = [];
  class Channel {
    constructor() {
      channels.push(this);
      this.sent = [];
    }
    postMessage(value) {
      this.sent.push(value);
    }
    close() {}
  }
  Object.defineProperty(window, "BroadcastChannel", {
    configurable: true,
    writable: true,
    value: Channel,
  });
  try {
    const api = install({ initial: identity() });
    await screen.findByText("All cities");
    api.setSession(identity("cashier", 2, 8));
    await act(async () =>
      channels[0].onmessage({
        data: { type: "session-changed", user: { role: "administrator" } },
      }),
    );
    await screen.findByText("Tampere");
    expect(screen.queryByText("Administrator")).toBe(null);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    await screen.findByRole("heading", { name: "Sign in to RIO" });
    expect(channels[0].sent).toEqual([{ type: "session-changed" }]);
  } finally {
    Object.defineProperty(window, "BroadcastChannel", {
      configurable: true,
      writable: true,
      value: previous,
    });
  }
});

test("disabled staff service explains setup and can recheck without rendering private content", async () => {
  let checks = 0;
  const user = userEvent.setup();
  const api = install({
    current: () =>
      ++checks === 1
        ? response(null, 503, "STAFF_UNAVAILABLE")
        : response(null, 401),
  });
  await screen.findByRole("heading", { name: "Staff sign-in isn’t available" });
  expect(
    screen.getByText(
      "Staff access hasn’t been enabled yet. Contact the person who manages RIO.",
    ),
  ).toBeTruthy();
  expect(screen.queryByRole("navigation")).toBe(null);
  expect(api.calls.length).toBe(1);
  await user.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByRole("heading", { name: "Sign in to RIO" });
});
