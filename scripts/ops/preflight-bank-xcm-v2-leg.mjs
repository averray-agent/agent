#!/usr/bin/env node

/**
 * Read-only, deployed-contract gate for each Bank XCM v2.1 leg.
 *
 * A destination-message DryRunApi proof is necessary but not sufficient: this
 * tool also invokes the exact adapter/wrapper calldata through ReviveApi_call,
 * first under a review-only high ceiling and then under a derived 25%-headroom
 * outer limit. It never signs or broadcasts.
 */

import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Contract, Interface, getAddress, keccak256 } from "ethers";

import {
  ADAPTER_ADMIN_ABI,
  BANK_XCM_V2,
  POLICY_BANK_ABI,
  WRAPPER_ADMIN_ABI,
  buildBankXcmV2Messages,
  buildRecoveryHomeMessage,
  loadJson
} from "./bank-xcm-v2-ceremony-lib.mjs";
import { assertDryRunEvidence } from "./prepare-bank-xcm-v2-multisig.mjs";
import { createCeremonyRpcContext, printCeremonyRpcPreflight } from "./ceremony-rpc.mjs";
import {
  assertOwnerRecordAuthority,
  assertSubstrateProfileEncoding
} from "./redeploy-escrowcore-wire-multisig.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const LEGS = new Set(["deposit_funding", "deposit_sell", "withdraw_sell", "withdraw_home", "recovery_home"]);
// This is the limit-aware ceiling that cleared the v2.0 funding call after the
// original 4b/100k/0.1-DOT envelope reverted. It is deliberately re-measured
// per leg rather than copied into any signed call.
const HIGH_WEIGHT = Object.freeze({ refTime: 10_000_000_000n, proofSize: 500_000n });
const HIGH_STORAGE = 5_000_000_000n;
const MIN_SAFE_STORAGE = 1_000_000_000n;

const WRAPPER_FLOW_ABI = Object.freeze([
  ...WRAPPER_ADMIN_ABI,
  "function queueRequest((bytes32 strategyId,uint8 kind,address account,address asset,address recipient,uint256 assets,uint256 shares,uint64 nonce),bytes,bytes,(uint64 refTime,uint64 proofSize)) returns (bytes32)",
  "function dispatchRecoveryHome(uint256 amount,uint64 nonce,bytes destination,bytes message) returns (bytes32)",
  "function previewRecoveryHomeId(uint256 amount,uint64 nonce) view returns (bytes32)",
  "function requestOperator(bytes32) view returns (address)",
  "function requestAdapter(bytes32) view returns (address)"
]);
const ADAPTER_FLOW_ABI = Object.freeze([
  ...ADAPTER_ADMIN_ABI,
  "function stageTreasuryDeposit(address,uint256,bytes,bytes,(uint64 refTime,uint64 proofSize),uint64) returns (bytes32)",
  "function stageTreasuryWithdraw(address,uint256,bytes,bytes,(uint64 refTime,uint64 proofSize),uint64) returns (bytes32)"
]);

export function parseArgs(argv) {
  const args = {
    profile: "mainnet",
    depositAssets: "150000",
    depositSellAmount: "100000",
    depositFee: "20201",
    withdrawShares: "100000",
    withdrawFee: "20201",
    homeAmount: "100000",
    homeFee: "677",
    depositNonce: "1",
    withdrawNonce: "2",
    recoveryAmount: "100000",
    recoveryFee: "677",
    recoveryNonce: "1"
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--profile") args.profile = argv[++index];
    else if (token === "--leg") args.leg = argv[++index];
    else if (token === "--wrapper") args.wrapper = argv[++index];
    else if (token === "--adapter") args.adapter = argv[++index];
    else if (token === "--converted-account") args.convertedAccount = argv[++index];
    else if (token === "--dry-run-evidence") args.dryRunEvidence = argv[++index];
    else if (token === "--inner-ref-time") args.innerRefTime = argv[++index];
    else if (token === "--inner-proof-size") args.innerProofSize = argv[++index];
    else if (token === "--deposit-assets") args.depositAssets = argv[++index];
    else if (token === "--deposit-sell-amount") args.depositSellAmount = argv[++index];
    else if (token === "--deposit-fee") args.depositFee = argv[++index];
    else if (token === "--withdraw-shares") args.withdrawShares = argv[++index];
    else if (token === "--withdraw-fee") args.withdrawFee = argv[++index];
    else if (token === "--home-amount") args.homeAmount = argv[++index];
    else if (token === "--home-fee") args.homeFee = argv[++index];
    else if (token === "--deposit-nonce") args.depositNonce = argv[++index];
    else if (token === "--withdraw-nonce") args.withdrawNonce = argv[++index];
    else if (token === "--recovery-amount") args.recoveryAmount = argv[++index];
    else if (token === "--recovery-fee") args.recoveryFee = argv[++index];
    else if (token === "--recovery-nonce") args.recoveryNonce = argv[++index];
    else if (token === "--out") args.out = argv[++index];
    else if (token === "--ws") args.ws = argv[++index];
    else if (token === "--help" || token === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

function usage() {
  return [
    "Usage: node scripts/ops/preflight-bank-xcm-v2-leg.mjs --profile mainnet \\",
    "  --leg deposit_funding|deposit_sell|withdraw_sell|withdraw_home|recovery_home \\",
    "  --wrapper 0x... --adapter 0x... --converted-account 0x... \\",
    "  --dry-run-evidence evidence.json --inner-ref-time N --inner-proof-size N \\",
    "  [the same amount/fee/nonce flags used to generate the exact messages] [--out evidence.json]",
    "",
    "Read-only: runs two ReviveApi_call simulations and never signs or broadcasts."
  ].join("\n");
}

function asPositive(raw, label) {
  const value = BigInt(raw ?? 0);
  if (value <= 0n) throw new Error(`${label} must be positive.`);
  return value;
}

export function deriveSafeReviveLimits(resultJson) {
  const required = resultJson?.weightRequired;
  const storage = resultJson?.storageDeposit;
  const charge = storage?.charge ?? (storage?.refund !== undefined ? 0 : undefined);
  if (required?.refTime === undefined || required?.proofSize === undefined || charge === undefined) {
    throw new Error("ReviveApi_call omitted required weight/storage evidence.");
  }
  const withHeadroom = (value) => (BigInt(value) * 5n + 3n) / 4n;
  return {
    weightLimit: {
      refTime: withHeadroom(required.refTime),
      proofSize: withHeadroom(required.proofSize)
    },
    storageDepositLimit: [MIN_SAFE_STORAGE, withHeadroom(charge)].reduce((max, value) => value > max ? value : max)
  };
}

export function assertReviveLegSimulation(resultJson, expectedReturn) {
  const ok = resultJson?.result?.ok;
  const flags = ok ? Number(ok.flags?.bits ?? ok.flags ?? -1) : null;
  const data = ok?.data;
  if (!ok || flags !== 0 || String(data).toLowerCase() !== String(expectedReturn).toLowerCase()) {
    const detail = ok
      ? `flags=${flags}, data=${data}`
      : `dispatchError=${JSON.stringify(resultJson?.result?.err ?? null)}`;
    throw new Error(`deployed-contract ReviveApi_call failed: ${detail}.`);
  }
  deriveSafeReviveLimits(resultJson);
  return resultJson;
}

export function buildLegCall({ leg, bundle, recovery, wrapper, adapter, owner, maxWeight }) {
  const wrapperIface = new Interface(WRAPPER_FLOW_ABI);
  const adapterIface = new Interface(ADAPTER_FLOW_ABI);
  const message = leg === "recovery_home"
    ? recovery
    : bundle.messages.find((entry) => entry.label === leg);
  if (!message) throw new Error(`message bundle is missing ${leg}.`);

  if (leg === "deposit_funding") {
    return {
      origin: "owner",
      to: adapter,
      expectedReturn: message.requestId,
      data: adapterIface.encodeFunctionData("stageTreasuryDeposit", [
        owner, bundle.contexts.deposit.assets, message.destination, message.message, maxWeight, bundle.contexts.deposit.nonce
      ])
    };
  }
  if (leg === "withdraw_sell") {
    return {
      origin: "owner",
      to: adapter,
      expectedReturn: message.requestId,
      data: adapterIface.encodeFunctionData("stageTreasuryWithdraw", [
        owner, bundle.contexts.withdraw.shares, message.destination, message.message, maxWeight, bundle.contexts.withdraw.nonce
      ])
    };
  }
  if (leg === "recovery_home") {
    return {
      origin: "owner",
      to: wrapper,
      expectedReturn: recovery.recoveryId,
      data: wrapperIface.encodeFunctionData("dispatchRecoveryHome", [
        recovery.amount, recovery.nonce, recovery.destination, recovery.message
      ])
    };
  }
  const context = leg === "deposit_sell" ? bundle.contexts.deposit : bundle.contexts.withdraw;
  return {
    origin: "operator",
    to: wrapper,
    expectedReturn: message.requestId,
    data: wrapperIface.encodeFunctionData("queueRequest", [context, message.destination, message.message, maxWeight])
  };
}

function stringify(value) {
  return JSON.stringify(value, (_key, entry) => typeof entry === "bigint" ? entry.toString() : entry, 2);
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return;
  }
  if (args.profile !== "mainnet" || !LEGS.has(args.leg)) throw new Error("profile must be mainnet and --leg must name one reviewed leg.");
  if (!args.wrapper || !args.adapter || !args.convertedAccount || !args.dryRunEvidence || !args.innerRefTime || !args.innerProofSize) {
    throw new Error("wrapper, adapter, converted account, dry-run evidence, and positive inner weight are required.");
  }
  const wrapperAddress = getAddress(args.wrapper);
  const adapterAddress = getAddress(args.adapter);
  const convertedAccount = String(args.convertedAccount).toLowerCase();
  if (!/^0x[0-9a-f]{64}$/u.test(convertedAccount)) throw new Error("--converted-account must be bytes32.");
  const manifest = loadJson(resolve(repoRoot, "deployments/mainnet.json"));
  const ownerRecord = loadJson(resolve(repoRoot, "deployments/mainnet-multisig-owner.json"));
  const bundle = buildBankXcmV2Messages({
    wrapper: wrapperAddress,
    convertedAccountId32: convertedAccount,
    asset: manifest.contracts.token,
    treasuryContext: manifest.owner,
    depositAssets: BigInt(args.depositAssets),
    depositSellAmount: BigInt(args.depositSellAmount),
    depositFee: BigInt(args.depositFee),
    withdrawShares: BigInt(args.withdrawShares),
    withdrawFee: BigInt(args.withdrawFee),
    homeAmount: BigInt(args.homeAmount),
    homeFee: BigInt(args.homeFee),
    depositNonce: BigInt(args.depositNonce),
    withdrawNonce: BigInt(args.withdrawNonce)
  });
  const recovery = buildRecoveryHomeMessage({
    wrapper: wrapperAddress,
    convertedAccountId32: convertedAccount,
    amount: BigInt(args.recoveryAmount),
    fee: BigInt(args.recoveryFee),
    nonce: BigInt(args.recoveryNonce)
  });
  const evidenceBundle = { ...bundle, messages: [...bundle.messages, recovery] };
  assertDryRunEvidence(loadJson(resolve(args.dryRunEvidence)), evidenceBundle);

  const maxWeight = {
    refTime: asPositive(args.innerRefTime, "--inner-ref-time"),
    proofSize: asPositive(args.innerProofSize, "--inner-proof-size")
  };
  const call = buildLegCall({
    leg: args.leg,
    bundle,
    recovery,
    wrapper: wrapperAddress,
    adapter: adapterAddress,
    owner: getAddress(manifest.owner),
    maxWeight
  });

  const createRpc = dependencies.createCeremonyRpcContext ?? createCeremonyRpcContext;
  const rpc = await createRpc({ manifest, phase: `bank-xcm-v2-preflight-${args.leg}`, write: false });
  let api;
  try {
    printCeremonyRpcPreflight(rpc);
    const wrapperContract = new Contract(wrapperAddress, WRAPPER_FLOW_ABI, rpc.provider);
    const policy = new Contract(getAddress(manifest.contracts.treasuryPolicy), POLICY_BANK_ABI, rpc.provider);
    const [liveOwner, liveOperator, dispatchPaused, hydrationAccount, boundAdapter] = await Promise.all([
      policy.owner(),
      wrapperContract.operator(),
      wrapperContract.dispatchPaused(),
      wrapperContract.hydrationAccountId32(),
      wrapperContract.strategyAdapter(BANK_XCM_V2.strategyId)
    ]);
    const authority = assertOwnerRecordAuthority({ ownerRecord, livePolicyOwner: getAddress(liveOwner) });
    if (getAddress(liveOperator) !== getAddress(manifest.verifier) || getAddress(boundAdapter) !== adapterAddress || hydrationAccount.toLowerCase() !== convertedAccount) {
      throw new Error("live wrapper operator/adapter/converted-account binding mismatch.");
    }
    if (args.leg === "recovery_home" ? dispatchPaused !== true : dispatchPaused !== false) {
      throw new Error(args.leg === "recovery_home" ? "recovery preflight requires local dispatch paused." : "request-leg preflight requires wrapper armed.");
    }

    const [{ ApiPromise, WsProvider }] = await Promise.all([import("@polkadot/api")]);
    api = await ApiPromise.create({
      provider: new WsProvider(args.ws ?? "wss://asset-hub-polkadot-rpc.n.dwellir.com", 5_000),
      noInitWarn: true,
      throwOnConnect: true
    });
    const substrate = await assertSubstrateProfileEncoding({ api, profile: "mainnet", reviveCallHexes: [] });
    const operatorAccount = await api.call.reviveApi.accountId(getAddress(liveOperator));
    const origin = call.origin === "owner" ? authority.derivedAccountId32 : operatorAccount.toHex();

    const high = (await api.call.reviveApi.call(
      origin, call.to, 0n, HIGH_WEIGHT, HIGH_STORAGE, call.data
    )).toJSON();
    assertReviveLegSimulation(high, call.expectedReturn);
    const safe = deriveSafeReviveLimits(high);
    const exact = (await api.call.reviveApi.call(
      origin, call.to, 0n, safe.weightLimit, safe.storageDepositLimit, call.data
    )).toJSON();
    assertReviveLegSimulation(exact, call.expectedReturn);

    const output = {
      schemaVersion: 1,
      kind: "averray.bankXcmV2DeployedLegPreflight",
      profile: "mainnet",
      capturedAt: new Date().toISOString(),
      leg: args.leg,
      wrapper: wrapperAddress,
      adapter: adapterAddress,
      convertedAccountId32: convertedAccount,
      requestId: call.expectedReturn,
      originKind: call.origin,
      originAccountId32: origin,
      substrate: {
        endpoint: args.ws ?? "wss://asset-hub-polkadot-rpc.n.dwellir.com",
        chainName: substrate.chainName,
        genesisHash: substrate.genesisHash,
        revivePalletIndex: substrate.revivePalletIndex
      },
      to: call.to,
      calldata: call.data,
      calldataHash: keccak256(call.data),
      messageHash: (args.leg === "recovery_home" ? recovery : bundle.messages.find((item) => item.label === args.leg)).messageHash,
      innerMaxWeight: maxWeight,
      highCeiling: { weightLimit: HIGH_WEIGHT, storageDepositLimit: HIGH_STORAGE },
      measured: high,
      emittedLimits: safe,
      emittedLimitSimulation: exact,
      result: "pass"
    };
    if (args.out) {
      await writeFile(resolve(args.out), `${stringify(output)}\n`, { flag: "wx" });
      console.log(`deployed-leg preflight written create-only: ${resolve(args.out)}`);
    }
    console.log(stringify(output));
    return output;
  } finally {
    await api?.disconnect?.();
    await rpc.provider.destroy?.();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`preflight-bank-xcm-v2-leg failed: ${error.message}`);
    process.exitCode = 1;
  });
}
