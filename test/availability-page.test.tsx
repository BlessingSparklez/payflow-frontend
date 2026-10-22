// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PlanPageClient } from "@/app/plans/[id]/PlanPageClient";
import SubscribePage from "@/app/subscribe/page";
import type { ApiPlan } from "@/lib/api";

const mocks = vi.hoisted(() => ({ plans: vi.fn(), chain: vi.fn(), subscribe: vi.fn(),
  feeBps: vi.fn(),
  wallet: { address: "wallet-a" as string | null, networkMismatch: false, signXdr: vi.fn() } }));
vi.mock("@/lib/api", () => ({ api: { plans: mocks.plans, mandatesFor: async () => ({ mandates: [] }) } }));
vi.mock("@/lib/chain", () => ({ chainPlans: mocks.chain }));
vi.mock("@/lib/payflow", () => ({ payflow: { subscribe: mocks.subscribe, feeBps: mocks.feeBps } }));
vi.mock("@/lib/wallet", () => ({ useWallet: () => mocks.wallet }));
vi.mock("@/lib/token", () => ({ useTokenMetas: () => ({}), metaFor: () => ({ symbol: "XLM", decimals: 7 }) }));
const plan = (extra: Partial<ApiPlan> = {}): ApiPlan => ({ id: 1, merchant: "merchant", name: "Cohort", token: "token", amount: "10000000", period: 86400, active: 1, ledger: 0, ...extra });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.wallet.address = "wallet-a";
  mocks.wallet.networkMismatch = false;
  mocks.subscribe.mockResolvedValue("a".repeat(64));
  mocks.feeBps.mockResolvedValue(100);
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

it.each(["api", "chain"])("blocks full and expired plans through %s", async (source) => {
  const plans = [plan({ max_subscribers: 2, subscriber_count: 2 }), plan({ id: 2, name: "Expired", available_until: 1 })];
  mocks.plans.mockResolvedValue(source === "api" ? { plans } : null);
  mocks.chain.mockResolvedValue(plans);
  render(<SubscribePage />);
  await screen.findByText("0 seats left");
  expect(screen.getByText(/closed to new/)).toBeTruthy();
  for (const button of screen.getAllByRole("button", { name: "Subscribe" })) {
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute("aria-describedby")).toBeTruthy();
    fireEvent.click(button);
  }
  expect(mocks.subscribe).not.toHaveBeenCalled();
});
it("shows available seats and a relative cutoff", async () => {
  mocks.plans.mockResolvedValue({ plans: [plan({ max_subscribers: 5, subscriber_count: 2, available_until: Math.floor(Date.now()/1000) + 86400 })] });
  render(<SubscribePage />);
  expect(await screen.findByText("3 seats left")).toBeTruthy();
  // Issue #45 spells relative times out; the cutoff is a day away.
  expect(screen.getByText(/in 1 day/)).toBeTruthy();
});
it("leaves legacy/unlimited plans unchanged", async () => {
  mocks.plans.mockResolvedValue({ plans: [plan(), plan({ id: 2, name: "Unlimited", max_subscribers: 0, available_until: 0 })] });
  render(<SubscribePage />);
  await screen.findByText("Unlimited");
  expect(screen.queryByText(/seats|Available until/)).toBeNull();
  fireEvent.click(screen.getAllByRole("button", { name: "Subscribe" })[0]!);
  // Issue #139: the signature request now sits behind a confirmation dialog.
  fireEvent.click(screen.getByRole("button", { name: "Confirm and sign" }));
  await vi.waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(1));
});
it("explains missing count support", async () => {
  mocks.plans.mockResolvedValue(null);
  mocks.chain.mockResolvedValue([plan({ max_subscribers: 5 })]);
  render(<SubscribePage />);
  expect(await screen.findByText(/Remaining seats are unavailable/)).toBeTruthy();
  expect(screen.queryByText("5 seats left")).toBeNull();
});
it.each(["disconnected", "wrong network"])("prevents submission when %s", async (state) => {
  mocks.wallet.address = state === "disconnected" ? null : "wallet-a";
  mocks.wallet.networkMismatch = state === "wrong network";
  mocks.plans.mockResolvedValue({ plans: [plan()] });
  render(<SubscribePage />);
  const button = await screen.findByRole("button", { name: state === "disconnected" ? "Connect wallet" : "Wrong network" });
  expect((button as HTMLButtonElement).disabled).toBe(true);
});
it("rechecks seats before submitting", async () => {
  mocks.plans.mockResolvedValueOnce({ plans: [plan({ max_subscribers: 1, subscriber_count: 0 })] })
    .mockResolvedValue({ plans: [plan({ max_subscribers: 1, subscriber_count: 1 })] });
  render(<SubscribePage />);
  fireEvent.click(await screen.findByRole("button", { name: "Subscribe" }));
  // The re-read happens when the confirmation is accepted, so that is what
  // this test has to click through to (issue #139).
  fireEvent.click(screen.getByRole("button", { name: "Confirm and sign" }));
  await screen.findByText("0 seats left");
  expect(mocks.subscribe).not.toHaveBeenCalled();
});
it("closes a plan while the tab remains open", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-19T00:00:00Z"));
  mocks.plans.mockResolvedValue({ plans: [plan({ available_until: Date.now()/1000 + 2 })] });
  render(<SubscribePage />);
  await act(async () => {});
  expect((screen.getByRole("button", { name: "Subscribe" }) as HTMLButtonElement).disabled).toBe(false);
  await act(async () => { vi.advanceTimersByTime(2000); });
  expect((screen.getByRole("button", { name: "Subscribe" }) as HTMLButtonElement).disabled).toBe(true);
});
it("does not submit after an account switch during the final read", async () => {
  mocks.plans.mockResolvedValueOnce({ plans: [plan()] });
  let finish!: (value: { plans: ApiPlan[] }) => void;
  mocks.plans.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const view = render(<SubscribePage />);
  fireEvent.click(await screen.findByRole("button", { name: "Subscribe" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm and sign" }));
  const oldFinish = finish;
  mocks.wallet.address = "wallet-b";
  view.rerender(<SubscribePage />);
  await act(async () => { oldFinish({ plans: [plan()] }); });
  expect(await screen.findByText(/Wallet changed/)).toBeTruthy();
  expect(mocks.subscribe).not.toHaveBeenCalled();
});
it("ignores a stale plan load after switching accounts", async () => {
  let finishOld!: (value: { plans: ApiPlan[] }) => void;
  mocks.plans.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
    .mockResolvedValue({ plans: [plan({ name: "Current plan" })] });
  const view = render(<SubscribePage />);
  mocks.wallet.address = "wallet-b";
  view.rerender(<SubscribePage />);
  await screen.findByText("Current plan");
  await act(async () => { finishOld({ plans: [plan({ name: "Stale plan" })] }); });
  expect(screen.queryByText("Stale plan")).toBeNull();
});
it("checks the current time again when clicked before the next timer tick", async () => {
  mocks.plans.mockResolvedValue({ plans: [plan({ available_until: Math.floor(Date.now()/1000) + 1 })] });
  render(<SubscribePage />);
  const button = await screen.findByRole("button", { name: "Subscribe" });
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2000);
  fireEvent.click(button);
  expect(mocks.subscribe).not.toHaveBeenCalled();
  expect(await screen.findByText(/closed to new subscriptions/)).toBeTruthy();
  vi.restoreAllMocks();
});
it("does not sign when the plan expires during simulation", async () => {
  const cutoff = Math.floor(Date.now()/1000) + 10;
  mocks.plans.mockResolvedValue({ plans: [plan({ available_until: cutoff })] });
  mocks.subscribe.mockImplementation(async (_address, sign) => {
    vi.spyOn(Date, "now").mockReturnValue(cutoff * 1000);
    return sign("unsigned-xdr");
  });
  render(<SubscribePage />);
  fireEvent.click(await screen.findByRole("button", { name: "Subscribe" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm and sign" }));
  expect(await screen.findByText(/closed to new subscriptions/)).toBeTruthy();
  expect(mocks.wallet.signXdr).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});
it.each([
  { available_until: 1 },
  { max_subscribers: 1, subscriber_count: 1 },
])("blocks unavailable plans on the newly added detail route: %j", async (fields) => {
  mocks.plans.mockResolvedValue({ plans: [plan(fields)] });
  render(<PlanPageClient planId="1" />);
  const button = await screen.findByRole("button", { name: "Subscribe" });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  expect(button.getAttribute("aria-describedby")).toBe("plan-availability");
  fireEvent.click(button);
  expect(mocks.subscribe).not.toHaveBeenCalled();
});
it("rechecks seats on the detail route before submission", async () => {
  mocks.plans.mockResolvedValueOnce({ plans: [plan({ max_subscribers: 1, subscriber_count: 0 })] })
    .mockResolvedValue({ plans: [plan({ max_subscribers: 1, subscriber_count: 1 })] });
  render(<PlanPageClient planId="1" />);
  fireEvent.click(await screen.findByRole("button", { name: "Subscribe" }));
  await vi.waitFor(() => expect(screen.getAllByText(/This plan is full/).length).toBeGreaterThan(0));
  expect(mocks.subscribe).not.toHaveBeenCalled();
});
it("keeps unlimited detail-route subscriptions working", async () => {
  mocks.plans.mockResolvedValue({ plans: [plan({ max_subscribers: 0, available_until: 0 })] });
  render(<PlanPageClient planId="1" />);
  fireEvent.click(await screen.findByRole("button", { name: "Subscribe" }));
  await vi.waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(1));
});
