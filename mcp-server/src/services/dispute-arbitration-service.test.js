import test from "node:test";
import assert from "node:assert/strict";
import { Interface, encodeBytes32String, id as selectorHash } from "ethers";
import { DisputeArbitrationService } from "./dispute-arbitration-service.js";
import { BlockchainGateway } from "../blockchain/gateway.js";
import { EventListener } from "../blockchain/event-listener.js";
import { MemoryStateStore } from "../core/state-store.js";
import { buildJobSnapshot } from "../core/job-snapshot.js";
import { disputeIdForSession } from "../core/dispute-resolution.js";
import { createDisputeRoutes } from "../protocols/http/dispute-routes.js";
import { createContentRoutes } from "../protocols/http/content-routes.js";
import { AuthenticationError } from "../core/errors.js";

const wallet = `0x${"aa".repeat(20)}`, arbitrator = `0x${"bb".repeat(20)}`, escrow = `0x${"cc".repeat(20)}`;
const asset = { symbol: "USDC", address: "0x0000053900000000000000000000000001200000", decimals: 6 };
const iface = new Interface([
  "function resolveDispute(bytes32,uint256,bytes32,string)",
  "event DisputeResolved(bytes32 indexed jobId,address indexed arbitrator,uint256 workerPayout,bytes32 reasonCode,string metadataURI)"
]);
const rationale = "Platform fault, see #1374. Worker should receive the remaining reward.";

async function fixture() {
  const store = new MemoryStateStore(), events = [], sends = [];
  const job = { id: "removed-job", rewardAsset: "USDC", rewardAmount: 2 };
  const session = await store.upsertSession({ sessionId: "arbitration-session", jobId: job.id,
    chainJobId: selectorHash(job.id), wallet, status: "disputed", disputedAt: "2026-09-15T20:24:00Z",
    jobSnapshot: buildJobSnapshot(job), statusHistory: [{ to: "disputed" }],
    operatorOverturn: { origin: "operator_overturn", openedAt: "2026-09-15T20:24:00Z", remainingPayout: 1.8 } });
  const live = { state: 5, specHash: session.jobSnapshot.specHash, worker: wallet, poster: arbitrator,
    asset: asset.address, reward: 2, rewardRaw: "2000000", released: 0.2, releasedRaw: "200000", escrowAddress: escrow };
  const gateway = new BlockchainGateway({ enabled: false, supportedAssets: [asset], arbitratorAddress: arbitrator });
  Object.assign(gateway, { isEnabled: () => true, getJob: async () => ({ ...live }),
    readEscrowJob: async () => ({ ...live }), escrowContractForLiveJob: () => ({ interface: iface }),
    policyContract: { arbitrators: async (value) => value === arbitrator },
    provider: { getNetwork: async () => ({ chainId: 420420419n }), getBlockNumber: async () => 100,
      getBlock: async () => ({ timestamp: 1789505000 }), getLogs: async () => [] },
    escrowContract: { target: escrow, interface: iface, jobs: async () => ({ ...live }) },
    resolveDispute: async (...args) => { sends.push(args); throw new Error("NO backend arbitration"); },
    getTreasuryPolicyStatus: async () => ({ signerIsArbitrator: false }) });
  const service = new DisputeArbitrationService({ stateStore: store, gateway, eventBus: { publish: (event) => events.push(event) },
    persistContentRecord: (record) => store.upsertContent(record), publicBaseUrl: "https://api.example.test" });
  const prepare = (payload = { verdict: "dismissed", rationale }) => service.prepare({ session, payload, auth: { wallet: arbitrator } });
  return { store, session, gateway, live, events, sends, service, prepare };
}

test("arbitration pin 1: prepared calldata is byte-exact, bytes32 text (never keccak), and public before signing", async () => {
  const f = await fixture();
  for (const verdict of ["dismissed", "upheld"]) {
    const prepared = await f.prepare({ verdict, rationale });
    const decoded = prepared.decoded;
    assert.equal(prepared.data.slice(0, 10), selectorHash("resolveDispute(bytes32,uint256,bytes32,string)").slice(0, 10));
    assert.equal(prepared.data, iface.encodeFunctionData("resolveDispute", Object.values(decoded)));
    assert.equal(decoded.reasonCode, encodeBytes32String(verdict === "dismissed" ? "DISPUTE_OVERTURNED" : "DISPUTE_LOST"));
    assert.equal(decoded.workerPayout, verdict === "dismissed" ? "1800000" : "0");
    assert.equal(prepared.arbitrator, arbitrator); assert.equal(prepared.chainId, 420420419);
    const response = {};
    const route = createContentRoutes({ stateStore: f.store, authMiddleware: async () => { throw new AuthenticationError("No login"); },
      respond: (res, status, body) => Object.assign(res, { status, body }) });
    const url = new URL(decoded.metadataURI);
    await route({ request: { method: "GET" }, response, pathname: url.pathname, url });
    assert.equal(response.status, 200); assert.match(JSON.stringify(response.body), /Platform fault/);
  }
  assert.equal(f.sends.length, 0);
});

test("arbitration pin 2: prepare refuses invalid input without sending; same input replays, changed input supersedes", async () => {
  const f = await fixture();
  for (const payload of [{ verdict: "split", rationale, workerPayout: 1.800001 }, { verdict: "other", rationale }, { verdict: "dismissed", rationale: "short" }]) {
    await assert.rejects(f.prepare(payload));
    assert.equal(await f.store.getMutationReceipt("dispute_preparation", disputeIdForSession(f.session.sessionId)), undefined);
  }
  const prepared = await f.prepare();
  assert.deepEqual(await f.prepare(), prepared);
  const changed = await f.prepare({ verdict: "split", rationale, workerPayout: 0.5 });
  assert.notEqual(changed.preparationId, prepared.preparationId);
  assert.equal((await f.service.liveState(f.session)).preparationId, changed.preparationId);
  assert.equal(f.sends.length, 0);
  f.gateway.policyContract.arbitrators = async () => false;
  await assert.rejects(f.prepare(), { code: "arbitrator_not_registered" });
});

test("arbitration pin 4: signed event converges the overturn using event payout; manual POST and replay never transition twice", async (t) => {
  const f = await fixture();
  const prepared = await f.prepare();
  f.live.state = 6; f.live.released = 1.7; f.live.releasedRaw = "1700000";
  const listener = new EventListener(f.gateway, { publish: (event) => f.events.push(event) }, f.store, { disputeArbitration: f.service });
  await listener.start();
  t.after(() => listener.stop());
  const args = { jobId: f.session.chainJobId, arbitrator, workerPayout: 1500000n,
    reasonCode: encodeBytes32String("DISPUTE_PARTIAL"), metadataURI: prepared.decoded.metadataURI };
  const txHash = `0x${"22".repeat(32)}`;
  await listener.dispatch("DisputeResolved", args, { transactionHash: txHash, blockNumber: 100 });
  const resolved = await f.store.getSession(f.session.sessionId);
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.operatorOverturn.resolution.workerPayout, 1.5);
  const receipt = await f.store.getMutationReceipt("dispute_verdict", disputeIdForSession(f.session.sessionId));
  assert.equal(receipt.chainStatus, "confirmed"); assert.equal(receipt.txHash, txHash);
  assert.deepEqual(receipt.warning, { code: "arbitration_prepared_payout_mismatch", expected: "1800000", actual: "1500000" });
  assert.ok(f.events.some((event) => event.topic === "dispute.preparation_payout_mismatch"));
  assert.ok(f.events.some((event) => event.topic === "escrow.dispute_resolved" && event.data.convergence === "confirmed"));
  const routes = createDisputeRoutes({ gateway: f.gateway, stateStore: f.store,
    service: { listRecentSessions: () => f.store.listRecentSessions(), resumeSession: (id) => f.store.getSession(id) },
    authMiddleware: async () => ({ wallet: arbitrator, claims: { roles: ["admin"] } }), hasRole: (c, r) => c.roles.includes(r),
    parseLimit: () => 50, readJsonBody: async () => ({ verdict: "dismissed", rationale }),
    buildScopedIdempotentMutationContext: () => ({}), getIdempotentMutationReplay: async () => undefined,
    respondWithMutationReceipt: async (_res, _i, _status, body) => { assert.equal(body.txHash, txHash); } });
  const pathname = `/disputes/${receipt.disputeId}/verdict`;
  await routes.handleDisputeRoute({ request: { method: "POST" }, response: {}, pathname, url: new URL(pathname, "https://api.example.test") });
  await listener.dispatch("DisputeResolved", args, { transactionHash: txHash, blockNumber: 100 });
  assert.deepEqual((await f.store.getSession(f.session.sessionId)).statusHistory, resolved.statusHistory);
  assert.equal(resolved.statusHistory.length, 2);
  assert.equal(f.sends.length, 0);
});

test("prepare HTTP surface requires admin or verifier and never trusts a caller's arbitrator address", async () => {
  const f = await fixture();
  let role = "worker";
  const routes = createDisputeRoutes({ gateway: f.gateway, stateStore: f.store, disputeArbitration: f.service,
    service: { listRecentSessions: () => f.store.listRecentSessions() },
    authMiddleware: async () => ({ wallet: arbitrator, claims: { roles: [role] } }), hasRole: (claims, value) => claims.roles.includes(value),
    readJsonBody: async () => ({ verdict: "dismissed", rationale, arbitrator: wallet }),
    respond: (res, status, body) => Object.assign(res, { status, body }) });
  const pathname = `/disputes/${disputeIdForSession(f.session.sessionId)}/prepare`;
  const response = {}, input = { request: { method: "POST" }, response, pathname, url: new URL(pathname, "http://localhost") };
  await assert.rejects(routes.handleDisputeRoute(input), { code: "missing_role" });
  for (role of ["admin", "verifier"]) {
    await routes.handleDisputeRoute(input);
    assert.equal(response.status, 200); assert.equal(response.body.arbitrator, arbitrator);
  }
  assert.equal(f.sends.length, 0);
});

test("arbitration event failure keeps the poll cursor before the log; replay repairs the receipt without double transition", async (t) => {
  const f = await fixture(); const prepared = await f.prepare();
  f.live.state = 6;
  let head = 100;
  f.gateway.provider.getBlockNumber = async () => head;
  const encoded = iface.encodeEventLog(iface.getEvent("DisputeResolved"), [f.session.chainJobId, arbitrator, 1800000n,
    encodeBytes32String("DISPUTE_OVERTURNED"), prepared.decoded.metadataURI]);
  f.gateway.provider.getLogs = async () => [{ address: escrow, topics: encoded.topics, data: encoded.data,
    transactionHash: `0x${"22".repeat(32)}`, blockNumber: 101, index: 1 }];
  const listener = new EventListener(f.gateway, { publish: () => {} }, f.store, { disputeArbitration: f.service, confirmations: 0 });
  await listener.start(); t.after(() => listener.stop()); head = 101;
  const upsert = f.store.upsertSession.bind(f.store);
  let fail = true;
  f.store.upsertSession = async (...args) => { if (fail) { fail = false; throw new Error("transient store outage"); } return upsert(...args); };
  await listener.pollOnce();
  assert.equal(listener.lastBlock, 100);
  assert.equal((await f.store.getSession(f.session.sessionId)).status, "disputed");
  const routes = createDisputeRoutes({ gateway: f.gateway, stateStore: f.store,
    service: { listRecentSessions: () => f.store.listRecentSessions() } });
  assert.equal((await routes.listDisputes(50))[0].convergenceStatus, "pending");
  await listener.pollOnce();
  assert.equal(listener.lastBlock, 101);
  const settled = await f.store.getSession(f.session.sessionId);
  assert.equal(settled.status, "resolved"); assert.equal(settled.statusHistory.length, 2);
  assert.equal((await routes.listDisputes(50))[0].convergenceStatus, "confirmed");
});
