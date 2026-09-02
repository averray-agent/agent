import test from "node:test";
import assert from "node:assert/strict";

import { PolicyService } from "./policy-service.js";
import { BUILTIN_POLICIES } from "./builtin-policies.js";
import { MemoryStateStore } from "./state-store.js";

function silentLogger() {
  return { warn() {}, info() {}, error() {}, debug() {} };
}

const SAMPLE_PROPOSAL = {
  id: "p-proposed-abcdef01",
  tag: "operator/sample-proposal@v1",
  scope: "claim",
  scopeLabel: "Claim",
  severity: "gating",
  state: "Pending",
  revision: 1,
  signersReq: 2,
  signersTotal: 3,
  signerKeys: ["fd2e", "9a13", "3e42"],
  activeSince: null,
  lastChange: { text: "Proposed by smoke test", author: "fd2e", at: "2026-05-18 12:00:00 UTC" },
  rule: { v1: "{}" },
  history: []
};

test("PolicyService — listAll returns built-in seeds before proposals", () => {
  const service = new PolicyService({ seedPolicies: BUILTIN_POLICIES });
  service.propose({ ...SAMPLE_PROPOSAL });
  const all = service.listAll();
  // Every seed policy must still come first.
  assert.equal(all.length, BUILTIN_POLICIES.length + 1);
  for (let i = 0; i < BUILTIN_POLICIES.length; i += 1) {
    assert.equal(all[i].tag, BUILTIN_POLICIES[i].tag);
  }
  assert.equal(all[all.length - 1].tag, SAMPLE_PROPOSAL.tag);
});

test("PolicyService — findByTagOrId matches both the tag and the id field", () => {
  const service = new PolicyService({ seedPolicies: BUILTIN_POLICIES });
  service.propose({ ...SAMPLE_PROPOSAL });

  // built-in lookup by id
  const builtinById = service.findByTagOrId("p-claim-deps-sec-only");
  assert.ok(builtinById);
  assert.equal(builtinById.tag, "claim/deps-sec-only@v4");

  // built-in lookup by tag
  const builtinByTag = service.findByTagOrId("settle/receipt-before-payout@v1");
  assert.ok(builtinByTag);
  assert.equal(builtinByTag.id, "p-settle-receipt-before-payout");

  // proposal lookup by tag
  const proposalByTag = service.findByTagOrId(SAMPLE_PROPOSAL.tag);
  assert.equal(proposalByTag?.id, SAMPLE_PROPOSAL.id);

  // proposal lookup by id
  const proposalById = service.findByTagOrId(SAMPLE_PROPOSAL.id);
  assert.equal(proposalById?.tag, SAMPLE_PROPOSAL.tag);

  // unknown
  assert.equal(service.findByTagOrId("does-not-exist"), undefined);
  assert.equal(service.findByTagOrId(undefined), undefined);
});

test("PolicyService — every propose() mirrors out to the state-store", async () => {
  const stateStore = new MemoryStateStore();
  const service = new PolicyService({ stateStore, seedPolicies: [] });
  service.propose({ ...SAMPLE_PROPOSAL });
  service.propose({ ...SAMPLE_PROPOSAL, tag: "operator/second@v1", id: "p-second" });
  await service.flush();

  const tags = await stateStore.listPolicyProposalTags();
  assert.deepEqual(tags.sort(), ["operator/sample-proposal@v1", "operator/second@v1"]);
  const fetched = await stateStore.getPolicyProposal(SAMPLE_PROPOSAL.tag);
  assert.equal(fetched.scope, "claim");
});

test("PolicyService — sequential proposes for the same tag persist in order", async () => {
  const stateStore = new MemoryStateStore();
  const service = new PolicyService({ stateStore, seedPolicies: [] });
  service.propose({ ...SAMPLE_PROPOSAL, revision: 1 });
  service.propose({ ...SAMPLE_PROPOSAL, revision: 2 });
  service.propose({ ...SAMPLE_PROPOSAL, revision: 3 });
  await service.flush();
  const fetched = await stateStore.getPolicyProposal(SAMPLE_PROPOSAL.tag);
  // The final persist wins, not an arbitrary mid-state.
  assert.equal(fetched.revision, 3);
});

test("PolicyService — hydrate loads every persisted proposal into the cache", async () => {
  const stateStore = new MemoryStateStore();
  await stateStore.upsertPolicyProposal("operator/persisted-a@v1", {
    ...SAMPLE_PROPOSAL,
    tag: "operator/persisted-a@v1"
  });
  await stateStore.upsertPolicyProposal("operator/persisted-b@v1", {
    ...SAMPLE_PROPOSAL,
    tag: "operator/persisted-b@v1"
  });

  const service = new PolicyService({ stateStore, seedPolicies: [] });
  assert.equal(service.findByTagOrId("operator/persisted-a@v1"), undefined);

  const result = await service.hydrate();
  assert.equal(result.hydrated, 2);
  assert.equal(result.skipped, 0);

  const all = service.listAll();
  const tags = all.map((p) => p.tag).sort();
  assert.deepEqual(tags, ["operator/persisted-a@v1", "operator/persisted-b@v1"]);
});

test("PolicyService — degrades to in-memory when state-store is missing", async () => {
  const service = new PolicyService({ seedPolicies: [] });
  service.propose({ ...SAMPLE_PROPOSAL });
  await service.flush(); // must not throw
  const result = await service.hydrate();
  assert.equal(result.hydrated, 0);
  assert.match(result.reason, /state-store unavailable/u);
  assert.equal(service.findByTagOrId(SAMPLE_PROPOSAL.tag).id, SAMPLE_PROPOSAL.id);
});

test("PolicyService — persist failure is logged but does not crash the caller", async () => {
  const stateStore = {
    upsertPolicyProposal: async () => {
      throw new Error("redis_unavailable");
    }
  };
  const captured = [];
  const logger = {
    warn: (payload, message) => captured.push({ payload, message }),
    info() {},
    error() {},
    debug() {}
  };
  const service = new PolicyService({ stateStore, seedPolicies: [], logger });
  service.propose({ ...SAMPLE_PROPOSAL });
  await service.flush();
  assert.equal(captured.length, 1);
  assert.equal(captured[0].message, "policy.persist_failed");
  assert.equal(captured[0].payload.tag, SAMPLE_PROPOSAL.tag);
  // Cache still has the value even though persist failed.
  assert.equal(service.findByTagOrId(SAMPLE_PROPOSAL.tag).id, SAMPLE_PROPOSAL.id);
});

test("PolicyService — restart simulation: propose, drop the service, rebuild from state-store, proposal survives", async () => {
  // This is the audit-board close-output integration check for Package G:
  // "Integration test: propose a policy, restart the server, assert the
  // proposal is still visible." Same shape as the AccountOverlayStore
  // restart simulation from Package C.
  const stateStore = new MemoryStateStore();
  const before = new PolicyService({ stateStore, seedPolicies: BUILTIN_POLICIES, logger: silentLogger() });

  before.propose({
    ...SAMPLE_PROPOSAL,
    tag: "operator/restart-proof@v1",
    id: "p-restart-proof",
    lastChange: { text: "Persists across restart", author: "fd2e", at: "2026-05-18 12:00:00 UTC" }
  });
  await before.flush();

  // Simulated restart: discard `before`, build a fresh service sharing
  // the same state-store, hydrate.
  const after = new PolicyService({ stateStore, seedPolicies: BUILTIN_POLICIES, logger: silentLogger() });
  await after.hydrate();

  // Built-in policies must still be present (seed survives).
  assert.ok(after.findByTagOrId("claim/deps-sec-only@v4"));
  // Proposal must be present (persisted to state-store and reloaded).
  const proposal = after.findByTagOrId("operator/restart-proof@v1");
  assert.ok(proposal, "operator-proposed policy must survive restart");
  assert.equal(proposal.id, "p-restart-proof");
});
