import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { getAddress } from "ethers";

import { MemoryStateStore } from "./state-store.js";
import { readGithubAuthors } from "../services/github-author-visibility.js";
import {
  ADMIN_OURS_LIMIT,
  ADMIN_OURS_SCOPE,
  PUBLIC_IDENTITY_CLASSES,
  SELF_IDENTITY_AUTHORITY,
  SELF_IDENTITY_KINDS,
  SERVER_CANARY_CREATED_BY,
  SelfIdentityRegistry,
  createSelfIdentityRegistry,
  describeSelfIdentity,
  editAdminOurs,
  normalizeApiKeyId
} from "./self-identity-registry.js";

const OPERATOR = "0x1111111111111111111111111111111111111111";
const ACCEPTANCE = "0x2222222222222222222222222222222222222222";
const ADMIN = "0x3333333333333333333333333333333333333333";
const VERIFIER = "0x4444444444444444444444444444444444444444";
const VIEWER = "0x7777777777777777777777777777777777777777";
const CANARY = "0x5555555555555555555555555555555555555555";
const OUTSIDER = "0x6666666666666666666666666666666666666666";
const RETAINED_ACCEPTANCE = "0x60385dD643f10934E8F384aC7A04c0D798dFc936";
const BLIND_TESTER = "0x97450BF69Cb4aEB0b33db3aE51AC2D18224d4b5c";

function readTemplateEnv(relativePath) {
  return Object.fromEntries(
    readFileSync(new URL(relativePath, import.meta.url), "utf8")
      .split("\n")
      .filter((line) => /^[A-Z][A-Z0-9_]*=/u.test(line))
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      })
  );
}

test("the shared registry composes operator, acceptance, admin, verifier, viewer, and client identities", () => {
  const registry = createSelfIdentityRegistry({
    env: {
      ARRIVAL_SELF_WALLETS: OPERATOR.toUpperCase(),
      ARRIVAL_ACCEPTANCE_WALLETS: ACCEPTANCE,
      ARRIVAL_SELF_CLIENTS: " smoke-probe ",
      ARRIVAL_AMBIGUOUS_CLIENTS: "shared-tool"
    },
    authConfig: {
      adminWallets: new Set([ADMIN]),
      verifierWallets: new Set([VERIFIER]),
      viewerWallets: new Set([VIEWER])
    }
  });

  assert.equal(registry.classify({ wallet: OPERATOR }).kind, SELF_IDENTITY_KINDS.OPERATOR);
  assert.equal(registry.classify({ wallet: ACCEPTANCE }).kind, SELF_IDENTITY_KINDS.ACCEPTANCE);
  assert.equal(registry.classify({ wallet: ADMIN }).kind, SELF_IDENTITY_KINDS.ADMIN_CONSOLE);
  assert.equal(registry.classify({ wallet: VERIFIER }).kind, SELF_IDENTITY_KINDS.VERIFIER);
  assert.equal(registry.classify({ wallet: VIEWER }).kind, SELF_IDENTITY_KINDS.VIEWER);
  assert.equal(registry.classify({ clientInfo: { name: "Smoke-Probe" } }).kind, SELF_IDENTITY_KINDS.CLIENT);
  assert.equal(registry.classify({ clientInfo: { name: "averray-roadmap" } }).self, true);
  assert.equal(registry.classify({ clientInfo: { name: "Anthropic/ClaudeAI" } }).ambiguous, true);
  assert.equal(registry.classify({ clientInfo: { name: "shared-tool" } }).ambiguous, true);
});

test("a durable per-run canary marker classifies an ephemeral wallet without a static allowlist", () => {
  const registry = new SelfIdentityRegistry();
  const identity = registry.classify({
    wallet: CANARY,
    session: {
      wallet: CANARY,
      claimantAttribution: {
        kind: "hosted_worker_canary",
        evidence: "wallet_bound_marker_v1"
      }
    }
  });
  assert.deepEqual(identity, {
    actor: "self",
    self: true,
    ambiguous: false,
    kind: "canary",
    evidence: "wallet_bound_canary_marker"
  });
});

test("an invalid canary marker and every unlisted wallet fail toward external", () => {
  const registry = new SelfIdentityRegistry({ operatorWallets: [OPERATOR] });
  assert.equal(registry.classify({ wallet: OPERATOR, canaryMarkerValid: false }).self, false);
  assert.equal(registry.classify({ wallet: OUTSIDER }).self, false);
  assert.equal(registry.classify({}).self, false);
});

test("qa, blind-user, canary, and operator-script wallets and api-key ids are self", () => {
  const qa = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const blind = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const canary = "0xcccccccccccccccccccccccccccccccccccccccc";
  const script = "0xdddddddddddddddddddddddddddddddddddddddd";
  const outsider = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  const registry = createSelfIdentityRegistry({
    env: {
      ARRIVAL_QA_ENGINEER_WALLETS: qa.toUpperCase(),
      ARRIVAL_BLIND_USER_WALLETS: blind,
      ARRIVAL_CANARY_WALLETS: canary,
      ARRIVAL_OPERATOR_SCRIPT_WALLETS: script,
      ARRIVAL_QA_ENGINEER_API_KEY_IDS: "grant-qa-engineer",
      ARRIVAL_BLIND_USER_API_KEY_IDS: "grant-blind-user",
      ARRIVAL_CANARY_API_KEY_IDS: "grant-canary",
      ARRIVAL_OPERATOR_SCRIPT_API_KEY_IDS: "grant-operator-script, sk-live-secret-value"
    }
  });

  assert.equal(registry.classify({ wallet: qa }).kind, SELF_IDENTITY_KINDS.QA_ENGINEER);
  assert.equal(registry.classify({ wallet: blind }).kind, SELF_IDENTITY_KINDS.BLIND_USER);
  assert.equal(registry.classify({ wallet: canary }).kind, SELF_IDENTITY_KINDS.CANARY);
  assert.equal(registry.classify({ wallet: script }).kind, SELF_IDENTITY_KINDS.OPERATOR_SCRIPT);
  assert.equal(registry.classify({ apiKeyId: "grant-qa-engineer", wallet: outsider }).self, true);
  assert.equal(registry.classify({ apiKeyId: "grant-blind-user" }).kind, SELF_IDENTITY_KINDS.BLIND_USER);
  assert.equal(registry.classify({ apiKeyId: "grant-canary" }).evidence, "canary_api_key_registry");
  assert.equal(registry.classify({ apiKeyId: "grant-operator-script" }).kind, SELF_IDENTITY_KINDS.OPERATOR_SCRIPT);
  assert.equal(registry.classify({ wallet: outsider }).self, false);
  assert.equal(registry.classify({ apiKeyId: "grant-unknown", wallet: outsider }).self, false);
  assert.equal(normalizeApiKeyId("sk-live-secret-value"), undefined);
  assert.equal(registry.operatorScriptApiKeyIds.has("sk-live-secret-value"), false);
  assert.equal(
    normalizeApiKeyId("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    undefined
  );
});

test("an unregistered blind tester stays external", () => {
  const registry = createSelfIdentityRegistry({
    env: { ARRIVAL_ACCEPTANCE_WALLETS: RETAINED_ACCEPTANCE }
  });

  const acceptance = registry.classify({ wallet: RETAINED_ACCEPTANCE });
  const tester = registry.classify({ wallet: BLIND_TESTER });
  assert.equal(acceptance.self, true);
  assert.equal(acceptance.kind, SELF_IDENTITY_KINDS.ACCEPTANCE);
  assert.equal(describeSelfIdentity(acceptance).classification, PUBLIC_IDENTITY_CLASSES.OPERATOR_RUN);
  assert.equal(tester.self, false);
  assert.equal(describeSelfIdentity(tester).classification, PUBLIC_IDENTITY_CLASSES.EXTERNAL);
  assert.equal(describeSelfIdentity(tester).authority, SELF_IDENTITY_AUTHORITY);
});

test("env templates document operator identity slots as empty placeholders", () => {
  const keys = [
    "ARRIVAL_QA_ENGINEER_WALLETS",
    "ARRIVAL_QA_ENGINEER_API_KEY_IDS",
    "ARRIVAL_BLIND_USER_WALLETS",
    "ARRIVAL_BLIND_USER_API_KEY_IDS",
    "ARRIVAL_CANARY_WALLETS",
    "ARRIVAL_CANARY_API_KEY_IDS",
    "ARRIVAL_OPERATOR_SCRIPT_WALLETS",
    "ARRIVAL_OPERATOR_SCRIPT_API_KEY_IDS"
  ];
  for (const env of [
    readTemplateEnv("../../../deploy/backend.env.template"),
    readTemplateEnv("../../../deploy/backend.mainnet.env.template")
  ]) {
    for (const key of keys) {
      assert.equal(env[key], "", `${key} must stay an empty placeholder`);
    }
    const registry = createSelfIdentityRegistry({ env });
    assert.equal(registry.qaEngineerWallets.size, 0);
    assert.equal(registry.blindUserWallets.size, 0);
    assert.equal(registry.canaryWallets.size, 0);
    assert.equal(registry.operatorScriptWallets.size, 0);
    assert.equal(registry.qaEngineerApiKeyIds.size, 0);
  }
});

test("mainnet env template registers the retained acceptance wallet as self", () => {
  const defaultEnv = readTemplateEnv("../../../deploy/backend.env.template");
  const mainnetEnv = readTemplateEnv("../../../deploy/backend.mainnet.env.template");

  assert.equal(defaultEnv.ARRIVAL_ACCEPTANCE_WALLETS, "");
  assert.equal(mainnetEnv.ARRIVAL_ACCEPTANCE_WALLETS, RETAINED_ACCEPTANCE);

  const registry = createSelfIdentityRegistry({ env: mainnetEnv });
  const acceptance = registry.classify({ wallet: RETAINED_ACCEPTANCE });
  assert.equal(acceptance.self, true);
  assert.equal(acceptance.kind, SELF_IDENTITY_KINDS.ACCEPTANCE);
});

test("the operator-viewer allowlist stays empty on testnet and names only the monitor read wallet on mainnet", () => {
  const defaultEnv = readTemplateEnv("../../../deploy/backend.env.template");
  const mainnetEnv = readTemplateEnv("../../../deploy/backend.mainnet.env.template");

  assert.equal(defaultEnv.OPERATOR_VIEWER_WALLETS, "");
  // The board's dedicated read identity — no funds, no transactions, reads
  // only. Any addition here grants operator READ access, so the list is
  // pinned: a new entry must be a deliberate, reviewed change.
  assert.equal(
    mainnetEnv.OPERATOR_VIEWER_WALLETS,
    "0x062DE35F58DE288B34d7b889E5aBe3cb09862a8A"
  );
});

test("session classification follows durable canary evidence through the shared authority", () => {
  const registry = new SelfIdentityRegistry();
  const identity = registry.classifySessions({
    wallet: CANARY,
    sessions: [{
      wallet: CANARY,
      claimantAttribution: {
        kind: "hosted_worker_canary",
        evidence: "wallet_bound_marker_v1"
      }
    }]
  });

  assert.equal(identity.kind, SELF_IDENTITY_KINDS.CANARY);
  assert.deepEqual(describeSelfIdentity(identity), {
    classification: "operator-run",
    kind: "canary",
    authority: "shared_self_identity_registry",
    evidence: "wallet_bound_canary_marker"
  });
});

test("an empty admin ours list classifies exactly as a registry that has never heard of it", async () => {
  const plain = new SelfIdentityRegistry({ operatorWallets: [OPERATOR] });
  const hydrated = new SelfIdentityRegistry({ operatorWallets: [OPERATOR] });
  await hydrated.hydrateAdminOurs({ getServiceState: async () => null });
  for (const wallet of [OPERATOR, OUTSIDER]) {
    assert.deepEqual(hydrated.classify({ wallet }), plain.classify({ wallet }));
  }
  assert.equal(JSON.stringify(describeSelfIdentity(hydrated.classify({ wallet: OUTSIDER }))).includes(OUTSIDER), false);
});

test("an outsider claiming a real canary job without the marker stays external", () => {
  const registry = new SelfIdentityRegistry({ operatorWallets: [OPERATOR] });
  const canaryJob = {
    id: "worker-canary-1786453506586",
    disposableProof: true,
    lineage: { createdBy: SERVER_CANARY_CREATED_BY }
  };
  for (const definition of [
    { id: "ordinary-job", disposableProof: true },
    { id: "worker-canary-1786453506586" },
    canaryJob
  ]) {
    const identity = registry.classify({
      wallet: OUTSIDER,
      session: { jobSnapshot: { definition } }
    });
    assert.equal(identity.actor, "external");
    assert.equal(identity.evidence, "unlisted_wallet");
    assert.equal(JSON.stringify(describeSelfIdentity(identity)).includes(OUTSIDER), false);
  }
  const invalid = registry.classify({
    wallet: OPERATOR,
    canaryMarkerValid: false,
    session: { jobSnapshot: { definition: canaryJob } }
  });
  assert.equal(invalid.actor, "external");
  assert.equal(invalid.evidence, "invalid_canary_marker");
  const marked = registry.classify({
    wallet: OUTSIDER,
    session: {
      claimantAttribution: { kind: "hosted_worker_canary", evidence: "wallet_bound_marker_v1" },
      jobSnapshot: { definition: canaryJob }
    }
  });
  assert.equal(marked.actor, "self");
  assert.equal(marked.evidence, "wallet_bound_canary_marker");
});

test("an admin ours wallet is excluded from the external lane burst and the public warning", async () => {
  const registry = new SelfIdentityRegistry();
  const store = new MemoryStateStore();
  const ours = "0x" + "ab".repeat(20);
  const external = (n) => "0x" + n.toString(16).padStart(40, "0");
  await editAdminOurs(store, {
    action: "add", wallet: ours, label: "dogfood", purpose: "dogfood",
    addedBy: OPERATOR, reason: "listed", logger: { info() {} }
  });
  await registry.hydrateAdminOurs(store);
  const t0 = Date.parse("2026-10-14T03:00:00.000Z");
  const claim = (id, wallet) => ({
    sessionId: id, wallet, status: "claimed", claimedAt: new Date(t0).toISOString(),
    jobSnapshot: { definition: { verifierMode: "github_pr", source: { type: "github_issue", repo: "example/project", githubRepoId: 11, issueNumber: 1 } } }
  });
  for (const session of [claim("ours", ours), claim("e1", external(2)), claim("e2", external(3))]) {
    await store.upsertSession(session);
  }
  const result = await readGithubAuthors(store, {
    now: new Date(t0 + 60_000),
    selfIdentityRegistry: registry
  });
  assert.equal(result.warnings.some((warning) => warning.code === "github_lane_claim_burst"), false);
  assert.equal(result.claimGuardrails.lane.ours >= 1, true);
  assert.equal(JSON.stringify(result.warnings).includes(ours), false);
  assert.equal(JSON.stringify(describeSelfIdentity(registry.classify({ wallet: ours }))).includes(ours), false);
});

test("ours edits store the reason, keep a removal history, cap the list, and checksum wallets", async () => {
  const store = new MemoryStateStore();
  const logs = [];
  const logger = { info(payload) { logs.push(payload); } };
  const ours = "0x" + "ab".repeat(20);
  const edited = await editAdminOurs(store, {
    action: "add", wallet: ours, label: "dogfood", purpose: "dogfood",
    addedBy: OPERATOR, reason: "listed for dogfood", logger
  });
  const checksum = getAddress(ours);
  assert.equal(edited.wallets[0].wallet, checksum);
  assert.equal(edited.wallets[0].reason, "listed for dogfood");
  assert.equal(logs[0].reason, "listed for dogfood");
  assert.equal(logs[0].wallet, checksum);
  assert.equal(logs[0].event, "self_identity_ours_edited");
  const removed = await editAdminOurs(store, {
    action: "remove", wallet: checksum, reason: "rotated out", addedBy: OPERATOR, logger
  });
  assert.equal(removed.count, 0);
  assert.equal(removed.removals.length, 1);
  assert.equal(removed.removals[0].wallet, checksum);
  assert.equal(removed.removals[0].reason, "rotated out");
  assert.equal(removed.removals[0].removedBy, getAddress(OPERATOR));
  assert.equal(typeof removed.removals[0].removedAt, "string");
  assert.equal(logs[1].reason, "rotated out");
  assert.equal(logs[1].action, "remove");
  const stored = await store.getServiceState(ADMIN_OURS_SCOPE);
  assert.deepEqual(stored.removals, removed.removals);
  assert.equal(stored.wallets.length, 0);
  const registry = new SelfIdentityRegistry();
  await registry.hydrateAdminOurs(store);
  assert.equal(registry.classify({ wallet: ours }).actor, "external");

  for (let index = 0; index < ADMIN_OURS_LIMIT; index += 1) {
    await editAdminOurs(store, {
      action: "add",
      wallet: "0x" + (index + 1).toString(16).padStart(40, "0"),
      label: "dogfood",
      purpose: "cap",
      addedBy: OPERATOR,
      reason: "cap fill",
      logger
    });
  }
  await assert.rejects(
    () => editAdminOurs(store, {
      action: "add", wallet: ours, label: "dogfood", purpose: "cap",
      addedBy: OPERATOR, reason: "one past the cap", logger
    }),
    (error) => error.message === "The ours list is full."
  );
  assert.equal((await store.getServiceState(ADMIN_OURS_SCOPE)).wallets.length, ADMIN_OURS_LIMIT);
});

test("ours edits use a service lock and a held claim lock does not block them", async () => {
  const store = new MemoryStateStore();
  await store.acquireClaimLock(ADMIN_OURS_SCOPE, "job-claim-owner", 30);
  const firstWallet = "0x" + "11".repeat(20);
  const secondWallet = "0x" + "22".repeat(20);
  const original = store.getServiceState.bind(store);
  let reads = 0;
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  store.getServiceState = async (scope) => {
    const value = await original(scope);
    if (scope === ADMIN_OURS_SCOPE) {
      reads += 1;
      if (reads === 1) await hold;
    }
    return value;
  };
  const input = (wallet) => ({
    action: "add", wallet, label: "dogfood", purpose: "lock",
    addedBy: OPERATOR, reason: "concurrent", logger: { info() {} }
  });
  const first = editAdminOurs(store, input(firstWallet));
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    () => editAdminOurs(store, input(secondWallet)),
    (error) => error.code === "self_identity_ours_in_progress"
  );
  assert.equal(await store.acquireClaimLock(ADMIN_OURS_SCOPE, "job-claim-owner", 30), true);
  assert.equal(await store.acquireClaimLock("unrelated-job", "worker", 30), true);
  release();
  const saved = await first;
  assert.equal(saved.count, 1);
  assert.equal(await store.acquireServiceLock(ADMIN_OURS_SCOPE, "later", 30), true);
});
