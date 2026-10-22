// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SubscribePage from "@/app/subscribe/page";
import type { ApiPlan } from "@/lib/api";

/**
 * The confirmation that stands between clicking Subscribe and the wallet popup
 * (issue #139). Before this, the first thing a subscriber saw was a signature
 * request that never said what a mandate is, how much it authorises, how often,
 * what the protocol takes, or how to stop it.
 *
 * These tests drive the real page with the wallet and the contract mocked, and
 * check the three things a unit test can hold: no signature before the
 * confirmation is accepted, the figures on the dialog are the contract's (not
 * a rounded display number), and the dialog still works in contract-only mode.
 * The focus trap and Escape handling belong to `Dialog` and are covered in
 * `test/dialog.test.tsx`; here they are checked as they reach the page.
 */

const mocks = vi.hoisted(() => ({
  plans: vi.fn(),
  chainPlans: vi.fn(),
  feeBps: vi.fn(),
  subscribe: vi.fn(),
  wallet: {
    address: "GSUBSCRIBER1234567890" as string | null,
    networkMismatch: false,
    signXdr: vi.fn(),
  },
}));

vi.mock("@/lib/api", () => ({ api: { plans: mocks.plans } }));
vi.mock("@/lib/chain", () => ({ chainPlans: mocks.chainPlans }));
vi.mock("@/lib/payflow", () => ({
  payflow: { subscribe: mocks.subscribe, feeBps: mocks.feeBps },
}));
vi.mock("@/lib/wallet", () => ({ useWallet: () => mocks.wallet }));
vi.mock("@/lib/token", () => ({
  useTokenMetas: () => new Map(),
  metaFor: () => ({ symbol: "XLM", decimals: 7 }),
}));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));

const TOKEN = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

function plan(extra: Partial<ApiPlan> = {}): ApiPlan {
  return {
    id: 1,
    merchant: "GMERCHANT1234567890",
    name: "Monthly Software",
    token: TOKEN,
    amount: "50000000", // 5 XLM at 7 decimals
    period: 2_592_000,
    active: 1,
    ledger: 100,
    ...extra,
  };
}

/** Render the page and wait for the plan cards, so a click has something to hit. */
async function openPage(plans: ApiPlan[] | null = [plan()]) {
  mocks.plans.mockResolvedValue(plans === null ? null : { plans });
  if (plans === null) mocks.chainPlans.mockResolvedValue([plan()]);
  const view = render(<SubscribePage />);
  const button = await screen.findByRole("button", { name: "Subscribe" });
  return { view, button };
}

/** Click Subscribe the way a keyboard user does: focus first, then activate. */
function openDialog(button: HTMLElement) {
  button.focus();
  fireEvent.click(button);
  return screen.getByRole("dialog");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.wallet.address = "GSUBSCRIBER1234567890";
  mocks.wallet.networkMismatch = false;
  mocks.feeBps.mockResolvedValue(100); // 1%
  mocks.subscribe.mockResolvedValue("a".repeat(64));
});

afterEach(cleanup);

describe("subscribe confirmation: gating the signature", () => {
  it("asks for confirmation instead of going straight to the wallet", async () => {
    const { button } = await openPage();
    openDialog(button);
    expect(mocks.subscribe).not.toHaveBeenCalled();
  });

  it("shows the amount, period, fee, cap, first charge and how to cancel", async () => {
    const { button } = await openPage();
    const dialog = openDialog(button);
    const inside = within(dialog);

    expect(inside.getByText("5 XLM")).toBeTruthy();
    expect(inside.getByText("per month")).toBeTruthy();
    expect(inside.getByText("Due now")).toBeTruthy();
    expect(inside.getByText("No limit — charges continue until you cancel.")).toBeTruthy();
    expect(inside.getByText(/Cancel any time from your account page/)).toBeTruthy();
    expect(inside.getByText(/A mandate is a standing permission/)).toBeTruthy();
    // The fee is read from the contract as basis points; 1% of 5 XLM is 0.05 XLM.
    // It resolves after the dialog opens, so the row starts on "Checking…".
    await waitFor(() => expect(inside.getByText("0.05 XLM (1%)")).toBeTruthy());
  });

  it("says when a trial pushes the first charge back", async () => {
    const { button } = await openPage([plan({ trial: 14 * 86_400 })]);
    const inside = within(openDialog(button));
    expect(inside.queryByText("Due now")).toBeNull();
    expect(inside.getByText(/in 14 days/)).toBeTruthy();
  });

  it("counts the charges the entered cap authorises", async () => {
    const { button } = await openPage();
    fireEvent.change(screen.getByLabelText("Charge limit (0 = open-ended)"), {
      target: { value: "3" },
    });
    const inside = within(openDialog(button));
    expect(inside.getByText("3 charges, then the mandate completes.")).toBeTruthy();
  });

  it("signs only after the confirmation is accepted, with the cap it showed", async () => {
    const { button } = await openPage();
    fireEvent.change(screen.getByLabelText("Charge limit (0 = open-ended)"), {
      target: { value: "3" },
    });
    const inside = within(openDialog(button));
    fireEvent.click(inside.getByRole("button", { name: "Confirm and sign" }));

    await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(1));
    expect(mocks.subscribe).toHaveBeenCalledWith(
      "GSUBSCRIBER1234567890",
      expect.any(Function),
      1,
      3,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes on Escape and returns focus to the Subscribe button, without signing", async () => {
    const { button } = await openPage();
    openDialog(button);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(mocks.subscribe).not.toHaveBeenCalled();
  });

  it("keeps Tab inside the dialog, away from the plan cards behind it", async () => {
    const { button } = await openPage();
    const dialog = openDialog(button);
    for (let i = 0; i < 8; i += 1) {
      fireEvent.keyDown(document.activeElement ?? document, { key: "Tab" });
      expect(dialog.contains(document.activeElement)).toBe(true);
      expect(document.activeElement).not.toBe(button);
    }
  });

  it("closes on Go back, without signing", async () => {
    const { button } = await openPage();
    const inside = within(openDialog(button));
    fireEvent.click(inside.getByRole("button", { name: "Go back" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mocks.subscribe).not.toHaveBeenCalled();
  });

  it("refuses a fractional cap before any dialog or wallet", async () => {
    const { button } = await openPage();
    fireEvent.change(screen.getByLabelText("Charge limit (0 = open-ended)"), {
      target: { value: "2.5" },
    });
    fireEvent.click(button);

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      screen.getByText("Charge limit must be a whole number, or 0 for open-ended."),
    ).toBeTruthy();
    expect(mocks.subscribe).not.toHaveBeenCalled();
  });
});

describe("subscribe confirmation: degraded sources", () => {
  it("works without a backend, reading plans from the contract", async () => {
    const { button } = await openPage(null);
    expect(screen.getByText(/Reading plans directly from the contract/)).toBeTruthy();
    const inside = within(openDialog(button));
    expect(inside.getByText("5 XLM")).toBeTruthy();
    await waitFor(() => expect(inside.getByText("0.05 XLM (1%)")).toBeTruthy());
  });

  it("says the fee is unavailable when the contract read fails, and still confirms", async () => {
    mocks.feeBps.mockRejectedValue(new Error("rpc unavailable"));
    const { button } = await openPage();
    const inside = within(openDialog(button));

    await waitFor(() => expect(inside.getByText("Unavailable")).toBeTruthy());
    expect(inside.getByText(/could not be read from the contract/)).toBeTruthy();
    expect(
      (inside.getByRole("button", { name: "Confirm and sign" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("closes itself when the wallet disconnects while the dialog is open", async () => {
    const { view, button } = await openPage();
    openDialog(button);

    // The wallet drops mid-confirmation: the summary no longer describes an
    // account that could sign it.
    mocks.wallet.address = null;
    view.rerender(<SubscribePage />);

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mocks.subscribe).not.toHaveBeenCalled();
  });
});
