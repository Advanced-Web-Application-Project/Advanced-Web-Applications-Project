import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import AdminPricesView from "../src/features/prices/components/AdminPricesView.jsx";
import PricesPage from "../src/pages/PricesPage.jsx";

const mockRequest = vi.fn();
let mockSession = {
  user: { role: "administrator", email: "admin@rio.fi" },
};

vi.mock("../src/features/session/hooks/useSession.js", () => ({
  useSession: () => ({
    session: mockSession,
    user: mockSession?.user ?? null,
    model: {
      request: (...args) => mockRequest(...args),
    },
  }),
}));

const samplePrices = [
  {
    category: "adult",
    amountCents: 1200,
    version: 3,
    updatedAt: "2026-05-01T10:30:00.000Z",
    updatedByEmail: "admin@rio.fi",
  },
  {
    category: "child",
    amountCents: 600,
    version: 3,
    updatedAt: "2026-05-01T10:30:00.000Z",
    updatedByEmail: "admin@rio.fi",
  },
];

describe("Issue #61: AdminPricesView and PricesPage", () => {
  beforeEach(() => {
    mockRequest.mockReset();
    mockSession = {
      user: { role: "administrator", email: "admin@rio.fi" },
    };
  });

  afterEach(() => {
    cleanup();
  });

  it("shows loading state and renders current prices, version and form", async () => {
    mockRequest.mockImplementation(async () => samplePrices);

    render(<AdminPricesView />);
    expect(screen.getByRole("status").textContent).toMatch(/loading/i);

    const input = await screen.findByLabelText(/adult ticket price/i);
    expect(input.value).toBe("12.00");
    expect(screen.getByText(/€12\.00/)).not.toBeNull();
    expect(screen.getAllByText(/€6\.00/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("3")).not.toBeNull();
  });

  it("shows load error with retry and reloads prices cleanly", async () => {
    let shouldFail = true;
    mockRequest.mockImplementation(async () => {
      if (shouldFail) {
        shouldFail = false;
        throw new Error("Network error");
      }
      return samplePrices;
    });

    render(<AdminPricesView />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/could not load price configuration/i);

    fireEvent.click(screen.getByRole("button", { name: /retry/i }));

    const input = await screen.findByLabelText(/adult ticket price/i);
    expect(input.value).toBe("12.00");
  });

  it("updates live child price preview rounded up as adult price changes", async () => {
    mockRequest.mockImplementation(async () => samplePrices);

    render(<AdminPricesView />);
    const input = await screen.findByLabelText(/adult ticket price/i);

    fireEvent.change(input, { target: { value: "10.01" } });
    const previewLabel = await screen.findByText(
      /derived child price before save/i,
    );
    expect(previewLabel.parentElement?.textContent).toMatch(/€5\.01/);
  });

  it("submits updated adult price with expectedVersion and shows confirmation", async () => {
    const updatedPrices = [
      { category: "adult", amountCents: 1400, version: 4 },
      { category: "child", amountCents: 700, version: 4 },
    ];

    mockRequest.mockImplementation(async (_path, options = {}) => {
      if (options?.method === "PUT") {
        return { version: 4, prices: updatedPrices };
      }
      return samplePrices;
    });

    render(<AdminPricesView />);
    const input = await screen.findByLabelText(/adult ticket price/i);

    fireEvent.change(input, { target: { value: "14.00" } });
    const saveButton = await screen.findByRole("button", {
      name: /save price/i,
    });
    fireEvent.click(saveButton);

    await waitFor(() => {
      const putCall = mockRequest.mock.calls.find(
        ([path, opts]) => path === "/prices" && opts?.method === "PUT",
      );
      expect(putCall).toBeDefined();
      expect(putCall[1].body).toEqual({
        category: "adult",
        amountCents: 1400,
        expectedVersion: 3,
      });
    });

    const confirm = await screen.findByText(
      /saved €14\.00 adult \/ €7\.00 child/i,
    );
    expect(confirm).not.toBeNull();
  });

  it("keeps user input on 409 conflict and offers reload latest prices", async () => {
    mockRequest.mockImplementation(async (_path, options = {}) => {
      if (options?.method === "PUT") {
        throw Object.assign(new Error("Conflict"), { status: 409 });
      }
      return samplePrices;
    });

    render(<AdminPricesView />);
    const input = await screen.findByLabelText(/adult ticket price/i);

    fireEvent.change(input, { target: { value: "15.50" } });
    const saveButton = await screen.findByRole("button", {
      name: /save price/i,
    });
    fireEvent.click(saveButton);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(
      /price settings changed while you were editing/i,
    );
    expect(input.value).toBe("15.50");
    expect(
      screen.getByRole("button", { name: /reload latest prices/i }),
    ).not.toBeNull();
  });

  it("denies access on PricesPage for non-administrator role", () => {
    mockSession = {
      user: { role: "cashier", email: "cashier@rio.fi" },
    };

    render(
      <MemoryRouter>
        <PricesPage />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole("heading", { name: /access denied/i }),
    ).not.toBeNull();
    expect(mockRequest).not.toHaveBeenCalled();
  });
});

describe("price editor regressions", () => {
  beforeEach(() => {
    mockRequest.mockReset();
  });
  afterEach(cleanup);
  it("keeps the same input focused through normal typing without refetching", async () => {
    mockRequest.mockResolvedValue(samplePrices);
    const user = userEvent.setup();
    render(<AdminPricesView />);
    const input = await screen.findByLabelText(/adult ticket price/i);
    await user.clear(input);
    await user.type(input, "12.01");
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("12.01");
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });
  it("uses the adult revision even if another category is first", async () => {
    mockRequest.mockImplementation(async (_path, options = {}) =>
      options.method === "PUT"
        ? { updated: [{ category: "adult", amount_cents: 1300, version: 8 }] }
        : [
            { category: "company", amount_cents: 1, version: 2 },
            { category: "adult", amount_cents: 1200, version: 7 },
          ],
    );
    const user = userEvent.setup();
    render(<AdminPricesView />);
    const input = await screen.findByLabelText(/adult ticket price/i);
    await user.clear(input);
    await user.type(input, "13");
    await user.click(screen.getByRole("button", { name: "Save price" }));
    await screen.findByText(/saved €13.00/i);
    expect(
      mockRequest.mock.calls.find(([, o]) => o.method === "PUT")[1].body
        .expectedVersion,
    ).toBe(7);
  });
  it("requires a read after an unknown save outcome, preserves draft and never replays writes", async () => {
    let reads = 0;
    mockRequest.mockImplementation(async (_path, options = {}) => {
      if (options.method === "PUT")
        throw Object.assign(new Error("timeout"), { status: 0 });
      reads++;
      return [
        {
          category: "adult",
          amount_cents: reads > 1 ? 1401 : 1200,
          version: reads > 1 ? 4 : 3,
        },
      ];
    });
    const user = userEvent.setup();
    render(<AdminPricesView />);
    const input = await screen.findByLabelText(/adult ticket price/i);
    await user.clear(input);
    await user.type(input, "14.01");
    await user.click(screen.getByRole("button", { name: "Save price" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "Save price" }).disabled).toBe(
      true,
    );
    await user.type(input, "0");
    expect(screen.getByRole("button", { name: "Save price" }).disabled).toBe(
      true,
    );
    await user.click(
      screen.getByRole("button", { name: "Reload latest prices" }),
    );
    await screen.findByText(/Latest prices loaded/i);
    expect(screen.getByLabelText(/adult ticket price/i)).toBe(input);
    expect(input.value).toBe("14.010");
    expect(
      mockRequest.mock.calls.filter(([, o]) => o.method === "PUT"),
    ).toHaveLength(1);
  });
});
