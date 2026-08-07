/**
 * The only vocabulary seam between the backend field envelope and the
 * operator app. This maps already-derived statuses; it never judges readAtMs.
 */
export const TRANSPARENCY_STATUS_TO_FRESHNESS = Object.freeze({
  fresh: "live",
  stale: "partial",
  unknown: "fallback",
});

export const TRANSPARENCY_STATUS_LABEL = Object.freeze({
  fresh: "Live",
  stale: "Stale",
  unknown: "No read",
});

// Ordered best → worst. Must cover every FreshnessState: an unranked
// state falls back to the WORST rank, never the best, so a state added
// to the shared vocabulary can never quietly make the page read fresher
// than it is.
const FRESHNESS_RANK = Object.freeze({
  live: 0,
  loading: 1,
  partial: 2,
  locked: 3,
  fallback: 4,
});

function freshnessRank(state) {
  return FRESHNESS_RANK[state] ?? FRESHNESS_RANK.fallback;
}

const READ_AT_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

export function mapTransparencyStatus(status) {
  return TRANSPARENCY_STATUS_TO_FRESHNESS[status] ?? "fallback";
}

export function presentTransparencyField(field, { decimals } = {}) {
  const status = field?.status ?? "unknown";
  const freshness = mapTransparencyStatus(status);
  const missing = status === "unknown" || field?.value === null || field?.value === undefined;
  return {
    freshness,
    statusLabel: TRANSPARENCY_STATUS_LABEL[status] ?? "No read",
    display: missing ? "no read" : formatValue(field.value, field.unit, decimals),
    missing,
    lastKnown: status === "stale",
  };
}

export function transparencyPageFreshness(payload) {
  const fields = collectFields(payload);
  return worstTransparencyFreshness(fields);
}

export function worstTransparencyFreshness(fields) {
  if (!Array.isArray(fields) || fields.length === 0) return "fallback";
  return fields
    .map((field) => mapTransparencyStatus(field.status))
    .reduce((worst, current) =>
      freshnessRank(current) > freshnessRank(worst) ? current : worst, "live");
}

export function transparencyFreshnessSentence(fields, label = "chain-read lines") {
  const normalized = Array.isArray(fields) ? fields : [];
  const total = normalized.length;
  const counts = normalized.reduce((result, field) => {
    const status = field?.status === "fresh" || field?.status === "stale" ? field.status : "unknown";
    result[status] += 1;
    return result;
  }, { fresh: 0, stale: 0, unknown: 0 });
  if (total === 0) return `No ${label} are available.`;
  if (counts.fresh === total) {
    return `${numberWord(total)} ${label}, all read within their freshness window.`;
  }
  const clauses = [];
  if (counts.fresh) clauses.push(`${counts.fresh} fresh`);
  if (counts.stale) clauses.push(`${counts.stale} stale`);
  if (counts.unknown) clauses.push(`${counts.unknown} with no read`);
  return `${numberWord(total)} ${label}: ${clauses.join(" · ")}.`;
}

export function transparencyCompositionSentence(composition) {
  const entries = [
    ["platform verification runs", composition?.platformVerificationRuns],
    ["ingested", composition?.ingested],
    ["external", composition?.external],
    ["unclassified", composition?.unclassified],
  ];
  if (entries.some(([, field]) => field?.status === "unknown" || field?.value === null || field?.value === undefined)) {
    return "24h composition has no complete read.";
  }
  const text = entries.map(([label, field]) => `${formatInteger(field.value)} ${label}`).join(" · ");
  const ownLoop = Number(composition.platformVerificationRuns.value) > 0
    && Number(composition.ingested.value) === 0
    && Number(composition.external.value) === 0
    && Number(composition.unclassified.value) === 0;
  return `${text}${ownLoop ? " — all volume is our own loop." : "."}`;
}

export function transparencyReadChanged(previous, current) {
  if (!previous || !current || current.status === "unknown") return false;
  return previous.readAtMs !== current.readAtMs && previous.value !== current.value;
}

export function aggregateDisclosure(field) {
  if (field?.status === "unknown" || field?.value === null || field?.value === undefined) {
    return "Incomplete total. The readable lines are a lower bound; the complete total has no read.";
  }
  if (field.status === "stale") {
    return "Last complete total. At least one contributing line is outside its freshness window.";
  }
  return "Complete total reported by the read model from the three proved lines below.";
}

export function formatReadAt(readAtMs) {
  if (!Number.isFinite(readAtMs)) return "read time unavailable";
  return READ_AT_FORMATTER.format(new Date(readAtMs)) + " UTC";
}

export function formatWindowMs(value) {
  if (!Number.isFinite(value)) return "window unavailable";
  if (value < 60_000) return `${Math.round(value / 1_000)}s window`;
  return `${Math.round(value / 60_000)} min window`;
}

export function extractProofAnchors(text) {
  const proof = String(text ?? "");
  const urls = unique(proof.match(/https?:\/\/[^\s;,]+/gu) ?? []);
  const addresses = unique(proof.match(/0x[a-fA-F0-9]{40}(?![a-fA-F0-9])/gu) ?? []);
  const transactions = /\btxs?\b/iu.test(proof)
    ? unique(proof.match(/0x[a-fA-F0-9]{64}(?![a-fA-F0-9])/gu) ?? [])
    : [];
  const routes = unique(proof.match(/\/(?:admin|account|jobs|receipts|status)[^\s;,]*/gu) ?? []);
  return { urls, addresses, transactions, routes };
}

function collectFields(value, out = []) {
  if (!value || typeof value !== "object") return out;
  if (typeof value.status === "string" && Object.hasOwn(value, "value")) {
    out.push(value);
    return out;
  }
  for (const child of Object.values(value)) collectFields(child, out);
  return out;
}

function formatValue(value, unit, decimals) {
  if (unit === "USDC") return formatDecimal(value, decimals ?? 6);
  if (unit === "jobs") return `${formatInteger(value)} jobs`;
  if (unit === "ms") return `${formatInteger(value)} ms`;
  return String(value);
}

function formatDecimal(value, decimals) {
  const text = String(value);
  if (!/^-?\d+(?:\.\d+)?$/u.test(text)) return text;
  const [whole, fraction = ""] = text.split(".");
  const sign = whole.startsWith("-") ? "-" : "";
  const digits = sign ? whole.slice(1) : whole;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
  const shown = fraction.slice(0, decimals).padEnd(decimals, "0");
  return decimals > 0 ? `${sign}${grouped}.${shown}` : `${sign}${grouped}`;
}

function formatInteger(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric).toLocaleString("en-US") : String(value);
}

function unique(values) {
  return [...new Set(values)];
}

function numberWord(value) {
  const words = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];
  return words[value] ?? String(value);
}
