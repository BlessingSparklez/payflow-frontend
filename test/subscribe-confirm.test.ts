import { describe, expect, it } from "vitest";
import {
  CHARGE_LIMIT_ERROR,
  confirmFacts,
  parseChargeLimit,
} from "@/lib/subscribe-confirm";

describe("parseChargeLimit (#subscribe-confirm)", () => {
  it("treats blank and 0 as open-ended", () => {
    expect(parseChargeLimit(undefined)).toEqual({ ok: true, limit: 0 });
    expect(parseChargeLimit(null)).toEqual({ ok: true, limit: 0 });
    expect(parseChargeLimit("")).toEqual({ ok: true, limit: 0 });
    expect(parseChargeLimit("   ")).toEqual({ ok: true, limit: 0 });
    expect(parseChargeLimit("0")).toEqual({ ok: true, limit: 0 });
  });

  it("accepts whole numbers of charges, tolerating surrounding space", () => {
    expect(parseChargeLimit("1")).toEqual({ ok: true, limit: 1 });
    expect(parseChargeLimit(" 12 ")).toEqual({ ok: true, limit: 12 });
  });

  it("rejects anything that is not a whole, non-negative number", () => {
    // A silently reinterpreted limit would change how long a mandate can
    // charge for — the dialog must refuse it and say the same words the
    // signing path uses.
    for (const raw of ["1.5", "-3", "12x", "twelve", "NaN"]) {
      expect(parseChargeLimit(raw)).toEqual({ ok: false, message: CHARGE_LIMIT_ERROR });
    }
  });
});

describe("confirmFacts", () => {
  it("keeps money in bigint smallest units through the fee split", () => {
    const facts = confirmFacts({ amount: "50000000" }, 100);
    // 5 XLM at 1%: the same integer math the contract's `charge` performs.
    expect(facts.amount).toBe(50000000n);
    expect(facts.fee).toBe(500000n);
    expect(facts.net).toBe(49500000n);
    expect(facts.feeBps).toBe(100);
    expect(facts.firstChargeDelay).toBe(0);
  });

  it("never rounds an amount beyond Number.MAX_SAFE_INTEGER", () => {
    const facts = confirmFacts({ amount: "90071992547409931" }, 0);
    expect(facts.amount).toBe(90071992547409931n);
    expect(facts.fee).toBe(0n);
    expect(facts.net).toBe(90071992547409931n);
  });

  it("reports an unreadable fee rate as unknown rather than free", () => {
    // The RPC may be offline while the dialog opens. A zero fee here would
    // promise the subscriber something the contract may not honour, so the
    // dialog defers to the wallet instead.
    for (const rate of [null, undefined, Number.NaN]) {
      const facts = confirmFacts({ amount: "10000000" }, rate);
      expect(facts.fee).toBeNull();
      expect(facts.net).toBeNull();
      expect(facts.feeBps).toBeNull();
    }
  });

  it("clamps a rate the way the contract's set_fee_bps would", () => {
    // Above MAX_FEE_BPS (10%) the contract would reject the write; the
    // preview must show the same ceiling rather than a bigger cut.
    expect(confirmFacts({ amount: "10000" }, 5_000).fee).toBe(1_000n);
    expect(confirmFacts({ amount: "10000" }, -50).fee).toBe(0n);
  });

  it("freezes the trial as the delay until the first charge", () => {
    expect(confirmFacts({ amount: "1", trial: 7 * 86_400 }, 100).firstChargeDelay).toBe(
      604_800,
    );
    // Absent and zero both mean no trial: a contract built before the trial
    // field cannot say, and neither can we — but it is not a delayed charge.
    expect(confirmFacts({ amount: "1" }, 100).firstChargeDelay).toBe(0);
    expect(confirmFacts({ amount: "1", trial: 0 }, 100).firstChargeDelay).toBe(0);
    // scValToNative decodes a u64 as bigint; the indexer sends a number.
    expect(confirmFacts({ amount: "1", trial: 3_600n }, 100).firstChargeDelay).toBe(3_600);
  });
});
