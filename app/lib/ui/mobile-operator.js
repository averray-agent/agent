/**
 * Pure state and truth helpers for the responsive operator room.
 *
 * React components consume these functions, and the node test suite exercises
 * the same transitions. Keeping route scope and sheet behaviour here avoids a
 * second, test-only description of the mobile contract.
 */

export const GOVERNANCE_OPERATOR_PATHS = Object.freeze([
  "/policies",
  "/capabilities",
  "/disputes",
  "/audit-log",
]);

export const RESPONSIVE_OPERATOR_PATHS = Object.freeze([
  "/overview",
  "/runs",
  "/receipts",
  "/poster",
  "/agents",
  "/treasury",
]);

export function isGovernanceOperatorPath(pathname) {
  return GOVERNANCE_OPERATOR_PATHS.some(
    (path) => pathname === path || pathname?.startsWith(`${path}/`),
  );
}

export function updateMoreSheetState(open, event) {
  if (event === "open") return true;
  if (event === "close" || event === "navigate" || event === "sign_out" || event === "disconnect") {
    return false;
  }
  return open;
}

export function formatOperatorSessionExpiry(value) {
  if (value === null || value === undefined || value === "") return "Not reported";
  const numeric = typeof value === "number" ? value : Number.NaN;
  const timestamp = Number.isFinite(numeric)
    ? numeric < 10_000_000_000
      ? numeric * 1_000
      : numeric
    : Date.parse(String(value));
  if (!Number.isFinite(timestamp)) return "Not reported";
  return new Date(timestamp).toISOString().replace(".000Z", "Z");
}

export function activePostingStep({ issueVerified, deliverableChosen, contentReady, rewardReady }) {
  if (!issueVerified) return 1;
  if (!deliverableChosen || !contentReady) return 2;
  if (!rewardReady) return 3;
  return 4;
}

export function receiptMatchesMobileQuery(row, query) {
  const normalized = String(query ?? "").trim().toLowerCase();
  if (!normalized) return true;
  return [row?.id, row?.kind, row?.subject, row?.subjectSub, row?.policy, row?.signedAt]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(normalized));
}
