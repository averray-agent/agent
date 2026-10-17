import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { p256 } from "@noble/curves/nist.js";
import { createHash, generateKeyPairSync } from "node:crypto";
import { MemoryStateStore } from "../core/state-store.js";
import { createLogger } from "../core/logger.js";
import { KmsBadgeReceiptSigner, verifyBadgeReceiptSignature } from "../core/badge-receipt-signing.js";
import { VerificationProfileRegistry } from "./verification-profile-registry.js";
import { VerificationRunService } from "./verification-run-service.js";
import { McpProbeCoordinator, McpProberClient } from "./mcp-probe-coordinator.js";
import { McpProberService } from "./mcp-prober-service.js";
import { McpFailureSemanticsRunner } from "./mcp-failure-semantics-runner.js";
import { McpProtocolError, EgressPolicyDeniedError, TargetUnavailableError } from "./mcp-probe-transport.js";
import { createBadgeRoutes } from "../protocols/http/badge-routes.js";
import { createVerifyRoutes } from "../protocols/http/verify-routes.js";
import { invokeHttpRoute } from "../protocols/mcp/route-adapter.js";
import { readJsonBody, respond } from "../protocols/http/http-helpers.js";

const SENTINEL = "verify-credential-SENTINEL-94c769-do-not-persist";
const target = { endpoint: "https://target.example.test/mcp", transport: "streamable_http",
  auth: { scheme: "bearer", credentialRef: "test-run-only" } };
// JSON.stringify(Map) is {}, and JSON.stringify(Error) drops its message. Inspect
// every map and error so the negative assertions cannot silently miss a leak.
function material(value) {
  return JSON.stringify(value, (_key, item) => item instanceof Map ? [...item]
    : item instanceof Set ? [...item] : item instanceof Error
      ? { ...item, name: item.name, message: item.message, stack: item.stack } : item);
}
function secretAbsent(value, label) { assert.ok(!material(value)?.includes(SENTINEL), label); }

for (const scenario of ["approved", "rejected", "unreachable", "platform_fault", "prober_failure", "dispatch_failure"]) {
  test(`credential privacy: header → prober → ${scenario} → signed receipt never persists or logs the sentinel`, async (t) => {
    const stateStore = new MemoryStateStore();
    const writes = [];
    // Observe the actual persistence boundary, including transient writes that
    // a later sanitized update could otherwise hide. Also cover the event log.
    for (const method of Object.getOwnPropertyNames(MemoryStateStore.prototype)) {
      if (method === "constructor") continue;
      const original = stateStore[method].bind(stateStore);
      stateStore[method] = (...args) => {
        secretAbsent(args, `state store call ${method}`);
        writes.push(method);
        return original(...args);
      };
    }
    const logCalls = [];
    const logLines = [];
    const realLogger = createLogger({ level: "debug", sink: (_level, record) => logLines.push(material(record)) });
    const logger = Object.fromEntries(["debug", "info", "warn", "error", "log"].map((level) => [level, (...args) => {
      logCalls.push(material(args));
      return realLogger[level](...args);
    }]));
    // Console output is also a sink: a debug print must turn this test red.
    for (const level of ["debug", "info", "warn", "error", "log"]) {
      t.mock.method(console, level, (...args) => logCalls.push(material(args)));
    }
    const seenCredentials = [];
    const runner = new McpFailureSemanticsRunner({ transportFactory: ({ credential }) => {
      seenCredentials.push(credential);
      if (scenario === "prober_failure") throw new Error(`host failure ${credential}`);
      return targetTransport({ credential, scenario });
    } });
    const prober = new McpProberService({ runner, proxyUrl: "http://unused-proxy.test", logger });
    const server = prober.listen({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    t.after(() => prober.close());
    const client = new McpProberClient({ baseUrl: `http://127.0.0.1:${server.address().port}` });
    if (scenario === "dispatch_failure") client.probe = async ({ credential }) => {
      seenCredentials.push(credential);
      throw new Error(`transport failure ${credential}`);
    };
    const coordinator = new McpProbeCoordinator({ stateStore, client, logger,
      grantService: { mint: async () => ({ token: "run-specific-egress-grant" }) } });
    const profiles = new VerificationProfileRegistry();
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const der = publicKey.export({ type: "spki", format: "der" });
    const keyId = "arn:aws:kms:eu-central-2:000000000000:key/11111111-2222-3333-4444-555555555555";
    const signer = new KmsBadgeReceiptSigner({ region: "eu-central-2", keyId, kid: "privacy-test",
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
      publicKeyFingerprint: "sha256:" + createHash("sha256").update(der).digest("hex")
    }, { kmsClient: { send: async (command) => {
      if (command.constructor.name === "GetPublicKeyCommand") return { KeyId: keyId, PublicKey: der };
      secretAbsent(command.input, "signer input");
      return { Signature: p256.sign(new Uint8Array(command.input.Message),
        new Uint8Array(Buffer.from(privateKey.export({ format: "jwk" }).d, "base64url")),
        { prehash: false, format: "der", lowS: false }) };
    } } });
    await signer.initialize();
    const jwk = signer.getJwks().keys[0];
    let captures = 0;
    const service = new VerificationRunService({ stateStore, profileRegistry: profiles, executionDispatcher: coordinator,
      publicReceiptBaseUrl: "https://averray.com", logger, badgeReceiptSigner: signer,
      paymentGate: {
        async authorize({ paymentProof, price }) { return { id: paymentProof, customer: "0x" + "1".repeat(40),
          amountRaw: price.amountRaw, asset: price.asset, network: price.network }; },
        async capture() { captures++; return { transactionHash: "0x" + "a".repeat(64) }; },
        async release() {}
      }
    });
    const route = createVerifyRoutes({ enforceLimit: async () => {}, rateLimitConfig: { verifierRun: {} },
      readJsonBody, respond, verificationRunService: service });
    const receiptRoute = createBadgeRoutes({ stateStore, respond, badgeReceiptSigner: signer });
    const post = (runTarget, headers) => invokeHttpRoute(route, { method: "POST", path: "/verify/runs", headers,
      body: { profile: "mcp-failure-semantics-v1", profileVersion: 1, target: runTarget, inputs: {} } });
    const responses = [];
    async function complete(reply) {
      responses.push(reply);
      assert.equal(reply.statusCode, 200);
      const runId = reply.body.runId;
      secretAbsent(stateStore, "all state during dispatch");
      await coordinator.inFlight.get(runId);
      await service.finalizeAvailableRuns();

      const publicReply = await invokeHttpRoute(route, { method: "GET", path: `/verify/runs/${runId}` });
      responses.push(publicReply);
      const run = publicReply.body;
      assert.equal(run.status, "complete", material(logCalls));
      assert.deepEqual(run.inputs, {});
      assert.equal(run.target.endpoint, target.endpoint);
      const receipt = await stateStore.getWorkReceiptDocumentBySession(runId);
      assert.ok(receipt, "completed run must have a receipt");
      assert.equal(verifyBadgeReceiptSignature(receipt, jwk), true);
      const alias = await invokeHttpRoute(receiptRoute, { method: "GET", path: `/receipts/${runId}` });
      assert.equal(alias.statusCode, 301, "public run-id receipt alias");
      const receiptReply = await invokeHttpRoute(receiptRoute, { method: "GET", path: `/receipts/${receipt.receiptId}` });
      assert.equal(receiptReply.statusCode, 200);
      responses.push(alias, receiptReply);
      secretAbsent(receipt, "signed receipt");
      secretAbsent(await stateStore.getRunReceiptDocument(runId), "receipt alias");
      secretAbsent(await stateStore.getVerificationRun(runId), "stored run");
      secretAbsent(responses, "all public run JSON");
      secretAbsent(stateStore, "all state including payment authorization and event log");
      secretAbsent(await stateStore.listEventLog(), "event log");
      secretAbsent(logCalls, "every logger/console call");
      secretAbsent(logLines, "every serialized log line");
      assert.equal(coordinator.inFlight.size, 0, "no live run retained after completion");
      return run;
    }
    const paidHeaders = { "payment-signature": "payment-one", "verification-target-authorization": `Bearer ${SENTINEL}` };
    const first = await complete(await post(target, paidHeaders));
    const decisive = scenario === "approved" || scenario === "rejected";
    assert.equal(first.billing.status, decisive ? "captured" : "not_captured");
    assert.equal(first.verdict.outcome, decisive ? scenario : ["platform_fault", "prober_failure"].includes(scenario) ? "platform_fault" : "inconclusive");
    // The same payment is a replay, not a second use of its credential.
    await post(target, paidHeaders);
    assert.deepEqual(seenCredentials, [SENTINEL]);
    await assert.rejects(post(target, { "payment-signature": "missing-credential" }), /scoped credential/u);
    assert.deepEqual(seenCredentials, [SENTINEL], "a later run cannot reuse a previous run's credential");
    const { auth: _auth, ...publicTarget } = target;
    await complete(await post(publicTarget, { "payment-signature": "payment-two" }));
    assert.deepEqual(seenCredentials, [SENTINEL, undefined]);
    assert.equal(captures, decisive ? 2 : 0);
    assert.ok(writes.includes("reserveVerificationRun") && writes.includes("storeVerificationRunExecution")
      && writes.includes("putWorkReceiptDocument"), "exercise real persistence, not an empty fixture");
    assert.ok(logLines.length, "exercise the real logger");
  });
}

function targetTransport({ credential, scenario }) {
  const tools = [
    { name: "protected", inputSchema: { type: "object", additionalProperties: false },
      _meta: { "averray/verification": { suiteVersion: 1, authProbe: { arguments: {} } } } },
    { name: "timeout", inputSchema: { type: "object" },
      _meta: { "averray/verification": { suiteVersion: 1, timeoutProbe: { arguments: {} } } } },
    { name: "destroy", inputSchema: { type: "object" }, annotations: { destructiveHint: true },
      _meta: { "averray/verification": { suiteVersion: 1, destructiveProbe: { argumentsWithoutConfirmation: {} } } } }
  ];
  return { createSession({ authenticated }) { return {
    async initialize() {
      if (scenario === "platform_fault") throw new EgressPolicyDeniedError(credential);
      if (scenario === "unreachable") throw new TargetUnavailableError(credential);
    },
    async close() {},
    async request(method, params) {
      if (method === "tools/list") return { tools };
      if (params.name === "timeout") await new Promise((resolve) => setTimeout(resolve, 110));
      if (params.name === "destroy" && scenario === "rejected") return { content: [{ text: credential }] };
      // A target may echo the secret in errors. The fixed runner must project
      // only bounded check results, never these messages, data or bodies.
      throw new McpProtocolError({ code: !authenticated ? -32001 : -32602,
        message: `target echoed ${credential}`, data: { token: credential } });
    }
  }; } };
}
