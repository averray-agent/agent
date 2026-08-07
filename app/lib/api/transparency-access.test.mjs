/**
 * Page-state tests for /transparency.
 *
 * The operator app has no DOM test harness, so a "render test" here is
 * the repo's established shape (see transparency-view-model.test.mjs):
 * drive the pure decision + copy layer the component renders verbatim,
 * then assert structurally on the component source for the parts that
 * only exist as JSX.
 *
 * Four scenarios, one per page state:
 *   1. authorized, data in hand
 *   2. authorized, one field unknown  → field-level `no read` survives
 *   3. 401 with requiredCapabilities  → authorization state, no `no read`
 *   4. genuine network failure        → still `no read`, still no fallback value
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  TRANSPARENCY_GATED_SECTIONS,
  authorizationRequirement,
  signedInRoleLabel,
  transparencyAccessState,
  transparencyAuthorizationNotice,
} from "./transparency-access.js";
import {
  presentTransparencyField,
  worstTransparencyFreshness,
} from "./transparency-view-model.js";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..", "..");
const panelSource = readFileSync(
  resolve(appRoot, "components", "transparency", "TransparencyPanel.tsx"),
  "utf8"
);
const pageSource = readFileSync(
  resolve(appRoot, "app", "(authed)", "transparency", "page.tsx"),
  "utf8"
);
const pillSource = readFileSync(
  resolve(appRoot, "components", "shell", "DataFreshnessPill.tsx"),
  "utf8"
);

/** The JSX that only the authorization state renders. */
const authorizationJsx = between(
  panelSource,
  "export function TransparencyAuthorizationState",
  "export function TransparencyRequestState"
);
/** The JSX that only the loading / genuine-failure state renders. */
const requestStateJsx = between(
  panelSource,
  "export function TransparencyRequestState",
  "function TransparencyTopbar"
);

const WORKER_WALLET = "0x089a4e0F3b1c2D5a6E7f8A9b0C1d2E3f4A5b8CeE";

/** The worker session in the defect report: signed in, no resolved role. */
const WORKER_SESSION = {
  authenticated: true,
  wallet: WORKER_WALLET,
  roles: [],
};

/** Exactly what mcp-server's HTTP layer serializes for a refused read. */
function refusal(status, code, details) {
  return {
    status,
    body: {
      error: code,
      message: status === 401 ? "Authentication required." : "Missing required capability.",
      details,
      requestId: "req_test",
    },
  };
}

const OPS_VIEW_401 = refusal(401, "missing_token", {
  requiresAuth: true,
  requiredAction: "wallet_sign_in",
  requiredCapabilities: ["ops:view"],
  authScheme: "SIWE_JWT",
});

const OPS_VIEW_403 = refusal(403, "missing_capability", {
  requiresAuth: true,
  requiredAction: "wallet_sign_in",
  requiredCapabilities: ["ops:view"],
  missingCapabilities: ["ops:view"],
});

function field(status, value, unit = "USDC") {
  return {
    value,
    unit,
    status,
    readAtMs: 1_786_000_000_000,
    source: "test source",
    proof: "https://rpc.example.test/",
  };
}

// ---------------------------------------------------------------------------
// 1. authorized, with data
// ---------------------------------------------------------------------------

test("authorized with data renders the panel, not any request state", () => {
  const payload = { treasury: { totalUsdcEquivalent: field("fresh", "878.804000") } };
  const access = transparencyAccessState({
    request: { data: payload, isLoading: false },
    auth: WORKER_SESSION,
  });

  assert.equal(access.kind, "ready");
  assert.equal(
    presentTransparencyField(payload.treasury.totalUsdcEquivalent).display,
    "878.804000"
  );
});

// ---------------------------------------------------------------------------
// 2. authorized, but one field is unknown — field-level `no read` is untouched
// ---------------------------------------------------------------------------

test("authorized with an unknown field still renders the panel and still says no read", () => {
  const payload = {
    treasury: {
      totalUsdcEquivalent: field("fresh", "878.804000"),
      // Field-level unknown from the payload — a real per-field read miss.
      operatingFloat: field("unknown", null),
    },
  };
  const access = transparencyAccessState({
    request: { data: payload, isLoading: false },
    auth: WORKER_SESSION,
  });

  assert.equal(access.kind, "ready");

  const unknown = presentTransparencyField(payload.treasury.operatingFloat);
  assert.equal(unknown.display, "no read");
  assert.equal(unknown.freshness, "fallback");
  assert.equal(unknown.missing, true);
  // Never a substituted value.
  assert.equal(unknown.lastKnown, false);
  assert.notEqual(unknown.display, "0");
});

// ---------------------------------------------------------------------------
// 3. 401/403 with requiredCapabilities — authorization state
// ---------------------------------------------------------------------------

test("401 carrying requiredCapabilities is an authorization state, not a failed read", () => {
  const access = transparencyAccessState({
    request: { error: OPS_VIEW_401 },
    auth: WORKER_SESSION,
  });

  assert.equal(access.kind, "unauthorized");
  assert.equal(access.status, 401);
  assert.equal(access.code, "missing_token");
  assert.deepEqual(access.capabilities, ["ops:view"]);
  assert.equal(access.requiredAction, "wallet_sign_in");
  assert.equal(access.role, "worker");
  assert.equal(access.wallet, WORKER_WALLET);
  assert.equal(access.signedIn, true);
});

test("403 missing_capability lands in the same authorization state", () => {
  const access = transparencyAccessState({
    request: { error: OPS_VIEW_403 },
    auth: WORKER_SESSION,
  });

  assert.equal(access.kind, "unauthorized");
  assert.equal(access.status, 403);
  assert.deepEqual(access.capabilities, ["ops:view"]);
  assert.deepEqual(access.missingCapabilities, ["ops:view"]);
});

test("authorization copy names the capability and the signed-in role", () => {
  const access = transparencyAccessState({
    request: { error: OPS_VIEW_401 },
    auth: WORKER_SESSION,
  });
  const notice = transparencyAuthorizationNotice(access);

  assert.match(notice.capabilitySentence, /ops:view/u);
  assert.equal(notice.capabilitySentence, "This view requires the ops:view capability.");
  assert.equal(notice.identitySentence, "You are signed in as worker 0x089a…8CeE.");
  assert.match(notice.nextStep, /Sign in with an operator account that holds ops:view\./u);
});

test("authorization copy never claims the read is unavailable or failed", () => {
  const access = transparencyAccessState({
    request: { error: OPS_VIEW_401 },
    auth: WORKER_SESSION,
  });
  const notice = transparencyAuthorizationNotice(access);
  const prose = [
    notice.headline,
    notice.capabilitySentence,
    notice.identitySentence,
    notice.boundarySentence,
    notice.nextStep,
  ].join(" ");

  assert.doesNotMatch(prose, /no read/iu);
  assert.doesNotMatch(prose, /unavailable/iu);
  assert.doesNotMatch(prose, /\bfailed to read\b/iu);
  // It must still carry the no-substitution promise the fallback state makes.
  assert.match(prose, /No last-known or placeholder values are being substituted\./u);
  // …and it must say the API answered, which is the whole correction.
  assert.match(prose, /The API answered/u);
});

test("gated sections are named as gated, never rendered as attempted reads", () => {
  const notice = transparencyAuthorizationNotice(
    transparencyAccessState({ request: { error: OPS_VIEW_401 }, auth: WORKER_SESSION })
  );

  assert.deepEqual(
    notice.gatedSections.map((section) => section.title),
    ["Flow · settled work", "Escrow backing", "Treasury", "Read policy"]
  );
  for (const section of notice.gatedSections) {
    assert.doesNotMatch(section.title, /no read/iu);
    assert.doesNotMatch(section.meta, /no read/iu);
  }
  assert.equal(notice.gatedSections, TRANSPARENCY_GATED_SECTIONS);
});

test("the authorization state renders no `no read` tile; the failure state still does", () => {
  assert.ok(authorizationJsx.length > 0, "authorization state component not found");
  assert.ok(requestStateJsx.length > 0, "request state component not found");

  assert.doesNotMatch(authorizationJsx, /no read/u);
  assert.doesNotMatch(authorizationJsx, /waiting for read/u);
  assert.doesNotMatch(authorizationJsx, /unavailable/iu);
  // The genuine-failure path is untouched.
  assert.match(requestStateJsx, /"no read"/u);
  assert.match(requestStateJsx, /No last-known or placeholder values are being substituted/u);
});

test("the topbar badge distinguishes not-authorized from unavailable", () => {
  assert.match(authorizationJsx, /<TransparencyTopbar freshness="locked" \/>/u);
  assert.match(pillSource, /locked: "Not authorized"/u);
  assert.match(pillSource, /fallback: "Unavailable"/u);
  assert.match(
    pillSource,
    /export type FreshnessState =[^;]*"locked"/u,
    "locked must be part of the shared freshness vocabulary, not a page-local one"
  );
  // The gated section rows reuse the same shared pill, not a new tone.
  assert.match(authorizationJsx, /<DataFreshnessPill state="locked" \/>/u);
});

test("the page routes an authorization refusal before the failure state", () => {
  assert.match(pageSource, /transparencyAccessState\(\{ request: transparency, auth \}\)/u);
  const unauthorizedAt = pageSource.indexOf('access.kind === "unauthorized"');
  const unavailableAt = pageSource.indexOf('access.kind === "unavailable"');
  assert.ok(unauthorizedAt > 0, "page does not branch on the authorization state");
  assert.ok(unavailableAt > 0, "page dropped the genuine-failure branch");
  assert.ok(
    unauthorizedAt < unavailableAt,
    "a refusal must be classified before the failure state can claim it"
  );
  assert.match(pageSource, /<TransparencyRequestState state="fallback" \/>/u);
});

// ---------------------------------------------------------------------------
// 4. genuine read failure — unchanged
// ---------------------------------------------------------------------------

test("a plain fetch error is a failed read, never the authorization state", () => {
  const access = transparencyAccessState({
    request: { error: new TypeError("Failed to fetch") },
    auth: WORKER_SESSION,
  });

  assert.equal(access.kind, "unavailable");
  assert.equal(authorizationRequirement(new TypeError("Failed to fetch")), null);
});

test("the authorization state is unreachable without an HTTP 401/403", () => {
  const notAuthorizationErrors = [
    new TypeError("Failed to fetch"),
    new Error("boom"),
    { status: 500, body: { error: "internal_error" } },
    { status: 502, body: { error: "upstream_failure" } },
    { status: 404, body: { error: "not_found" } },
    // The decisive one: a body that LOOKS like a requirement envelope but
    // arrives on a non-auth status must not unlock the authorization state.
    { status: 503, body: { details: { requiredCapabilities: ["ops:view"] } } },
    { body: { details: { requiredCapabilities: ["ops:view"] } } },
    { status: "401", body: { details: { requiredCapabilities: ["ops:view"] } } },
  ];

  for (const error of notAuthorizationErrors) {
    assert.equal(authorizationRequirement(error), null, `leaked: ${JSON.stringify(error)}`);
    assert.equal(
      transparencyAccessState({ request: { error }, auth: WORKER_SESSION }).kind,
      "unavailable",
      `leaked: ${JSON.stringify(error)}`
    );
  }
});

test("loading is still loading, and an empty request is not a refusal", () => {
  assert.equal(
    transparencyAccessState({ request: { isLoading: true }, auth: WORKER_SESSION }).kind,
    "loading"
  );
  assert.equal(transparencyAccessState({}).kind, "loading");
  assert.equal(transparencyAccessState().kind, "loading");
});

// ---------------------------------------------------------------------------
// Degraded inputs — the state must not fabricate what it was not told
// ---------------------------------------------------------------------------

test("a refusal with no requirement envelope stays a refusal and names no capability", () => {
  const access = transparencyAccessState({
    request: { error: { status: 403, body: "Forbidden" } },
    auth: WORKER_SESSION,
  });

  assert.equal(access.kind, "unauthorized");
  assert.deepEqual(access.capabilities, []);

  const notice = transparencyAuthorizationNotice(access);
  assert.doesNotMatch(notice.capabilitySentence, /ops:view/u);
  assert.equal(
    notice.capabilitySentence,
    "This view requires an operator capability this session does not hold."
  );
  assert.equal(notice.nextStep, "Sign in with an operator account.");
  assert.doesNotMatch(notice.identitySentence + notice.nextStep, /unavailable/iu);
});

test("a flattened requirement body still names the capability", () => {
  const access = transparencyAccessState({
    request: {
      error: {
        status: 401,
        body: { error: "missing_token", requiredAction: "wallet_sign_in", requiredCapabilities: ["ops:view"] },
      },
    },
    auth: WORKER_SESSION,
  });

  assert.equal(access.kind, "unauthorized");
  assert.deepEqual(access.capabilities, ["ops:view"]);
  assert.equal(access.requiredAction, "wallet_sign_in");
});

test("role label matches the operator rail: resolved roles, else worker", () => {
  assert.equal(signedInRoleLabel([]), "worker");
  assert.equal(signedInRoleLabel(undefined), "worker");
  assert.equal(signedInRoleLabel(["admin"]), "admin");
  assert.equal(signedInRoleLabel(["admin", "verifier"]), "admin · verifier");

  const adminAccess = transparencyAccessState({
    request: { error: OPS_VIEW_403 },
    auth: { authenticated: true, wallet: WORKER_WALLET, roles: ["verifier"] },
  });
  assert.match(
    transparencyAuthorizationNotice(adminAccess).identitySentence,
    /signed in as verifier 0x089a…8CeE\./u
  );
});

test("an unreadable session is reported as such, never as a named identity", () => {
  const access = transparencyAccessState({
    request: { error: OPS_VIEW_401 },
    auth: { authenticated: false, roles: [] },
  });

  assert.equal(access.kind, "unauthorized");
  assert.equal(access.signedIn, false);
  assert.equal(
    transparencyAuthorizationNotice(access).identitySentence,
    "No signed-in wallet was found for this session."
  );
});

test("an unranked freshness state degrades the page, it never reads as fresh", () => {
  // Widening the shared FreshnessState vocabulary must not let a state the
  // rank table has not seen masquerade as the freshest one.
  assert.equal(
    worstTransparencyFreshness([{ status: "fresh" }, { status: "not-a-status-yet" }]),
    "fallback"
  );
  assert.equal(worstTransparencyFreshness([{ status: "fresh" }]), "live");
});

function between(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) return "";
  return source.slice(start, end);
}
