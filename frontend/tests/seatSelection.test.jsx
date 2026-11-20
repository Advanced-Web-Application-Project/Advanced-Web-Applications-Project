import { StrictMode } from "react";
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
import SeatSelection from "../src/features/seats/components/SeatSelection.jsx";
import HomePage from "../src/pages/HomePage.jsx";
import {
  seatData,
  response,
  selectionResponse,
  deferred,
} from "./fixtures/seatData.js";

const screenInfo = { id: 11, capacity: 100 },
  show = { id: 111, screen_id: 11 };
function installApi({
  seats = () => response(seatData()),
  validate = (request) => response(selectionResponse(request)),
} = {}) {
  const fetch = vi.fn(async (path, options = {}) => {
    const url = new URL(path, "http://localhost");
    if (url.pathname === "/api/seats")
      return seats(
        Number(url.searchParams.get("screenId")),
        Number(url.searchParams.get("screeningId")),
        options,
      );
    if (url.pathname === "/api/seats/validate")
      return validate(JSON.parse(options.body), options);
    throw Error("Unexpected request");
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
const seat = (label, row = 1) =>
  screen.getByRole("button", {
    name: new RegExp(`^Row ${row}, seat ${label},`),
  });
const check = () => screen.getByRole("button", { name: "Check selection" });
const selectedText = () =>
  screen.getByRole("heading", { name: /Your places/ }).parentElement
    .textContent;
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

for (const capacity of [100, 200])
  test(`${capacity} map preserves server layout, protects seat1 and supports keyboard and wheelchair selection`, async () => {
    const user = userEvent.setup(),
      rows = seatData(capacity);
    installApi({ seats: () => response(rows.reverse()) });
    render(
      <SeatSelection screen={{ ...screenInfo, capacity }} screening={show} />,
    );
    await screen.findByRole("button", { name: /Row 1, seat 2,/ });
    expect(
      screen.getAllByRole("button", {
        name: /^(Row \d+, seat|Wheelchair space)/,
      }).length,
    ).toBe(capacity + 10);
    const protectedSeat = seat(1);
    expect(protectedSeat.getAttribute("aria-disabled")).toBe("true");
    await user.click(protectedSeat);
    expect(selectedText()).toContain("(0)");
    expect(seat(1).getAttribute("aria-label")).toContain("ceo reserved");
    const secondRow = screen.getByRole("group", { name: "Row 2", exact: true });
    expect(
      within(secondRow)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["21", "20", "19", "18", "17", "16", "15", "14", "12", "11"]);
    const rowGroups = document.querySelectorAll(
      '.seated-zone > [role="group"]',
    );
    expect(rowGroups[0].getAttribute("aria-label")).toBe(
      `Row ${capacity === 100 ? 10 : 21}`,
    );
    expect(rowGroups[rowGroups.length - 1].getAttribute("aria-label")).toBe(
      "Row 1",
    );
    expect(
      document.querySelector(".seated-zone").nextElementSibling.className,
    ).toBe("wheelchair-zone");
    expect(
      document.querySelector(".wheelchair-zone").nextElementSibling.textContent,
    ).toBe("Screen");
    seat(21, 2).focus();
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(seat(20, 2));
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(seat(11, 2));
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(seat(10, 1));
    await user.keyboard(" ");
    expect(seat(10).getAttribute("aria-pressed")).toBe("true");
    await user.click(
      screen.getByRole("button", { name: "Wheelchair space W3, available" }),
    );
    expect(selectedText()).toContain("Wheelchair W3");
  });

test("whole selection is checked only on request; valid callbacks and feedback expire on edits", async () => {
  const user = userEvent.setup(),
    validated = vi.fn(),
    requests = [];
  installApi({
    validate: (request) => {
      requests.push(request);
      return response(selectionResponse(request));
    },
  });
  render(
    <SeatSelection
      screen={screenInfo}
      screening={show}
      onValidatedSelection={validated}
    />,
  );
  await screen.findByRole("button", { name: /Row 1, seat 3,/ });
  expect(check().disabled).toBe(true);
  await user.click(seat(3));
  await user.click(seat(2));
  expect(requests.length).toBe(0);
  expect(check().disabled).toBe(false);
  await user.click(check());
  await screen.findByText("Selection checked. These places are not reserved.", {
    selector: ".selection-valid",
  });
  expect(requests[0]).toEqual({
    screenId: 11,
    screeningId: 111,
    seatIds: [11003, 11002],
  });
  expect(validated.mock.calls.filter(([value]) => value).length).toBe(1);
  await user.click(seat(3));
  expect(
    screen.queryByText("Selection checked. These places are not reserved.", {
      selector: ".selection-valid",
    }),
  ).toBe(null);
  expect(validated.mock.calls.at(-1)[0]).toBe(null);
  expect(selectedText()).toContain("(1)");
});

test("backend gap errors explain unselected gap places; transport failures support retry", async () => {
  const user = userEvent.setup();
  let attempt = 0;
  installApi({
    validate: (request) => {
      attempt++;
      if (attempt === 1)
        return response(
          selectionResponse(request, false, [
            {
              code: "ISOLATED_SEAT_GAP",
              message: "This selection leaves seat 2 alone in row 1.",
              seat_ids: [11002],
            },
          ]),
        );
      if (attempt === 2) throw Error("offline");
      return response(selectionResponse(request));
    },
  });
  render(<SeatSelection screen={screenInfo} screening={show} />);
  await screen.findByRole("button", { name: /Row 1, seat 3,/ });
  await user.click(seat(3));
  await user.click(check());
  expect((await screen.findByRole("alert")).textContent).toContain(
    "seat 2 alone",
  );
  await user.click(seat(2));
  await user.click(check());
  expect((await screen.findByRole("alert")).textContent).toContain(
    "could not be checked",
  );
  await user.click(check());
  await screen.findByText("Selection checked. These places are not reserved.", {
    selector: ".selection-valid",
  });
});

test("refresh announces and removes a newly unavailable selected place and invalidates success", async () => {
  const user = userEvent.setup();
  let reads = 0;
  installApi({ seats: () => response(seatData(100, 11, reads++ ? [2] : [])) });
  render(<SeatSelection screen={screenInfo} screening={show} />);
  await screen.findByRole("button", { name: /Row 1, seat 2,/ });
  await user.click(seat(2));
  await user.click(check());
  await screen.findByText("Selection checked. These places are not reserved.", {
    selector: ".selection-valid",
  });
  await user.click(screen.getByRole("button", { name: "Refresh seats" }));
  await waitFor(() =>
    expect(seat(2).getAttribute("aria-disabled")).toBe("true"),
  );
  expect(screen.getByRole("status").textContent).toContain(
    "now unavailable and removed",
  );
  expect(selectedText()).toContain("(0)");
  expect(check().disabled).toBe(true);
  expect(
    screen.queryByText("Selection checked. These places are not reserved.", {
      selector: ".selection-valid",
    }),
  ).toBe(null);
});

test("stale validation cannot approve edited choices or a different screening, even if fetch ignores abort", async () => {
  const user = userEvent.setup(),
    old = deferred(),
    later = deferred(),
    validated = vi.fn();
  const requests = [];
  installApi({
    validate: (body) => {
      requests.push(body);
      return requests.length === 1 ? old.promise : later.promise;
    },
  });
  const view = render(
    <SeatSelection
      screen={screenInfo}
      screening={show}
      onValidatedSelection={validated}
    />,
  );
  await screen.findByRole("button", { name: /Row 1, seat 2,/ });
  await user.click(seat(2));
  await user.click(check());
  await user.click(seat(3));
  await act(async () => old.resolve(response(selectionResponse(requests[0]))));
  expect(validated.mock.calls.filter(([value]) => value).length).toBe(0);
  expect(
    screen.queryByText("Selection checked. These places are not reserved.", {
      selector: ".selection-valid",
    }),
  ).toBe(null);
  await user.click(check());
  expect(
    screen.getByRole("button", { name: "Checking selection…" }).disabled,
  ).toBe(true);
  view.rerender(
    <SeatSelection
      screen={screenInfo}
      screening={{ ...show, id: 112 }}
      onValidatedSelection={validated}
    />,
  );
  await screen.findByRole("button", { name: /Row 1, seat 2,/ });
  await act(async () =>
    later.resolve(response(selectionResponse(requests[1]))),
  );
  expect(validated.mock.calls.filter(([value]) => value).length).toBe(0);
  expect(selectedText()).toContain("(0)");
  expect(check().disabled).toBe(true);
});

test("old inventory cannot replace a new screening; pending, empty and failed reads have distinct states", async () => {
  const old = deferred();
  installApi({
    seats: (_, showId) =>
      showId === 111 ? old.promise : response(seatData(200, 12)),
  });
  const view = render(<SeatSelection screen={screenInfo} screening={show} />);
  expect(screen.getByRole("status").textContent).toContain("Loading");
  view.rerender(
    <SeatSelection
      screen={{ id: 12, capacity: 200 }}
      screening={{ id: 121, screen_id: 12 }}
    />,
  );
  await screen.findByRole("button", { name: /Row 21, seat 201,/ });
  await act(async () => old.resolve(response(seatData())));
  expect(
    screen.getAllByRole("button", { name: /^(Row \d+, seat|Wheelchair space)/ })
      .length,
  ).toBe(210);
  view.unmount();
  installApi({ seats: () => response([]) });
  const empty = render(<SeatSelection screen={screenInfo} screening={show} />);
  await screen.findByText(/No places are listed/);
  expect(check().disabled).toBe(true);
  empty.unmount();
  let tries = 0;
  installApi({
    seats: () => {
      if (tries++ === 0) throw Error("offline");
      return response(seatData());
    },
  });
  render(<SeatSelection screen={screenInfo} screening={show} />);
  expect((await screen.findByRole("alert")).textContent).toContain(
    "could not be loaded",
  );
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Refresh seats" }));
  await screen.findByRole("button", { name: /Row 1, seat 2,/ });
});

test("focus refresh checks current availability; polling updates without creating a hold", async () => {
  const user = userEvent.setup(),
    fetch = installApi();
  render(
    <StrictMode>
      <SeatSelection screen={screenInfo} screening={show} />
    </StrictMode>,
  );
  await screen.findByRole("button", { name: /Row 1, seat 2,/ });
  const before = fetch.mock.calls.length;
  await act(async () => window.dispatchEvent(new Event("focus")));
  await waitFor(() => expect(fetch.mock.calls.length).toBeGreaterThan(before));
  vi.useFakeTimers();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30000);
  });
  expect(
    fetch.mock.calls.every(([path]) => !String(path).includes("/bookings")),
  ).toBe(true);
  vi.useRealTimers();
  await user.click(seat(2));
  expect(selectedText()).toContain("(1)");
});

test("browsing composes the real seat feature and changing showtime clears choices", async () => {
  const user = userEvent.setup(),
    next = new Date(Date.now() + 86400000).toISOString();
  const fetch = vi.fn(async (path, options = {}) => {
    const url = new URL(path, "http://localhost");
    if (url.pathname === "/api/cities")
      return response([{ id: 1, name: "Oulu" }]);
    if (url.pathname === "/api/screens")
      return response([
        { id: 11, city_id: 1, capacity: 100, wheelchair_capacity: 10 },
      ]);
    if (url.pathname === "/api/screenings")
      return response(
        [111, 112].map((id) => ({
          id,
          city_id: 1,
          screen_id: 11,
          film_id: 31,
          film_title: "Northern Lights",
          screening_time: next,
        })),
      );
    if (url.pathname === "/api/seats") return response(seatData());
    if (url.pathname === "/api/seats/validate")
      return response(selectionResponse(JSON.parse(options.body)));
    throw Error("Unexpected request");
  });
  vi.stubGlobal("fetch", fetch);
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
  await screen.findByRole("button", { name: /Row 1, seat 2,/ });
  await user.click(seat(2));
  expect(selectedText()).toContain("(1)");
  await user.selectOptions(screen.getByLabelText("4. Showtime"), "112");
  await screen.findByRole("button", { name: /Row 1, seat 2,/ });
  expect(selectedText()).toContain("(0)");
});
