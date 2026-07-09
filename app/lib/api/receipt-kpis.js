export const COSIGN_TARGET_PCT = 95;

/**
 * @param {{ signers?: Array<{ identified?: boolean }> } | null | undefined} row
 * @returns {number}
 */
export function identifiedSignerCount(row) {
  const signers = Array.isArray(row?.signers) ? row.signers : [];
  return signers.filter((signer) => signer?.identified === true).length;
}

/**
 * @param {Array<{ signers?: Array<{ identified?: boolean }> }> | null | undefined} rows
 * @returns {{
 *   value: string;
 *   unit: "" | "%";
 *   meta: string;
 *   metaTone: "muted" | "ok" | "warn";
 *   status: "unknown" | "within" | "below";
 * }}
 */
export function coSignKpiState(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) {
    return {
      value: "—",
      unit: "",
      meta: "no receipt rows in this view",
      metaTone: "muted",
      status: "unknown",
    };
  }

  const rowsWithSignerIdentity = list.filter((row) => identifiedSignerCount(row) > 0);
  if (rowsWithSignerIdentity.length === 0) {
    return {
      value: "—",
      unit: "",
      meta: "signer identities not yet emitted by /badges",
      metaTone: "warn",
      status: "unknown",
    };
  }

  const coSigned = rowsWithSignerIdentity.filter((row) => identifiedSignerCount(row) > 1).length;
  const pct = Math.round((coSigned / rowsWithSignerIdentity.length) * 1000) / 10;
  return {
    value: pct.toFixed(1),
    unit: "%",
    meta: `${coSigned} of ${rowsWithSignerIdentity.length} receipts · identified signer chain`,
    metaTone: pct >= COSIGN_TARGET_PCT ? "ok" : "warn",
    status: pct >= COSIGN_TARGET_PCT ? "within" : "below",
  };
}
