import test from "node:test";
import assert from "node:assert/strict";

import {
  REPO,
  SA_TOKEN_REGISTRY,
  planRotation,
  validateTokenShape,
  buildGhSecretSetArgs,
  detectShadow,
  buildVpsUpdateCommand,
  parseArgs,
} from "./rotate-sa-token.mjs";

test("planRotation resolves a known token to its consumers", () => {
  const p = planRotation("prod-smoke-tests");
  assert.equal(p.tokenId, "prod-smoke-tests");
  assert.equal(p.consumers[0].name, "OP_SERVICE_ACCOUNT_TOKEN_PROD_SMOKE");
  assert.equal(p.consumers[0].env, "production");
});

test("planRotation throws on an unknown token, listing the known set", () => {
  assert.throws(() => planRotation("nope"), /unknown token "nope".*prod-ci-deploy/s);
});

test("every gh-secret consumer is pinned to env=production (the consumed scope)", () => {
  for (const entry of Object.values(SA_TOKEN_REGISTRY)) {
    for (const c of entry.consumers) {
      if (c.kind === "gh-secret") assert.equal(c.env, "production", `${c.name} must target env production`);
    }
  }
});

test("validateTokenShape: accepts a well-formed ops_ token", () => {
  const v = validateTokenShape("  ops_" + "a".repeat(80) + "  ");
  assert.equal(v.ok, true);
  assert.equal(v.token.startsWith("ops_"), true);
  assert.equal(/\s/.test(v.token), false); // trimmed
});

test("validateTokenShape: rejects empty, wrong-prefix, short, and whitespace-laden", () => {
  assert.equal(validateTokenShape("").ok, false);
  assert.equal(validateTokenShape("   ").ok, false);
  assert.equal(validateTokenShape("eyJabc" + "x".repeat(80)).ok, false); // no ops_ prefix
  assert.equal(validateTokenShape("ops_short").ok, false);
  assert.equal(validateTokenShape("ops_" + "a".repeat(40) + " " + "b".repeat(40)).ok, false); // inner whitespace
});

test("buildGhSecretSetArgs sets name + repo + env and NEVER the value (stdin only)", () => {
  const args = buildGhSecretSetArgs({ name: "OP_X", env: "production", repo: REPO });
  assert.deepEqual(args, ["secret", "set", "OP_X", "--repo", REPO, "--env", "production"]);
  assert.equal(args.includes("--body"), false);
  assert.equal(args.some((a) => a.startsWith("ops_")), false);
});

test("buildGhSecretSetArgs omits --env when env is falsy (repo scope)", () => {
  assert.deepEqual(buildGhSecretSetArgs({ name: "OP_X", env: null }), ["secret", "set", "OP_X", "--repo", REPO]);
});

test("detectShadow flags the dual-scope split-brain (the D-01 bug)", () => {
  const s = detectShadow({ name: "OP_X", repoScopeNames: ["OP_X"], envScopeNames: ["OP_X"] });
  assert.equal(s.shadowed, true);
  assert.equal(s.onlyRepo, false);
  assert.equal(s.onlyEnv, false);
});

test("detectShadow: onlyRepo means a repo-scoped rotation would be read by nothing", () => {
  const s = detectShadow({ name: "OP_X", repoScopeNames: ["OP_X"], envScopeNames: [] });
  assert.equal(s.onlyRepo, true);
  assert.equal(s.shadowed, false);
});

test("detectShadow: onlyEnv is the healthy single-scope end state", () => {
  const s = detectShadow({ name: "OP_X", repoScopeNames: [], envScopeNames: ["OP_X"] });
  assert.equal(s.onlyEnv, true);
  assert.equal(s.shadowed, false);
  assert.equal(s.missing, false);
});

test("buildVpsUpdateCommand rewrites only the one var, atomically, via stdin (no token in args)", () => {
  const cmd = buildVpsUpdateCommand({ path: "/etc/agent-stack/op-backend.env", var: "OP_SERVICE_ACCOUNT_TOKEN", service: "agent-stack-env-render" });
  assert.match(cmd, /grep -v '\^OP_SERVICE_ACCOUNT_TOKEN='/);
  assert.match(cmd, /install -m 0400 -o root -g root/);
  assert.match(cmd, /systemctl restart agent-stack-env-render\.service/);
  assert.match(cmd, /<PASTE_NEW_TOKEN>/); // placeholder, not a real value
});

test("parseArgs: defaults are dry-run, prod repo, env production, 7-day grace", () => {
  const a = parseArgs(["--token", "prod-ci-deploy"]);
  assert.equal(a.token, "prod-ci-deploy");
  assert.equal(a.commit, false);
  assert.equal(a.repo, REPO);
  assert.equal(a.env, "production");
  assert.equal(a.grace, 7);
});

test("parseArgs: --commit and overrides", () => {
  const a = parseArgs(["--token", "x", "--commit", "--env", "staging", "--grace", "3"]);
  assert.equal(a.commit, true);
  assert.equal(a.env, "staging");
  assert.equal(a.grace, 3);
});

test("parseArgs throws on unknown flags", () => {
  assert.throws(() => parseArgs(["--bogus"]));
});
