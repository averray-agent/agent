// Tests for scripts/ops/audit-launch-readiness.mjs.
//
// The audit itself hits Hub TestNet, so we don't exercise main() here.
// Instead we cover the pure logic that decides whether the backend
// signer has enough USDC for a claim — the same calculation the
// contract performs in EscrowCore.claimJobFor (reward + claimStake +
// claimFee). If this diverges from the chain, the audit's "required"
// number diverges too, and the operator gets a misleading gap.
//
// We also cover the pure logic the new bytecode-selector check is built
// on: extracting selectors from an ethers v6 Interface, and detecting
// missing selectors as 4-byte substrings of deployed bytecode. The
// 2026-05-25 worker-loop debug session burned ~2h on exactly this kind
// of mismatch (claimJobFor(bytes32,address) missing from the deployed
// EscrowCore at 0x7BB8...), so these tests pin the logic so a future
// refactor can't silently regress to "passes when the selector is
// absent".

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseArgs,
  resolveRewardRaw,
  computeRequiredClaimAmount,
  formatUsdc,
  selectorsFromAbi,
  findMissingSelectors
} from "./audit-launch-readiness.mjs";

import {
  AGENT_ACCOUNT_ABI,
  ESCROW_CORE_ABI,
  REPUTATION_SBT_ABI,
  TREASURY_POLICY_ABI
} from "../../mcp-server/src/blockchain/abis.js";

// --- parseArgs ------------------------------------------------------------

test("parseArgs: defaults to testnet profile and no --min-reward override", () => {
  const args = parseArgs([]);
  assert.equal(args.profile, "testnet");
  assert.equal(args.minRewardRaw, undefined);
});

test("parseArgs: --profile picks a non-default deployments file", () => {
  const args = parseArgs(["--profile", "mainnet"]);
  assert.equal(args.profile, "mainnet");
});

test("parseArgs: --min-reward captures the raw base-unit string", () => {
  const args = parseArgs(["--min-reward", "100000"]);
  assert.equal(args.minRewardRaw, "100000");
});

test("parseArgs: ignores unknown flags rather than throwing", () => {
  const args = parseArgs(["--unknown", "value", "--profile", "testnet"]);
  assert.equal(args.profile, "testnet");
});

// --- resolveRewardRaw -----------------------------------------------------

test("resolveRewardRaw: default is 0.1 USDC = 100_000 raw (matches run-hosted-worker-loop)", () => {
  assert.equal(resolveRewardRaw({}), 100_000n);
  assert.equal(resolveRewardRaw({ cliRaw: undefined, envDecimal: undefined }), 100_000n);
  assert.equal(resolveRewardRaw({ cliRaw: "", envDecimal: "" }), 100_000n);
});

test("resolveRewardRaw: --min-reward takes precedence over env", () => {
  assert.equal(
    resolveRewardRaw({ cliRaw: "250000", envDecimal: "0.1" }),
    250_000n
  );
});

test("resolveRewardRaw: PRODUCT_PROOF_REWARD_AMOUNT env parses decimal USDC", () => {
  assert.equal(resolveRewardRaw({ envDecimal: "0.1" }), 100_000n);
  assert.equal(resolveRewardRaw({ envDecimal: "1.234567" }), 1_234_567n);
  assert.equal(resolveRewardRaw({ envDecimal: "5" }), 5_000_000n);
});

test("resolveRewardRaw: rejects zero or negative --min-reward", () => {
  assert.throws(() => resolveRewardRaw({ cliRaw: "0" }), /must be positive/u);
});

test("resolveRewardRaw: rejects env with more than 6 fractional digits", () => {
  assert.throws(
    () => resolveRewardRaw({ envDecimal: "0.1234567" }),
    /6 decimal places/u
  );
});

test("resolveRewardRaw: rejects non-decimal env input", () => {
  assert.throws(() => resolveRewardRaw({ envDecimal: "1e6" }), /positive decimal/u);
  assert.throws(() => resolveRewardRaw({ envDecimal: "-1" }), /positive decimal/u);
  assert.throws(() => resolveRewardRaw({ envDecimal: "abc" }), /positive decimal/u);
});

// --- computeRequiredClaimAmount ------------------------------------------

test("computeRequiredClaimAmount: today's testnet params (10% stake + 2% fee on 0.1 USDC reward)", () => {
  // Live testnet params (deployments/testnet.json):
  //   reward = 100_000 raw (0.1 USDC)
  //   stake  = 100_000 * 1000 / 10_000 = 10_000   (defaultClaimStakeBps=1000)
  //   fee    = 100_000 *  200 / 10_000 =  2_000   (claimFeeBps=200)
  //   total  = 112_000 raw = 0.112 USDC
  // The 2026-05-25 hosted failure had positions.liquid = 100_000 raw, short
  // by exactly 12_000 raw.
  const required = computeRequiredClaimAmount({
    reward: 100_000n,
    defaultClaimStakeBps: 1000,
    claimFeeBps: 200
  });
  assert.equal(required, 112_000n);
});

test("computeRequiredClaimAmount: zero bps means required == reward", () => {
  const required = computeRequiredClaimAmount({
    reward: 100_000n,
    defaultClaimStakeBps: 0,
    claimFeeBps: 0
  });
  assert.equal(required, 100_000n);
});

test("computeRequiredClaimAmount: accepts bigint, number, and string reward", () => {
  const params = { defaultClaimStakeBps: 1000, claimFeeBps: 200 };
  assert.equal(computeRequiredClaimAmount({ reward: 100_000n, ...params }), 112_000n);
  assert.equal(computeRequiredClaimAmount({ reward: 100_000, ...params }), 112_000n);
  assert.equal(computeRequiredClaimAmount({ reward: "100000", ...params }), 112_000n);
});

test("computeRequiredClaimAmount: uses integer division like the contract", () => {
  // reward = 7 raw, stakeBps = 1000 → stake = 7 * 1000 / 10000 = 0 (floor).
  // Same rounding the EVM uses for uint256 division — the audit MUST agree
  // or the gap will be off by 1 raw at small amounts.
  const required = computeRequiredClaimAmount({
    reward: 7n,
    defaultClaimStakeBps: 1000,
    claimFeeBps: 200
  });
  assert.equal(required, 7n);
});

test("computeRequiredClaimAmount: rejects non-positive reward and negative bps", () => {
  assert.throws(
    () => computeRequiredClaimAmount({ reward: 0n, defaultClaimStakeBps: 1000, claimFeeBps: 200 }),
    /reward must be positive/u
  );
  assert.throws(
    () => computeRequiredClaimAmount({ reward: 100_000n, defaultClaimStakeBps: -1, claimFeeBps: 200 }),
    /bps values must be non-negative/u
  );
});

// --- formatUsdc -----------------------------------------------------------

test("formatUsdc: integer USDC has no decimals appended", () => {
  assert.equal(formatUsdc(0n), "0");
  assert.equal(formatUsdc(1_000_000n), "1");
  assert.equal(formatUsdc(10_000_000n), "10");
});

test("formatUsdc: fractional USDC keeps significant digits and trims trailing zeros", () => {
  assert.equal(formatUsdc(100_000n), "0.1");
  assert.equal(formatUsdc(112_000n), "0.112");
  assert.equal(formatUsdc(50_000n), "0.05");
  assert.equal(formatUsdc(1n), "0.000001");
});

test("formatUsdc: matches the gap the audit would print for the 2026-05-25 failure", () => {
  // signer.liquid = 100_000 raw (0.10 USDC), required = 112_000 raw (0.112).
  // Gap = 12_000 raw = 0.012 USDC. This is the literal string the operator
  // copies into `fund-signer-usdc-deposit.mjs --amount <gap>`.
  const liquid = 100_000n;
  const required = computeRequiredClaimAmount({
    reward: 100_000n,
    defaultClaimStakeBps: 1000,
    claimFeeBps: 200
  });
  const gap = required - liquid;
  assert.equal(gap, 12_000n);
  assert.equal(formatUsdc(gap), "0.012");
});

// --- selectorsFromAbi -----------------------------------------------------

test("selectorsFromAbi: returns one entry per function fragment", () => {
  const entries = selectorsFromAbi([
    "function foo(uint256 x) returns (bool)",
    "function bar(address a)"
  ]);
  assert.equal(entries.length, 2);
  for (const entry of entries) {
    assert.match(entry.selector, /^0x[0-9a-f]{8}$/u);
    assert.equal(entry.signature.endsWith(")"), true);
  }
});

test("selectorsFromAbi: skips events, constructors, and errors", () => {
  // Only the function fragment should be picked up. Events have a 32-byte
  // topic, not a 4-byte selector, and would never appear in the dispatch
  // table — checking them would produce spurious "missing" reports.
  const entries = selectorsFromAbi([
    "function ping()",
    "event Bing(address indexed who)",
    "error Bong(string reason)",
    "constructor(address owner)"
  ]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].signature, "ping()");
});

test("selectorsFromAbi: signatures are canonical sighash (no param names, no types-only)", () => {
  // `claimJobFor(bytes32 jobId, address worker)` should normalize to
  // `claimJobFor(bytes32,address)` — same form the EVM uses to derive
  // the selector via keccak256(signature)[:4].
  const [entry] = selectorsFromAbi([
    "function claimJobFor(bytes32 jobId, address worker)"
  ]);
  assert.equal(entry.signature, "claimJobFor(bytes32,address)");
  // 4-byte keccak of "claimJobFor(bytes32,address)" — pin to detect any
  // upstream change in how ethers v6 formats selectors. If this breaks,
  // the audit's "missing" report would also be wrong.
  assert.equal(entry.selector, "0x090cf6d5");
});

test("selectorsFromAbi: pins ERC20 transfer to its canonical selector", () => {
  // 0xa9059cbb is one of the most-tested selectors in EVM history; if
  // ours differs, something is fundamentally wrong with how we compute.
  const [entry] = selectorsFromAbi([
    "function transfer(address to, uint256 amount) returns (bool)"
  ]);
  assert.equal(entry.signature, "transfer(address,uint256)");
  assert.equal(entry.selector, "0xa9059cbb");
});

test("selectorsFromAbi: handles overloaded function names without collisions", () => {
  // Two functions with the same name but different parameter types must
  // produce two distinct selectors — the dispatch table treats them as
  // separate entries, so the audit needs to as well.
  const entries = selectorsFromAbi([
    "function foo(uint256)",
    "function foo(address)"
  ]);
  assert.equal(entries.length, 2);
  const signatures = entries.map((e) => e.signature).sort();
  assert.deepEqual(signatures, ["foo(address)", "foo(uint256)"]);
  const selectors = new Set(entries.map((e) => e.selector));
  assert.equal(selectors.size, 2, "overloads must have distinct selectors");
});

test("selectorsFromAbi: emits lowercase selector strings", () => {
  // The bytecode substring search is case-sensitive; mixing cases would
  // silently miss otherwise-present selectors. Pin lowercase here.
  const entries = selectorsFromAbi(["function FooBar(uint256)"]);
  assert.equal(entries[0].selector, entries[0].selector.toLowerCase());
});

// --- findMissingSelectors -------------------------------------------------

const SAMPLE_SELECTORS = selectorsFromAbi([
  "function transfer(address,uint256) returns (bool)",  // 0xa9059cbb
  "function approve(address,uint256) returns (bool)",   // 0x095ea7b3
  "function balanceOf(address) view returns (uint256)"  // 0x70a08231
]);

function concatenateSelectors(selectors) {
  return "0x" + selectors.map((s) => s.selector.slice(2)).join("");
}

test("findMissingSelectors: empty bytecode means every selector is missing", () => {
  // `provider.getCode(addr)` returns "0x" for EOAs and undeployed
  // addresses. The audit must treat that as "nothing dispatches" rather
  // than as "all present by vacuous truth".
  const missing = findMissingSelectors("0x", SAMPLE_SELECTORS);
  assert.equal(missing.length, SAMPLE_SELECTORS.length);
});

test("findMissingSelectors: undefined / null bytecode is treated as empty", () => {
  assert.equal(findMissingSelectors(undefined, SAMPLE_SELECTORS).length, SAMPLE_SELECTORS.length);
  assert.equal(findMissingSelectors(null, SAMPLE_SELECTORS).length, SAMPLE_SELECTORS.length);
});

test("findMissingSelectors: bytecode containing all selectors returns empty array", () => {
  const code = concatenateSelectors(SAMPLE_SELECTORS);
  assert.deepEqual(findMissingSelectors(code, SAMPLE_SELECTORS), []);
});

test("findMissingSelectors: bytecode missing one selector returns just that one", () => {
  // Build bytecode that contains every sample selector except approve.
  // The audit should report exactly that selector — no false positives
  // for the others, no false negatives for approve.
  const without = SAMPLE_SELECTORS.filter((s) => s.signature !== "approve(address,uint256)");
  const code = concatenateSelectors(without);
  const missing = findMissingSelectors(code, SAMPLE_SELECTORS);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].signature, "approve(address,uint256)");
});

test("findMissingSelectors: works on bytecode with no 0x prefix", () => {
  // ethers always returns "0x..." from getCode, but the helper is
  // forgiving — make sure stripping is idempotent.
  const code = SAMPLE_SELECTORS.map((s) => s.selector.slice(2)).join("");
  assert.deepEqual(findMissingSelectors(code, SAMPLE_SELECTORS), []);
});

test("findMissingSelectors: comparison is case-insensitive on bytecode", () => {
  // Some RPC providers historically returned uppercase hex. Our selectors
  // are lowercase; without normalization, "A9059CBB" wouldn't match
  // "a9059cbb" and we'd report a false positive.
  const code = "0x" + SAMPLE_SELECTORS.map((s) => s.selector.slice(2).toUpperCase()).join("");
  assert.deepEqual(findMissingSelectors(code, SAMPLE_SELECTORS), []);
});

test("findMissingSelectors: matches selectors anywhere in bytecode, not just at start", () => {
  // The dispatch table sits a few opcodes into runtime bytecode after
  // the function selector load (PUSH1 0x00 CALLDATALOAD ...). Verify the
  // match works at arbitrary offsets — a leading-substring-only check
  // would miss every real-world contract.
  const padding = "00".repeat(64); // 64 bytes of zero padding
  const code = "0x" + padding + SAMPLE_SELECTORS[0].selector.slice(2) + padding;
  const missing = findMissingSelectors(code, [SAMPLE_SELECTORS[0]]);
  assert.deepEqual(missing, []);
});

test("findMissingSelectors: does not mutate the input selectors array", () => {
  // Defensive: the audit script reuses the targets list across calls;
  // a mutating helper would corrupt the next contract's check.
  const snapshot = SAMPLE_SELECTORS.map((s) => ({ ...s }));
  findMissingSelectors("0x", SAMPLE_SELECTORS);
  assert.deepEqual(SAMPLE_SELECTORS, snapshot);
});

// --- End-to-end against the gateway ABIs ---------------------------------

test("end-to-end: every gateway ABI yields a non-empty selector list", () => {
  // A regression where one of the ABIs becomes events-only would make
  // the audit silently report "0/0 selectors ✅" for that contract.
  // Confirm each target ABI has at least one function.
  for (const [name, abi] of [
    ["ESCROW_CORE_ABI", ESCROW_CORE_ABI],
    ["AGENT_ACCOUNT_ABI", AGENT_ACCOUNT_ABI],
    ["TREASURY_POLICY_ABI", TREASURY_POLICY_ABI],
    ["REPUTATION_SBT_ABI", REPUTATION_SBT_ABI]
  ]) {
    const selectors = selectorsFromAbi(abi);
    assert.ok(selectors.length > 0, `${name} should contain at least one function fragment`);
  }
});

test("end-to-end: ESCROW_CORE_ABI exposes claimJobFor — the selector the 2026-05-25 incident missed", () => {
  // This is the specific selector PR #357 added. If the gateway ABI
  // ever drops it, the audit would never have caught the original
  // incident — pin its presence here so a regression is loud.
  const selectors = selectorsFromAbi(ESCROW_CORE_ABI);
  const claimJobFor = selectors.find((s) => s.signature === "claimJobFor(bytes32,address)");
  assert.ok(claimJobFor, "ESCROW_CORE_ABI must include claimJobFor(bytes32,address)");
  assert.equal(claimJobFor.selector, "0x090cf6d5");
});

test("end-to-end: ESCROW_CORE_ABI exposes openDispute for live dispute proof", () => {
  // The hosted dispute verdict proof moves rejected chain jobs into the
  // disputed state before the arbitrator resolves them. Keep the gateway ABI
  // pinned to that contract surface so the live path cannot regress silently.
  const selectors = selectorsFromAbi(ESCROW_CORE_ABI);
  const openDispute = selectors.find((s) => s.signature === "openDispute(bytes32)");
  assert.ok(openDispute, "ESCROW_CORE_ABI must include openDispute(bytes32)");
  assert.equal(openDispute.selector, "0xf08ef6cb");
});

test("end-to-end: synthetic 'pre-#357' bytecode reports claimJobFor as the only missing selector", () => {
  // Reconstruct the exact failure mode: a bytecode that contains every
  // ESCROW_CORE_ABI selector except claimJobFor. This is the report the
  // audit would have produced against the 2026-05-25 deployed contract
  // if the check had existed.
  const selectors = selectorsFromAbi(ESCROW_CORE_ABI);
  const pre357 = selectors.filter((s) => s.signature !== "claimJobFor(bytes32,address)");
  const syntheticBytecode = concatenateSelectors(pre357);
  const missing = findMissingSelectors(syntheticBytecode, selectors);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].signature, "claimJobFor(bytes32,address)");
  assert.equal(missing[0].selector, "0x090cf6d5");
});
