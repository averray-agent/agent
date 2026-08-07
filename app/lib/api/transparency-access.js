/**
 * Authorization as its own page state for /transparency.
 *
 * `GET /transparency` is gated on the `ops:view` capability. A signed-in
 * wallet without it (a worker account, say) gets 401/403 carrying the
 * backend's requirement envelope — `requiredCapabilities`,
 * `requiredAction`, `requiredRole`. The first cut of this page discarded
 * that and collapsed the refusal into the generic unknown state, so the
 * reader saw `no read` tiles and an `UNAVAILABLE` badge. Both are false:
 * nothing is unavailable, the API answered — it refused this session.
 * "Unavailable" reads as a system fault and sends the reader looking for
 * an outage that isn't happening. Same conflation the monitor was fixed
 * for in averray-reference-agent#778: reporting "I did not get an answer"
 * as "the thing is broken".
 *
 * Four page states, mapped straight onto the app's existing feed-presence
 * vocabulary (lib/api/feed-presence.js) rather than a second one:
 *
 *   feedPresence   page state       what it means
 *   ------------   --------------   ------------------------------------
 *   "loading"      "loading"        first read still in flight
 *   "live"         "ready"          payload in hand — render it
 *   "locked"       "unauthorized"   API answered 401/403; not our data
 *   "down"         "unavailable"    the read genuinely failed
 *
 * `unauthorized` is reachable ONLY from an error carrying HTTP 401/403 —
 * the same test `feedPresence` already applies app-wide. A plain fetch
 * error (network down, no `status`) is "down" → "unavailable", which
 * keeps the pre-existing path exactly as it was: a genuine failure still
 * says `no read`, and never substitutes a last-known value.
 *
 * A 401/403 that arrives WITHOUT a requirement envelope (a bare proxy
 * 403, a revoked token) still lands in `unauthorized` — a refusal is a
 * refusal — but the copy degrades instead of naming a capability we were
 * not told about.
 */

import { feedPresence } from "./feed-presence.js";

/**
 * The page's own sections, named so the authorization state can say what
 * is gated without rendering `no read` tiles for them. `no read` means
 * "we tried to read this and could not"; when the API refuses at the auth
 * boundary no read is attempted at all, so those tiles would be a lie.
 */
export const TRANSPARENCY_GATED_SECTIONS = Object.freeze([
  Object.freeze({ title: "Flow · settled work", meta: "Jobs and paid USDC" }),
  Object.freeze({ title: "Escrow backing", meta: "Poster obligations and contract balance" }),
  Object.freeze({ title: "Treasury", meta: "Asset Hub and Hydration positions" }),
  Object.freeze({ title: "Read policy", meta: "Cache TTL and freshness windows" }),
]);

/**
 * Pull the backend's auth-requirement envelope off an ApiError.
 *
 * The HTTP layer serializes AppError as
 * `{ error, message, details, requestId }`, so the requirement fields sit
 * under `details`. Top-level copies are accepted too so a flattened or
 * proxied body still names the capability.
 *
 * Returns `null` for anything that is not an HTTP 401/403 — that is the
 * single gate that keeps a plain fetch error out of the authorization
 * state.
 *
 * @param {unknown} error
 * @returns {null | {
 *   status: number, code: string, capabilities: string[],
 *   missingCapabilities: string[], requiredAction: string, requiredRole: string
 * }}
 */
export function authorizationRequirement(error) {
  const status = authStatus(error);
  if (status === null) return null;
  const body = record(/** @type {{ body?: unknown }} */ (error)?.body);
  const details = record(body?.details);
  return {
    status,
    code: text(body?.error) || text(body?.code),
    capabilities: stringArray(details?.requiredCapabilities ?? body?.requiredCapabilities),
    missingCapabilities: stringArray(details?.missingCapabilities ?? body?.missingCapabilities),
    requiredAction: text(details?.requiredAction ?? body?.requiredAction),
    requiredRole: text(details?.requiredRole ?? body?.requiredRole),
  };
}

/**
 * Classify one `/transparency` SWR request into the page state to render.
 *
 * @param {{
 *   request?: { data?: unknown, error?: unknown, isLoading?: boolean } | null,
 *   auth?: { authenticated?: boolean, wallet?: string, roles?: string[] } | null
 * }} [input]
 */
export function transparencyAccessState(input = {}) {
  const request = input?.request ?? null;
  const presence = feedPresence(request);

  if (presence === "locked") {
    const requirement = authorizationRequirement(request?.error) ?? {
      status: 0,
      code: "",
      capabilities: [],
      missingCapabilities: [],
      requiredAction: "",
      requiredRole: "",
    };
    const auth = input?.auth ?? null;
    const wallet = text(auth?.wallet);
    return {
      kind: "unauthorized",
      ...requirement,
      signedIn: Boolean(auth?.authenticated) && wallet.length > 0,
      wallet,
      role: signedInRoleLabel(auth?.roles),
    };
  }
  if (presence === "loading") return { kind: "loading" };
  if (presence === "down") return { kind: "unavailable" };
  return { kind: "ready" };
}

/**
 * Build the authorization state's copy. Kept out of the component so the
 * exact sentences are assertable — the point of this state is what it
 * says, not how it is boxed.
 *
 * @param {{
 *   capabilities?: string[], role?: string, wallet?: string,
 *   signedIn?: boolean, requiredRole?: string
 * }} [state]
 */
export function transparencyAuthorizationNotice(state = {}) {
  const capabilities = stringArray(state?.capabilities);
  const named = capabilities.join(", ");
  const noun = capabilities.length > 1 ? "capabilities" : "capability";
  const role = text(state?.role) || DEFAULT_ROLE_LABEL;
  const wallet = text(state?.wallet);
  const requiredRole = text(state?.requiredRole);
  const signedIn = Boolean(state?.signedIn) && wallet.length > 0;

  return {
    headline: "This session is not authorized to read the transparency page.",
    capabilitySentence: capabilities.length
      ? `This view requires the ${named} ${noun}.`
      : "This view requires an operator capability this session does not hold.",
    identitySentence: signedIn
      ? `You are signed in as ${role} ${shortWallet(wallet)}.`
      : "No signed-in wallet was found for this session.",
    // Says only what a 401/403 actually proves — the API answered, and it
    // answered with a refusal. It does NOT claim the read model is
    // healthy; we were never told either way.
    boundarySentence:
      "The API answered — it refused this session rather than failing a read, so nothing below was read. No last-known or placeholder values are being substituted.",
    nextStep: capabilities.length
      ? `Sign in with an operator account that holds ${named}.`
      : requiredRole
        ? `Sign in with a wallet that holds the ${requiredRole} role.`
        : "Sign in with an operator account.",
    gatedSections: TRANSPARENCY_GATED_SECTIONS,
  };
}

/**
 * How the app names a signed-in identity's role: the resolved roles, or
 * `worker` when the backend resolved none. Mirrors the operator rail's
 * footer (components/shell/OperatorRail.tsx) so the page and the rail
 * never disagree about who you are signed in as.
 *
 * @param {unknown} roles
 * @returns {string}
 */
export function signedInRoleLabel(roles) {
  const resolved = stringArray(roles);
  return resolved.length ? resolved.join(" · ") : DEFAULT_ROLE_LABEL;
}

const DEFAULT_ROLE_LABEL = "worker";

/** Same 6+4 shape as `shortAddress(value, 4)` in lib/format. */
function shortWallet(value) {
  const v = String(value ?? "").trim();
  return v.length > 10 ? `${v.slice(0, 6)}…${v.slice(-4)}` : v;
}

function authStatus(error) {
  if (!error || typeof error !== "object") return null;
  const status = /** @type {{ status?: unknown }} */ (error).status;
  return status === 401 || status === 403 ? status : null;
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : null;
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function stringArray(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value) {
    const trimmed = text(entry);
    if (trimmed) out.push(trimmed);
  }
  return out;
}
