import { describe, expect, it } from "vitest";
import { feeSplit } from "@/lib/format";
import {
  CHARGE_LIMIT_MESSAGE,
  checkChargeLimit,
  confirmationFor,
} from "@/lib/subscribe-confirmation";

/**
 * The figures the subscribe confirmation shows (issue #139): amount, period,
 * protocol fee, charge cap and when the first charge lands.
 *
 * Pure tests: no React, no RPC. The point of most of these is that money stays
 * in the token's smallest unit as a `bigint` and that an unreadable fee is
 * reported as unknown rather than as a free transaction.
 */

const PLAN = { amount: "50000000", period: 2_592_000 };
const NOW = 1_766_000_000;

function summary(overrides: Partial<Parameters<typeof confirmationFor>[0]> = {}) {
  return confirmationFor({ plan: PLAN, limit: 0, feeBps: 100, now: NOW, ...overrides });
}

describe("confirmationFor: amounts", () => {
  it("splits the amount exactly as charge does, in bigint", () => {
    const result = summary();
    expect(result.gross).toBe(50_000_000n);
    expect(result.fee).toBe(500_000n);
    expect(result.net).toBe(49_500_000n);
    // Same integer division as the contract: not a percentage of a float.
    expect(result).toMatchObject(feeSplit(50_000_000n, 100));
  });

  it("keeps every figure a bigint, never a number", () => {
    const result = summary({ plan: { amount: "999999999999999999", period: 86_400 } });
    expect(typeof result.gross).toBe("bigint");
    expect(typeof result.fee).toBe("bigint");
    expect(typeof result.net).toBe("bigint");
  });

  it("accepts an amount that is already a bigint", () => {
    const result = summary({ plan: { amount: 12_345n, period: 60 } });
    expect(result.gross).toBe(12_345n);
  });

  it("clamps a rate past the contract's ceiling so the split and the percent agree", () => {
    const result = summary({ feeBps: 5_000 });
    expect(result.feeBps).toBe(1_000);
    expect(result.fee).toBe(5_000_000n);
  });

  it("reports an unreadable fee as unknown, not as zero", () => {
    const result = summary({ feeBps: null });
    expect(result.feeBps).toBeNull();
    expect(result.fee).toBeNull();
    expect(result.net).toBeNull();
    // The amount itself is still known: only the split is missing.
    expect(result.gross).toBe(50_000_000n);
  });

  it("does not throw on a malformed amount from a stale source", () => {
    const result = summary({ plan: { amount: "not-a-number", period: 60 } });
    expect(result.gross).toBe(0n);
  });
});

describe("confirmationFor: charge timing and cap", () => {
  it("says the first charge is due now when the plan has no trial", () => {
    const result = summary();
    expect(result.trialSeconds).toBe(0);
    expect(result.firstChargeAt).toBe(NOW);
    expect(result.firstChargeDueNow).toBe(true);
  });

  it("moves the first charge to the end of a trial", () => {
    const result = summary({ plan: { ...PLAN, trial: 14 * 86_400 } });
    expect(result.trialSeconds).toBe(1_209_600);
    expect(result.firstChargeAt).toBe(NOW + 1_209_600);
    expect(result.firstChargeDueNow).toBe(false);
  });

  it("treats a cap of 0 as open-ended and any other cap as bounded", () => {
    expect(summary({ limit: 0 }).openEnded).toBe(true);
    expect(summary({ limit: 1 }).openEnded).toBe(false);
    expect(summary({ limit: 12 })).toMatchObject({ openEnded: false, limit: 12 });
  });
});

describe("checkChargeLimit", () => {
  it.each([
    [undefined, 0],
    ["", 0],
    ["   ", 0],
    ["0", 0],
    ["1", 1],
    ["  12 ", 12],
  ])("reads %j as %i charges", (raw, expected) => {
    expect(checkChargeLimit(raw as string | undefined)).toEqual({ ok: true, limit: expected });
  });

  it.each(["2.5", "-1", "1e3", "twelve", "1 2", "1,000"])(
    "refuses %j rather than authorising a number nobody chose",
    (raw) => {
      expect(checkChargeLimit(raw)).toEqual({ ok: false, message: CHARGE_LIMIT_MESSAGE });
    },
  );

  it("refuses a count too large to survive as an integer", () => {
    expect(checkChargeLimit("9".repeat(30))).toEqual({
      ok: false,
      message: CHARGE_LIMIT_MESSAGE,
    });
  });
});
