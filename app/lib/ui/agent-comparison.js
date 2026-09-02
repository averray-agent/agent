/**
 * Cross-agent comparison model + CSV export (roadmap C4).
 *
 * Pure, presentation-agnostic so `node:test` can exercise the row
 * builder and CSV serializer without React. The dialog
 * (`AgentComparisonDialog.tsx`) maps each `AgentRecord` to the flat
 * `ComparisonAgent` shape below (resolving badge ids to human labels via
 * the `BADGES` map, which lives in a `.ts` module) and then calls these.
 *
 * @typedef {Object} ComparisonAgent
 * @property {string} handle
 * @property {string} walletFull
 * @property {string} tier
 * @property {number} score
 * @property {string} specialty
 * @property {string[]} badges          Human-readable badge labels.
 * @property {string} recentActivity
 * @property {number} stakeDeposited
 * @property {number} stakeLocked
 * @property {number} slashed30
 * @property {number} delegated
 * @property {number} subcontracted
 */

/**
 * Ordered metric rows for the side-by-side table + CSV. Tier, score,
 * badges, and recent activity are the close-criteria fields; the rest
 * are useful adjacent context. Stake is labelled DOT to match the
 * directory's existing display (no new denomination claim introduced).
 * @type {{ key: keyof ComparisonAgent, label: string }[]}
 */
export const COMPARISON_METRICS = [
  { key: "walletFull", label: "Wallet" },
  { key: "tier", label: "Tier" },
  { key: "score", label: "Reputation score" },
  { key: "specialty", label: "Specialty" },
  { key: "badges", label: "Badges" },
  { key: "recentActivity", label: "Recent activity" },
  { key: "stakeDeposited", label: "Stake deposited (DOT)" },
  { key: "stakeLocked", label: "Stake locked (DOT)" },
  { key: "slashed30", label: "Slashed (30d)" },
  { key: "delegated", label: "Sub-jobs delegated" },
  { key: "subcontracted", label: "Worked as sub-contractor" },
];

/**
 * Format a single metric value for display. Empty/missing values render
 * as an em-dash so a blank never reads as a real "0" or "".
 * @param {keyof ComparisonAgent} key
 * @param {ComparisonAgent} agent
 * @returns {string}
 */
function formatMetric(key, agent) {
  const value = agent ? agent[key] : undefined;
  if (key === "badges") {
    return Array.isArray(value) && value.length ? value.join("; ") : "—";
  }
  if (value === undefined || value === null || value === "") return "—";
  return String(value);
}

/**
 * Build the side-by-side rows: one row per metric, with one value per
 * agent (aligned to the input order).
 * @param {ComparisonAgent[]} agents
 * @returns {{ key: string, label: string, values: string[] }[]}
 */
export function buildComparisonRows(agents) {
  const list = Array.isArray(agents) ? agents : [];
  return COMPARISON_METRICS.map((metric) => ({
    key: String(metric.key),
    label: metric.label,
    values: list.map((agent) => formatMetric(metric.key, agent)),
  }));
}

/**
 * Escape a single CSV cell per RFC 4180: wrap in quotes when it contains
 * a comma, quote, or newline, doubling any internal quotes.
 * @param {unknown} value
 * @returns {string}
 */
function csvCell(value) {
  const str = String(value ?? "");
  return /[",\r\n]/u.test(str) ? `"${str.replace(/"/gu, '""')}"` : str;
}

/**
 * Serialize the comparison to CSV. Header row is `Metric` + each agent's
 * handle; one row per metric thereafter. CRLF line endings (spreadsheet
 * friendly).
 * @param {ComparisonAgent[]} agents
 * @returns {string}
 */
export function comparisonToCsv(agents) {
  const list = Array.isArray(agents) ? agents : [];
  const header = ["Metric", ...list.map((a) => a?.handle || a?.walletFull || "agent")];
  const rows = buildComparisonRows(list).map((row) => [row.label, ...row.values]);
  return [header, ...rows]
    .map((cols) => cols.map(csvCell).join(","))
    .join("\r\n");
}

/**
 * Suggested download filename for an export, stamped by the caller.
 * @param {string} [stamp] e.g. an ISO date; caller supplies it (no clock here)
 * @returns {string}
 */
export function comparisonCsvFilename(stamp) {
  const suffix = stamp ? `-${String(stamp).replace(/[^0-9a-zA-Z-]/gu, "")}` : "";
  return `averray-agent-comparison${suffix}.csv`;
}
