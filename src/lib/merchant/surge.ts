/**
 * Merchant Surge Pricing Simulation State
 *
 * Provides an in-memory TTL-based surge pricing toggle for judge demonstrations.
 * When active, checkout proposals will simulate a 15% price increase above discovery price,
 * triggering the price slippage defense (STEP_UP) and logging NO_RAZORPAY_ORDER_CREATED.
 */

let surgeActiveUntil: number | null = null;
export const SURGE_PERCENT = 15; // 15% price surge
/** Explicit policy reason surfaced in every trace when surge pricing re-prices a quote. */
export const SURGE_PRICING_REASON = "SURGE_PRICING_ACTIVE";

export function setSurgePricing(active: boolean, durationSeconds = 60): void {
  if (active) {
    surgeActiveUntil = Date.now() + durationSeconds * 1000;
  } else {
    surgeActiveUntil = null;
  }
}

export function isSurgePricingActive(): boolean {
  if (!surgeActiveUntil) return false;
  if (Date.now() > surgeActiveUntil) {
    surgeActiveUntil = null;
    return false;
  }
  return true;
}

export function getSurgeStatus(): {
  active: boolean;
  remainingSeconds: number;
  surgePercent: number;
} {
  const active = isSurgePricingActive();
  const remainingSeconds =
    active && surgeActiveUntil
      ? Math.max(0, Math.ceil((surgeActiveUntil - Date.now()) / 1000))
      : 0;

  return {
    active,
    remainingSeconds,
    surgePercent: SURGE_PERCENT,
  };
}

/** Persistable view of the surge toggle (survives process restarts). */
export function getSurgeActiveUntilEpoch(): number | null {
  return surgeActiveUntil;
}

/** Rehydrate the surge toggle from the merchant's persisted config. */
export function hydrateSurgeState(activeUntilEpoch: number | null): void {
  surgeActiveUntil =
    typeof activeUntilEpoch === "number" && activeUntilEpoch > Date.now()
      ? activeUntilEpoch
      : null;
}
