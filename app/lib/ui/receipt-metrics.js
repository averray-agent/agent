/**
 * Shared operator labels for receipt totals.
 *
 * `/badges` is the live source for today's receipt index, but the rows can
 * represent several receipt shapes. Keeping the breakdown explicit prevents
 * the `/receipts` total from being confused with the `/agents` badge count.
 */

export const RECEIPT_KIND_ORDER = Object.freeze(["run", "badge", "settle", "policy"]);

/**
 * @typedef {object} ReceiptLike
 * @property {string} [kind]
 */

/**
 * @param {ReceiptLike[]} rows
 * @returns {{ run: number, badge: number, settle: number, policy: number }}
 */
export function receiptKindBreakdown(rows) {
  const counts = { run: 0, badge: 0, settle: 0, policy: 0 };
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== "object") continue;
    const kind = row.kind;
    if (kind === "run" || kind === "badge" || kind === "settle" || kind === "policy") {
      counts[kind] += 1;
    }
  }
  return counts;
}

/**
 * @param {ReceiptLike[]} rows
 * @returns {string}
 */
export function formatReceiptKindBreakdown(rows) {
  const counts = receiptKindBreakdown(rows);
  return RECEIPT_KIND_ORDER
    .map((kind) => `${kind} ${counts[kind]}`)
    .join(" · ");
}
