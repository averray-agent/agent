import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { ROUTE_CAPABILITY_RULES } from "../auth/capabilities.js";
import { buildAgentSurfaceParity } from "./agent-surface-parity.js";
import {
  DISCOVERY_TOOLS,
  CONNECTED_ONLY_TOOLS,
  buildDiscoveryManifest
} from "./discovery-manifest.js";
import { MCP_TOOLS } from "../protocols/mcp/tools.js";
import { buildProductionDiscoveryManifestContent } from "../../../scripts/ops/discovery-manifest-file.mjs";

const REPO_ROOT = new URL("../../../", import.meta.url);

test("MCP and every directory mirror share one registry with an explicit connected-only boundary", async () => {
  const names = (tools) => tools.map(({ name }) => name).sort();
  assert.deepEqual([...CONNECTED_ONLY_TOOLS].sort(), ["fetchAuthNonce", "verifySiwe", "refreshAuthToken", "claimJob", "submitWork", "createLockedDeposit", "requestLockedDepositExit", "startVerificationRun"].sort());
  const expected = names(MCP_TOOLS.filter(({ name }) => !CONNECTED_ONLY_TOOLS.has(name)));
  assert.deepEqual([...expected, ...CONNECTED_ONLY_TOOLS].sort(), names(MCP_TOOLS));
  for (const name of CONNECTED_ONLY_TOOLS) {
    assert.ok(MCP_TOOLS.some((tool) => tool.name === name), name);
    assert.ok(!expected.includes(name), name);
  }
  for (const name of ["draftJob", "buildPostJobTransactions"]) assert.ok(expected.includes(name));
  assert.equal(new Set(expected).size, expected.length);
  assert.deepEqual(names(DISCOVERY_TOOLS), expected);
  assert.deepEqual(names(buildDiscoveryManifest().tools), expected);
  for (const path of ["discovery/agent-tools.json", "discovery/.well-known/agent-tools.json", "site/.well-known/agent-tools.json"]) {
    const manifest = JSON.parse(await readFile(new URL(path, REPO_ROOT), "utf8"));
    assert.deepEqual(names(manifest.tools), expected, path);
    assert.equal(await readFile(new URL(path, REPO_ROOT), "utf8"), buildProductionDiscoveryManifestContent(), path);
    for (const tool of MCP_TOOLS.filter(({ name }) => !CONNECTED_ONLY_TOOLS.has(name))) {
      const advertised = manifest.tools.find((entry) => entry.name === tool.name);
      assert.deepEqual(advertised.inputSchema, tool.inputSchema, tool.name);
      assert.deepEqual(advertised._meta, tool._meta, tool.name);
      assert.deepEqual(advertised.annotations, tool.annotations, tool.name);
      assert.equal(advertised.surface, "mcp");
    }
  }
});

test("every account parity tool and HTTP route resolves through its real registry", () => {
  const mcpNames = new Set(MCP_TOOLS.map(({ name }) => name));
  const httpRoutes = new Set(ROUTE_CAPABILITY_RULES.map(({ method, path }) => (
    `${method} ${path}`
  )));
  const parity = buildAgentSurfaceParity();

  for (const action of parity.actions) {
    for (const name of action.agentSurface.mcpTools ?? []) {
      assert.ok(mcpNames.has(name), `${action.humanAction} advertises missing MCP tool ${name}`);
    }
    for (const route of action.agentSurface.httpRoutes ?? []) {
      assert.ok(httpRoutes.has(route), `${action.humanAction} advertises missing HTTP route ${route}`);
    }
  }
  assert.ok(
    parity.actions.some((action) => action.agentSurface.httpRoutes?.includes("GET /reputation")),
    "HTTP-only reputation must remain visible in account parity"
  );
});

test("committed site agent-tools mirror is byte-identical to the production generator", async () => {
  const committed = await readFile(new URL("site/.well-known/agent-tools.json", REPO_ROOT), "utf8");
  assert.equal(committed, buildProductionDiscoveryManifestContent());
});

test("Glama metadata keeps its schema and maintainer and cannot over-advertise capabilities", async () => {
  const glama = JSON.parse(await readFile(new URL("site/.well-known/glama.json", REPO_ROOT), "utf8"));
  assert.equal(typeof glama.$schema, "string");
  assert.ok(glama.$schema.length > 0);
  assert.ok(Array.isArray(glama.maintainers) && glama.maintainers.length > 0);

  const manifestNames = new Set(buildDiscoveryManifest().tools.map(({ name }) => name));
  for (const { path, names } of collectNamedLists(glama)) {
    for (const name of names) {
      assert.ok(manifestNames.has(name), `${path} advertises ${name}, which is absent from agent-tools`);
    }
  }
});

function collectNamedLists(value, path = "glama") {
  if (!value || typeof value !== "object") return [];
  const lists = [];
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (["tools", "capabilities"].includes(key) && Array.isArray(child)) {
      lists.push({
        path: childPath,
        names: child.map((entry) => typeof entry === "string" ? entry : entry?.name).filter(Boolean)
      });
    }
    lists.push(...collectNamedLists(child, childPath));
  }
  return lists;
}
