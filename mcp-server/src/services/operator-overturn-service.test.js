import test from "node:test";
import assert from "node:assert/strict";
import { OperatorOverturnService } from "./operator-overturn-service.js";
import { MemoryStateStore } from "../core/state-store.js";
import { buildJobSnapshot } from "../core/job-snapshot.js";
import { transitionSession, canTransitionSession } from "../core/session-state-machine.js";
import { VerifierService } from "./verifier-service.js";
import { buildAgentProfile } from "../core/agent-profile.js";
import { createDisputeRoutes } from "../protocols/http/dispute-routes.js";
import { disputeIdForSession } from "../core/dispute-resolution.js";

const wallet = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const job = { id: "removed-github-job", title: "Patch", rewardAmount: 2, rewardAsset: "USDC" };
const now = new Date("2026-09-13T00:00:00Z");
const original = { outcome: "rejected", score: 80, reasonCode: "GITHUB_PR_EVIDENCE_INCOMPLETE" };
async function fixture(state = 4, at = now) {
  const store = new MemoryStateStore();
  const session = await store.upsertSession({ sessionId: "overturn-session", jobId: job.id, chainJobId: "chain-job",
    wallet, status: "rejected", jobSnapshot: buildJobSnapshot(job), statusHistory: [{ to: "rejected" }] });
  await store.upsertVerificationResult(session.sessionId, original);
  const live = { state, worker: wallet, specHash: session.jobSnapshot.specHash,
    rejectedAt: now.getTime() / 1000 - 60, released: 0, reward: 2 };
  const calls = [], events = [];
  const gateway = { isEnabled: () => true, getJob: async () => ({ ...live }), getDisputeWindowSeconds: async () => 60,
    openDispute: async (...args) => {
      assert.equal((await store.getSession(session.sessionId)).operatorOverturn.origin, "operator_overturn");
      calls.push(args); live.state = 5;
    } };
  const service = new OperatorOverturnService({ stateStore: store, gateway, now: () => at, eventBus: { publish: (e) => events.push(e) } });
  return { store, session, live, calls, events, gateway, service,
    run: () => service.overturn({ sessionId: session.sessionId, rationale: "Platform footer error", operator: wallet }) };
}

test("overturn uses the snapshot with no catalogue, permits the exact window boundary, and replays without a second chain call", async () => {
  const f = await fixture();
  const result = await f.run();
  assert.deepEqual(f.calls, [["chain-job", wallet]]);
  assert.equal(result.status, "disputed");
  assert.equal(result.statusHistory.at(-1).reason, "platform_fault_operator_overturn");
  assert.equal(result.statusHistory.at(-1).metadata.origin, "operator_overturn");
  assert.equal(f.events[0].topic, "platform.overturn_dispute_opened");
  assert.equal(f.events[0].data.workerInitiated, false);
  assert.deepEqual(await f.run(), result);
  assert.equal(f.calls.length, 1);
  assert.equal(f.events.length, 1);
});

test("one second after the chain window fails closed with its end time and no write; wrong worker also refuses", async () => {
  const f = await fixture(4, new Date(now.getTime() + 1000));
  await assert.rejects(f.run(), (error) => error.code === "overturn_window_closed" && error.statusCode === 409
    && error.details.windowEndsAt === now.toISOString());
  assert.equal(f.calls.length, 0);
  assert.equal((await f.store.getSession(f.session.sessionId)).operatorOverturn, undefined);
  const mismatch = await fixture();
  mismatch.live.worker = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  await assert.rejects(mismatch.run(), { code: "overturn_worker_mismatch" });
  assert.equal(mismatch.calls.length, 0);
});

test("chain already Disputed converges only; rejected to disputed is forbidden without operator origin", async () => {
  const f = await fixture(5, new Date(now.getTime() + 1000));
  assert.equal((await f.run()).status, "disputed");
  assert.equal(f.calls.length, 0);
  for (const metadata of [undefined, {}, { origin: "worker" }]) {
    assert.equal(canTransitionSession(f.session, "disputed", { metadata }), false);
    assert.throws(() => transitionSession(f.session, "disputed", { metadata }), { code: "invalid_session_transition" });
  }
});

test("hardware payout convergence resolves an overturn, excludes the historic rejection, and preserves the original verifier result", async () => {
  const f = await fixture();
  await f.run();
  const verifier = new VerifierService({}, f.store, f.gateway);
  assert.equal((await verifier.getResult(f.session.sessionId)).outcome, "disputed");
  f.live.state = 6;
  f.live.released = 2;
  const gateway = { ...f.gateway, resolveDispute: () => { throw new Error("hardware only"); },
    requireArbitratorSigner: () => { throw new Error("hardware only"); },
    getTreasuryPolicyStatus: async () => ({ signerIsArbitrator: false }) };
  const service = { listRecentSessions: () => f.store.listRecentSessions(), resumeSession: (id) => f.store.getSession(id) };
  const response = {};
  const routes = createDisputeRoutes({ gateway, service, stateStore: f.store,
    authMiddleware: async () => ({ wallet, claims: { roles: ["admin"] } }), hasRole: (c, r) => c.roles.includes(r),
    parseLimit: () => 50, readJsonBody: async () => ({ verdict: "dismissed", rationale: "Hardware paid the worker" }),
    buildScopedIdempotentMutationContext: () => ({}), getIdempotentMutationReplay: async () => undefined,
    persistContentRecord: async () => {}, respond: (_r, _s, body) => { response.body = body; },
    respondWithMutationReceipt: async (_r, _i, _s, body) => { response.body = body; }
  });
  const disputes = await routes.listDisputes(50);
  assert.equal(disputes[0].origin, "operator_overturn");
  assert.equal(disputes[0].workerInitiated, false);
  assert.equal(disputes[0].rationale, "Platform footer error");
  const path = `/disputes/${disputeIdForSession(f.session.sessionId)}/verdict`;
  await routes.handleDisputeRoute({ request: { method: "POST" }, response, url: new URL(path, "http://localhost"), pathname: path });
  const session = await f.store.getSession(f.session.sessionId);
  assert.equal(session.status, "resolved");
  assert.equal(session.operatorOverturn.resolution.workerPayout, 2);
  const result = await verifier.getResult(session.sessionId);
  assert.equal(result.outcome, "approved");
  assert.equal(result.sessionStatus, "resolved");
  assert.equal(result.workerPayout, 2);
  assert.deepEqual(result.originalVerdict, original);
  assert.deepEqual(await f.store.getVerificationResult(session.sessionId), original);
  const profile = buildAgentProfile({ wallet, sessions: [{ ...session, verification: original }], getJobDefinition: () => { throw new Error("catalogue absent"); } });
  assert.equal(profile.stats.rejectedCount, 0);
  assert.equal(profile.stats.totalEarned.amount, "2000000");
  assert.equal(profile.badges[0].overturn.origin, "operator_overturn");
  assert.equal(profile.disputes[0].status, "resolved");
  assert.equal(profile.disputes[0].workerInitiated, false);
  // Model a crash after the durable verdict receipt but before local status.
  await f.store.upsertSession({ ...session, status: "disputed", operatorOverturn: { ...session.operatorOverturn, resolution: undefined } });
  await routes.handleDisputeRoute({ request: { method: "POST" }, response, url: new URL(path, "http://localhost"), pathname: path });
  assert.equal((await f.store.getSession(session.sessionId)).status, "resolved");
  assert.equal((await verifier.getResult(session.sessionId)).workerPayout, 2);
});

test("a failed opening checkpoint is still rejected in the result until chain Disputed confirms", async () => {
  const f = await fixture();
  f.gateway.openDispute = async () => { throw new Error("RPC unavailable"); };
  await assert.rejects(f.run(), /RPC unavailable/);
  const verifier = new VerifierService({}, f.store, f.gateway);
  assert.deepEqual(await verifier.getResult(f.session.sessionId), original);
});
