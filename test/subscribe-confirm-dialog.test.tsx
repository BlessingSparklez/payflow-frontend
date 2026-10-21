// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SubscribePage from "@/app/subscribe/page";
import type { ApiPlan } from "@/lib/api";

const apiMock = vi.hoisted(() => ({ plans: vi.fn() }));
const chainMock = vi.hoisted(() => ({ chainPlans: vi.fn() }));
const mocks = vi.hoisted(() => ({
  subscribe: vi.fn(),
  feeBps: vi.fn(),
  wallet: {
    address: "GSUBSCRIBER12345678901234567890123456789012345678901234567" as string | null,
    networkMismatch: false,
    signXdr: vi.fn(),
  },
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/chain", () => ({ chainPlans: chainMock.chainPlans }));
vi.mock("@/lib/wallet", () => ({ useWallet: () => mocks.wallet }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/token", () => ({
  useTokenMetas: () => new Map(),
  metaFor: () => ({ symbol: "XLM", decimals: 7 }),
}));
vi.mock("@/lib/toml", () => ({ useOrgName: () => null }));
// Partial: the page drives only `subscribe` and `feeBps`, everything else
// (readContract, getPlan, …) stays real so the module's exports keep working.
vi.mock("@/lib/payflow", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/payflow")>();
  return {
    ...actual,
    payflow: { ...actual.payflow, subscribe: mocks.subscribe, feeBps: mocks.feeBps },
  };
});

function makePlan(overrides: Partial<ApiPlan> = {}): ApiPlan {
  return {
    id: 7,
    merchant: "GMERCHANT123456789",
    name: "Monthly Software",
    token: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    amount: "50000000",
    period: 2_592_000,
    active: 1,
    ledger: 100,
    ...overrides,
  };
}

const DIALOG_NAME = "Confirm your subscription";

async function openDialog() {
  await screen.findByText("Monthly Software");
  fireEvent.click(screen.getByRole("button", { name: "Subscribe" }));
  return screen.findByRole("dialog", { name: DIALOG_NAME });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.wallet.address =
    "GSUBSCRIBER12345678901234567890123456789012345678901234567";
  mocks.wallet.networkMismatch = false;
  mocks.feeBps.mockResolvedValue(100);
  chainMock.chainPlans.mockResolvedValue([]);
  // The real path hands the prepared XDR to the wallet; mirror it so the
  // page's signer callback (wallet-changed guards included) actually runs.
  mocks.subscribe.mockImplementation(
    async (_address: string, signer: (xdr: string) => Promise<string>) => {
      await signer("prepared-xdr");
      return "ABC123HASH";
    },
  );
  mocks.wallet.signXdr.mockResolvedValue("signed-xdr");
});

afterEach(() => {
  cleanup();
});

describe("Subscribe confirmation dialog", () => {
  it("shows every term up front and never touches the wallet until Confirm", async () => {
    apiMock.plans.mockResolvedValue({ plans: [makePlan()] });

    render(<SubscribePage />);
    const dialog = await openDialog();

    // Focus moves into the dialog, which is labelled by its title…
    expect(document.activeElement).toBe(dialog);
    // …and described by the mandate explanation.
    const describedBy = dialog.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toMatch(/mandate/i);

    // Amount, period, fee, cap, first charge, how to cancel — all six.
    expect(within(dialog).getByText("Amount per charge")).toBeTruthy();
    expect(within(dialog).getByText("5 XLM")).toBeTruthy();
    expect(within(dialog).getByText("per month")).toBeTruthy();
    expect(within(dialog).getByText("0.05 XLM (1%)")).toBeTruthy();
    expect(within(dialog).getByText("Open-ended (no fixed number of charges)")).toBeTruthy();
    expect(within(dialog).getByText(/Due now — the first charge/)).toBeTruthy();
    expect(within(dialog).getByText(/How to cancel: open your/)).toBeTruthy();
    expect(within(dialog).getByText("account page").closest("a")?.getAttribute("href")).toBe(
      "/account",
    );

    // The fee rate came from the contract, once, and nothing was signed.
    expect(mocks.feeBps).toHaveBeenCalledTimes(1);
    expect(mocks.subscribe).not.toHaveBeenCalled();
    expect(mocks.wallet.signXdr).not.toHaveBeenCalled();
  });

  it("dismisses with Escape and with Cancel, without requesting a signature", async () => {
    apiMock.plans.mockResolvedValue({ plans: [makePlan()] });

    render(<SubscribePage />);
    await openDialog();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Subscribe" }));
    const dialog = await screen.findByRole("dialog", { name: DIALOG_NAME });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    expect(mocks.subscribe).not.toHaveBeenCalled();
    expect(mocks.wallet.signXdr).not.toHaveBeenCalled();
  });

  it("requests the signature only after Confirm and reports the transaction", async () => {
    apiMock.plans.mockResolvedValue({ plans: [makePlan()] });

    render(<SubscribePage />);
    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm and sign" }));

    await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(1));
    const [address, , planId, limit] = mocks.subscribe.mock.calls[0] ?? [];
    expect(address).toBe(mocks.wallet.address);
    expect(planId).toBe(7);
    expect(limit).toBe(0);

    // The page's signer callback ran, and the dialog is gone: the wallet
    // popup owns the screen, errors land in the page's notice.
    await waitFor(() => expect(mocks.wallet.signXdr).toHaveBeenCalledWith("prepared-xdr"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(await screen.findByText(/Subscribed\. Transaction/)).toBeTruthy();
  });

  it("works contract-only: plans and fee come straight from the chain", async () => {
    // NEXT_PUBLIC_API_URL empty: api.plans() resolves null, the list falls
    // back to contract state, and the dialog must fill in anyway.
    apiMock.plans.mockResolvedValue(null);
    chainMock.chainPlans.mockResolvedValue([
      makePlan({ name: "Chain Only Plan", amount: "25000000" }),
    ]);

    render(<SubscribePage />);
    expect(await screen.findByText(/Reading plans directly from the contract/)).toBeTruthy();
    await screen.findByText("Chain Only Plan");
    fireEvent.click(screen.getByRole("button", { name: "Subscribe" }));

    const dialog = await screen.findByRole("dialog", { name: DIALOG_NAME });
    expect(within(dialog).getByText("2.5 XLM")).toBeTruthy();
    expect(within(dialog).getByText("0.025 XLM (1%)")).toBeTruthy();
    expect(mocks.feeBps).toHaveBeenCalledTimes(1);
    expect(mocks.subscribe).not.toHaveBeenCalled();
  });

  it("defers to the wallet when the fee rate cannot be read", async () => {
    apiMock.plans.mockResolvedValue({ plans: [makePlan()] });
    mocks.feeBps.mockRejectedValue(new Error("rpc offline"));

    render(<SubscribePage />);
    const dialog = await openDialog();

    // Unknown must never render as "the fee is nothing".
    expect(within(dialog).getByText("Shown in your wallet when you confirm")).toBeTruthy();
    expect(within(dialog).queryByText(/0\.05 XLM/)).toBeNull();
    expect(mocks.subscribe).not.toHaveBeenCalled();
  });

  it("offers no dialog without a wallet or on the wrong network", async () => {
    apiMock.plans.mockResolvedValue({ plans: [makePlan()] });

    mocks.wallet.address = null;
    const first = render(<SubscribePage />);
    await screen.findByText("Monthly Software");
    expect(
      (screen.getByRole("button", { name: "Connect wallet" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    first.unmount();

    mocks.wallet.networkMismatch = true;
    render(<SubscribePage />);
    await screen.findByText("Monthly Software");
    expect(
      (screen.getByRole("button", { name: "Wrong network" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mocks.subscribe).not.toHaveBeenCalled();
  });

  it("rejects a malformed charge limit before showing the dialog", async () => {
    apiMock.plans.mockResolvedValue({ plans: [makePlan()] });

    render(<SubscribePage />);
    await screen.findByText("Monthly Software");

    fireEvent.change(screen.getByLabelText("Charge limit (0 = open-ended)"), {
      target: { value: "1.5" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Subscribe" }));

    expect(
      await screen.findByText("Charge limit must be a whole number, or 0 for open-ended."),
    ).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mocks.subscribe).not.toHaveBeenCalled();
  });

  it("shows the cap the dialog displayed as the limit it signs", async () => {
    apiMock.plans.mockResolvedValue({ plans: [makePlan()] });

    render(<SubscribePage />);
    await screen.findByText("Monthly Software");
    fireEvent.change(screen.getByLabelText("Charge limit (0 = open-ended)"), {
      target: { value: "12" },
    });

    const dialog = await openDialog();
    expect(within(dialog).getByText("Up to 12 charges")).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm and sign" }));
    await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(1));
    expect(mocks.subscribe.mock.calls[0]?.[3]).toBe(12);
  });

  it("shifts the first charge when the plan has a free trial", async () => {
    apiMock.plans.mockResolvedValue({ plans: [makePlan({ trial: 7 * 86_400 })] });

    render(<SubscribePage />);
    const dialog = await openDialog();

    expect(
      within(dialog).getByText(
        "Your free trial runs for 7 days — nothing is charged until it ends, so the first charge is due 7 days from now.",
      ),
    ).toBeTruthy();
    expect(within(dialog).queryByText(/Due now/)).toBeNull();
  });
});
