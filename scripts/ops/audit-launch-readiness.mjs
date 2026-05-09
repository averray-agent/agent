#!/usr/bin/env node

/**
 * Launch-readiness audit for the v1 product-proof gate.
 *
 * Read-only — no signing. Hits Hub TestNet and reports:
 *   - TreasuryPolicy.paused / owner / pauser
 *   - verifiers(backendSigner)
 *   - serviceOperators(EscrowCore) / serviceOperators(AgentAccountCore)
 *   - approvedAssets(USDC) (auto-generated getter on the public mapping)
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

const EXPECTED_CHAIN_ID = 420420417; // Polkadot Hub TestNet

async function main() {
  const deployments = JSON.parse(
    await readFile(resolve(repoRoot, "deployments/testnet.json"), "utf8")
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

  // Read everything in parallel — all view calls.
  const [
    owner,
    pauser,
    paused,
    signerIsVerifier,
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
    blockNumber,
    chainId
  ] = await Promise.all([
    policy.owner(),
    policy.pauser(),
    policy.paused(),
    policy.verifiers(backendSigner),
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
    provider.getBlockNumber(),
    provider.getNetwork().then((n) => Number(n.chainId))
  ]);

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
  console.log(`serviceOperators(escrow)         ${escrowIsOperator ? "✅" : "❌"}  ${escrowIsOperator}`);
  console.log(`serviceOperators(agentAccount)   ${agentAccountIsOperator ? "✅" : "❌"}  ${agentAccountIsOperator}  (defensive — strictly required for v1 single-payout is escrow only)`);
  console.log(`arbitrators(${short(expectedArbitrator)})  ${arbitratorIsApproved ? "✅" : "❌"}  ${arbitratorIsApproved}  (required for resolveDispute)`);
  console.log(`approvedAssets(USDC)             ${usdcIsApproved ? "✅" : "❌"}  ${usdcIsApproved}`);

  console.log("");
  console.log(`## Parameter drift vs deployments/testnet.json`);
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

main().catch((error) => {
  console.error(`audit failed: ${error?.stack ?? error?.message ?? error}`);
  process.exitCode = 1;
});
