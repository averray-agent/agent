function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function amount(value) {
  const candidate = record(value);
  const raw = text(candidate?.raw);
  const decimals = Number(candidate?.decimals);
  if (!raw || !/^-?\d+$/u.test(raw) || !Number.isSafeInteger(decimals) || decimals < 0) return null;

  const negative = raw.startsWith("-");
  const digits = negative ? raw.slice(1) : raw;
  const padded = digits.padStart(decimals + 1, "0");
  const whole = decimals === 0 ? padded : padded.slice(0, -decimals);
  const fraction = decimals === 0 ? "" : padded.slice(-decimals).replace(/0+$/u, "");
  const grouped = BigInt(whole).toLocaleString("en-US");
  return `${negative ? "−" : ""}${grouped}${fraction ? `.${fraction}` : ""}`;
}

function amountWithUnit(value, unit = "USDC") {
  const formatted = amount(value);
  return formatted === null ? null : `${formatted} ${unit}`;
}

function transitionStatement(payload) {
  return text(record(payload.transition)?.statement)
    ?? text(record(payload.poolTransition)?.statement)
    ?? null;
}

function count(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Presentation-only projection of GET /pool.
 *
 * All descriptive sentences remain API-owned. This function supplies labels
 * and exact raw-unit formatting, but never substitutes client-side economics,
 * risk copy, venue claims, or transition claims.
 */
export function buildDepositPoolSurface(input) {
  const payload = record(input);
  if (!payload || payload.available !== true) {
    return {
      available: false,
      reason: text(payload?.reason),
      disclosure: null,
      transition: null,
      facts: [],
      yield: null,
      venue: null,
      attribution: null
    };
  }

  const disclosure = text(record(payload.disclosure)?.statement);
  const sharePrice = record(payload.sharePrice);
  const markedSharePrice = record(payload.markedSharePrice);
  const venueMark = record(payload.venueMark);
  const attribution = record(payload.yieldAttribution);
  const gain = record(attribution?.gain);
  const ledger = record(attribution?.subsidyLedger);

  return {
    available: true,
    disclosure,
    transition: transitionStatement(payload),
    facts: [
      { label: "Total assets", value: amountWithUnit(payload.totalAssets) },
      { label: "Pool buffer", value: amountWithUnit(payload.bufferAssets) },
      { label: "Quoted NAV per share", value: amountWithUnit(record(sharePrice?.assetsPerShare)) },
      { label: "Venue-marked NAV per share", value: amountWithUnit(record(markedSharePrice?.assetsPerShare)) }
    ],
    yield: {
      status: text(payload.yieldStatus),
      statement: text(payload.yieldStatusText)
    },
    venue: venueMark ? {
      status: text(venueMark.status),
      statement: text(venueMark.statement),
      depositsBlocked: typeof venueMark.depositsBlocked === "boolean" ? venueMark.depositsBlocked : null,
      costBasis: amountWithUnit(venueMark.costBasis),
      marked: amountWithUnit(venueMark.marked),
      shortfall: amountWithUnit(venueMark.shortfall),
      surplus: amountWithUnit(venueMark.surplus)
    } : null,
    attribution: attribution ? {
      status: text(attribution.status),
      statement: text(attribution.statement),
      cumulativeNav: amountWithUnit(gain?.cumulativeNav),
      venueEarned: amountWithUnit(gain?.venueEarned),
      operatorAdded: amountWithUnit(gain?.operatorAdded),
      attestation: text(ledger?.attestation),
      entryCount: count(ledger?.entryCount)
    } : null
  };
}
