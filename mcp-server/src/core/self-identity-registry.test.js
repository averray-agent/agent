import assert from "node:assert/strict";
import test from "node:test";

import {
  SELF_IDENTITY_KINDS,
  SelfIdentityRegistry,
  createSelfIdentityRegistry
} from "./self-identity-registry.js";

const OPERATOR = "0x1111111111111111111111111111111111111111";
const ACCEPTANCE = "0x2222222222222222222222222222222222222222";
const ADMIN = "0x3333333333333333333333333333333333333333";
const VERIFIER = "0x4444444444444444444444444444444444444444";
const CANARY = "0x5555555555555555555555555555555555555555";
const OUTSIDER = "0x6666666666666666666666666666666666666666";

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
