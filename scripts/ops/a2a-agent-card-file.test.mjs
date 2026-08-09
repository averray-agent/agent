import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { MCP_SERVER_INFO } from "../../mcp-server/src/protocols/mcp/handler.js";
import { MCP_TOOLS } from "../../mcp-server/src/protocols/mcp/tools.js";
import {
  A2A_AGENT_CARD_PATH,
  A2A_AGENT_CARD_SCHEMA_VERSION,
  A2A_MCP_PROTOCOL_BINDING,
  buildProductionA2aAgentCard,
  buildProductionA2aAgentCardContent
} from "./a2a-agent-card-file.mjs";

const AUTH_META_KEY = "com.averray/auth";

test("A2A v1.0 discovery uses the registered agent-card well-known path", () => {
  assert.equal(A2A_AGENT_CARD_PATH, "/.well-known/agent-card.json");
  assert.notEqual(A2A_AGENT_CARD_PATH, "/.well-known/a2a-card.json");
});

test("Agent Card advertises only the live MCP and HTTP+JSON interfaces", () => {
  const card = buildProductionA2aAgentCard();

  assert.equal(card.name, MCP_SERVER_INFO.title);
  assert.equal(card.version, MCP_SERVER_INFO.version);
  assert.match(card.description, /format only/u);
  assert.match(card.description, /does not serve A2A JSON-RPC or A2A task methods/u);
  assert.deepEqual(card.capabilities, {});
  assert.deepEqual(card.defaultInputModes, ["application/json"]);
  assert.deepEqual(card.defaultOutputModes, ["application/json"]);
  assert.deepEqual(card.supportedInterfaces, [
    {
      url: "https://api.averray.com/mcp",
      protocolBinding: A2A_MCP_PROTOCOL_BINDING,
      protocolVersion: A2A_AGENT_CARD_SCHEMA_VERSION
    },
    {
      url: "https://api.averray.com",
      protocolBinding: "HTTP+JSON",
      protocolVersion: A2A_AGENT_CARD_SCHEMA_VERSION
    }
  ]);
  assert.ok(A2A_MCP_PROTOCOL_BINDING.includes("modelcontextprotocol.io"));
  assert.ok(card.supportedInterfaces.every(({ protocolBinding }) => protocolBinding !== "JSONRPC"));
});

test("every Agent Card skill is derived from the configured MCP tools list", () => {
  const card = buildProductionA2aAgentCard();

  assert.deepEqual(card.skills.map(({ id }) => id), MCP_TOOLS.map(({ name }) => name));
  assert.equal(card.skills.length, MCP_TOOLS.length);

  for (const [index, source] of MCP_TOOLS.entries()) {
    const skill = card.skills[index];
    const auth = source._meta[AUTH_META_KEY];
    assert.equal(skill.name, source.title, source.name);
    assert.equal(skill.description, source.description, source.name);
    assert.deepEqual(skill.tags, [
      "mcp-tool",
      source.name,
      source.annotations.readOnlyHint ? "read-only" : "state-changing",
      auth.required ? "authentication-required" : "anonymous"
    ], source.name);
  }
});

test("Agent Card content is stable JSON with every v1.0 required field populated", () => {
  const content = buildProductionA2aAgentCardContent();
  const card = JSON.parse(content);

  assert.ok(content.endsWith("\n"));
  for (const field of [
    "name",
    "description",
    "supportedInterfaces",
    "version",
    "capabilities",
    "defaultInputModes",
    "defaultOutputModes",
    "skills"
  ]) {
    assert.ok(Object.hasOwn(card, field), field);
  }
  assert.ok(card.supportedInterfaces.length > 0);
  assert.ok(card.defaultInputModes.length > 0);
  assert.ok(card.defaultOutputModes.length > 0);
  assert.ok(card.skills.length > 0);
  assert.ok(card.skills.every((skill) => skill.id && skill.name && skill.description && skill.tags.length));
});

test("marketing sync allow-lists the card exactly once as a nested generated file", async () => {
  const source = await readFile(new URL("../sync-marketing-site.mjs", import.meta.url), "utf8");
  const topLevel = source.match(/const generatedEntries = \[([^;]+)\];/u)?.[1] ?? "";
  const nested = source.match(/const generatedNestedFiles = \[([\s\S]+?)\];/u)?.[1] ?? "";
  const cardPath = A2A_AGENT_CARD_PATH.slice(1);

  assert.doesNotMatch(topLevel, /agent-card\.json/u);
  assert.match(nested, /\.well-known\/agent-card\.json/u);
  assert.equal(source.split(`"${cardPath}"`).length - 1, 1);
});
