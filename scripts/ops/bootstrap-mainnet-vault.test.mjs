// Tests for scripts/ops/bootstrap-mainnet-vault.mjs.
//
// The script's whole value is getting the IMMUTABLE 1Password scope right once:
// no service-account token may read the mainnet-critical firebreak, no wildcard
// scope, mainnet-only vaults. These tests pin those invariants + the evidence
// shape check-mainnet-env-secrets-proof.mjs consumes, so a future edit to the
// topology can't silently widen a token or grant critical.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAINNET_VAULTS,
  MAINNET_SA_TOKENS,
  planTokens,
  assertScopes,
  buildVaultCreateCmd,
  buildServiceAccountCreateCmd,
  evidenceServiceTokens,
  parseArgs,
} from "./bootstrap-mainnet-vault.mjs";

// --- topology invariants --------------------------------------------------

test("mainnet-critical is the only firebreak vault, and no SA token reads it", () => {
  const firebreaks = MAINNET_VAULTS.filter((v) => v.firebreak).map((v) => v.name);
  assert.deepEqual(firebreaks, ["mainnet-critical"]);
  for (const [id, t] of Object.entries(MAINNET_SA_TOKENS)) {
    const scopes = [...(t.reads || []), ...(t.writes || [])];
    assert.ok(!scopes.includes("mainnet-critical"), `${id} must not read the firebreak`);
  }
});

test("every vault name is mainnet-scoped (no testnet/prod reuse)", () => {
  for (const v of MAINNET_VAULTS) assert.ok(v.name.startsWith("mainnet-"), v.name);
});

test("planTokens: four base tokens by default, plus the R+W one with --with-refresh-rw", () => {
  assert.deepEqual(Object.keys(planTokens()).sort(), ["ciDeploy", "smokeTests", "vpsBackend", "vpsIndexer"]);
  const withRw = planTokens({ withRefreshRw: true });
  assert.ok("refreshRw" in withRw);
  assert.deepEqual(withRw.refreshRw.writes, ["mainnet-backend"]);
});

test("the launch four map to the least-privilege scopes from the plan", () => {
  const t = MAINNET_SA_TOKENS;
  assert.deepEqual(t.ciDeploy.reads, ["mainnet-ci", "mainnet-ci-external"]);
  assert.deepEqual(t.vpsIndexer.reads, ["mainnet-indexer"]);
  assert.deepEqual(t.smokeTests.reads, ["mainnet-smoke"]); // firebreak: smoke reads ONLY smoke
});

// --- assertScopes: the fail-closed invariants -----------------------------

test("assertScopes: the real topology passes", () => {
  assert.doesNotThrow(() => assertScopes());
  assert.doesNotThrow(() => assertScopes(planTokens({ withRefreshRw: true })));
});

test("assertScopes: rejects a token that reads the firebreak vault", () => {
  assert.throws(
    () => assertScopes({ bad: { account: "x", reads: ["mainnet-critical"] } }),
    /firebreak vault 'mainnet-critical'/u
  );
});

test("assertScopes: rejects wildcard, unknown, non-mainnet, and empty scopes", () => {
  assert.throws(() => assertScopes({ b: { account: "x", reads: ["*"] } }), /wildcard/u);
  assert.throws(() => assertScopes({ b: { account: "x", reads: ["all"] } }), /wildcard/u);
  assert.throws(() => assertScopes({ b: { account: "x", reads: ["mainnet-nope"] } }), /unknown vault/u);
  assert.throws(() => assertScopes({ b: { account: "x", reads: ["prod-backend"] } }), /unknown vault/u);
  assert.throws(() => assertScopes({ b: { account: "x", reads: [] } }), /empty scope/u);
});

// --- command builders -----------------------------------------------------

test("buildVaultCreateCmd quotes the vault name", () => {
  assert.equal(buildVaultCreateCmd({ name: "mainnet-backend" }), 'op vault create "mainnet-backend"');
});

test("buildServiceAccountCreateCmd emits whole-vault read grants + 90d expiry", () => {
  const cmd = buildServiceAccountCreateCmd(MAINNET_SA_TOKENS.ciDeploy);
  assert.match(cmd, /op service-account create "averray-mainnet-ci-deploy"/u);
  assert.match(cmd, /--expires-in 90d/u);
  assert.match(cmd, /--vault mainnet-ci:read_items/u);
  assert.match(cmd, /--vault mainnet-ci-external:read_items/u);
  assert.ok(!/write_items/u.test(cmd), "base tokens are read-only");
});

test("buildServiceAccountCreateCmd adds write grants only for the R+W token", () => {
  const cmd = buildServiceAccountCreateCmd(planTokens({ withRefreshRw: true }).refreshRw);
  assert.match(cmd, /--vault mainnet-backend:read_items/u);
  assert.match(cmd, /--vault mainnet-backend:write_items/u);
});

// --- evidence block (feeds check-mainnet-env-secrets-proof.mjs) -----------

test("evidenceServiceTokens: mainnetOnly + no critical + non-empty vaults, realized=false in dry-run", () => {
  const block = evidenceServiceTokens();
  for (const [id, e] of Object.entries(block)) {
    assert.equal(e.mainnetOnly, true, `${id} mainnetOnly`);
    assert.equal(e.reusedTestnetToken, false, `${id} reusedTestnetToken`);
    assert.equal(e.rawTokenRendered, false, `${id} rawTokenRendered`);
    assert.equal(e.grantsCritical, false, `${id} grantsCritical`);
    assert.ok(e.vaults.length > 0, `${id} vaults non-empty`);
    assert.equal(e.realized, false, `${id} realized=false in dry-run`);
  }
});

test("evidenceServiceTokens: realized flips true when a matching op read is supplied", () => {
  const block = evidenceServiceTokens(MAINNET_SA_TOKENS, {
    "averray-mainnet-smoke-tests": { id: "abc" },
  });
  assert.equal(block.smokeTests.realized, true);
  assert.equal(block.ciDeploy.realized, false);
});

// --- parseArgs ------------------------------------------------------------

test("parseArgs: defaults, flags, and unknown-flag rejection", () => {
  assert.deepEqual(parseArgs([]), { verify: false, withRefreshRw: false });
  assert.equal(parseArgs(["--verify"]).verify, true);
  assert.equal(parseArgs(["--with-refresh-rw"]).withRefreshRw, true);
  assert.throws(() => parseArgs(["--nope"]), /unknown flag/u);
});
