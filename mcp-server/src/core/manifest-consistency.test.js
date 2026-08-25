import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { ROUTE_CAPABILITY_RULES } from "../auth/capabilities.js";
import { buildAgentSurfaceParity } from "./agent-surface-parity.js";
import {
  CONNECTED_ONLY_TOOLS,
  DISCOVERY_HTTP_ONLY_TOOLS,
  DISCOVERY_TOOLS,
  buildDiscoveryManifest
} from "./discovery-manifest.js";
import { MCP_TOOLS } from "../protocols/mcp/tools.js";
import { buildProductionDiscoveryManifestContent } from "../../../scripts/ops/discovery-manifest-file.mjs";

const REPO_ROOT = new URL("../../../", import.meta.url);

test("MCP and discovery tool catalogues agree except for the explicit connected-only boundary", () => {
  const mcpNames = new Set(MCP_TOOLS.map(({ name }) => name));
  const discoveryNames = new Set(DISCOVERY_TOOLS.map(({ name }) => name));
  const connectedOnlyNames = new Set(CONNECTED_ONLY_TOOLS);
  const httpOnlyNames = new Set(DISCOVERY_HTTP_ONLY_TOOLS);

  assert.equal(connectedOnlyNames.size, CONNECTED_ONLY_TOOLS.length, "CONNECTED_ONLY_TOOLS contains duplicates");
  assert.equal(httpOnlyNames.size, DISCOVERY_HTTP_ONLY_TOOLS.length, "DISCOVERY_HTTP_ONLY_TOOLS contains duplicates");

  for (const name of mcpNames) {
    assert.ok(
      discoveryNames.has(name) || connectedOnlyNames.has(name),
      `MCP tool ${name} must be discoverable or explicitly connected-only`
    );
  }
  for (const name of connectedOnlyNames) {
    assert.ok(mcpNames.has(name), `connected-only tool ${name} must resolve to a real MCP tool`);
    assert.equal(discoveryNames.has(name), false, `connected-only tool ${name} must stay outside directory-safe discovery`);
  }
  for (const tool of DISCOVERY_TOOLS) {
    assert.ok(["mcp", "http_only"].includes(tool.surface), `${tool.name} must declare its transport surface`);
    if (tool.surface === "mcp") {
      assert.ok(mcpNames.has(tool.name), `advertised MCP tool ${tool.name} does not resolve`);
      assert.equal(httpOnlyNames.has(tool.name), false);
    } else {
      assert.ok(httpOnlyNames.has(tool.name), `HTTP-only tool ${tool.name} is missing from the explicit declaration`);
      assert.equal(mcpNames.has(tool.name), false, `HTTP-only tool ${tool.name} unexpectedly resolves through MCP`);
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
