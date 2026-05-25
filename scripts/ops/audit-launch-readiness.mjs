#!/usr/bin/env node

/**
 * Launch-readiness audit for the v1 product-proof gate.
 *
 * Read-only — no signing. Hits Hub TestNet and reports:
 *   - TreasuryPolicy.paused / owner / pauser
 *   - verifiers(backendSigner)
 *   - serviceOperators(backendSigner) — the wallet that calls
 *     EscrowCore.claimJobFor and other onlyOperator entry points.
 *     Distinct from the verifier role; both flip independently and a
 *     KMS-signer rotation needs both. Missing this check let a real
 *     prod misconfig (Phase 3 KMS cutover authorized the new signer as
 *     verifier but not as service operator) slip past launch readiness
 *     until the first hosted worker-loop hit a bare `require(false)`
 *     on `claimJobFor`. The audit now flags it preemptively.
 *   - serviceOperators(EscrowCore) / serviceOperators(AgentAccountCore)
 *   - approvedAssets(USDC) (auto-generated getter on the public mapping)
 *   - AgentAccountCore.positions(backendSigner, USDC).liquid — the
 *     deposited USDC balance the backend signer can draw against when
 *     EscrowCore.claimJobFor moves reward + claimStake + claimFee out
 *     of its position. Authorization (serviceOperators) is necessary
 *     but not sufficient: a rotated signer also needs funded liquidity
 *     before the first claim. Missing this check let the 2026-05-25
 *     hosted deploy burn 24s of CI on a settlement attempt that the
 *     contract reverted because positions[signer][USDC].liquid was
 *     0.10 USDC — short of the 0.16 USDC required for one claim.
 *   - USDC.balanceOf(backendSigner) — the raw precompile balance that
 *     never made it into the position. Funding the EOA without then
 *     calling deposit() leaves liquid=0; surfacing balanceOf separately
 *     points the operator at fund-signer-usdc-deposit.mjs instead of
 *     "where did my USDC go".
 * Then prints a punch list of any setVerifier / setServiceOperator /
 * setApprovedAsset calls that need to happen on the multisig owner.
 *
 * Prepares the unsigned function-call data for any required fix so a
 * multisig signer can paste it directly. Does NOT broadcast.
 */

import { JsonRpcProvider, Contract, Interface } from "ethers";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

// Auto-generated getters for `mapping(address => bool) public ...`. The
// current TREASURY_POLICY_ABI in mcp-server doesn't list `approvedAssets`
// or `arbitrators` — we add them locally so the audit script can read
// them without waiting for the other agent's policy-readiness PR to land.
const READ_ABI = [
  "function owner() view returns (address)",
  "function pauser() view returns (address)",
  "function paused() view returns (bool)",
  "function verifiers(address) view returns (bool)",
  "function serviceOperators(address) view returns (bool)",
  "function arbitrators(address) view returns (bool)",
  "function approvedAssets(address) view returns (bool)",
  "function dailyOutflowCap() view returns (uint256)",
  "function perAccountBorrowCap() view returns (uint256)",
  "function defaultClaimStakeBps() view returns (uint16)",
  "function claimFeeBps() view returns (uint16)",
  "function claimFeeVerifierBps() view returns (uint16)",
  "function onboardingWaiverClaimCount() view returns (uint256)",
  "function minClaimFeeByAsset(address) view returns (uint256)"
];

const WRITE_ABI = [
  "function setVerifier(address verifier, bool approved)",
  "function setServiceOperator(address operator, bool approved)",
  "function setArbitrator(address arbitrator, bool approved)",
  "function setApprovedAsset(address asset, bool approved)",
  "function setMinClaimFee(address asset, uint256 amount)",
  "function setDailyOutflowCap(uint256 cap)"
];

const AGENT_ACCOUNT_READ_ABI = [
  // Matches the AssetPosition struct in contracts/AgentAccountCore.sol: the
  // auto-generated getter returns the six fields in declaration order. We
  // only consume `liquid` (the first slot), but ethers v6 demands the full
  // tuple layout in the fragment.
  "function positions(address wallet, address asset) view returns (uint256 liquid, uint256 reserved, uint256 strategyAllocated, uint256 collateralLocked, uint256 jobStakeLocked, uint256 debtOutstanding)"
];

const ERC20_READ_ABI = [
  // The Polkadot Hub ERC20 precompile does NOT implement name/symbol/
  // decimals, but balanceOf is part of the mandatory subset (per
  // https://docs.polkadot.com/smart-contracts/precompiles/erc20/). We only
  // need balanceOf to surface un-deposited USDC sitting in the EOA.
  "function balanceOf(address) view returns (uint256)"
];

const EXPECTED_CHAIN_ID = 420420417; // Polkadot Hub TestNet

// USDC base unit scale on Hub TestNet (6 decimals, asset id 1337 / Trust-Backed).
const USDC_DECIMALS_SCALE = 1_000_000n;

// Default product-proof reward used by `scripts/ops/run-hosted-worker-loop.mjs`
// (DEFAULT_REWARD_AMOUNT = 0.1, scaled by 10**6). Kept in sync with that
// script — if it ever changes there, change it here. The audit accepts
// `--min-reward <rawBaseUnits>` (or `PRODUCT_PROOF_REWARD_AMOUNT` decimal
// env, same name the worker loop reads) to override.
const DEFAULT_PRODUCT_PROOF_REWARD_RAW = 100_000n;

// Polkadot Hub ERC20-precompile address-suffix conventions.
//
// Per https://docs.polkadot.com/smart-contracts/precompiles/erc20/, the
// last 4 bytes of an ERC20-precompile address encode the asset category:
//
//   01200000  Trust-Backed Assets (Assets pallet, u32 asset ID)
//   02200000  Foreign Assets       (XCM-derived index)
//   03200000  Pool Assets          (liquidity-pool derived)
//
// v1 escrow targets a Trust-Backed Asset (USDC / USDt). The suffix is
// the only on-chain-introspectable signal we have — the precompile does
// NOT implement the optional ERC20 metadata functions (name(), symbol(),
// decimals()), so we cannot verify the token by calling those at all.
// Validation has to compare against the static `assets.js` record
// (symbol + address + assetClass + assetId + decimals) plus this
// suffix gate.
const TRUST_BACKED_ASSET_SUFFIX = "01200000";
const FOREIGN_ASSET_SUFFIX = "02200000";
const POOL_ASSET_SUFFIX = "03200000";

function classifyAssetSuffix(address) {
  const lower = String(address ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/u.test(lower)) return "invalid";
  const suffix = lower.slice(-8);
  if (suffix === TRUST_BACKED_ASSET_SUFFIX) return "trust_backed";
  if (suffix === FOREIGN_ASSET_SUFFIX) return "foreign";
  if (suffix === POOL_ASSET_SUFFIX) return "pool";
  return "unknown";
}

export function parseArgs(argv) {
  const args = { profile: "testnet", minRewardRaw: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--profile") args.profile = argv[++i];
    else if (arg === "--min-reward") args.minRewardRaw = argv[++i];
  }
  return args;
}

// Resolve the per-claim reward (USDC base units) used to compute the
// required signer liquidity. Precedence:
//   1. --min-reward <raw>             (CLI flag, base units)
//   2. PRODUCT_PROOF_REWARD_AMOUNT    (env, decimal USDC — same shape the
//                                      hosted worker loop reads)
//   3. DEFAULT_PRODUCT_PROOF_REWARD_RAW (0.1 USDC)
export function resolveRewardRaw({ cliRaw, envDecimal } = {}) {
  if (cliRaw !== undefined && cliRaw !== null && cliRaw !== "") {
    const raw = BigInt(cliRaw);
    if (raw <= 0n) throw new Error(`--min-reward must be positive; got ${cliRaw}`);
    return raw;
  }
  if (envDecimal !== undefined && envDecimal !== null && String(envDecimal).trim() !== "") {
    return decimalUsdcToRaw(String(envDecimal).trim());
  }
  return DEFAULT_PRODUCT_PROOF_REWARD_RAW;
}

// Decimal USDC (e.g. "0.1", "1.234567") → raw base units. Rejects more
// than 6 fractional digits and negative / non-numeric input. Matches the
// shape `PRODUCT_PROOF_REWARD_AMOUNT` takes in run-hosted-worker-loop.
function decimalUsdcToRaw(text) {
  if (!/^\d+(\.\d+)?$/u.test(text)) {
    throw new Error(`PRODUCT_PROOF_REWARD_AMOUNT must be a positive decimal; got ${JSON.stringify(text)}`);
  }
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > 6) {
    throw new Error(`PRODUCT_PROOF_REWARD_AMOUNT must fit 6 decimal places; got ${JSON.stringify(text)}`);
  }
  const padded = (fraction + "000000").slice(0, 6);
  const raw = BigInt(whole) * USDC_DECIMALS_SCALE + BigInt(padded);
  if (raw <= 0n) {
    throw new Error(`PRODUCT_PROOF_REWARD_AMOUNT must be greater than zero; got ${JSON.stringify(text)}`);
  }
  return raw;
}

// Mirrors EscrowCore.claimJobFor's economics: when the backend signer
// brokers a claim it locks `reward + claimStake + claimFee` out of its
// own position. claimStake is `reward * defaultClaimStakeBps / 10_000`
// and claimFee is `reward * claimFeeBps / 10_000`. The contract uses
// integer division and the same rounding semantics; we replicate that
// with BigInt division so the audit's "required" matches the chain.
export function computeRequiredClaimAmount({ reward, defaultClaimStakeBps, claimFeeBps }) {
  const r = BigInt(reward);
  const stakeBps = BigInt(defaultClaimStakeBps);
  const feeBps = BigInt(claimFeeBps);
  if (r <= 0n) throw new Error("reward must be positive");
  if (stakeBps < 0n || feeBps < 0n) throw new Error("bps values must be non-negative");
  const stake = (r * stakeBps) / 10_000n;
  const fee = (r * feeBps) / 10_000n;
  return r + stake + fee;
}

export function formatUsdc(baseUnits) {
  // 6 decimals per Polkadot docs (asset id 1337). Render with up to 6
  // fractional digits and trim trailing zeros for readability.
  const big = BigInt(baseUnits);
  const whole = big / USDC_DECIMALS_SCALE;
  const fraction = big % USDC_DECIMALS_SCALE;
  const fractionText = fraction.toString().padStart(6, "0").replace(/0+$/u, "");
  return fractionText ? `${whole}.${fractionText}` : whole.toString();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rewardRaw = resolveRewardRaw({
    cliRaw: args.minRewardRaw,
    envDecimal: process.env.PRODUCT_PROOF_REWARD_AMOUNT
  });

  const deployments = JSON.parse(
    await readFile(resolve(repoRoot, "deployments", `${args.profile}.json`), "utf8")
  );

  const rpcUrl = deployments.rpcUrl;
  const policyAddress = deployments.contracts.treasuryPolicy;
  const escrowAddress = deployments.contracts.escrowCore;
  const agentAccountAddress = deployments.contracts.agentAccountCore;
  const usdcAddress = deployments.contracts.token; // 0x...01200000
  const backendSigner = deployments.verifier;     // backend signer == verifier on testnet
  const expectedArbitrator = deployments.arbitrator;
  const expectedOwner = deployments.owner;
  const expectedPauser = deployments.pauser;
  const expectedParameters = deployments.parameters ?? {};

  console.log(`# Launch readiness audit`);
  console.log(`Profile: ${deployments.profile}`);
  console.log(`RPC:     ${rpcUrl}`);
  console.log(`Policy:  ${policyAddress}`);
  console.log(`Escrow:  ${escrowAddress}`);
  console.log(`Agent:   ${agentAccountAddress}`);
  console.log(`USDC:    ${usdcAddress}`);
  console.log(`Signer:  ${backendSigner}`);
  console.log("");

  const provider = new JsonRpcProvider(rpcUrl);
  const policy = new Contract(policyAddress, READ_ABI, provider);
  const agentAccount = new Contract(agentAccountAddress, AGENT_ACCOUNT_READ_ABI, provider);
  const usdc = new Contract(usdcAddress, ERC20_READ_ABI, provider);

  // Read everything in parallel — all view calls.
  const [
    owner,
    pauser,
    paused,
    signerIsVerifier,
    signerIsOperator,
    escrowIsOperator,
    agentAccountIsOperator,
    arbitratorIsApproved,
    usdcIsApproved,
    minClaimFeeUsdc,
    dailyOutflowCap,
    perAccountBorrowCap,
    defaultClaimStakeBps,
    claimFeeBps,
    claimFeeVerifierBps,
    onboardingWaiverClaimCount,
    signerPosition,
    signerUsdcBalance,
    blockNumber,
    chainId
  ] = await Promise.all([
    policy.owner(),
    policy.pauser(),
    policy.paused(),
    policy.verifiers(backendSigner),
    policy.serviceOperators(backendSigner),
    policy.serviceOperators(escrowAddress),
    policy.serviceOperators(agentAccountAddress),
    policy.arbitrators(expectedArbitrator),
    policy.approvedAssets(usdcAddress),
    policy.minClaimFeeByAsset(usdcAddress),
    policy.dailyOutflowCap(),
    policy.perAccountBorrowCap(),
    policy.defaultClaimStakeBps(),
    policy.claimFeeBps(),
    policy.claimFeeVerifierBps(),
    policy.onboardingWaiverClaimCount(),
    agentAccount.positions(backendSigner, usdcAddress),
    usdc.balanceOf(backendSigner),
    provider.getBlockNumber(),
    provider.getNetwork().then((n) => Number(n.chainId))
  ]);

  // The auto-generated getter on `mapping(address => mapping(address =>
  // AssetPosition))` returns the struct's fields in declaration order. We
  // only need `liquid`.
  const signerLiquidUsdc = BigInt(signerPosition.liquid ?? signerPosition[0] ?? 0n);
  const signerUsdcBalanceRaw = BigInt(signerUsdcBalance ?? 0n);
  const requiredPerClaim = computeRequiredClaimAmount({
    reward: rewardRaw,
    defaultClaimStakeBps,
    claimFeeBps
  });
  const liquidityOk = signerLiquidUsdc >= requiredPerClaim;
  const liquidityGap = liquidityOk ? 0n : requiredPerClaim - signerLiquidUsdc;

  // Drift check: confirm we're talking to the chain we expected.
  const chainOk = chainId === EXPECTED_CHAIN_ID;

  // Drift check: every numeric parameter from deployments/testnet.json
  // should match what's actually on-chain. A silent drift here (e.g.,
  // dailyOutflowCap = 0) would let settlement fail mid-run with an
  // unhelpful revert; better to catch it up front.
  const paramChecks = [
    { label: "dailyOutflowCap",            live: dailyOutflowCap,              expected: expectedParameters.dailyOutflowCap },
    { label: "perAccountBorrowCap",        live: perAccountBorrowCap,          expected: expectedParameters.borrowCap },
    { label: "defaultClaimStakeBps",       live: defaultClaimStakeBps,         expected: expectedParameters.defaultClaimStakeBps },
    { label: "claimFeeBps",                live: claimFeeBps,                  expected: expectedParameters.claimFeeBps },
    { label: "claimFeeVerifierBps",        live: claimFeeVerifierBps,          expected: expectedParameters.claimFeeVerifierBps },
    { label: "onboardingWaiverClaimCount", live: onboardingWaiverClaimCount,   expected: expectedParameters.onboardingWaiverClaimCount },
    { label: "minClaimFeeByAsset(USDC)",   live: minClaimFeeUsdc,              expected: expectedParameters.minClaimFee }
  ].map((check) => ({
    ...check,
    ok: check.expected === undefined || String(check.live) === String(check.expected)
  }));

  console.log(`## Live state`);
  console.log(`block:         ${blockNumber}`);
  console.log(`chainId:       ${chainId}  ${chainOk ? "✅" : `❌ expected ${EXPECTED_CHAIN_ID}`}`);
  console.log(`owner:         ${owner}  ${ciEqual(owner, expectedOwner) ? "✅" : `⚠ expected ${expectedOwner}`}`);
  console.log(`pauser:        ${pauser}  ${ciEqual(pauser, expectedPauser) ? "✅" : `⚠ expected ${expectedPauser}`}`);
  console.log(`paused:        ${paused}  ${paused ? "❌" : "✅"}`);
  console.log(`verifiers(${short(backendSigner)})         ${signerIsVerifier ? "✅" : "❌"}  ${signerIsVerifier}`);
  console.log(`serviceOperators(${short(backendSigner)})  ${signerIsOperator ? "✅" : "❌"}  ${signerIsOperator}  (backend signer must be an operator to call EscrowCore.claimJobFor)`);
  console.log(`serviceOperators(escrow)         ${escrowIsOperator ? "✅" : "❌"}  ${escrowIsOperator}`);
  console.log(`serviceOperators(agentAccount)   ${agentAccountIsOperator ? "✅" : "❌"}  ${agentAccountIsOperator}  (defensive — strictly required for v1 single-payout is escrow only)`);
  console.log(`arbitrators(${short(expectedArbitrator)})  ${arbitratorIsApproved ? "✅" : "❌"}  ${arbitratorIsApproved}  (required for resolveDispute)`);
  console.log(`approvedAssets(USDC)             ${usdcIsApproved ? "✅" : "❌"}  ${usdcIsApproved}`);

  // Suffix classification — only thing we can introspect about the
  // ERC20-precompile address itself, since name/symbol/decimals are
  // not implemented on the precompile (per Polkadot docs).
  const usdcAssetClass = classifyAssetSuffix(usdcAddress);
  const usdcSuffixOk = usdcAssetClass === "trust_backed";
  console.log(`USDC asset class (suffix)        ${usdcSuffixOk ? "✅" : "❌"}  ${usdcAssetClass}  (expected trust_backed)`);

  // Backend-signer USDC liquidity — authorization is necessary but not
  // sufficient. The 2026-05-25 hosted deploy proved the failure mode:
  // serviceOperators[signer] was true, but positions[signer][USDC].liquid
  // was 0.10 USDC, short of the 0.16 USDC required for one claim.
  console.log("");
  console.log(`## Backend-signer USDC liquidity`);
  console.log(`reward (per claim):              ${formatUsdc(rewardRaw)} USDC (${rewardRaw} raw)`);
  console.log(`defaultClaimStakeBps:            ${defaultClaimStakeBps}`);
  console.log(`claimFeeBps:                     ${claimFeeBps}`);
  console.log(`required (reward+stake+fee):     ${formatUsdc(requiredPerClaim)} USDC (${requiredPerClaim} raw)`);
  console.log(`positions[signer][USDC].liquid   ${liquidityOk ? "✅" : "❌"}  ${formatUsdc(signerLiquidUsdc)} USDC (${signerLiquidUsdc} raw)`);
  if (!liquidityOk) {
    console.log(`   short by:                     ${formatUsdc(liquidityGap)} USDC (${liquidityGap} raw)`);
  }
  // Surface the raw EOA balance separately. This is the giveaway when
  // someone funds the wallet but forgets to call deposit() — USDC sits
  // at the precompile, position stays empty, claims keep reverting.
  const balanceHintsAtUndeposited = !liquidityOk && signerUsdcBalanceRaw > 0n;
  console.log(`USDC.balanceOf(signer)           ${signerUsdcBalanceRaw === 0n ? "ℹ" : "•"}  ${formatUsdc(signerUsdcBalanceRaw)} USDC (${signerUsdcBalanceRaw} raw)${balanceHintsAtUndeposited ? "  ← un-deposited; run fund-signer-usdc-deposit.mjs" : ""}`);

  console.log("");
  console.log(`## Parameter drift vs deployments/${args.profile}.json`);
  for (const check of paramChecks) {
    const live = String(check.live);
    const expected = check.expected === undefined ? "(not pinned)" : String(check.expected);
    console.log(`${check.label.padEnd(36, " ")}  ${check.ok ? "✅" : "❌"}  live=${live}  expected=${expected}`);
  }

  // Punch list of fixes needed.
  const fixes = [];
  if (paused) {
    fixes.push({
      label: "TreasuryPolicy is paused — unpausing must precede settlement",
      reasonCode: "policy_paused",
      // setPaused(false) is owner-or-pauser; the deployment file's pauser
      // (`0xFd2EAE…6519`) can do this directly without a multisig signature.
    });
  }
  if (!chainOk) {
    fixes.push({
      label: `RPC chainId drift — connected to ${chainId}, expected ${EXPECTED_CHAIN_ID}`,
      reasonCode: "chain_id_drift"
    });
  }
  if (!signerIsVerifier) {
    fixes.push(buildCall("setVerifier", [backendSigner, true], policyAddress));
  }
  if (!signerIsOperator) {
    // Backend signer must be a service operator to call
    // EscrowCore.claimJobFor (the admin-operated path that brokers
    // claim-on-behalf-of-worker, dispute resolution, etc.). Without
    // this, the platform's user-facing job lifecycle silently
    // reverts with bare `require(false)` on every chain mutation
    // initiated by the backend. The signer-rotation runbook needs
    // to flip BOTH verifiers[signer]=true AND
    // serviceOperators[signer]=true; missing either one is a launch
    // blocker.
    fixes.push(buildCall("setServiceOperator", [backendSigner, true], policyAddress));
  }
  if (!escrowIsOperator) {
    fixes.push(buildCall("setServiceOperator", [escrowAddress, true], policyAddress));
  }
  if (!agentAccountIsOperator) {
    fixes.push(buildCall("setServiceOperator", [agentAccountAddress, true], policyAddress));
  }
  if (!arbitratorIsApproved) {
    fixes.push(buildCall("setArbitrator", [expectedArbitrator, true], policyAddress));
  }
  if (!usdcIsApproved) {
    fixes.push(buildCall("setApprovedAsset", [usdcAddress, true], policyAddress));
  }
  if (!usdcSuffixOk) {
    fixes.push({
      label: `USDC address suffix mismatch — got asset class "${usdcAssetClass}", expected "trust_backed"`,
      reasonCode: "asset_class_mismatch"
      // No setter — this means deployments/testnet.json#contracts.token
      // points at the wrong precompile. Fix the deployment file, not
      // the chain.
    });
  }
  if (!liquidityOk) {
    // Not a multisig-owner fix — the signer (or anyone with USDC) can
    // top this up directly via fund-signer-usdc-deposit.mjs, which does
    // ERC20 approve + AgentAccountCore.deposit in one shot. We hand the
    // operator the exact gap so they can `--amount <gap-raw>` it.
    const hint = balanceHintsAtUndeposited
      ? ` — wallet already holds ${formatUsdc(signerUsdcBalanceRaw)} USDC at the precompile; deposit() it into the position`
      : " — wallet does not hold enough USDC at the precompile; acquire USDC first (swap PAS→USDC or transfer from a funded wallet), then deposit";
    fixes.push({
      label: `backend signer is under-funded for one claim: positions[signer][USDC].liquid = ${formatUsdc(signerLiquidUsdc)} USDC, required ${formatUsdc(requiredPerClaim)} USDC (short by ${formatUsdc(liquidityGap)} USDC)${hint}`,
      reasonCode: "signer_liquidity_short",
      runbook: `node scripts/ops/fund-signer-usdc-deposit.mjs --amount ${liquidityGap.toString()} --use-kms --commit`
    });
  }
  // Parameter drift fixes — only emit calldata for the cases where the
  // contract has a setter we know about. dailyOutflowCap and
  // minClaimFeeByAsset both do. The rest (claimFeeBps, etc.) require
  // their own ops follow-up; we surface the drift but don't autogen
  // calldata for fields that aren't in this audit's WRITE_ABI.
  for (const check of paramChecks) {
    if (check.ok) continue;
    if (check.label === "dailyOutflowCap" && check.expected !== undefined) {
      fixes.push(buildCall("setDailyOutflowCap", [BigInt(check.expected)], policyAddress));
    } else if (check.label === "minClaimFeeByAsset(USDC)" && check.expected !== undefined) {
      fixes.push(buildCall("setMinClaimFee", [usdcAddress, BigInt(check.expected)], policyAddress));
    } else {
      fixes.push({
        label: `parameter drift on ${check.label} (live=${check.live}, expected=${check.expected}) — manual setter call required`,
        reasonCode: "parameter_drift"
      });
    }
  }

  console.log("");
  if (fixes.length === 0) {
    console.log("## Verdict");
    console.log("✅ All TreasuryPolicy roles are configured. Ready for the hosted product-proof smoke.");
    return;
  }

  console.log(`## Multisig fix list (${fixes.length} call${fixes.length === 1 ? "" : "s"})`);
  console.log(`Owner that must sign: ${expectedOwner}`);
  console.log("");
  for (const [index, fix] of fixes.entries()) {
    console.log(`### ${index + 1}. ${fix.label}`);
    if (fix.reasonCode) {
      console.log(`   reason: ${fix.reasonCode}`);
      if (fix.runbook) {
        console.log(`   runbook: ${fix.runbook}`);
      }
      continue;
    }
    console.log(`   to:    ${fix.to}`);
    console.log(`   value: 0`);
    console.log(`   data:  ${fix.data}`);
    console.log(`   call:  ${fix.functionName}(${fix.args.map((a) => JSON.stringify(a)).join(", ")})`);
  }
  console.log("");
  console.log("⚠ None of these calls are signed. Hand the (to, value, data) tuples to the multisig owner.");
  process.exitCode = 2; // non-zero so CI catches drift
}

function buildCall(functionName, args, to) {
  const iface = new Interface(WRITE_ABI);
  const data = iface.encodeFunctionData(functionName, args);
  return {
    label: `${functionName}(${args.map(prettyArg).join(", ")})`,
    to,
    // Stringified so JSON.stringify is safe — BigInt would throw.
    value: "0",
    data,
    functionName,
    args: args.map((a) => (typeof a === "bigint" ? a.toString() : a))
  };
}

function prettyArg(arg) {
  if (typeof arg === "string" && /^0x[a-fA-F0-9]{40}$/.test(arg)) {
    return short(arg);
  }
  if (typeof arg === "boolean") return String(arg);
  return JSON.stringify(arg);
}

function short(addr) {
  if (typeof addr !== "string") return String(addr);
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function ciEqual(a, b) {
  return String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
}

// Only run main() when invoked as a CLI — not when imported (e.g. by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`audit failed: ${error?.stack ?? error?.message ?? error}`);
    process.exitCode = 1;
  });
}
