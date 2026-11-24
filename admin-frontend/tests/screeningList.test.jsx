import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useSearchParams } from "react-router";
import { SessionContext } from "../src/features/session/SessionContext.js";
import { createSessionModel } from "../src/features/session/services/sessionModel.js";
import StaffScreeningList from "../src/features/screenings/components/StaffScreeningList.jsx";
import { formatScreeningTime } from "../src/features/screenings/services/screeningList.js";
import { identity, response, deferred } from "./fixtures/sessionData.js";
const models = [];
const row = (id = 1, complete = true) => ({
  id,
  film_title: "Northern Lights",
  screen_id: 11,
  city_id: 7,
  city_name: "Oulu",
  screening_time: "2030-01-15T16:00:00Z",
  availability: {
    inventory_complete: complete,
    seated: { total: 100, available: complete ? 99 : null },
    wheelchair: { total: 10, available: complete ? 10 : null },
  },
});
const listing = (rows = [row()]) => ({
  as_of: "2030-01-15T10:00:00Z",
  screenings: rows,
  cities: [
    { id: 7, name: "Oulu" },
    { id: 8, name: "Tampere" },
  ],
  screens: [
    { id: 11, city_id: 7, capacity: 100 },
    { id: 12, city_id: 8, capacity: 200 },
  ],
  filters: {
    dateFrom: "2030-01-15",
    dateTo: "2030-01-15",
    cityId: null,
    screenId: null,
  },
});
beforeEach(() =>
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  }),
);
afterEach(() => {
  cleanup();
  models.splice(0).forEach((model) => model.stop());
  vi.useRealTimers();
});
function TestRoute() {
  const [, setParams] = useSearchParams();
  return (
    <>
      <button onClick={() => setParams({ dateFrom: "2030-01-16" })}>
        Change date
      </button>
      <StaffScreeningList />
    </>
  );
}
async function install(
  read = async () => response(listing()),
  role = "administrator",
) {
  const calls = [];
  const model = createSessionModel({
    fetchImpl: async (url, options) => {
      if (url.endsWith("/staff/session")) return response(identity(role));
      calls.push({ url, options });
      return read(url, options);
    },
  });
  models.push(model);
  await model.check();
  render(
    <MemoryRouter initialEntries={["/screenings"]}>
      <SessionContext.Provider value={model}>
        <TestRoute />
      </SessionContext.Provider>
    </MemoryRouter>,
  );
  return { model, calls };
}
test("list announces loading and exposes counts, freshness and Helsinki times", async () => {
  const pending = deferred();
  await install(() => pending.promise);
  expect(screen.getByRole("status").textContent).toContain("Loading");
  await act(async () => pending.resolve(response(listing())));
  await screen.findByText("Northern Lights");
  expect(screen.getByText(/15 Jan 2030, 18:00/)).toBeTruthy();
  expect(screen.getByText("Seated")).toBeTruthy();
  expect(screen.getByText("99")).toBeTruthy();
  expect(screen.getByText(/Updated/)).toBeTruthy();
  expect(screen.getByText(/does not reserve/)).toBeTruthy();
});
test("combined filters are applied together and city changes clear a conflicting screen", async () => {
  const user = userEvent.setup();
  const api = await install();
  await screen.findByText("Northern Lights");
  await user.selectOptions(screen.getByLabelText("City"), "7");
  await user.selectOptions(screen.getByLabelText("Screen"), "11");
  await user.selectOptions(screen.getByLabelText("City"), "8");
  expect(screen.getByLabelText("Screen").value).toBe("");
  await user.selectOptions(screen.getByLabelText("City"), "7");
  await user.selectOptions(screen.getByLabelText("Screen"), "11");
  await user.clear(screen.getByLabelText("From"));
  await user.type(screen.getByLabelText("From"), "2030-01-14");
  await user.click(screen.getByRole("button", { name: "Apply filters" }));
  expect(api.calls.at(-1).url).toContain(
    "dateFrom=2030-01-14&dateTo=2030-01-15&cityId=7&screenId=11",
  );
});
test("cashier city is fixed and sent from current session", async () => {
  await install(
    () =>
      response({
        ...listing(),
        filters: { ...listing().filters, cityId: 7 },
        cities: [{ id: 7, name: "Oulu" }],
      }),
    "cashier",
  );
  await screen.findByText("Northern Lights");
  expect(screen.getByLabelText("City").disabled).toBe(true);
  expect(screen.queryByRole("option", { name: "All cities" })).toBe(null);
});
test("empty, incomplete inventory and capped results are explicit", async () => {
  const api = await install(() =>
    response({ ...listing([row(1, false)]), truncated: true }),
  );
  await screen.findByText(
    "Inventory is incomplete. Availability cannot be confirmed.",
  );
  expect(screen.getAllByText("Unavailable").length).toBe(2);
  expect(screen.getByText(/first 500/)).toBeTruthy();
  expect(api.calls.length).toBe(1);
});
test("error retry discards old failed response and handles empty results", async () => {
  let count = 0;
  const user = userEvent.setup();
  await install(() =>
    ++count === 1 ? Promise.reject(Error("offline")) : response(listing([])),
  );
  await user.click(await screen.findByRole("button", { name: "Try again" }));
  await screen.findByText("No screenings match these filters.");
  expect(count).toBe(2);
});
test("late results from a replaced request cannot restore stale screenings", async () => {
  const pending = deferred();
  let count = 0;
  const user = userEvent.setup();
  const api = await install(() =>
    ++count === 2
      ? pending.promise
      : response(
          listing([
            { ...row(), film_title: count === 1 ? "Initial" : "Fresh" },
          ]),
        ),
  );
  await screen.findByText("Initial");
  await user.click(screen.getByRole("button", { name: "Refresh" }));
  expect(api.calls[1].options.signal.aborted).toBe(false);
  await user.click(screen.getByRole("button", { name: "Change date" }));
  await screen.findByText("Fresh");
  await act(async () =>
    pending.resolve(response(listing([{ ...row(), film_title: "Stale" }]))),
  );
  expect(api.calls[1].options.signal.aborted).toBe(true);
  expect(screen.getByText("Fresh")).toBeTruthy();
  expect(screen.queryByText("Stale")).toBe(null);
});
test("visible list refreshes after thirty seconds", async () => {
  vi.useFakeTimers();
  let api;
  await act(async () => {
    api = await install();
  });
  expect(api.calls.length).toBe(1);
  await act(async () => vi.advanceTimersByTimeAsync(30000));
  expect(api.calls.length).toBe(2);
});
test("time formatting never depends on browser timezone", () => {
  expect(formatScreeningTime("2030-07-15T15:00:00Z")).toContain("18:00");
});
