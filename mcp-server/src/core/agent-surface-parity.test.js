import assert from "node:assert/strict";
import test from "node:test";

import { ROUTE_CAPABILITY_RULES } from "../auth/capabilities.js";
import { MCP_TOOLS } from "../protocols/mcp/tools.js";
import {
  ACCOUNT_ACTION_PARITY_MAPPINGS,
  AGENT_SURFACE_COMPLETE_STATEMENT,
  APP_SESSION_ADOPTION_STATEMENT,
  UNMAPPED_BY_DESIGN,
  auditAgentSurfaceCoverage,
  buildAgentSurfaceParity
} from "./agent-surface-parity.js";

test("account parity is derived from both registries and unmapped additions cannot invent a row", () => {
  const parity = buildAgentSurfaceParity();
  assert.equal(parity.actions.length, ACCOUNT_ACTION_PARITY_MAPPINGS.length);
  assert.deepEqual(
    parity.actions.find(({ humanAction }) => humanAction === "see available balance"),
    {
      humanAction: "see available balance",
      agentSurface: {
        mcpTools: ["getAccountPosition"],
        httpRoutes: ["GET /account"]
      },
      agentCalls: ["getAccountPosition", "GET /account"]
    }
  );
  assert.deepEqual(
    parity.actions.find(({ humanAction }) => humanAction === "read standing / tier / receipts"),
    {
      humanAction: "read standing / tier / receipts",
      agentSurface: {
        httpRoutes: ["GET /me", "GET /reputation", "GET /receipts"]
      },
      agentCalls: ["GET /me", "GET /reputation", "GET /receipts"]
    }
  );

  const withUnmappedEntries = buildAgentSurfaceParity({
    mcpTools: [...MCP_TOOLS, { name: "unmappedAccountTool" }],
    httpRoutes: [
      ...ROUTE_CAPABILITY_RULES,
      { method: "POST", path: "/unmapped-account-action" }
    ]
  });
  assert.deepEqual(withUnmappedEntries, parity);

  const withoutReputation = buildAgentSurfaceParity({
    httpRoutes: ROUTE_CAPABILITY_RULES.filter(({ method, path }) => (
      !(method === "GET" && path === "/reputation")
    ))
  });
  assert.equal(
    withoutReputation.actions.some(({ humanAction }) => (
      humanAction === "read standing / tier / receipts"
    )),
    false,
    "the HTTP-only reputation row must disappear rather than advertise a guessed route"
  );
});

test("agent parity states account completeness and the deliberate no-adoption boundary verbatim", () => {
  const parity = buildAgentSurfaceParity();
  assert.equal(parity.completeForAccounts, AGENT_SURFACE_COMPLETE_STATEMENT);
  assert.equal(parity.appSessionBoundary, APP_SESSION_ADOPTION_STATEMENT);
  assert.match(parity.completeForAccounts, /without a browser, an injected wallet, or the app/u);
  assert.match(parity.appSessionBoundary, /never ask anyone to paste a bearer token/u);
  assert.match(parity.appSessionBoundary, /sign in there separately with the same wallet/u);
});

test("every registry entry is either mapped into a parity row or unmapped by design", () => {
  // The guard. Adding an MCP tool or an HTTP route fails here until someone
  // decides whether it belongs in the parity table, so the document cannot
  // quietly stop enumerating a surface it still claims is complete.
  assert.deepEqual(auditAgentSurfaceCoverage(), {
    unclassifiedTools: [],
    unclassifiedRoutes: [],
    staleTools: [],
    staleRoutes: [],
    doubleClassified: [],
    unreasoned: [],
    misdeclaredRoleGated: [],
    brokenTwins: []
  });
});

test("a new account-lane tool or route fails the guard instead of silently under-claiming", () => {
  const withNewTool = auditAgentSurfaceCoverage({
    mcpTools: [...MCP_TOOLS, { name: "closeAccount" }]
  });
  assert.deepEqual(withNewTool.unclassifiedTools, ["closeAccount"]);
  assert.deepEqual(
    buildAgentSurfaceParity({ mcpTools: [...MCP_TOOLS, { name: "closeAccount" }] }),
    buildAgentSurfaceParity(),
    "the builder still fails safe; the audit is what makes the omission loud"
  );

  const withNewRoute = auditAgentSurfaceCoverage({
    httpRoutes: [
      ...ROUTE_CAPABILITY_RULES,
      { method: "POST", path: "/account/close", capabilities: ["account:read"] }
    ]
  });
  assert.deepEqual(withNewRoute.unclassifiedRoutes, ["POST /account/close"]);
});

test("the by-design allowlist cannot rot into names that no longer resolve", () => {
  const droppedTool = auditAgentSurfaceCoverage({
    mcpTools: MCP_TOOLS.filter(({ name }) => name !== "verifySiwe")
  });
  assert.deepEqual(droppedTool.staleTools, ["verifySiwe"]);

  const droppedRoute = auditAgentSurfaceCoverage({
    httpRoutes: ROUTE_CAPABILITY_RULES.filter(({ method, path }) => (
      !(method === "POST" && path === "/jobs/claim")
    ))
  });
  assert.deepEqual(droppedRoute.staleRoutes, ["POST /jobs/claim"]);
});

test("by-design reasons are checked, not merely asserted", () => {
  // A route declared role-gated must actually be unreachable by a plain
  // signed-in wallet session, so the cheapest wrong reason is also the one
  // the guard rejects first.
  const misdeclared = auditAgentSurfaceCoverage({
    unmapped: {
      mcpTools: UNMAPPED_BY_DESIGN.mcpTools,
      httpRoutes: UNMAPPED_BY_DESIGN.httpRoutes.map((entry) => (
        entry.path === "/events" ? { ...entry, roleGated: true } : entry
      ))
    }
  });
  assert.deepEqual(misdeclared.misdeclaredRoleGated, ["GET /events"]);

  // An HTTP twin must name a tool that a parity row really maps, so a row
  // deleted upstream cannot leave its twins claiming coverage that is gone.
  const brokenTwin = auditAgentSurfaceCoverage({
    mappings: ACCOUNT_ACTION_PARITY_MAPPINGS.filter(({ humanAction }) => (
      humanAction !== "browse and claim work"
    ))
  });
  assert.deepEqual(brokenTwin.brokenTwins, [
    "GET /jobs/preflight -> preflightJob",
    "POST /jobs/claim -> claimJob"
  ]);

  const unreasoned = auditAgentSurfaceCoverage({
    unmapped: {
      mcpTools: UNMAPPED_BY_DESIGN.mcpTools.map((entry) => (
        entry.name === "verifySiwe" ? { ...entry, reason: "  " } : entry
      )),
      httpRoutes: UNMAPPED_BY_DESIGN.httpRoutes
    }
  });
  assert.deepEqual(unreasoned.unreasoned, ["verifySiwe"]);
});

test("the account lane is mapped rather than allowlisted", () => {
  // The allowlist is for surfaces outside the account lane. If an account-lane
  // tool ever lands in it, the completeness statement above stops being true.
  const parity = buildAgentSurfaceParity();
  const mapped = new Set(parity.actions.flatMap(({ agentSurface }) => agentSurface.mcpTools ?? []));
  for (const name of [
    "getAccountPosition",
    "buildAccountDepositTransactions",
    "buildWithdrawTransactions",
    "getDepositPoolInfo",
    "buildDepositPoolTransactions",
    "getCreditInfo",
    "buildCreditTransactions",
    "estimateNetReward",
    "explainEligibility"
  ]) {
    assert.ok(mapped.has(name), `${name} is account lane and must be a parity row, not an allowlist entry`);
  }
});
