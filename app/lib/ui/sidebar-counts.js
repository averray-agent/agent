/**
 * Sidebar "attention" count helpers (roadmap A5).
 *
 * Convention: the left rail shows a count ONLY where the number is an
 * action signal an operator should triage on — open work, in-flight
 * sessions, open disputes. Roster/total counts (receipts, agents,
 * policies, capabilities) and ever-growing logs (audit) carry no badge,
 * because a raw total there is noise, not a decision input.
 *
 * TRUTH-BOUNDARY: every helper returns `undefined` while the data is
 * absent or in an unrecognized shape (i.e. still loading / errored), and
 * a real number (including `0`) only once a list is actually present. So
 * a loading rail never renders a confident `0`, and "0 open disputes"
 * (queue clear) is visually distinct from "disputes didn't load" (no
 * badge). `0` is a meaningful, reassuring signal for an attention item.
 */

/**
 * Pull an array out of a SWR payload that may be a bare array or an
 * envelope object keyed by one of `keys`. Returns `null` when no array
 * is found (treated by callers as "not loaded / not countable").
 * @param {unknown} data
 * @param {string[]} keys
 * @returns {Array<unknown> | null}
 */
function listFrom(data, keys) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    const record = /** @type {Record<string, unknown>} */ (data);
    for (const key of keys) {
      if (Array.isArray(record[key])) return /** @type {Array<unknown>} */ (record[key]);
    }
  }
  return null;
}

/**
 * Open/claimable jobs — the `/jobs` feed is already the live queue
 * (paused/archived rows are filtered server-side), so its length is the
 * count of work available to act on.
 * @param {unknown} jobsData
 * @returns {number | undefined}
 */
export function openJobsCount(jobsData) {
  const list = listFrom(jobsData, ["jobs", "items", "data"]);
  return list ? list.length : undefined;
}

/**
 * Mirror of `session-adapters.ts` `state()` raw→SessionState mapping.
 * Kept in sync so the rail count matches the labels the Sessions page
 * shows. Unknown statuses fall through to `active`, same as the page.
 * @param {unknown} raw
 * @returns {"submitted"|"approved"|"rejected"|"disputed"|"slashed"|"settled"|"active"}
 */
function sessionState(raw) {
  switch (String(raw ?? "").toLowerCase()) {
    case "submitted":
      return "submitted";
    case "resolved":
    case "approved":
      return "approved";
    case "rejected":
    case "expired":
    case "timed_out":
      return "rejected";
    case "disputed":
      return "disputed";
    case "slashed":
      return "slashed";
    case "closed":
    case "settled":
      return "settled";
    default:
      return "active";
  }
}

/** Session states that still need operator attention (not terminal). */
const SESSION_IN_FLIGHT = new Set(["active", "submitted", "disputed"]);

/**
 * In-flight sessions — work that is still moving or needs action
 * (active/claimed, awaiting verification, or disputed). Terminal
 * sessions (settled, approved, rejected, slashed) are not counted.
 * @param {unknown} sessionsData
 * @returns {number | undefined}
 */
export function activeSessionsCount(sessionsData) {
  const list = listFrom(sessionsData, ["sessions", "items", "history", "data"]);
  if (!list) return undefined;
  return list.filter((entry) => {
    const status =
      entry && typeof entry === "object"
        ? /** @type {Record<string, unknown>} */ (entry).status ??
          /** @type {Record<string, unknown>} */ (entry).state ??
          /** @type {Record<string, unknown>} */ (entry).lifecycle
        : undefined;
    return SESSION_IN_FLIGHT.has(sessionState(status));
  }).length;
}

/**
 * A dispute is resolved (no longer needs attention) when it carries a
 * verdict, or its status/state is `resolved`/`closed`. Mirrors
 * `dispute-adapters.ts` `stateFor()`.
 * @param {unknown} entry
 * @returns {boolean}
 */
function isDisputeResolved(entry) {
  if (!entry || typeof entry !== "object") return false;
  const record = /** @type {Record<string, unknown>} */ (entry);
  const verdict = record.verdict;
  if (verdict != null && String(verdict).trim() !== "") return true;
  const normalized = String(record.status ?? record.state ?? "open")
    .toLowerCase()
    .replace(/_/gu, "-");
  return normalized === "resolved" || normalized === "closed";
}

/**
 * Open disputes — the operator's action queue. Matches the Disputes
 * page "Open disputes" metric (`state !== "resolved"`).
 * @param {unknown} disputesData
 * @returns {number | undefined}
 */
export function openDisputesCount(disputesData) {
  const list = listFrom(disputesData, ["disputes", "items", "data"]);
  if (!list) return undefined;
  return list.filter((entry) => !isDisputeResolved(entry)).length;
}
