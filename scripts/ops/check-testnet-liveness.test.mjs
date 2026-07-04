// Tests for scripts/ops/check-testnet-liveness.mjs.
//
// The gate's job is a trustworthy GO/NO-GO after the Paseo V1→V2 cutover. The two
// things that must not regress: (1) a frozen chain is NO-GO (height>0 alone is not
// "alive" — the halt lesson), and (2) a wrong chainId (endpoint not repointed to V2)
// is NO-GO. Plus the pure encode/decode helpers.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  hexToBigInt,
  isCodePresent,
  balanceOfCalldata,
  TOTAL_SUPPLY_CALLDATA,
  formatUnits,
  classifyAdvance,
  decideGoNoGo,
  runLivenessChecks,
  EXPECTED_CHAIN_ID,
} from "./check-testnet-liveness.mjs";

// ── pure helpers ────────────────────────────────────────────────────────

test("hexToBigInt parses hex quantities, rejects non-hex", () => {
  assert.equal(hexToBigInt("0x2a"), 42n);
  assert.throws(() => hexToBigInt("42"), /not a hex/u);
});

test("isCodePresent: 0x / all-zero = none; real bytecode = present", () => {
  assert.equal(isCodePresent("0x"), false);
  assert.equal(isCodePresent("0x0000"), false);
  assert.equal(isCodePresent(undefined), false);
  assert.equal(isCodePresent("0x60806040"), true);
});

test("balanceOfCalldata: selector + 32-byte left-padded address", () => {
  const d = balanceOfCalldata("0x31ad432dFe083B998c69B6dB88A984ec5207ab7F");
  assert.ok(d.startsWith("0x70a08231"));
  assert.equal(d.length, 2 + 8 + 64);
  assert.ok(d.endsWith("31ad432dfe083b998c69b6db88a984ec5207ab7f"));
  assert.equal(TOTAL_SUPPLY_CALLDATA, "0x18160ddd");
});

test("formatUnits: 6dp USDC + 18dp gas", () => {
  assert.equal(formatUnits(249999999920000n, 6), "249999999.92");
  assert.equal(formatUnits(1000000n, 6), "1");
  assert.equal(formatUnits(0n, 6), "0");
  assert.equal(formatUnits(1n, 18), "0.000000000000000001");
});

test("classifyAdvance: b2>b1 = advancing; frozen = not", () => {
  assert.equal(classifyAdvance(100, 101, 12).advancing, true);
  const frozen = classifyAdvance(10612201, 10612201, 160000);
  assert.equal(frozen.advancing, false);
  assert.match(frozen.detail, /NOT advancing/u);
});

test("decideGoNoGo: any critical fail blocks GO; warns don't", () => {
  assert.deepEqual(decideGoNoGo([{ name: "a", critical: true, status: "pass" }]), { go: true, blockers: [] });
  assert.deepEqual(
    decideGoNoGo([{ name: "advancing", critical: true, status: "fail" }, { name: "x", critical: false, status: "fail" }]),
    { go: false, blockers: ["advancing"] }
  );
});

// ── runLivenessChecks (mock RPC) ────────────────────────────────────────

const DEP = {
  rpcUrl: "http://rpc",
  verifier: "0x31ad432dFe083B998c69B6dB88A984ec5207ab7F",
  deployer: "0x1f8c4da4aaac79916350f1fabf1221309591b6f9",
  contracts: { escrowCore: "0x70d661C3A5DdE64bB8cbFa0A5336470c1662eFCa", xcmWrapper: null, token: "0x0000053900000000000000000000000001200000" },
};
const hx = (n) => "0x" + BigInt(n).toString(16);

// method → result; blockNumber increments per eth_getBlockByNumber call unless frozen.
function mockRpc({ chainId = 420420417, frozen = false, totalSupply = 250000000000000n, code = "0x60806040", ts = Math.floor(Date.now() / 1000) } = {}) {
  let block = 10612201;
  return async (_url, init) => {
    const { method } = JSON.parse(init.body);
    let result;
    if (method === "eth_chainId") result = hx(chainId);
    else if (method === "eth_getBlockByNumber") { if (!frozen) block += 1; result = { number: hx(block), timestamp: hx(ts) }; }
    else if (method === "eth_call") result = init.body.includes("18160ddd") ? hx(totalSupply) : hx(5_000_000n);
    else if (method === "eth_getCode") result = code;
    else if (method === "eth_getBalance") result = hx(2n * 10n ** 18n);
    return { ok: true, status: 200, json: async () => ({ result }) };
  };
}
const opts = (fetchImpl) => ({ profile: "testnet", deployment: DEP, fetchImpl, sleep: async () => {}, now: () => Date.now() });

test("GO: live advancing chain, right chainId, USDC answering", async () => {
  const r = await runLivenessChecks(opts(mockRpc({ frozen: false })));
  assert.equal(r.go, true);
  assert.equal(r.blockers.length, 0);
  assert.equal(r.checks.find((c) => c.name === "advancing").status, "pass");
});

test("NO-GO: frozen chain (height>0 but not advancing) — the halt lesson", async () => {
  const r = await runLivenessChecks(opts(mockRpc({ frozen: true })));
  assert.equal(r.go, false);
  assert.deepEqual(r.blockers, ["advancing"]);
});

test("NO-GO: wrong chainId (endpoint not repointed to V2) is a blocker", async () => {
  // Reachable-but-wrong-chain still runs the other checks (informative); only an
  // UNREACHABLE rpc short-circuits. chainId is the blocker either way.
  const r = await runLivenessChecks(opts(mockRpc({ chainId: 1 })));
  assert.equal(r.go, false);
  assert.deepEqual(r.blockers, ["chainId"]);
  assert.equal(r.checks.length, 3); // chainId + advancing + usdc all evaluated
});

test("NO-GO: RPC totally unreachable short-circuits after the first check", async () => {
  const r = await runLivenessChecks(opts(async () => { throw new Error("network down"); }));
  assert.equal(r.go, false);
  assert.deepEqual(r.blockers, ["chainId"]);
  assert.equal(r.checks.length, 1); // short-circuit: nothing downstream can work
  assert.match(r.checks[0].detail, /unreachable/u);
});

test("survival: EMPTY contract code is flagged warn (state didn't survive)", async () => {
  const r = await runLivenessChecks(opts(mockRpc({ code: "0x" })));
  const escrow = r.survival.find((s) => s.name === "code:escrowCore");
  assert.equal(escrow.status, "warn");
  assert.match(escrow.detail, /EMPTY/u);
  // null contract (xcmWrapper) is skipped, not reported
  assert.equal(r.survival.find((s) => s.name === "code:xcmWrapper"), undefined);
});

test("expected chain ids are pinned", () => {
  assert.equal(EXPECTED_CHAIN_ID.testnet, 420420417);
  assert.equal(EXPECTED_CHAIN_ID.mainnet, 420420419);
});
