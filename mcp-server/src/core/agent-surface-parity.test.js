import assert from "node:assert/strict";
import test from "node:test";

import { ROUTE_CAPABILITY_RULES } from "../auth/capabilities.js";
import { MCP_TOOLS } from "../protocols/mcp/tools.js";
import {
  ACCOUNT_ACTION_PARITY_MAPPINGS,
  AGENT_SURFACE_COMPLETE_STATEMENT,
  APP_SESSION_ADOPTION_STATEMENT,
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
