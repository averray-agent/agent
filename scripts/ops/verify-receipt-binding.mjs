#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { Interface, JsonRpcProvider, getAddress } from "ethers";

import { ESCROW_CORE_ABI } from "../../mcp-server/src/blockchain/abis.js";
import { computeVerdictCoreCommitment } from "../../mcp-server/src/core/work-receipt.js";

const DEFAULT_API_BASE = "https://api.averray.com";
const RECEIPT_ID_RE = /^0x[a-fA-F0-9]{64}$/u;
const escrowInterface = new Interface(ESCROW_CORE_ABI);

export async function verifyReceiptBinding({
  receipt,
  transactionReceipt,
  escrowAddress
}) {
  if (!receipt?.chainBinding) {
    throw new Error("Receipt has no chainBinding; legacy receipts are not replayable by this proof.");
  }
  const binding = receipt.chainBinding;
  const commitment = computeVerdictCoreCommitment(receipt);
  if (commitment !== String(binding.committedVerdictHash ?? "").toLowerCase()) {
    throw new Error(
      `Receipt commitment mismatch: binding ${binding.committedVerdictHash ?? "missing"}, reproduced ${commitment}.`
    );
  }
  if (
    !transactionReceipt
    || Number(transactionReceipt.status) !== 1
    || String(transactionReceipt.hash ?? transactionReceipt.transactionHash ?? "").toLowerCase()
      !== String(binding.verifiedTxHash ?? "").toLowerCase()
  ) {
    throw new Error("The named settlement transaction is missing, unsuccessful, or has a different hash.");
  }

  const expectedEscrow = getAddress(escrowAddress).toLowerCase();
  const expectedLogIndex = Number(binding.logIndex);
  const log = (transactionReceipt.logs ?? []).find((candidate) =>
    Number(candidate.index ?? candidate.logIndex) === expectedLogIndex
    && String(candidate.address ?? "").toLowerCase() === expectedEscrow
  );
  if (!log) {
    throw new Error(`Verified log ${expectedLogIndex} was not emitted by the configured EscrowCore.`);
  }
  const parsed = escrowInterface.parseLog(log);
  if (parsed?.name !== "Verified") {
    throw new Error(`Log ${expectedLogIndex} is ${parsed?.name ?? "unparseable"}, not Verified.`);
  }
  const eventJobId = String(parsed.args.jobId).toLowerCase();
  const eventCommitment = String(parsed.args.reasoningHash).toLowerCase();
  if (eventJobId !== String(receipt.chainJobId ?? "").toLowerCase()) {
    throw new Error("Verified event jobId does not match the receipt chainJobId.");
  }
  if (eventCommitment !== commitment) {
    throw new Error(
      `Verified event commitment mismatch: event ${eventCommitment}, reproduced ${commitment}.`
    );
  }
  return {
    receiptId: receipt.receiptId,
    commitment,
    txHash: String(binding.verifiedTxHash).toLowerCase(),
    logIndex: expectedLogIndex
  };
}

export function formatReceiptBindingVerdict(result, { fixture = false } = {}) {
  return `${fixture ? "FIXTURE " : ""}PASS receipt-keyed, operator-verified receipt ${result.receiptId} commitment ${result.commitment} tx ${result.txHash} log ${result.logIndex}`;
}

export async function runReceiptBindingCli(argv = process.argv.slice(2), {
  fetchImpl = globalThis.fetch
} = {}) {
  const args = parseArgs(argv);
  if (args.fixture) {
    const fixture = JSON.parse(await readFile(args.fixture, "utf8"));
    const result = await verifyReceiptBinding(fixture);
    return formatReceiptBindingVerdict(result, { fixture: true });
  }
  if (!args.receipt) {
    throw new Error("Usage: verify-receipt-binding.mjs <receipt-id-or-url> [--rpc-url <url>] [--escrow <address>]");
  }
  const deployment = JSON.parse(await readFile(
    new URL("../../deployments/mainnet.json", import.meta.url),
    "utf8"
  ));
  const receiptUrl = RECEIPT_ID_RE.test(args.receipt)
    ? `${args.apiBase ?? DEFAULT_API_BASE}/receipts/${args.receipt.toLowerCase()}`
    : new URL(args.receipt).toString();
  const response = await fetchImpl(receiptUrl, { headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`Receipt fetch failed with HTTP ${response.status}.`);
  }
  const receipt = await response.json();
  if (!receipt?.chainBinding?.verifiedTxHash) {
    throw new Error("Receipt has no chainBinding; legacy receipts are not replayable by this proof.");
  }
  const provider = new JsonRpcProvider(args.rpcUrl ?? process.env.RPC_URL ?? deployment.rpcUrl);
  const transactionReceipt = await provider.getTransactionReceipt(receipt.chainBinding.verifiedTxHash);
  const result = await verifyReceiptBinding({
    receipt,
    transactionReceipt,
    escrowAddress: args.escrow ?? deployment.contracts.escrowCore
  });
  return formatReceiptBindingVerdict(result);
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--fixture") parsed.fixture = argv[++index];
    else if (value === "--rpc-url") parsed.rpcUrl = argv[++index];
    else if (value === "--escrow") parsed.escrow = argv[++index];
    else if (value === "--api-base") parsed.apiBase = argv[++index]?.replace(/\/+$/u, "");
    else if (!parsed.receipt) parsed.receipt = value;
    else throw new Error(`Unknown argument ${value}.`);
  }
  return parsed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runReceiptBindingCli()
    .then((line) => console.log(line))
    .catch((error) => {
      console.error(`FAIL receipt binding: ${error?.message ?? error}`);
      process.exitCode = 1;
    });
}
