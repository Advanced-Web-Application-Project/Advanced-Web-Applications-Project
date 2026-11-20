import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import MovieDetails from "../src/features/movies/components/MovieDetails.jsx";
import { response, deferred } from "./fixtures/seatData.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("retained details load through RIO only, rendering markup as text and no remote media", async () => {
  const pending = deferred();
  const fetch = vi.fn(() => pending.promise);
  vi.stubGlobal("fetch", fetch);
  render(<MovieDetails filmId={31} />);
  expect(screen.getByRole("status").textContent).toContain(
    "Loading movie details",
  );
  await act(async () =>
    pending.resolve(
      response({
        id: 31,
        title: "Northern Lights",
        description: '<script>alert("fixture")</script>\nA local synopsis.',
        artwork_url: "https://external.invalid/poster.jpg",
      }),
    ),
  );
  expect(screen.getByRole("heading", { name: "Northern Lights" })).toBeTruthy();
  expect(screen.getByText(/<script>/).textContent).toContain(
    "A local synopsis",
  );
  expect(document.querySelector("script, img, iframe")).toBe(null);
  expect(fetch.mock.calls.length).toBe(1);
  expect(fetch.mock.calls[0][0]).toBe("/api/films/31");
});

test.each([null, "", "   "])(
  "missing description %s has an explicit fallback",
  async (description) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response({ id: 31, title: "Northern Lights", description }),
      ),
    );
    render(<MovieDetails filmId={31} />);
    await screen.findByText("No description is available for this movie yet.");
  },
);

test.each(["network", "missing", "wrong identity", "malformed"])(
  "%s fails safely and can retry",
  async (kind) => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        if (++calls > 1)
          return response({
            id: 31,
            title: "Northern Lights",
            description: "Recovered synopsis",
          });
        if (kind === "network") throw Error("private internal detail");
        if (kind === "missing") return response(null, 404, "Film not found");
        return response({
          id: kind === "wrong identity" ? 32 : 31,
          title: "Northern Lights",
          description: kind === "malformed" ? {} : "Wrong movie",
        });
      }),
    );
    const user = userEvent.setup();
    render(<MovieDetails filmId={31} />);
    expect((await screen.findByRole("alert")).textContent).toContain(
      "You can still choose a showtime",
    );
    expect(document.body.textContent).not.toContain("private internal detail");
    await user.click(
      screen.getByRole("button", { name: "Retry movie details" }),
    );
    await screen.findByText("Recovered synopsis");
  },
);

test("late replies cannot replace the currently selected movie", async () => {
  const old = deferred();
  let oldSignal;
  vi.stubGlobal(
    "fetch",
    vi.fn((path, options) => {
      if (path === "/api/films/31") {
        oldSignal = options.signal;
        return old.promise;
      }
      return Promise.resolve(
        response({
          id: 32,
          title: "Lake Stories",
          description: "Current synopsis",
        }),
      );
    }),
  );
  const view = render(<MovieDetails filmId={31} />);
  view.rerender(<MovieDetails filmId={32} />);
  await screen.findByText("Current synopsis");
  expect(oldSignal.aborted).toBe(true);
  await act(async () =>
    old.resolve(
      response({ id: 31, title: "Old title", description: "Stale synopsis" }),
    ),
  );
  expect(screen.queryByText("Stale synopsis")).toBe(null);
  expect(screen.getByText("Current synopsis")).toBeTruthy();
});
