import { ROUTE_CAPABILITY_RULES } from "../auth/capabilities.js";
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
  mapping("submit work", {
    mcpTools: ["submitWork", "validateJobSubmission"]
  }),
  mapping("lock a deposit", {
    mcpTools: ["quoteLockedDeposit", "createLockedDeposit"]
  }),
  mapping("exit a lock", {
    mcpTools: ["requestLockedDepositExit"]
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
