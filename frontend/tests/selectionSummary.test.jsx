import { afterEach, expect, test, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import HomePage from "../src/pages/HomePage.jsx";
import ScreeningAvailability from "../src/features/screenings/components/ScreeningAvailability.jsx";
import {
  seatData,
  response,
  selectionResponse,
  deferred,
} from "./fixtures/seatData.js";

const next = new Date(Date.now() + 86400000).toISOString();
const shows = [11, 12, 21, 22].flatMap((screenId) =>
  [1, 2].map((n) => ({
    id: screenId * 10 + n,
    screen_id: screenId,
    city_id: Math.floor(screenId / 10),
    film_id: 31,
    film_title: "Northern Lights",
    screening_time: next,
  })),
);
function install({ availability, validate, seats } = {}) {
  const fetch = vi.fn(async (path, options = {}) => {
    const url = new URL(path, "http://localhost");
    const screenId = Number(url.searchParams.get("screenId")),
      screeningId = Number(url.searchParams.get("screeningId"));
    const capacity = screenId % 10 === 1 ? 100 : 200;
    switch (url.pathname) {
      case "/api/cities":
        return response([
          { id: 1, name: "Oulu" },
          { id: 2, name: "Tampere" },
        ]);
      case "/api/screens":
        return response(
          [11, 12, 21, 22]
            .filter(
              (id) =>
                Math.floor(id / 10) === Number(url.searchParams.get("cityId")),
            )
            .map((id) => ({
              id,
              city_id: Math.floor(id / 10),
              capacity: id % 10 === 1 ? 100 : 200,
            })),
        );
      case "/api/screenings":
        return response(shows.filter((s) => s.screen_id === screenId));
      case "/api/seats":
        return seats
          ? seats(screenId, screeningId)
          : response(seatData(capacity, screenId));
      case "/api/seats/availability":
        return availability
          ? availability(screenId, screeningId)
          : response({
              screen_id: screenId,
              screening_id: screeningId,
              as_of: new Date().toISOString(),
              inventory_complete: true,
              seated: { total: capacity, available: capacity - 1 },
              wheelchair: { total: 10, available: 10 },
            });
      case "/api/seats/validate":
        return validate
          ? validate(JSON.parse(options.body))
          : response(selectionResponse(JSON.parse(options.body)));
      default:
        throw Error("Unexpected request");
    }
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
async function browse(user, city = "1", screenId = "11", showId = "111") {
  await screen.findByRole("option", {
    name: city === "1" ? "Oulu" : "Tampere",
  });
  await user.selectOptions(screen.getByLabelText("1. City"), city);
  await waitFor(() =>
    expect(screen.getByLabelText("2. Screen").disabled).toBe(false),
  );
  await user.selectOptions(screen.getByLabelText("2. Screen"), screenId);
  await waitFor(() =>
    expect(screen.getByLabelText("3. Movie").disabled).toBe(false),
  );
  await user.selectOptions(screen.getByLabelText("3. Movie"), "31");
  await user.selectOptions(screen.getByLabelText("4. Showtime"), showId);
  await screen.findByRole("button", { name: /Row 1, seat 2,/ });
}
const seat = () => screen.getByRole("button", { name: /Row 1, seat 2,/ });
const check = () => screen.getByRole("button", { name: "Check selection" });
const review = () =>
  screen.queryByRole("region", { name: "Your selection summary" });
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

for (const [city, id, capacity] of [
  ["1", 11, 100],
  ["2", 22, 200],
])
  test(`real feature composition reaches exact ${capacity}-seat review and returns to choices`, async () => {
    const user = userEvent.setup(),
      fetch = install();
    render(<HomePage />);
    await browse(user, city, String(id), String(id * 10 + 1));
    await screen.findAllByText(
      `${capacity - 1}/${capacity} seated · 10/10 wheelchair`,
    );
    await user.click(seat());
    await user.click(
      screen.getByRole("button", { name: /Wheelchair space W3,/ }),
    );
    await user.click(check());
    await screen.findByRole("region", { name: "Your selection summary" });
    const summary = review();
    expect(summary.dataset.screeningId).toBe(String(id * 10 + 1));
    expect(summary.dataset.cityId).toBe(city);
    expect(summary.dataset.screenId).toBe(String(id));
    expect(summary.dataset.filmId).toBe("31");
    const labels = [...summary.querySelectorAll("[data-seat-id]")];
    const rows = seatData(capacity, id);
    expect(labels.map((x) => Number(x.dataset.seatId))).toEqual([
      rows.find((p) => p.display_label === "2").id,
      rows.find((p) => p.display_label === "W3").id,
    ]);
    expect(labels.map((x) => x.textContent)).toEqual([
      "Seat 2 (row 1)",
      "Wheelchair W3",
    ]);
    expect(summary.textContent).not.toContain("Helsinki time");
    expect(summary.textContent).toContain("not reserved");
    expect(document.activeElement.textContent).toBe("Your selection summary");
    await user.click(
      within(summary).getByRole("button", { name: "Back to seats" }),
    );
    expect(review()).toBe(null);
    expect(seat().getAttribute("aria-pressed")).toBe("true");
    expect(document.activeElement.textContent).toBe("Seats for this screening");
    await user.click(check());
    await screen.findByRole("region", { name: "Your selection summary" });
    await user.click(screen.getByRole("button", { name: "Change screening" }));
    expect(review()).toBe(null);
    expect(screen.getByLabelText("4. Showtime").value).toBe("");
    expect(document.activeElement).toBe(screen.getByLabelText("1. City"));
    await user.selectOptions(
      screen.getByLabelText("4. Showtime"),
      String(id * 10 + 2),
    );
    await screen.findByRole("button", { name: /Row 1, seat 2,/ });
    expect(seat().getAttribute("aria-pressed")).toBe("false");
    expect(
      fetch.mock.calls.every(([path]) => !String(path).includes("/bookings")),
    ).toBe(true);
  });

test("validated summary disappears on edits, focus refresh and city changes; failed validation never reviews", async () => {
  const user = userEvent.setup();
  let valid = true;
  install({
    validate: (body) =>
      valid
        ? response(selectionResponse(body))
        : Promise.reject(Error("offline")),
  });
  render(<HomePage />);
  await browse(user);
  await user.click(seat());
  await user.click(check());
  await screen.findByRole("region", { name: "Your selection summary" });
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(review()).toBe(null);
  await waitFor(() => expect(check().disabled).toBe(false));
  await user.click(check());
  await screen.findByRole("region", { name: "Your selection summary" });
  await user.click(seat());
  expect(review()).toBe(null);
  await user.click(seat());
  valid = false;
  await user.click(check());
  await screen.findByText(/Your selection could not be checked/);
  expect(review()).toBe(null);
  await user.selectOptions(screen.getByLabelText("1. City"), "2");
  expect(review()).toBe(null);
  expect(screen.queryByRole("button", { name: /Row 1, seat 2,/ })).toBe(null);
});

test("late validation cannot restore a summary after showtime changes", async () => {
  const old = deferred();
  let body;
  install({
    validate: (request) => {
      body = request;
      return old.promise;
    },
  });
  const user = userEvent.setup();
  render(<HomePage />);
  await browse(user);
  await user.click(seat());
  await user.click(check());
  await user.selectOptions(screen.getByLabelText("4. Showtime"), "112");
  await screen.findByRole("button", { name: /Row 1, seat 2,/ });
  await act(async () => old.resolve(response(selectionResponse(body))));
  expect(review()).toBe(null);
});

test("counts distinguish loading, malformed, incomplete, retry and stale screening replies", async () => {
  const old = deferred();
  let tries = 0;
  install({
    availability: (_, id) =>
      id === 111
        ? old.promise
        : response({
            screen_id: 11,
            screening_id: 112,
            as_of: next,
            inventory_complete: ++tries > 2,
            seated: {
              total: 100,
              available: tries > 2 ? 98 : tries === 1 ? 0 : null,
            },
            wheelchair: { total: 10, available: tries > 2 ? 9 : null },
          }),
  });
  const view = render(
    <ScreeningAvailability
      screen={{ id: 11, capacity: 100 }}
      screening={{ id: 111, screening_time: next }}
    />,
  );
  expect(screen.getByRole("status").textContent).toContain("Loading");
  view.rerender(
    <ScreeningAvailability
      screen={{ id: 11, capacity: 100 }}
      screening={{ id: 112, screening_time: next }}
    />,
  );
  await screen.findByRole("button", { name: /Retry availability/ });
  expect(screen.queryByText(/0\/100/)).toBe(null);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /Retry availability/ }));
  await screen.findByRole("button", { name: /Retry availability/ });
  expect(screen.getByRole("status").textContent).toContain("unavailable");
  await user.click(screen.getByRole("button", { name: /Retry availability/ }));
  await screen.findByText("98/100 seated · 9/10 wheelchair");
  await act(async () =>
    old.resolve(
      response({
        screen_id: 11,
        screening_id: 111,
        as_of: next,
        inventory_complete: true,
        seated: { total: 100, available: 99 },
        wheelchair: { total: 10, available: 10 },
      }),
    ),
  );
  expect(screen.queryByText("99/100 seated · 10/10 wheelchair")).toBe(null);
});

test("availability refresh uses new server counts after occupancy or expiry changes", async () => {
  let available = 99;
  install({
    availability: (screenId, screeningId) =>
      response({
        screen_id: screenId,
        screening_id: screeningId,
        as_of: next,
        inventory_complete: true,
        seated: { total: 100, available },
        wheelchair: { total: 10, available: 8 },
      }),
  });
  vi.useFakeTimers();
  await act(async () =>
    render(
      <ScreeningAvailability
        screen={{ id: 11, capacity: 100 }}
        screening={{ id: 111, screening_time: next }}
      />,
    ),
  );
  expect(screen.getByRole("status").textContent).toBe(
    "99/100 seated · 8/10 wheelchair",
  );
  available = 97;
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(screen.getByRole("status").textContent).toBe(
    "97/100 seated · 8/10 wheelchair",
  );
  available = 99;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30000);
  });
  expect(screen.getByRole("status").textContent).toBe(
    "99/100 seated · 8/10 wheelchair",
  );
});
