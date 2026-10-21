import { feeSplit, MAX_FEE_BPS } from "./format";
import { trialSeconds } from "./trial";

/**
 * Facts the subscribe confirmation dialog shows before a signature is asked
 * for: what one charge costs the subscriber, what the protocol takes, and
 * when the first charge lands.
 *
 * Kept here rather than in the page so the arithmetic can be tested without
 * rendering React — and because every value that touches money stays a
 * bigint in the token's smallest unit until the moment it is formatted.
 * Floating point never enters this module.
 */
export interface ConfirmSource {
  /** Plan price per charge, in the smallest unit, as a decimal string or bigint. */
  amount: string | bigint;
  /** Optional trial length in seconds; absent/zero means no trial. */
  trial?: unknown;
}

export interface ConfirmFacts {
  /** What one charge costs the subscriber, in the smallest unit. */
  amount: bigint;
  /** The protocol fee per charge, in the smallest unit. */
  fee: bigint | null;
  /** What reaches the merchant per charge: `amount - fee`. */
  net: bigint | null;
  /** The rate the fee was derived from, in basis points. */
  feeBps: number | null;
  /**
   * Seconds until the first charge: 0 means due now (nothing is charged
   * before the subscriber confirms), otherwise the trial length.
   */
  firstChargeDelay: number;
}

/**
 * Build the dialog's facts from the plan as displayed and the contract's
 * current fee rate.
 *
 * The rate is read live from the subscription contract (`payflow.feeBps`)
 * because the contract freezes `fee_bps` into each mandate at subscribe time
 * — the dialog must show what THIS subscription will charge, not a stale
 * constant. The split itself is `feeSplit`'s integer math, identical to the
 * contract's `charge`, so the preview cannot disagree with the chain by a
 * stroop.
 *
 * A null `feeBps` (the rate could not be read, e.g. RPC offline) produces
 * null fee/net rather than a zero: "we cannot say yet" must never render as
 * "the fee is nothing", and the dialog then defers to the wallet.
 */
export function confirmFacts(
  source: ConfirmSource,
  feeBps: number | null | undefined,
): ConfirmFacts {
  const amount = typeof source.amount === "bigint" ? source.amount : BigInt(source.amount);
  const bps =
    typeof feeBps === "number" && Number.isFinite(feeBps)
      ? Math.min(Math.max(Math.trunc(feeBps), 0), MAX_FEE_BPS)
      : null;
  const split = bps === null ? null : feeSplit(amount, bps);
  return {
    amount,
    fee: split?.fee ?? null,
    net: split?.net ?? null,
    feeBps: bps,
    firstChargeDelay: trialSeconds(source),
  };
}

/** Reused verbatim so the dialog and the signing path reject the same input with the same words. */
export const CHARGE_LIMIT_ERROR =
  "Charge limit must be a whole number, or 0 for open-ended.";

export type ChargeLimitResult =
  | { ok: true; limit: number }
  | { ok: false; message: string };

/**
 * Parse the charge-limit field: a whole number of charges, or 0 (or blank)
 * for open-ended.
 *
 * Exported for tests because a limit that silently becomes a different
 * number changes how long a mandate can charge for — the dialog must show
 * exactly what the contract will be told.
 */
export function parseChargeLimit(raw: string | null | undefined): ChargeLimitResult {
  const text = raw?.trim();
  if (!text) return { ok: true, limit: 0 };
  const limit = Number(text);
  if (!Number.isInteger(limit) || limit < 0) {
    return { ok: false, message: CHARGE_LIMIT_ERROR };
  }
  return { ok: true, limit };
}
