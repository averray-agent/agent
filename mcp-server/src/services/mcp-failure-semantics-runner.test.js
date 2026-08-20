import assert from "node:assert/strict";
import test from "node:test";

import { EgressPolicyDeniedError, McpProtocolError, TargetAuthenticationError, TargetUnavailableError } from "./mcp-probe-transport.js";
import { McpFailureSemanticsRunner } from "./mcp-failure-semantics-runner.js";

const PROFILE = { ref: "mcp-failure-semantics-v1@1", version: 1, limits: { timeoutMs: 30_000 } };
const TARGET = { endpoint: "https://mcp.example.test/run", transport: "streamable_http", auth: { scheme: "bearer", credentialRef: "run-only" } };

test("fixed suite names five independent checks; known-good passes and one bad behavior fails only its check", async () => {
  const good = await execute(fakeTransport());
  assert.equal(good.status, "decidable");
  assert.deepEqual(good.report.checks.map(({ name, verdict }) => [name, verdict]), [
    ["auth-boundary", "pass"],
    ["timeout-recovery", "pass"],
    ["tool-schema-stability", "pass"],
    ["destructive-action-safety", "pass"],
    ["error-shape-conformance", "pass"]
  ]);

  const bad = await execute(fakeTransport({ destructiveServed: true }));
  assert.equal(bad.status, "decidable");
  assert.deepEqual(bad.report.checks.filter(({ verdict }) => verdict === "fail").map(({ name }) => name), ["destructive-action-safety"]);
  assert.equal(bad.report.checks.filter(({ verdict }) => verdict === "pass").length, 4);
});

test("target reachability and authentication failures are inconclusive rather than endpoint failures", async () => {
  for (const failure of [new TargetUnavailableError(), new TargetAuthenticationError()]) {
    const execution = await execute({
      createSession() {
        return { async initialize() { throw failure; }, async close() {} };
      }
    });
    assert.equal(execution.status, "inconclusive");
    assert.equal(execution.report.checks.some(({ verdict }) => verdict === "inconclusive"), true);
    assert.equal(execution.report.checks.some(({ verdict }) => verdict === "fail"), false);
  }
});

test("timeout recovery fails when the structured timeout corrupts the live MCP session", async () => {
  const transport = fakeTransport({ timeoutCorruptsSession: true });
  const execution = await execute(transport);
  assert.equal(execution.status, "decidable");
  assert.deepEqual(
    execution.report.checks.filter(({ verdict }) => verdict === "fail").map(({ name, reason }) => [name, reason]),
    [["timeout-recovery", "session_not_recovered"]]
  );
});

test("egress mutation is a platform fault when the boundary refuses a second host", async () => {
  const execution = await execute({
    createSession() {
      return { async initialize() { throw new EgressPolicyDeniedError(); }, async close() {} };
    }
  });
  assert.equal(execution.status, "platform_fault");
  assert.equal(execution.reason, "runner_fault");
  assert.match(execution.detail, /undeclared destination/u);
});

test("the fixed suite accepts no customer probe code and requires ephemeral credential parity", () => {
  const runner = new McpFailureSemanticsRunner({ transportFactory: () => fakeTransport() });
  assert.throws(() => runner.validate({ profile: PROFILE, target: TARGET, inputs: { command: "curl elsewhere" }, credential: "token" }), /fixed suite.*no customer/u);
  assert.throws(() => runner.validate({ profile: PROFILE, target: TARGET, inputs: {} }), /scoped credential/u);
  assert.throws(() => runner.validate({ profile: PROFILE, target: { ...TARGET, auth: undefined }, inputs: {}, credential: "token" }), /only when target.auth/u);
});

function execute(transport) {
  return new McpFailureSemanticsRunner({ transportFactory: () => transport }).run({
    profile: PROFILE,
    runId: "verify-unit",
    target: TARGET,
    inputs: {},
    credential: "run-scoped-secret",
    egressGrant: "grant",
    proxyUrl: "http://proxy:8080"
  });
}

function fakeTransport({ destructiveServed = false, timeoutCorruptsSession = false } = {}) {
  const tools = [
    {
      name: "protected",
      inputSchema: { type: "object", additionalProperties: false, required: ["value"], properties: { value: { type: "string" } } },
      _meta: { "averray/verification": { suiteVersion: 1, authProbe: { arguments: { value: "probe" } } } }
    },
    {
      name: "timeout",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      _meta: { "averray/verification": { suiteVersion: 1, timeoutProbe: { arguments: {} } } }
    },
    {
      name: "destroy",
      inputSchema: { type: "object", additionalProperties: false, properties: { resource: { type: "string" } } },
      annotations: { destructiveHint: true },
      _meta: { "averray/verification": { suiteVersion: 1, destructiveProbe: { argumentsWithoutConfirmation: { resource: "fixture" } } } }
    }
  ];
  return {
    createSession({ authenticated }) {
      let corrupted = false;
      return {
        async initialize() {},
        async close() {},
        async request(method, params) {
          if (method === "tools/list") {
            if (corrupted) throw protocolError(-32603, "Session unavailable");
            return { tools };
          }
          if (params?.name === "protected") {
            if (!authenticated) throw protocolError(-32001, "Authentication required");
            throw protocolError(-32602, "Invalid params");
          }
          if (params?.name === "timeout") {
            await new Promise((resolve) => setTimeout(resolve, 110));
            corrupted = timeoutCorruptsSession;
            throw protocolError(-32008, "Operation timed out");
          }
          if (params?.name === "destroy") {
            if (destructiveServed) return { content: [] };
            throw protocolError(-32602, "Confirmation required");
          }
          if (params?.name === "__averray_missing_tool_v1__") throw protocolError(-32601, "Tool not found");
          throw new Error("unexpected fake request");
        }
      };
    }
  };
}

function protocolError(code, message) {
  return new McpProtocolError({ code, message });
}
