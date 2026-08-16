import { FEED_STATE_LABEL } from "./feed-presence.js";

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
 * Tags of Active policies whose current rule mandates co-signing of the
 * receipts it governs. Three machine shapes count as a mandate:
 *   - `kind: "receipt.co_sign"` WITHOUT the `on_missing_identity: "omit"`
 *     escape — the omit form is best-effort attribution ("record identities
 *     when observable"), not a requirement, and is how the live built-in
 *     receipt/operator-verifier-cosign@v1 is written;
 *   - a non-empty `receipt.co_sign` handler list on another rule kind
 *     (e.g. claim/deps-sec-only@v4 co-signs its run receipts);
 *   - `require["co_sign.min"] >= 1` (proposal-shaped settle/co-sign gates).
 * Rules that fail to parse are ignored — an unreadable rule cannot be
 * read as a mandate.
 *
 * @param {unknown} policies — the /policies feed payload
 * @returns {Set<string>}
 */
export function coSignMandateTags(policies) {
  const tags = new Set();
  if (!Array.isArray(policies)) return tags;
  for (const policy of policies) {
    if (!policy || typeof policy !== "object") continue;
    const record = /** @type {Record<string, unknown>} */ (policy);
    if (String(record.state ?? "").toLowerCase() !== "active") continue;
    if (typeof record.tag !== "string" || !record.tag) continue;
    if (ruleMandatesCoSign(currentRule(record))) tags.add(record.tag);
  }
  return tags;
}

/**
 * @param {Record<string, unknown>} policy
 * @returns {Record<string, unknown> | null}
 */
function currentRule(policy) {
  const rules =
    policy.rule && typeof policy.rule === "object" && !Array.isArray(policy.rule)
      ? /** @type {Record<string, unknown>} */ (policy.rule)
      : {};
  const revision = Number(policy.revision);
  const revisionKey = `v${revision}`;
  const key =
    Number.isFinite(revision) && rules[revisionKey] != null
      ? revisionKey
      : latestRevisionKey(rules);
  if (!key) return null;
  try {
    const parsed = JSON.parse(String(rules[key]));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * @param {Record<string, unknown>} rules
 * @returns {string | null}
 */
function latestRevisionKey(rules) {
  const revisions = Object.keys(rules)
    .map((key) => {
      const match = /^v(\d+)$/u.exec(key);
      return match ? Number(match[1]) : null;
    })
    .filter((value) => value !== null)
    .sort((left, right) => right - left);
  return revisions.length > 0 ? `v${revisions[0]}` : null;
}

/**
 * @param {Record<string, unknown> | null} rule
 * @returns {boolean}
 */
function ruleMandatesCoSign(rule) {
  if (!rule) return false;
  if (rule.kind === "receipt.co_sign") return rule.on_missing_identity !== "omit";
  const receipt =
    rule.receipt && typeof rule.receipt === "object" && !Array.isArray(rule.receipt)
      ? /** @type {Record<string, unknown>} */ (rule.receipt)
      : null;
  if (receipt && Array.isArray(receipt.co_sign) && receipt.co_sign.length > 0) return true;
  const require =
    rule.require && typeof rule.require === "object" && !Array.isArray(rule.require)
      ? /** @type {Record<string, unknown>} */ (rule.require)
      : null;
  const min = require ? require["co_sign.min"] : null;
  return typeof min === "number" && min >= 1;
}

/**
 * Every policy ref a receipt row carries: the row-level `policy` string
 * plus run-receipt `policyTags` (surfaced on the row or on the raw
 * backend list row preserved as `listRow`). Badge rows carry only the
 * synthesized `category/tier-N` ref, which never matches a policy tag.
 *
 * @param {Record<string, unknown>} row
 * @returns {string[]}
 */
function rowPolicyRefs(row) {
  const refs = [];
  if (typeof row.policy === "string" && row.policy) refs.push(row.policy);
  const listRow =
    row.listRow && typeof row.listRow === "object" && !Array.isArray(row.listRow)
      ? /** @type {Record<string, unknown>} */ (row.listRow)
      : null;
  for (const source of [row.policyTags, listRow?.policyTags]) {
    if (!Array.isArray(source)) continue;
    for (const tag of source) {
      if (typeof tag === "string" && tag) refs.push(tag);
    }
  }
  return refs;
}

/**
 * Co-sign KPI verdict for the receipts in view. `status` is the machine
 * field — consumers branch on it, never on the meta prose:
 *   - "unknown"      · the rate cannot be measured (no rows, policy feed
 *                      unavailable, or signer identities not emitted)
 *   - "not-required" · no active policy requires co-signing of any
 *                      receipt in this view — neutral, not an alarm
 *   - "within"/"below" · measured against COSIGN_TARGET_PCT over the
 *                      policy-required receipts only
 *
 * @param {Array<{
 *   signers?: Array<{ identified?: boolean }>;
 *   policy?: string;
 *   policyTags?: unknown;
 *   listRow?: unknown;
 * }> | null | undefined} rows
 * @param {unknown} policies — the /policies feed payload; pass the raw SWR
 *   data (undefined while loading/locked/down — the state that cannot
 *   claim "not required")
 * @param {"live" | "loading" | "locked" | "down"} [policiesPresence] — the
 *   feedPresence of the /policies request, so a normal first load renders
 *   as loading rather than claiming the feed is degraded
 * @returns {{
 *   value: string;
 *   unit: "" | "%";
 *   meta: string;
 *   metaTone: "muted" | "ok" | "warn";
 *   status: "unknown" | "not-required" | "within" | "below";
 * }}
 */
export function coSignKpiState(rows, policies, policiesPresence) {
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

  if (!Array.isArray(policies)) {
    // "live" with a non-array payload is still unreadable — label it down.
    const label =
      policiesPresence && policiesPresence !== "live"
        ? FEED_STATE_LABEL[policiesPresence] ?? FEED_STATE_LABEL.down
        : FEED_STATE_LABEL.down;
    return {
      value: "—",
      unit: "",
      meta: `policy feed ${label} · co-sign requirement unknown`,
      metaTone: "muted",
      status: "unknown",
    };
  }

  const mandateTags = coSignMandateTags(policies);
  const requiredRows = list.filter((row) =>
    rowPolicyRefs(/** @type {Record<string, unknown>} */ (row)).some((ref) => mandateTags.has(ref))
  );
  if (requiredRows.length === 0) {
    return {
      value: "—",
      unit: "",
      meta: "co-signing not required by any active policy",
      metaTone: "muted",
      status: "not-required",
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

  const coSigned = requiredRows.filter((row) => identifiedSignerCount(row) > 1).length;
  const pct = Math.round((coSigned / requiredRows.length) * 1000) / 10;
  return {
    value: pct.toFixed(1),
    unit: "%",
    meta: `${coSigned} of ${requiredRows.length} policy-required receipts · identified signer chain`,
    metaTone: pct >= COSIGN_TARGET_PCT ? "ok" : "warn",
    status: pct >= COSIGN_TARGET_PCT ? "within" : "below",
  };
}
