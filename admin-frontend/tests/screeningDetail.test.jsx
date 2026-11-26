import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { render, screen, cleanup, act, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route, Link } from "react-router";
import { createSessionModel } from "../src/features/session/services/sessionModel.js";
import { SessionContext } from "../src/features/session/SessionContext.js";
import StaffScreeningDetail from "../src/features/screenings/components/StaffScreeningDetail.jsx";
import OccupancyMap from "../src/features/screenings/components/OccupancyMap.jsx";
import {
  validateScreeningDetail,
  occupancyRows,
} from "../src/features/screenings/services/occupancyLayout.js";
import { identity, response, deferred } from "./fixtures/sessionData.js";
import { occupancyData } from "./fixtures/occupancyData.js";
const models = [];
beforeEach(() =>
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  }),
);
afterEach(() => {
  cleanup();
  models.splice(0).forEach((m) => m.stop());
  vi.useRealTimers();
});
async function install(
  read = async () => response(occupancyData()),
  path = "/screenings/1?dateFrom=2030-01-15&cityId=7",
) {
  const calls = [];
  const model = createSessionModel({
    fetchImpl: async (url, options) => {
      if (url.endsWith("/staff/session")) return response(identity());
      calls.push({ url, options });
      return read(url, options);
    },
  });
  models.push(model);
  await model.check();
  render(
    <MemoryRouter initialEntries={[path]}>
      <SessionContext.Provider value={model}>
        <Link to="/screenings/2?dateFrom=2030-01-16">Next screening</Link>
        <Routes>
          <Route
            path="/screenings/:screeningId"
            element={<StaffScreeningDetail />}
          />
          <Route path="/screenings" element={<p>Returned list</p>} />
        </Routes>
      </SessionContext.Provider>
    </MemoryRouter>,
  );
  return { calls, model };
}
test.each([100, 200])(
  "readonly map retains %s seated places and W1–W10 with six labeled states",
  (capacity) => {
    const data = occupancyData(1, capacity);
    expect(validateScreeningDetail(data, 1)).toBe(data);
    render(<OccupancyMap places={data.places} />);
    expect(screen.getAllByRole("gridcell").length).toBe(capacity + 10);
    for (const state of [
      "available",
      "active hold",
      "unpaid reservation",
      "paid",
      "company secured",
      "ceo reserved",
    ])
      expect(
        screen.getAllByRole("gridcell", { name: new RegExp(state) }).length,
      ).toBeGreaterThan(0);
    expect(
      screen.getByRole("gridcell", { name: "Wheelchair space W10, available" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button")).toBe(null);
    const rows = occupancyRows(data.places);
    expect(rows.at(-1).label).toBe(1);
    expect(rows[0].places[0].physical_column).toBe(1);
  },
);
test("arrow/Home/End navigation follows physical positions with one tab stop per zone", async () => {
  const user = userEvent.setup();
  render(<OccupancyMap places={occupancyData().places} />);
  const grid = screen.getByRole("grid", { name: "Seated occupancy" });
  const cells = within(grid).getAllByRole("gridcell");
  expect(cells.filter((cell) => cell.tabIndex === 0).length).toBe(1);
  cells[0].focus();
  await user.keyboard("{ArrowRight}");
  expect(document.activeElement).toBe(cells[1]);
  await user.keyboard("{End}");
  expect(document.activeElement).toBe(cells[9]);
  await user.keyboard("{Home}");
  expect(document.activeElement).toBe(cells[0]);
  await user.keyboard("{ArrowDown}");
  expect(document.activeElement).toBe(cells[10]);
});
test("detail loads server identity/counts and back link preserves list filters", async () => {
  const pending = deferred(),
    user = userEvent.setup();
  await install(() => pending.promise);
  expect(screen.getByRole("status").textContent).toContain("Loading");
  await act(async () => pending.resolve(response(occupancyData())));
  await screen.findByRole("heading", { name: "Film 1" });
  expect(screen.getByText(/95 \/ 100 available/)).toBeTruthy();
  expect(
    screen
      .getByRole("link", { name: "Back to screenings" })
      .getAttribute("href"),
  ).toBe("/screenings?dateFrom=2030-01-15&cityId=7");
  await user.click(screen.getByRole("link", { name: "Back to screenings" }));
  await screen.findByText("Returned list");
});
test("not-found and foreign detail show no map and support explicit retry", async () => {
  let calls = 0;
  const user = userEvent.setup();
  await install(() =>
    ++calls === 1 ? response(null, 404) : response(occupancyData()),
  );
  await screen.findByText(
    "Screening was not found or is not available to your account.",
  );
  expect(screen.queryByRole("grid")).toBe(null);
  await user.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByRole("heading", { name: "Film 1" });
});
test("route change aborts old response and cannot restore a previous film", async () => {
  const pending = deferred(),
    user = userEvent.setup();
  const api = await install((url) =>
    url.endsWith("/1") ? pending.promise : response(occupancyData(2)),
  );
  await user.click(screen.getByRole("link", { name: "Next screening" }));
  await screen.findByRole("heading", { name: "Film 2" });
  expect(api.calls[0].options.signal.aborted).toBe(true);
  await act(async () => pending.resolve(response(occupancyData(1))));
  expect(screen.queryByRole("heading", { name: "Film 1" })).toBe(null);
});
test("incomplete inventory withholds the map and reports unknown counts", async () => {
  const data = occupancyData();
  data.places.pop();
  data.availability.inventory_complete = false;
  data.availability.seated.available = null;
  data.availability.wheelchair.available = null;
  await install(() => response(data));
  await screen.findByText(
    "Inventory is incomplete. The occupancy map and availability cannot be confirmed.",
  );
  expect(screen.queryByRole("grid")).toBe(null);
});
test("wrong identities, state names, duplicate positions and mismatched counts are rejected", () => {
  expect(() => validateScreeningDetail(occupancyData(), 2)).toThrow();
  for (const change of [
    (d) => (d.places[0].occupancy_state = "unexpected"),
    (d) => (d.places[1].physical_column = 1),
    (d) => (d.availability.seated.available = 100),
  ]) {
    const d = occupancyData();
    change(d);
    expect(() => validateScreeningDetail(d, 1)).toThrow();
  }
});
test("refresh reads changed server states and never sends a write", async () => {
  const user = userEvent.setup();
  let count = 0;
  const api = await install(() => {
    const data = occupancyData();
    if (++count > 1) {
      data.places.find((p) => p.occupancy_state === "hold").occupancy_state =
        "available";
      data.availability.seated.available++;
    }
    return response(data);
  });
  await screen.findByRole("gridcell", { name: "Row 1, seat 2, active hold" });
  await user.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByRole("gridcell", { name: "Row 1, seat 2, available" });
  expect(api.calls.every((call) => call.options.method === "GET")).toBe(true);
});
test("periodic refresh pauses while a map cell is being inspected", async () => {
  vi.useFakeTimers();
  let api;
  await act(async () => {
    api = await install();
  });
  screen.getAllByRole("gridcell")[0].focus();
  await act(async () => vi.advanceTimersByTimeAsync(30000));
  expect(api.calls.length).toBe(1);
});
