import { formatUnits } from "ethers";

export const DEPOSIT_POOL_YIELD_NOT_EARNING_TEXT =
  "Deposits do not currently earn yield. No venue deployment is recorded for this pool. The operator decides each cycle.";

export const DEPOSIT_POOL_YIELD_EARNING_TEXT =
  "Pool capital is deployed to the configured venue; yield is recognized only when returned to pool accounting.";

function quantity(value) {
  const formatted = formatUnits(value.raw, value.decimals);
  return formatted.includes(".") ? formatted.replace(/\.?0+$/u, "") : formatted;
}

function date(proof) {
  return proof?.timestampIso ? `${proof.timestampIso.slice(0, 10)} (UTC)` : "an unavailable date";
}

/** One source for both pool doors. Missing history is not evidence of no history. */
export function depositPoolYieldStatus(deployedPrincipalRaw, history) {
  if (BigInt(deployedPrincipalRaw ?? 0) > 0n) {
    return {
      yieldStatus: "earning",
      yieldStatusText: DEPOSIT_POOL_YIELD_EARNING_TEXT
    };
  }
  if (history?.status !== "available") {
    return {
      yieldStatus: "history_unavailable",
      yieldStatusText: "No principal is currently deployed. Venue history is unavailable; past cycles cannot be described from this read."
    };
  }
  if (BigInt(history.deploymentCount) === 0n) {
    return { yieldStatus: "not_yet_earning", yieldStatusText: DEPOSIT_POOL_YIELD_NOT_EARNING_TEXT };
  }
  const last = history.lastDeployment;
  const difference = BigInt(last.principalOut.raw) - BigInt(last.returnedAssets.raw);
  const result = difference >= 0n
    ? `the ${quantity({ raw: difference, decimals: last.principalOut.decimals })} USDC difference is the measured round-trip cost`
    : `the ${quantity({ raw: -difference, decimals: last.principalOut.decimals })} USDC excess returned is the recorded venue result`;
  const received = last.lastReturn
    ? `received ${quantity(last.returnedAssets)} USDC back in total, with the last return on ${date(last.lastReturn)}`
    : `has no returned assets recorded`;
  return {
    yieldStatus: "home_after_cycle",
    yieldStatusText: `Pool capital is home. ${history.completedCycleCount} venue cycle(s) completed; the last, deployment #${last.id}, sent ${quantity(last.principalOut)} USDC out on ${date(last.dispatch)} and ${received}; ${result}. ${quantity(last.writtenOff)} USDC was written off. No cycle is scheduled; the operator decides each one.`
  };
}

/** Describe attribution, never infer it from a share price above principal. */
export function depositPoolYieldAttributionText(attribution) {
  const gain = attribution?.gain;
  if (!gain?.unattributed || !gain?.operatorAdded || !gain?.venueEarned) {
    return "Yield attribution is unavailable; a share price above principal is not proof of yield.";
  }
  const parts = [];
  if (BigInt(gain.unattributed.raw) > 0n) {
    parts.push(`${quantity(gain.unattributed)} USDC above principal is not yet attributed; an unattributed gain is not yield.`);
  } else if (BigInt(gain.unattributed.raw) < 0n) {
    parts.push(`${quantity({ ...gain.unattributed, raw: -BigInt(gain.unattributed.raw) })} USDC of loss is not yet attributed.`);
  }
  if (BigInt(gain.operatorAdded.raw) > 0n) {
    parts.push(`${quantity(gain.operatorAdded)} USDC was added by the operator, attested against chain evidence; this is not venue yield.`);
  }
  const venue = BigInt(gain.venueEarned.raw);
  if (venue < 0n) {
    parts.push(`The venue result is a cost of ${quantity({ ...gain.venueEarned, raw: -venue })} USDC.`);
  } else if (venue > 0n) {
    parts.push(`The attributed venue result is ${quantity(gain.venueEarned)} USDC; a venue mark is not a promise of future returns.`);
  }
  return parts.join(" ") || "No venue gain or operator-added assets are attributed in this read.";
}
