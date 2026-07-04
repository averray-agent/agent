// Tests for scripts/ops/check-mainnet-deploy-readiness.mjs.
//
// The dry-run's value is an honest pre-deploy picture: chain target up, config
// artifacts present, and — the standout safety check — a WARN if DAILY_OUTFLOW_CAP
// is armed finite before audit-2 H-1 is deployed (arming it self-DoSes settlement).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAINNET,
  parseEnvText,
  classifyOutflowCap,
  classifyAdvance,
  hexToBigInt,
  runConfigReadiness,
  runChainTarget,
  deploySprintChecklist,
  REQUIRED_ARTIFACTS,
} from "./check-mainnet-deploy-readiness.mjs";

// ── pure helpers ────────────────────────────────────────────────────────

test("parseEnvText: KEY=VALUE, skips comments/blank", () => {
  const e = parseEnvText("# a comment\nAUTH_CHAIN_ID=420420419\n\n  RPC_URL=https://x/  \n#K=v");
  assert.equal(e.AUTH_CHAIN_ID, "420420419");
  assert.equal(e.RPC_URL, "https://x/");
  assert.equal(e.K, undefined);
});

test("classifyOutflowCap: finite armed = warn; 0/unset/non-numeric = safe", () => {
  assert.equal(classifyOutflowCap("250000000").armed, true);
  assert.match(classifyOutflowCap("250000000").note, /DO NOT ARM.*H-1/u);
  assert.equal(classifyOutflowCap("0").armed, false);
  assert.equal(classifyOutflowCap("").armed, false);
  assert.equal(classifyOutflowCap(undefined).armed, false);
  assert.equal(classifyOutflowCap("abc").armed, false);
});

test("classifyAdvance: b2>b1 advancing; equal frozen", () => {
  assert.equal(classifyAdvance(10, 11).advancing, true);
  assert.equal(classifyAdvance(11, 11).advancing, false);
});

test("hexToBigInt", () => {
  assert.equal(hexToBigInt("0x190f1b43"), 420420419n);
  assert.throws(() => hexToBigInt("nope"), /not a hex/u);
});

// ── config readiness (injected fs) ──────────────────────────────────────

const ALL_PRESENT = { exists: () => true };
function envFixture(overrides = {}) {
  const base = { AUTH_CHAIN_ID: "420420419", RPC_URL: "https://eth-rpc.polkadot.io/", DAILY_OUTFLOW_CAP: "250000000", ...overrides };
  return Object.entries(base).map(([k, v]) => `${k}=${v}`).join("\n");
}

test("config: all artifacts present + correct identity → passes, cap warns", () => {
  const checks = runConfigReadiness({ exists: () => true, readFile: () => envFixture() });
  for (const a of REQUIRED_ARTIFACTS) assert.equal(checks.find((c) => c.name === a.path).status, "pass");
  assert.equal(checks.find((c) => c.name === "env:AUTH_CHAIN_ID").status, "pass");
  assert.equal(checks.find((c) => c.name === "env:RPC_URL").status, "pass");
  assert.equal(checks.find((c) => c.name === "env:DAILY_OUTFLOW_CAP").status, "warn");
});

test("config: a missing artifact is a fail", () => {
  const checks = runConfigReadiness({ exists: (p) => p !== "scripts/ops/bootstrap-mainnet-vault.mjs", readFile: () => envFixture() });
  assert.equal(checks.find((c) => c.name === "scripts/ops/bootstrap-mainnet-vault.mjs").status, "fail");
});

test("config: wrong AUTH_CHAIN_ID / testnet RPC are fails; cap=0 is safe", () => {
  const checks = runConfigReadiness({ exists: () => true, readFile: () => envFixture({ AUTH_CHAIN_ID: "420420417", RPC_URL: "https://eth-rpc-testnet.polkadot.io/", DAILY_OUTFLOW_CAP: "0" }) });
  assert.equal(checks.find((c) => c.name === "env:AUTH_CHAIN_ID").status, "fail");
  assert.equal(checks.find((c) => c.name === "env:RPC_URL").status, "fail");
  assert.equal(checks.find((c) => c.name === "env:DAILY_OUTFLOW_CAP").status, "pass");
});

// ── chain target (mock fetch) ───────────────────────────────────────────

const hx = (n) => "0x" + BigInt(n).toString(16);
function mockChain({ chainId = MAINNET.chainId, frozen = false } = {}) {
  let block = 1000;
  return async (_url, init) => {
    const { method } = JSON.parse(init.body);
    let result;
    if (method === "eth_chainId") result = hx(chainId);
    else if (method === "eth_getBlockByNumber") { if (!frozen) block += 1; result = { number: hx(block) }; }
    else if (method === "eth_call") result = hx(0n);
    return { ok: true, status: 200, json: async () => ({ result }) };
  };
}
const chainOpts = (fetchImpl) => ({ fetchImpl, sleep: async () => {} });

test("chain target: live advancing mainnet → chainReady", async () => {
  const r = await runChainTarget(chainOpts(mockChain()));
  assert.equal(r.chainReady, true);
  assert.equal(r.checks.find((c) => c.name === "advancing").status, "pass");
});

test("chain target: wrong chainId → not ready", async () => {
  const r = await runChainTarget(chainOpts(mockChain({ chainId: 420420417 })));
  assert.equal(r.chainReady, false);
});

test("chain target: frozen chain → advancing fail", async () => {
  const r = await runChainTarget(chainOpts(mockChain({ frozen: true })));
  assert.equal(r.chainReady, false);
  assert.equal(r.checks.find((c) => c.name === "advancing").status, "fail");
});

test("chain target: unreachable → single chainId fail, short-circuit", async () => {
  const r = await runChainTarget(chainOpts(async () => { throw new Error("down"); }));
  assert.equal(r.chainReady, false);
  assert.equal(r.checks.length, 1);
});

// ── sprint checklist ────────────────────────────────────────────────────

test("sprint: chain+config ready → first two READY, audit+ceremony PENDING", () => {
  const s = deploySprintChecklist({ chainReady: true, configReady: true, mainnetJsonExists: false });
  assert.equal(s[0].ready, true); // chain target
  assert.equal(s[1].ready, true); // config
  assert.equal(s[2].ready, false); // audited build (long pole)
  assert.ok(s.some((x) => /mainnet\.json/.test(x.step) && !x.ready)); // ceremony pending
  assert.ok(s.some((x) => /DAILY_OUTFLOW_CAP kept UNARMED/.test(x.step))); // H-1 safety gate present
});
