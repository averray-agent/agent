/**
 * Present a pinned personhood read on a profile or directory line.
 * The server owns the tooltip. A missing or unavailable read keeps the
 * truncated address and shows no pill.
 */

/**
 * @param {unknown} payload
 * @returns {Record<string, unknown>}
 */
export function indexPersonhood(payload) {
  const record = payload && typeof payload === "object" ? payload : null;
  const results = record && "results" in record && Array.isArray(record.results) ? record.results : [];
  /** @type {Record<string, unknown>} */
  const indexed = {};
  for (const row of results) {
    const wallet = typeof row?.wallet === "string" ? row.wallet.toLowerCase() : "";
    if (!wallet) continue;
    indexed[wallet] = row;
  }
  return indexed;
}

export function personhoodFor(index, wallet) {
  if (!index || typeof wallet !== "string") return null;
  const row = index[wallet.toLowerCase()];
  if (!row || row.available === false || (row.tier !== "none" && row.tier !== "lite" && row.tier !== "full")) {
    return null;
  }
  return row;
}

export function personhoodLineText(row, fallback) {
  const text = row?.line?.text;
  if (typeof text === "string" && text.trim()) return text.trim();
  return fallback;
}

/**
 * @param {unknown} row
 * @returns {{ pill: "lite" | "full" | "suspended", tooltip: string } | null}
 */
export function personhoodPill(row) {
  const pill = row && typeof row === "object" && "line" in row && row.line && typeof row.line === "object" && "pill" in row.line
    ? row.line.pill
    : null;
  if (pill === "lite" || pill === "full" || pill === "suspended") {
    return {
      pill,
      tooltip: typeof row.line.tooltip === "string" ? row.line.tooltip : ""
    };
  }
  return null;
}
