import assert from "node:assert/strict";
import test from "node:test";

import {
  PUBLIC_IDENTITY_CLASSES,
  SELF_IDENTITY_AUTHORITY,
  SELF_IDENTITY_KINDS,
  SelfIdentityRegistry,
  createSelfIdentityRegistry,
  describeSelfIdentity
} from "./self-identity-registry.js";

const OPERATOR = "0x1111111111111111111111111111111111111111";
const ACCEPTANCE = "0x2222222222222222222222222222222222222222";
const ADMIN = "0x3333333333333333333333333333333333333333";
const VERIFIER = "0x4444444444444444444444444444444444444444";
const CANARY = "0x5555555555555555555555555555555555555555";
const OUTSIDER = "0x6666666666666666666666666666666666666666";
const RETAINED_ACCEPTANCE = "0x60385dD643f10934E8F384aC7A04c0D798dFc936";
const BLIND_TESTER = "0x97450BF69Cb4aEB0b33db3aE51AC2D18224d4b5c";

test("the shared registry composes operator, acceptance, admin, verifier, and client identities", () => {
  const registry = createSelfIdentityRegistry({
    env: {
      ARRIVAL_SELF_WALLETS: OPERATOR.toUpperCase(),
      ARRIVAL_ACCEPTANCE_WALLETS: ACCEPTANCE,
      ARRIVAL_SELF_CLIENTS: " smoke-probe ",
      ARRIVAL_AMBIGUOUS_CLIENTS: "shared-tool"
    },
    authConfig: {
      adminWallets: new Set([ADMIN]),
      verifierWallets: new Set([VERIFIER])
    }
  });

  assert.equal(registry.classify({ wallet: OPERATOR }).kind, SELF_IDENTITY_KINDS.OPERATOR);
  assert.equal(registry.classify({ wallet: ACCEPTANCE }).kind, SELF_IDENTITY_KINDS.ACCEPTANCE);
  assert.equal(registry.classify({ wallet: ADMIN }).kind, SELF_IDENTITY_KINDS.ADMIN_CONSOLE);
  assert.equal(registry.classify({ wallet: VERIFIER }).kind, SELF_IDENTITY_KINDS.VERIFIER);
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

test("retained acceptance is self while the blind tester remains external", () => {
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
