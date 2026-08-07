import { readFileSync } from "node:fs";

import { ApiPromise, WsProvider } from "@polkadot/api";
import { Interface, JsonRpcProvider } from "ethers";

import { createStateStore } from "../core/state-store.js";

const FIXTURE_URL = new URL(
  "../services/fixtures/mainnet-bank-v221-10usdc-deposit-swap.json",
  import.meta.url
);
const DISPATCH_INTERFACE = new Interface([
  "function dispatchLeg(bytes32 requestId,uint8 leg,uint256 feeAmount)"
]);

const commit = process.argv.slice(2).includes("--commit");
if (process.argv.slice(2).some((argument) => argument !== "--commit")) {
  throw new Error("Usage: node src/demo/backfill-bank-v22-deposit-evidence.js [--commit]");
}

const fixture = JSON.parse(readFileSync(FIXTURE_URL, "utf8"));
const event = fixture?.event;
const evidence = event?.data;
const remote = evidence?.remoteExecution;
assertFixtureShape(event);

const assetHubProvider = new JsonRpcProvider(assetHubRpcUrl());
const hydrationProvider = new WsProvider(requiredEnv("BANK_XCM_HYDRATION_SUBSTRATE_RPC_URL"));
const hydration = await ApiPromise.create({ provider: hydrationProvider, noInitWarn: true });
const stateStore = createStateStore(process.env, { logger: { warn() {} } });

try {
  const [receipt, transaction, hydrationHash] = await Promise.all([
    assetHubProvider.getTransactionReceipt(evidence.txHash),
    assetHubProvider.getTransaction(evidence.txHash),
    hydration.rpc.chain.getBlockHash(remote.blockNumber)
  ]);
  const network = await assetHubProvider.getNetwork();
  if (network.chainId !== BigInt(fixture.chainId)) {
    throw new Error(`Asset Hub chainId ${network.chainId} does not match ${fixture.chainId}.`);
  }
  if (!receipt || receipt.status !== 1 || receipt.blockNumber !== evidence.blockNumber) {
    throw new Error("Asset Hub dispatch receipt does not match the committed backfill evidence.");
  }
  if (!transaction || String(transaction.to).toLowerCase() !== evidence.wrapper) {
    throw new Error("Asset Hub dispatch transaction does not target the recorded wrapper generation.");
  }
  const decoded = DISPATCH_INTERFACE.decodeFunctionData("dispatchLeg", transaction.data);
  if (String(decoded.requestId).toLowerCase() !== evidence.requestId || Number(decoded.leg) !== 1) {
    throw new Error("Asset Hub transaction is not deposit_sell for the recorded requestId.");
  }
  if (hydrationHash.toHex().toLowerCase() !== remote.blockHash) {
    throw new Error("Hydration block hash does not match the committed backfill evidence.");
  }

  const records = await hydration.query.system.events.at(hydrationHash);
  const swapRecord = records[remote.eventIndex];
  const processedRecord = records[remote.processedEventIndex];
  assertRemoteSwap(swapRecord, remote, evidence.requestId);
  assertRemoteProcessed(processedRecord, remote, evidence.requestId);

  const existing = await stateStore.getBankXcmLegDispatchEvidence(
    evidence.wrapper,
    evidence.requestId,
    evidence.leg
  );
  if (existing && JSON.stringify(existing) !== JSON.stringify(event)) {
    throw new Error("A different generation-keyed dispatch record already exists; refusing overwrite.");
  }
  if (commit && !existing) {
    await stateStore.recordBankXcmLegDispatchEvidence(event);
  }

  console.log(JSON.stringify({
    schemaVersion: 1,
    kind: "averray.bankV22DepositDispatchBackfillResult",
    mode: commit ? "commit" : "dry-run",
    chainVerified: true,
    alreadyPresent: Boolean(existing),
    stored: Boolean(existing || commit),
    wrapper: evidence.wrapper,
    requestId: evidence.requestId,
    leg: evidence.leg,
    assetHub: {
      txHash: evidence.txHash,
      blockNumber: evidence.blockNumber,
      receiptStatus: receipt.status
    },
    hydration: {
      blockNumber: remote.blockNumber,
      blockHash: remote.blockHash,
      eventIndex: remote.eventIndex,
      event: `${remote.event.section}.${remote.event.method}`,
      amountInRaw: "10000000",
      amountOutRaw: "10000000",
      processedEventIndex: remote.processedEventIndex,
      processedSuccess: true
    }
  }, null, 2));
} finally {
  await Promise.allSettled([
    hydration.disconnect(),
    stateStore.client?.quit?.()
  ]);
  assetHubProvider.destroy();
}

function assertFixtureShape(input) {
  if (input?.topic !== "bank.v22_leg_dispatched") throw new Error("Backfill topic is invalid.");
  if (input?.data?.leg !== "deposit_sell" || Number(input?.data?.legIndex) !== 1) {
    throw new Error("Backfill evidence must describe deposit_sell leg 1.");
  }
  if (!/^0x[a-f0-9]{40}$/u.test(input?.data?.wrapper ?? "")) throw new Error("Backfill wrapper is invalid.");
  if (!/^0x[a-f0-9]{64}$/u.test(input?.data?.requestId ?? "")) throw new Error("Backfill requestId is invalid.");
  if (!/^0x[a-f0-9]{64}$/u.test(input?.data?.txHash ?? "")) throw new Error("Backfill txHash is invalid.");
}

function assertRemoteSwap(record, expected, requestId) {
  if (!record || record.event.section.toLowerCase() !== "broadcast" || record.event.method !== "Swapped3") {
    throw new Error("Hydration backfill event is not Broadcast.Swapped3.");
  }
  if (record.event.toHex().toLowerCase() !== expected.eventRaw) {
    throw new Error("Hydration Broadcast.Swapped3 raw bytes differ from the committed evidence.");
  }
  const human = record.event.data.toHuman();
  const input = human.inputs?.find((entry) => rawInteger(entry.asset) === 22n);
  const output = human.outputs?.find((entry) => rawInteger(entry.asset) === 1003n);
  const xcm = human.operationStack?.find((entry) => Array.isArray(entry.Xcm))?.Xcm;
  if (
    String(human.fillerType).toUpperCase() !== "AAVE"
    || String(human.operation) !== "ExactIn"
    || rawInteger(input?.amount) !== 10_000_000n
    || rawInteger(output?.amount) !== 10_000_000n
    || String(xcm?.[0]).toLowerCase() !== requestId
  ) {
    throw new Error("Hydration Broadcast.Swapped3 semantics differ from the committed evidence.");
  }
}

function assertRemoteProcessed(record, expected, requestId) {
  if (!record || record.event.section.toLowerCase() !== "messagequeue" || record.event.method !== "Processed") {
    throw new Error("Hydration backfill omitted messageQueue.Processed.");
  }
  if (record.event.toHex().toLowerCase() !== expected.processedEventRaw) {
    throw new Error("Hydration messageQueue.Processed raw bytes differ from the committed evidence.");
  }
  const human = record.event.data.toHuman();
  if (String(human.id).toLowerCase() !== requestId || human.success !== true) {
    throw new Error("Hydration messageQueue.Processed does not prove successful execution for requestId.");
  }
}

function rawInteger(value) {
  const normalized = String(value ?? "").replaceAll(",", "");
  return /^(0|[1-9][0-9]*)$/u.test(normalized) ? BigInt(normalized) : null;
}

function requiredEnv(name) {
  const value = String(process.env[name] ?? "").trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function assetHubRpcUrl() {
  const value = process.env.DWELLER_RPC_URL
    ?? process.env.POLKADOT_RPC_URL
    ?? process.env.RPC_URL;
  if (!String(value ?? "").trim()) {
    throw new Error("RPC_URL (or DWELLER_RPC_URL / POLKADOT_RPC_URL) is required.");
  }
  return String(value).trim();
}
