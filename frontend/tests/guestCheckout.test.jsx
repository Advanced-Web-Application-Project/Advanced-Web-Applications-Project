import { afterEach, expect, test, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  fireEvent,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import GuestCheckout from "../src/features/bookings/components/GuestCheckout.jsx";
import HomePage from "../src/pages/HomePage.jsx";
import {
  response,
  deferred,
  seatData,
  selectionResponse,
} from "./fixtures/seatData.js";
const next = new Date(Date.now() + 86400000).toISOString();
function context(capacity = 100) {
  return {
    city: { id: 1, name: "Oulu" },
    screen: { id: 11, capacity },
    film: { id: 31, title: "Hope" },
    screening: { id: 111, screen_id: 11, screening_time: next },
    showtime: "Sat, 21 Nov 2026, 12:00",
    selected: ["2", "W3"].map((label) =>
      seatData(capacity).find((p) => p.display_label === label),
    ),
  };
}
const errorResponse = (status, code, error) => ({
  ok: false,
  status,
  json: async () => ({ success: false, code, error }),
});
function install({ quote, create, release, capacity = 100 } = {}) {
  const ctx = context(capacity),
    calls = { quotes: [], creates: [], releases: [] },
    holds = new Map();
  const priced = (body) => ({
    screeningid: 111,
    screenId: 11,
    filmId: 31,
    screeningTime: next,
    currency: "EUR",
    asOf: new Date(Date.now() - 500).toISOString(),
    quoteFingerprint: (body.seatId.some((i) => i.category === "child")
      ? "b"
      : "a"
    ).repeat(64),
    tickets: body.seatId.map((item) => ({
      ...item,
      amountCharged: item.category === "child" ? 600 : 1200,
    })),
    totalCents: body.seatId.reduce(
      (sum, i) => sum + (i.category === "child" ? 600 : 1200),
      0,
    ),
  });
  const makeHold = (body, key) => {
    if (!holds.has(key)) {
      const p = priced(body);
      holds.set(key, {
        bookingId: 71,
        screeningid: 111,
        status: "hold",
        paymentStatus: "unpaid",
        holdToken: key,
        expiresAt: new Date(Date.now() + 300000).toISOString(),
        tickets: p.tickets,
        totalCents: p.totalCents,
      });
    }
    return holds.get(key);
  };
  const fetch = vi.fn(async (path, options = {}) => {
    const url = new URL(path, "http://localhost"),
      body = options.body ? JSON.parse(options.body) : null;
    if (url.pathname === "/api/bookings/quote") {
      calls.quotes.push(body);
      return quote ? quote(body, options, priced) : response(priced(body));
    }
    if (url.pathname === "/api/bookings" && options.method === "POST") {
      const key = options.headers["Idempotency-Key"];
      calls.creates.push({ body, key });
      return create
        ? create(body, key, makeHold, calls.creates.length)
        : response(makeHold(body, key));
    }
    if (url.pathname === "/api/bookings/71" && options.method === "DELETE") {
      calls.releases.push(options.headers.Authorization);
      return release
        ? release(calls.releases.length)
        : response({ bookingId: 71, status: "expired", historyRetained: true });
    }
    if (url.pathname === "/api/cities")
      return response([{ id: 1, name: "Oulu" }]);
    if (url.pathname === "/api/screens")
      return response([
        { id: 11, city_id: 1, capacity, wheelchair_capacity: 10 },
      ]);
    if (url.pathname === "/api/screenings")
      return response([
        { ...ctx.screening, city_id: 1, film_id: 31, film_title: "Hope" },
      ]);
    if (url.pathname === "/api/seats") return response(seatData(capacity));
    if (url.pathname === "/api/seats/validate")
      return response(selectionResponse(body));
    if (url.pathname === "/api/seats/availability")
      return response({
        screen_id: 11,
        screening_id: 111,
        as_of: new Date().toISOString(),
        inventory_complete: true,
        seated: { total: capacity, available: capacity - 1 },
        wheelchair: { total: 10, available: 10 },
      });
    throw Error("Unexpected request");
  });
  vi.stubGlobal("fetch", fetch);
  return { ctx, calls, fetch, holds, priced };
}
const start = () =>
  screen.getByRole("button", { name: "Start five-minute checkout" });
const email = () => screen.getByLabelText("Email address");
const seatCategory = () => screen.getByLabelText("Ticket for Seat 2 (row 1)");
const wheelCategory = () => screen.getByLabelText("Ticket for Wheelchair W3");
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
for (const capacity of [100, 200])
  test(`${capacity}: email/category review gets server prices, creates one unpaid hold and releases with its private credential`, async () => {
    const user = userEvent.setup(),
      onBack = vi.fn(),
      api = install({ capacity });
    render(<GuestCheckout context={api.ctx} onBack={onBack} />);
    await screen.findByText("€24.00");
    expect(api.calls.creates.length).toBe(0);
    expect(api.calls.quotes[0].clientEmail).toBe(undefined);
    await user.selectOptions(wheelCategory(), "child");
    await screen.findByText("€18.00");
    await user.click(start());
    expect(screen.getByRole("alert").textContent).toContain("valid email");
    expect(api.calls.creates.length).toBe(0);
    expect(document.activeElement).toBe(email());
    expect(email().getAttribute("aria-invalid")).toBe("true");
    await user.type(email(), "customer@example.invalid");
    await user.click(start());
    await screen.findByText(
      "Places held for checkout. Your booking is unpaid.",
    );
    expect(api.calls.creates.length).toBe(1);
    const attempt = api.calls.creates[0];
    expect(attempt.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(attempt.body.expectedQuote).toBe("b".repeat(64));
    expect(attempt.body.clientEmail).toBe("customer@example.invalid");
    expect(seatCategory().matches(":disabled")).toBe(true);
    expect(email().matches(":disabled")).toBe(true);
    expect(document.body.textContent).not.toContain(attempt.key);
    expect(screen.getByRole("timer").textContent).toMatch(/^4:5[89]|5:00$/);
    await user.click(
      screen.getByRole("button", {
        name: "Cancel checkout and return to seats",
      }),
    );
    expect(api.calls.releases).toEqual([`Bearer ${attempt.key}`]);
    expect(onBack).toHaveBeenCalledTimes(1);
  });
test("a dropped creation response keeps inputs and the exact private request for retry", async () => {
  const user = userEvent.setup(),
    api = install({
      create: (body, key, makeHold, count) => {
        const hold = makeHold(body, key);
        if (count === 1) throw Error("offline after commit");
        return response(hold);
      },
    });
  render(<GuestCheckout context={api.ctx} onBack={vi.fn()} />);
  await screen.findByText("€24.00");
  await user.type(email(), "customer@example.invalid");
  await user.click(start());
  await screen.findByRole("button", { name: "Retry checkout" });
  expect(screen.queryByText(/Your places are not held yet/)).toBe(null);
  expect(email().value).toBe("customer@example.invalid");
  expect(email().matches(":disabled")).toBe(true);
  await user.click(screen.getByRole("button", { name: "Retry checkout" }));
  await screen.findByText("Places held for checkout. Your booking is unpaid.");
  expect(api.calls.creates[1]).toEqual(api.calls.creates[0]);
  expect(api.holds.size).toBe(1);
});
test("cancel reconciles an uncertain outcome before returning; release failures retain the hold for retry", async () => {
  const user = userEvent.setup(),
    onBack = vi.fn(),
    api = install({
      create: (body, key, makeHold, count) => {
        const hold = makeHold(body, key);
        if (count === 1) throw Error("lost");
        return response(hold);
      },
      release: (count) => {
        if (count === 1) throw Error("offline");
        return response({
          bookingId: 71,
          status: "expired",
          historyRetained: true,
        });
      },
    });
  render(<GuestCheckout context={api.ctx} onBack={onBack} />);
  await screen.findByText("€24.00");
  await user.type(email(), "customer@example.invalid");
  await user.click(start());
  await screen.findByRole("button", { name: "Retry checkout" });
  await user.click(
    screen.getByRole("button", { name: "Cancel checkout and return to seats" }),
  );
  await screen.findByText(/could not confirm the release/);
  expect(onBack).not.toHaveBeenCalled();
  await user.click(
    screen.getByRole("button", { name: "Cancel checkout and return to seats" }),
  );
  await waitFor(() => expect(onBack).toHaveBeenCalledTimes(1));
  expect(
    api.calls.creates.every((c) => c.key === api.calls.creates[0].key),
  ).toBe(true);
});
test("changed quotes require another explicit review before allocating; email is kept", async () => {
  let changed = false;
  const user = userEvent.setup(),
    api = install({
      quote: (body, options, priced) => {
        const data = priced(body);
        return response(
          changed
            ? {
                ...data,
                quoteFingerprint: "c".repeat(64),
                totalCents: 3200,
                tickets: data.tickets.map((t) => ({
                  ...t,
                  amountCharged: 1600,
                })),
              }
            : data,
        );
      },
      create: () => {
        changed = true;
        return errorResponse(
          409,
          "QUOTE_CHANGED",
          "Prices changed. Review the new quote.",
        );
      },
    });
  render(<GuestCheckout context={api.ctx} onBack={vi.fn()} />);
  await screen.findByText("€24.00");
  await user.type(email(), "customer@example.invalid");
  await user.click(start());
  await screen.findByText("€32.00");
  expect(screen.getByRole("alert").textContent).toContain("Prices changed");
  expect(api.calls.creates.length).toBe(1);
  expect(email().value).toBe("customer@example.invalid");
  expect(email().disabled).toBe(false);
  expect(start().disabled).toBe(false);
});
test("price failure differs from pending and supports retry; late quote replies cannot replace current categories", async () => {
  const old = deferred();
  let count = 0;
  const user = userEvent.setup(),
    api = install({
      quote: (body, options, priced) => {
        count++;
        if (count === 1) return old.promise;
        if (count === 2)
          return errorResponse(
            503,
            "PRICE_NOT_CONFIGURED",
            "Prices are not configured",
          );
        return response(priced(body));
      },
    });
  render(<GuestCheckout context={api.ctx} onBack={vi.fn()} />);
  expect(screen.getByRole("status").textContent).toContain("Loading");
  await user.selectOptions(wheelCategory(), "child");
  await screen.findByText("Prices are not configured");
  expect(start().disabled).toBe(true);
  await user.click(screen.getByRole("button", { name: "Retry prices" }));
  await screen.findByText("€18.00");
  await act(async () =>
    old.resolve(
      response(
        api.priced({
          screeningId: 111,
          seatId: api.ctx.selected.map((p) => ({
            seatId: p.id,
            category: "adult",
          })),
        }),
      ),
    ),
  );
  expect(screen.queryByText("€24.00")).toBe(null);
});
test("server deadline ends the countdown without silently creating a new hold", async () => {
  vi.useFakeTimers();
  const api = install(),
    onBack = vi.fn();
  await act(async () => {
    render(<GuestCheckout context={api.ctx} onBack={onBack} />);
  });
  fireEvent.change(email(), { target: { value: "customer@example.invalid" } });
  await act(async () => {
    fireEvent.submit(start().closest("form"));
  });
  expect(
    screen.getByText("Places held for checkout. Your booking is unpaid."),
  ).toBeTruthy();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(301000);
  });
  expect(screen.getByRole("alert").textContent).toContain(
    "hold time has ended",
  );
  expect(api.calls.creates.length).toBe(1);
  expect(screen.queryByRole("button", { name: /Start five/ })).toBe(null);
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", {
        name: "Cancel checkout and return to seats",
      }),
    );
  });
  expect(onBack).toHaveBeenCalledTimes(1);
});

test("browsing → validated seats → checkout survives focus refresh and returns to the same screening with fresh choices", async () => {
  const user = userEvent.setup(),
    api = install();
  render(<HomePage />);
  await screen.findByRole("option", { name: "Oulu" });
  await user.selectOptions(screen.getByLabelText("1. City"), "1");
  await waitFor(() =>
    expect(screen.getByLabelText("2. Screen").disabled).toBe(false),
  );
  await user.selectOptions(screen.getByLabelText("2. Screen"), "11");
  await waitFor(() =>
    expect(screen.getByLabelText("3. Movie").disabled).toBe(false),
  );
  await user.selectOptions(screen.getByLabelText("3. Movie"), "31");
  await user.selectOptions(screen.getByLabelText("4. Showtime"), "111");
  await user.click(
    await screen.findByRole("button", { name: /^Row 1, seat 2,/ }),
  );
  await user.click(screen.getByRole("button", { name: "Check selection" }));
  await screen.findByRole("region", { name: "Your selection summary" });
  await user.click(
    screen.getByRole("button", { name: "Continue to guest checkout" }),
  );
  await screen.findAllByText("€12.00");
  expect(screen.queryByLabelText("1. City")).toBe(null);
  await user.type(email(), "customer@example.invalid");
  await user.click(start());
  await screen.findByText("Places held for checkout. Your booking is unpaid.");
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(
    screen.getByText("Places held for checkout. Your booking is unpaid."),
  ).toBeTruthy();
  await user.click(
    screen.getByRole("button", { name: "Cancel checkout and return to seats" }),
  );
  await screen.findByRole("button", { name: /^Row 1, seat 2,/ });
  expect(screen.getByLabelText("4. Showtime").value).toBe("111");
  expect(screen.getByRole("heading", { name: "Your places (0)" })).toBeTruthy();
  expect(api.calls.releases.length).toBe(1);
});

test("a stalled quote times out with retry feedback and never allocates a hold", async () => {
  vi.useFakeTimers();
  let count = 0;
  const api = install({
    quote: (body, options, priced) => {
      if (++count === 1)
        return new Promise((resolve, reject) =>
          options.signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          ),
        );
      return response(priced(body));
    },
  });
  await act(async () => {
    render(<GuestCheckout context={api.ctx} onBack={vi.fn()} />);
  });
  expect(screen.getByRole("status").textContent).toContain("Loading");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15001);
  });
  expect(screen.getByRole("alert").textContent).toContain(
    "did not respond in time",
  );
  expect(api.calls.creates.length).toBe(0);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Retry prices" }));
  });
  expect(screen.getByText("€24.00")).toBeTruthy();
});
