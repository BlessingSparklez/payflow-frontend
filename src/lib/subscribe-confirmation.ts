import { feeSplit, MAX_FEE_BPS } from "./format";
import { trialSeconds, type HasTrial } from "./trial";

/**
 * What a subscriber is about to agree to, before the wallet ever opens.
 *
 * Clicking Subscribe used to go straight to the signing popup, which says
 * nothing about a mandate: how much, how often, what the protocol takes, how
 * many charges were authorised, when the first one lands, or how to stop it.
 * Those figures are arithmetic over contract values, so they live here as a
 * pure function rather than inside the dialog component — `test/
 * subscribe-confirmation.test.ts` checks them without rendering React.
 *
 * Every amount is a `bigint` in the token's smallest unit. The fee comes from
 * `feeSplit`, the same integer division `charge` performs on-chain, so the
 * confirmation cannot promise a stroop more or less than the contract moves.
 * Nothing here formats a number: the page owns the locale and the token's
 * decimals, and a display string is not something a test can compare exactly.
 */

/** The plan fields the summary reads, from the indexer or from contract state. */
export interface ConfirmationPlan extends HasTrial {
  /** Price of one charge, in the token's smallest unit, as a decimal string. */
  amount: string | bigint;
  /** Seconds between charges. */
  period: number;
}

export interface ConfirmationInput {
  plan: ConfirmationPlan;
  /** Charge cap the subscriber entered; 0 means open-ended. */
  limit: number;
  /**
   * Protocol fee in basis points, or `null` when the contract read failed.
   *
   * Null is not zero: "the fee could not be read" and "the protocol charges
   * nothing" lead to different copy, and only one of them is true here.
   */
  feeBps: number | null;
  /** Reference time in Unix seconds, so a trial end is testable. */
  now: number;
}

export interface Confirmation {
  /** Full price of one charge. */
  gross: bigint;
  /** The protocol's cut of that charge, or null when the rate is unknown. */
  fee: bigint | null;
  /** What the merchant receives, or null when the rate is unknown. */
  net: bigint | null;
  /** The rate the split was computed at, clamped to the contract's range. */
  feeBps: number | null;
  periodSeconds: number;
  limit: number;
  /** True when the mandate has no charge cap and runs until cancelled. */
  openEnded: boolean;
  /** Trial length in seconds; 0 when there is none or it cannot be told. */
  trialSeconds: number;
  /** Unix seconds of the first charge: now, or the end of the trial. */
  firstChargeAt: number;
  /** True when nothing delays the first charge. */
  firstChargeDueNow: boolean;
}

function smallestUnit(raw: string | bigint): bigint {
  if (typeof raw === "bigint") return raw;
  try {
    return BigInt(raw.trim() || "0");
  } catch {
    // A malformed amount from a stale index is not a number to charge against.
    // Zero at least keeps the dialog renderable; the contract re-reads the plan
    // and rejects anything it cannot parse before a signature is requested.
    return 0n;
  }
}

/** Clamp a rate the way `feeSplit` does, so the percentage matches the amount. */
function clampFeeBps(feeBps: number): number {
  if (!Number.isFinite(feeBps)) return 0;
  return Math.min(MAX_FEE_BPS, Math.max(0, Math.trunc(feeBps)));
}

export function confirmationFor({
  plan,
  limit,
  feeBps,
  now,
}: ConfirmationInput): Confirmation {
  const gross = smallestUnit(plan.amount);
  const trial = trialSeconds(plan);
  const rate = feeBps === null ? null : clampFeeBps(feeBps);
  const split = rate === null ? null : feeSplit(gross, rate);

  return {
    gross,
    fee: split?.fee ?? null,
    net: split?.net ?? null,
    feeBps: rate,
    periodSeconds: plan.period,
    limit,
    openEnded: limit === 0,
    trialSeconds: trial,
    firstChargeAt: now + trial,
    firstChargeDueNow: trial === 0,
  };
}

/** Why a charge cap cannot be submitted, or the cap as a whole number. */
export type ChargeLimitCheck = { ok: true; limit: number } | { ok: false; message: string };

/** The wording shown for a cap the contract would not accept. */
export const CHARGE_LIMIT_MESSAGE =
  "Charge limit must be a whole number, or 0 for open-ended.";

/**
 * Read the optional "charge limit" field.
 *
 * An empty field means open-ended, which is the contract's 0. Digits only,
 * deliberately: `Number("1e3")` would silently authorise a thousand charges
 * from a typo, and `Number("2.5")` would authorise a fraction of one. The check
 * runs before the dialog opens so a bad cap is corrected next to the field
 * rather than after a wallet popup has already been raised.
 */
export function checkChargeLimit(raw: string | undefined): ChargeLimitCheck {
  const text = (raw ?? "").trim();
  if (text === "") return { ok: true, limit: 0 };
  if (!/^\d+$/.test(text)) return { ok: false, message: CHARGE_LIMIT_MESSAGE };
  const limit = Number(text);
  if (!Number.isSafeInteger(limit)) return { ok: false, message: CHARGE_LIMIT_MESSAGE };
  return { ok: true, limit };
}
