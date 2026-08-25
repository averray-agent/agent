import { ROUTE_CAPABILITY_RULES, resolveCapabilities } from "../auth/capabilities.js";
import { MCP_TOOLS } from "../protocols/mcp/tools.js";

export const AGENT_SURFACE_COMPLETE_STATEMENT =
  "The agent surface is complete for accounts. Everything above is reachable without a browser, an injected wallet, or the app.";

export const APP_SESSION_ADOPTION_STATEMENT =
  "The app cannot adopt an API session, and that is deliberate. A session obtained by API stays with the caller who signed for it; we will never ask anyone to paste a bearer token into a page. An agent that wants a browser view should sign in there separately with the same wallet.";

// Human actions need a small semantic map; tool and route existence must not
// be inferred from prose. The builder resolves every target against the live
// registries and omits the whole row if any named target no longer exists.
// Conversely, a new registry entry has no guessed human meaning and therefore
// cannot silently create a wrong parity row.
export const ACCOUNT_ACTION_PARITY_MAPPINGS = Object.freeze([
  mapping("see available balance", {
    mcpTools: ["getAccountPosition"],
    httpRoutes: [route("GET", "/account")]
  }),
  mapping("add funds", {
    mcpTools: ["buildAccountDepositTransactions"]
  }),
  mapping("withdraw", {
    mcpTools: ["buildWithdrawTransactions"]
  }),
  mapping("browse and claim work", {
    mcpTools: ["listJobs", "getJobDefinition", "preflightJob", "claimJob"]
  }),
  mapping("judge a job before claiming", {
    mcpTools: ["estimateNetReward", "explainEligibility"]
  }),
  mapping("submit work", {
    mcpTools: ["submitWork", "validateJobSubmission"]
  }),
  mapping("lock a deposit", {
    mcpTools: ["quoteLockedDeposit", "createLockedDeposit"]
  }),
  mapping("exit a lock", {
    mcpTools: ["requestLockedDepositExit"]
  }),
  mapping("use the deposit pool", {
    mcpTools: ["getDepositPoolInfo", "buildDepositPoolTransactions"]
  }),
  // Names the surface, not the outcome: perAccountBorrowCap reads 0 on
  // mainnet today, so "borrow against standing" would advertise an action
  // that currently cannot succeed. The tools are reachable either way.
  mapping("read and use the credit line", {
    mcpTools: ["getCreditInfo", "buildCreditTransactions"]
  }),
  mapping("post a job", {
    mcpTools: ["getPosterOnboarding", "draftJob", "buildPostJobTransactions"]
  }),
  mapping("read standing / tier / receipts", {
    httpRoutes: [
      route("GET", "/me"),
      route("GET", "/reputation"),
      route("GET", "/receipts")
    ]
  })
]);

// The builder above fails safe but not loud. A mapping whose target vanished
// drops its whole row, so the document can never advertise a name that does not
// resolve; a registry entry that nothing maps simply produces no row, and
// AGENT_SURFACE_COMPLETE_STATEMENT keeps claiming a surface the table has
// quietly stopped enumerating.
//
// This closes that direction. Every MCP tool and every HTTP route must be
// either mapped into a row above or named here, so adding one fails the build
// until someone decides which it is. The reasons are not prose-only:
// `roleGated` is re-derived from resolveCapabilities() and `twinOf` from the
// mappings above, so a wrong reason fails as loudly as a missing entry.
export const UNMAPPED_BY_DESIGN = Object.freeze({
  mcpTools: Object.freeze([
    ...unmappedTools("the auth handshake that precedes every account action; the parity table starts from an already signed-in session", [
      "fetchAuthNonce",
      "verifySiwe",
      "refreshAuthToken"
    ]),
    ...unmappedTools("discovery metadata: describes the surface rather than acting on an account", [
      "getPlatformCapabilities"
    ]),
    ...unmappedTools("job-authoring catalogue consumed while drafting a job, not an account action", [
      "listVerificationProfiles"
    ])
  ]),
  httpRoutes: Object.freeze([
    ...twinRoutes([
      ["GET", "/account/position", "getAccountPosition"],
      ["POST", "/account/deposit/transactions", "buildAccountDepositTransactions"],
      ["POST", "/account/withdraw/transactions", "buildWithdrawTransactions"],
      ["POST", "/locked-deposits/quote", "quoteLockedDeposit"],
      ["POST", "/locked-deposits/consent", "createLockedDeposit"],
      ["POST", "/locked-deposits/:id/exit", "requestLockedDepositExit"],
      ["GET", "/jobs/preflight", "preflightJob"],
      ["GET", "/jobs/:id/estimate", "estimateNetReward"],
      ["POST", "/jobs/claim", "claimJob"],
      ["POST", "/jobs/submit", "submitWork"],
      ["POST", "/pool/transactions", "buildDepositPoolTransactions"],
      ["GET", "/credit", "getCreditInfo"],
      ["POST", "/credit/transactions", "buildCreditTransactions"],
      ["POST", "/credit/consent", "buildCreditTransactions"]
    ]),
    ...unmappedRoutes("retired: answered 410 before auth, and the rule survives only so old clients receive the retirement notice", [
      ["GET", "/account/strategies"],
      ["POST", "/account/allocate"],
      ["POST", "/account/deallocate"]
    ]),
    ...unmappedRoutes("custodial-ledger mutation where the platform moves the balance; the advertised account lane is self-custody, where the agent signs and broadcasts its own transaction", [
      ["POST", "/account/fund"],
      ["POST", "/account/borrow"],
      ["POST", "/account/repay"]
    ]),
    ...unmappedRoutes("registers interest in a pilot cash line; it records a waitlist intent and moves no balance", [
      ["POST", "/credit/interest"]
    ]),
    ...unmappedRoutes("prospective consent gate with its own availability-aware onboarding product; it is not a current app action and must not solicit consent while the allocation route is unavailable", [
      ["GET", "/account/idle-allocation"],
      ["POST", "/account/idle-allocation/quote"],
      ["POST", "/account/idle-allocation/consent"],
      ["POST", "/account/idle-allocation/revoke"]
    ]),
    ...unmappedRoutes("read-only HTTP surface with no MCP twin of its own; reading it moves nothing", [
      ["GET", "/account/borrow-capacity"],
      ["GET", "/disputes"],
      ["GET", "/disputes/:id"],
      ["GET", "/jobs/recommendations"],
      ["GET", "/session"],
      ["GET", "/session/timeline"],
      ["GET", "/sessions"],
      ["GET", "/events"],
      ["GET", "/xcm/request"]
    ]),
    ...unmappedRoutes("sub-job delegation between agents, a separate lane from the account surface", [
      ["GET", "/jobs/sub"],
      ["POST", "/jobs/sub"]
    ]),
    ...unmappedRoutes("agent-to-agent payment rail, not an account-balance action", [
      ["POST", "/payments/send"]
    ]),
    ...roleGatedRoutes("operator and governance console", [
      ["GET", "/alerts"],
      ["GET", "/audit"],
      ["GET", "/policies"],
      ["POST", "/policies"],
      ["GET", "/transparency"]
    ]),
    ...roleGatedRoutes("dispute adjudication, exercised by the arbitrator", [
      ["POST", "/disputes/:id/verdict"],
      ["POST", "/disputes/:id/release"]
    ]),
    ...roleGatedRoutes("operator job control: inventory, ingestion, and recurring lifecycle", [
      ["GET", "/admin/jobs"],
      ["POST", "/admin/jobs"],
      ["POST", "/admin/jobs/ingest/:provider"],
      ["POST", "/admin/jobs/fire"],
      ["POST", "/admin/jobs/lifecycle"],
      ["POST", "/admin/jobs/pause"],
      ["POST", "/admin/jobs/resume"],
      ["GET", "/admin/jobs/timeline"]
    ]),
    ...roleGatedRoutes("operator observability", [
      ["GET", "/admin/sessions"],
      ["GET", "/admin/ops/overnight-ledger"],
      ["GET", "/admin/ops/topup-destinations"],
      ["GET", "/admin/arrivals/timeline"],
      ["POST", "/admin/arrivals/canary-marker"],
      ["GET", "/admin/worker-journeys"],
      ["GET", "/admin/status"],
      ["GET", "/admin/treasury/summary"],
      ["GET", "/admin/github/status"],
      ["GET", "/admin/platform-fault-remediations"],
      ["GET", "/admin/usdc-liquidity/status"],
      ["GET", "/admin/xcm/finalize-exhausted"]
    ]),
    ...roleGatedRoutes("operator side of the credit lane: origination and L3 posting review", [
      ["POST", "/admin/credit/originate"],
      ["GET", "/admin/l3-posting/requests"],
      ["POST", "/admin/l3-posting/requests"],
      ["GET", "/admin/l3-posting/refusals"],
      ["POST", "/admin/l3-posting/requests/:id/advance"],
      ["POST", "/admin/l3-posting/requests/:id/reconcile"],
      ["POST", "/admin/l3-posting/sweep"]
    ]),
    ...roleGatedRoutes("treasury movement performed by the operator", [
      ["POST", "/admin/agent-transfers"],
      ["POST", "/admin/bootstrap-self-report/send"]
    ]),
    ...roleGatedRoutes("capability and service-token administration", [
      ["GET", "/admin/capability-grants"],
      ["POST", "/admin/capability-grants"],
      ["POST", "/admin/capability-grants/:id/revoke"],
      ["GET", "/admin/service-tokens"],
      ["POST", "/admin/service-tokens"],
      ["POST", "/admin/service-tokens/:id/rotate"],
      ["POST", "/admin/service-tokens/:id/revoke"]
    ]),
    ...roleGatedRoutes("XCM settlement operations", [
      ["POST", "/admin/xcm/observe"],
      ["POST", "/admin/xcm/finalize"]
    ]),
    ...roleGatedRoutes("verifier execution, reached with a verifier role rather than a wallet session", [
      ["POST", "/verifier/replay"],
      ["POST", "/verifier/run"]
    ])
  ])
});

export function buildAgentSurfaceParity({
  mcpTools = MCP_TOOLS,
  httpRoutes = ROUTE_CAPABILITY_RULES,
  mappings = ACCOUNT_ACTION_PARITY_MAPPINGS
} = {}) {
  const mcpByName = new Map(mcpTools.map((tool) => [tool.name, tool]));
  const httpByKey = new Map(httpRoutes.map((entry) => [
    routeKey(entry.method, entry.path),
    entry
  ]));
  const actions = [];

  for (const candidate of mappings) {
    const tools = candidate.mcpTools.map((name) => mcpByName.get(name));
    const routes = candidate.httpRoutes.map(({ method, path }) => (
      httpByKey.get(routeKey(method, path))
    ));
    if (tools.some((entry) => !entry) || routes.some((entry) => !entry)) continue;

    const mcpNames = tools.map(({ name }) => name);
    const httpNames = routes.map(({ method, path }) => routeKey(method, path));
    actions.push({
      humanAction: candidate.humanAction,
      agentSurface: {
        ...(mcpNames.length > 0 ? { mcpTools: mcpNames } : {}),
        ...(httpNames.length > 0 ? { httpRoutes: httpNames } : {})
      },
      agentCalls: [...mcpNames, ...httpNames]
    });
  }

  return {
    heading: "Use the agent surface for account work",
    actions,
    completeForAccounts: AGENT_SURFACE_COMPLETE_STATEMENT,
    appSessionBoundary: APP_SESSION_ADOPTION_STATEMENT
  };
}

/**
 * Audit both registries against the curated mappings and UNMAPPED_BY_DESIGN.
 * Every returned array must be empty; each one names a distinct way the parity
 * document can drift from the surface it claims to describe.
 *
 * - `unclassifiedTools` / `unclassifiedRoutes`: a registry entry nothing has
 *   decided about. This is the under-claim the guard exists to catch.
 * - `staleTools` / `staleRoutes`: an allowlist entry naming something that no
 *   longer exists, so the allowlist cannot rot into a list of ghosts.
 * - `doubleClassified`: named both in a parity row and in the allowlist.
 * - `unreasoned`: an allowlist entry carrying no reason.
 * - `misdeclaredRoleGated`: declared role-gated but reachable by a plain
 *   signed-in wallet session.
 * - `brokenTwins`: declared the HTTP twin of a tool that no parity row maps.
 */
export function auditAgentSurfaceCoverage({
  mcpTools = MCP_TOOLS,
  httpRoutes = ROUTE_CAPABILITY_RULES,
  mappings = ACCOUNT_ACTION_PARITY_MAPPINGS,
  unmapped = UNMAPPED_BY_DESIGN
} = {}) {
  const mappedTools = new Set();
  const mappedRoutes = new Set();
  for (const candidate of mappings) {
    for (const name of candidate.mcpTools) mappedTools.add(name);
    for (const { method, path } of candidate.httpRoutes) mappedRoutes.add(routeKey(method, path));
  }

  const allowedTools = new Map(unmapped.mcpTools.map((entry) => [entry.name, entry]));
  const allowedRoutes = new Map(unmapped.httpRoutes.map((entry) => [
    routeKey(entry.method, entry.path),
    entry
  ]));

  const toolNames = new Set(mcpTools.map(({ name }) => name));
  const routeKeys = new Set(httpRoutes.map(({ method, path }) => routeKey(method, path)));
  const plainSessionCapabilities = new Set(resolveCapabilities({}));
  const routeCapabilities = new Map(httpRoutes.map((entry) => [
    routeKey(entry.method, entry.path),
    entry.capabilities ?? []
  ]));

  const unreasoned = [...allowedTools.values(), ...allowedRoutes.values()]
    .filter((entry) => typeof entry.reason !== "string" || entry.reason.trim() === "")
    .map((entry) => entry.name ?? routeKey(entry.method, entry.path));

  return {
    unclassifiedTools: [...toolNames].filter((name) => (
      !mappedTools.has(name) && !allowedTools.has(name)
    )),
    unclassifiedRoutes: [...routeKeys].filter((key) => (
      !mappedRoutes.has(key) && !allowedRoutes.has(key)
    )),
    staleTools: [...allowedTools.keys()].filter((name) => !toolNames.has(name)),
    staleRoutes: [...allowedRoutes.keys()].filter((key) => !routeKeys.has(key)),
    doubleClassified: [
      ...[...allowedTools.keys()].filter((name) => mappedTools.has(name)),
      ...[...allowedRoutes.keys()].filter((key) => mappedRoutes.has(key))
    ],
    unreasoned,
    misdeclaredRoleGated: [...allowedRoutes.values()]
      .filter((entry) => entry.roleGated)
      .map((entry) => routeKey(entry.method, entry.path))
      .filter((key) => (
        routeKeys.has(key)
        && (routeCapabilities.get(key) ?? []).every((capability) => (
          plainSessionCapabilities.has(capability)
        ))
      )),
    brokenTwins: [...allowedRoutes.values()]
      .filter((entry) => entry.twinOf && !mappedTools.has(entry.twinOf))
      .map((entry) => `${routeKey(entry.method, entry.path)} -> ${entry.twinOf}`)
  };
}

function mapping(humanAction, { mcpTools = [], httpRoutes = [] } = {}) {
  return Object.freeze({
    humanAction,
    mcpTools: Object.freeze([...mcpTools]),
    httpRoutes: Object.freeze(httpRoutes.map((entry) => Object.freeze({ ...entry })))
  });
}

function route(method, path) {
  return { method, path };
}

function routeKey(method, path) {
  return `${String(method).toUpperCase()} ${path}`;
}

function unmappedTools(reason, names) {
  return names.map((name) => Object.freeze({ name, reason }));
}

function unmappedRoutes(reason, entries, extra = {}) {
  return entries.map(([method, path]) => Object.freeze({
    method,
    path,
    reason,
    roleGated: false,
    twinOf: null,
    ...extra
  }));
}

function roleGatedRoutes(reason, entries) {
  return unmappedRoutes(
    `${reason}; reached with a role capability a plain wallet session never holds`,
    entries,
    { roleGated: true }
  );
}

function twinRoutes(entries) {
  return entries.map(([method, path, twinOf]) => Object.freeze({
    method,
    path,
    reason: `HTTP twin of the ${twinOf} row; the same action is enumerated once, through MCP`,
    roleGated: false,
    twinOf
  }));
}
