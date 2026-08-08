import { Interface, formatUnits, id } from "ethers";

import { DEFAULT_ESCROW_ASSET } from "../core/assets.js";

// This declaration is recovered from the deployed AgentAccountCore log at
// mainnet tx 0x25fa6c...ef06e. Do not replace it with a source-derived ABI: the
// historical four-field source declaration has a different topic and silently
// returns zero logs against the deployed contract.
export const RESERVATION_SETTLED_TOPIC0 =
  "0x3cdc0be5ec7141f2342208f6404c1b1852936343f0edf1fda179e6c9f46573ee";
export const RESERVATION_SETTLED_SIGNATURE =
  "ReservationSettled(bytes32,address,address,address,uint256)";

const RESERVATION_SETTLED_INTERFACE = new Interface([
  "event ReservationSettled(bytes32 indexed settlementId,address indexed account,address indexed recipient,address asset,uint256 amount)"
]);
// EscrowCore v2's deployed interface is separately pinned in
// deployments/interfaces/mainnet-escrow-core-v2.json. It supplies fee metadata;
// the AAC ReservationSettled log below remains the authoritative value-movement
// proof because the USDC precompile emits no Transfer logs.
const SETTLEMENT_SPLIT_INTERFACE = new Interface([
  "event SettlementSplit(bytes32 indexed jobId,address indexed worker,address indexed treasuryAccount,address asset,uint256 workerAmount,uint256 protocolFeeAmount,uint16 protocolFeeBps)"
]);
const SETTLEMENT_SPLIT_TOPIC0 = id(
  "SettlementSplit(bytes32,address,address,address,uint256,uint256,uint16)"
).toLowerCase();
const JOB_CLOSED_TOPIC0 = id("JobClosed(bytes32,address,uint256)").toLowerCase();
const JOB_CLOSED_INTERFACE = new Interface([
  "event JobClosed(bytes32 indexed jobId,address indexed worker,uint256 releasedAmount)"
]);
const LOG_QUERY_CHUNK_SIZE = 50_000;
const DEFAULT_MAX_RECORDS = 10_000;
const DEFAULT_PAGE_SIZE = 100;

if (
  RESERVATION_SETTLED_INTERFACE.getEvent("ReservationSettled").topicHash.toLowerCase()
  !== RESERVATION_SETTLED_TOPIC0
) {
  throw new Error("Deployed ReservationSettled ABI no longer reproduces its chain-observed topic0.");
}

export async function backfillPayoutReceipts({
  stateStore,
  provider,
  deployment,
  expectedChainId,
  commit = false,
  sessionIds = [],
  pageSize = DEFAULT_PAGE_SIZE,
  maxRecords = DEFAULT_MAX_RECORDS
} = {}) {
  assertDependencies({ stateStore, provider, deployment, expectedChainId });
  const network = await provider.getNetwork();
  if (BigInt(network.chainId) !== BigInt(expectedChainId)) {
    throw new Error(`Payout receipt backfill connected to chain ${network.chainId}, expected ${expectedChainId}.`);
  }

  const sessions = sessionIds.length > 0
    ? await Promise.all(sessionIds.map(async (sessionId) => {
      const session = await stateStore.getSession(sessionId);
      if (!session) throw new Error(`Payout receipt backfill session ${sessionId} was not found.`);
      return session;
    }))
    : await collectSessions(stateStore, pageSize, maxRecords);
  const candidates = sessions.filter(needsPayoutReceiptRepair);
  const latestBlock = candidates.length > 0
    ? await provider.getBlockNumber()
    : undefined;

  // Verify every candidate before the first write. A malformed log, RPC gap, or
  // ambiguous job lookup aborts the batch instead of leaving a partly trusted
  // repair behind.
  const verified = [];
  for (const session of candidates) {
    try {
      verified.push(await verifySessionPayout({ session, provider, deployment, latestBlock }));
    } catch (error) {
      throw new Error(
        `Payout receipt backfill could not chain-verify session ${session.sessionId}: ${error?.message ?? error}`,
        { cause: error }
      );
    }
  }

  if (commit) {
    for (const entry of verified) {
      await stateStore.upsertSession(entry.session);
    }
  }

  return {
    schemaVersion: 1,
    kind: "averray.payoutReceiptBackfillResult",
    mode: commit ? "commit" : "dry-run",
    chainId: String(expectedChainId),
    chainVerified: verified.every((entry) => entry.chainVerified === true),
    scanned: sessions.length,
    candidateCount: candidates.length,
    repairedCount: verified.length,
    storedCount: commit ? verified.length : 0,
    items: verified.map((entry) => ({
      sessionId: entry.session.sessionId,
      jobId: entry.session.jobId,
      chainJobId: entry.chainJobId,
      txHash: entry.txHash,
      blockNumber: entry.blockNumber,
      outcome: entry.outcome,
      workerAmountRaw: entry.workerAmountRaw,
      chainVerified: true,
      stored: commit
    }))
  };
}

export function decodeReservationSettledLog(log) {
  if (String(log?.topics?.[0] ?? "").toLowerCase() !== RESERVATION_SETTLED_TOPIC0) {
    throw new Error("Log is not the chain-observed ReservationSettled event.");
  }
  let parsed;
  try {
    parsed = RESERVATION_SETTLED_INTERFACE.parseLog({ topics: log.topics, data: log.data });
  } catch (error) {
    throw new Error(`ReservationSettled log does not match the deployed five-field ABI: ${error?.message ?? error}`);
  }
  return {
    settlementId: String(parsed.args.settlementId).toLowerCase(),
    account: normalizeAddress(parsed.args.account, "ReservationSettled account"),
    recipient: normalizeAddress(parsed.args.recipient, "ReservationSettled recipient"),
    asset: normalizeAddress(parsed.args.asset, "ReservationSettled asset"),
    amountRaw: parsed.args.amount.toString(),
    txHash: String(log.transactionHash ?? "").toLowerCase(),
    blockNumber: numberValue(log.blockNumber)
  };
}

export function needsPayoutReceiptRepair(session) {
  return session?.status === "resolved"
    && (!validTxHash(session?.payoutTx?.txHash) || !session?.payoutTx?.settlement);
}

async function verifySessionPayout({ session, provider, deployment, latestBlock }) {
  const chainJobId = normalizeChainJobId(session);
  const worker = normalizeAddress(session.wallet, "session worker wallet");
  const proof = await resolveFinalSettlementProof({
    session,
    provider,
    deployment,
    chainJobId,
    latestBlock
  });
  const { txHash, transaction, receipt } = proof;
  const escrowAddress = normalizeAddress(transaction.to ?? receipt.to, "settlement transaction target");
  const currentEscrow = normalizeAddress(deployment.contracts.escrowCore, "current EscrowCore");
  const legacyEscrow = deployment.contracts.legacyEscrowCore
    ? normalizeAddress(deployment.contracts.legacyEscrowCore, "legacy EscrowCore")
    : undefined;
  if (escrowAddress !== currentEscrow && escrowAddress !== legacyEscrow) {
    throw new Error(`Transaction ${txHash} targets undeclared escrow ${escrowAddress}.`);
  }
  const closed = decodeJobClosed(receipt, escrowAddress, chainJobId);
  if (closed.worker !== worker) {
    throw new Error(`JobClosed worker ${closed.worker} does not match session worker ${worker}.`);
  }
  const payoutTx = {
    ...(session.payoutTx ?? {}),
    txHash,
    blockNumber: numberValue(receipt.blockNumber),
    status: 1
  };
  const asset = normalizeAddress(deployment.contracts.token, "deployment settlement asset");
  const reservations = reservationLogs(receipt, deployment);
  const workerReservations = reservations.filter((entry) => entry.recipient === worker && entry.asset === asset);
  if (workerReservations.length !== 1) {
    throw new Error(
      `Approved settlement ${txHash} has ${workerReservations.length} worker ReservationSettled logs; expected exactly one.`
    );
  }
  const workerReservation = workerReservations[0];
  const settlement = escrowAddress === currentEscrow
    ? settlementFromV2Logs({
      receipt,
      escrowAddress,
      chainJobId,
      worker,
      asset,
      reservations,
      workerReservation
    })
    : settlementFromLegacyLog({
      worker,
      asset,
      releasedAmountRaw: closed.releasedAmountRaw,
      reservations,
      workerReservation
    });
  payoutTx.settlement = settlement;

  return {
    session: { ...session, payoutTx },
    chainJobId,
    txHash,
    blockNumber: payoutTx.blockNumber,
    outcome: "resolved",
    workerAmountRaw: settlement.workerAmountRaw,
    chainVerified: true
  };
}

function reservationLogs(receipt, deployment) {
  const agentAccount = normalizeAddress(deployment.contracts.agentAccountCore, "AgentAccountCore");
  return (receipt.logs ?? [])
    .filter((log) => normalizeAddress(log.address, "receipt log address") === agentAccount)
    .filter((log) => String(log?.topics?.[0] ?? "").toLowerCase() === RESERVATION_SETTLED_TOPIC0)
    .map(decodeReservationSettledLog);
}

function settlementFromV2Logs({
  receipt,
  escrowAddress,
  chainJobId,
  worker,
  asset,
  reservations,
  workerReservation
}) {
  const splitLogs = (receipt.logs ?? []).filter(
    (log) => normalizeAddress(log.address, "receipt log address") === escrowAddress
      && String(log?.topics?.[0] ?? "").toLowerCase() === SETTLEMENT_SPLIT_TOPIC0
  );
  if (splitLogs.length !== 1) {
    throw new Error(`EscrowCore v2 receipt has ${splitLogs.length} SettlementSplit logs; expected exactly one.`);
  }
  let parsed;
  try {
    parsed = SETTLEMENT_SPLIT_INTERFACE.parseLog({ topics: splitLogs[0].topics, data: splitLogs[0].data });
  } catch (error) {
    throw new Error(`SettlementSplit does not match the deployed v2 ABI: ${error?.message ?? error}`);
  }
  const split = {
    jobId: String(parsed.args.jobId).toLowerCase(),
    worker: normalizeAddress(parsed.args.worker, "SettlementSplit worker"),
    treasuryAccount: normalizeAddress(parsed.args.treasuryAccount, "SettlementSplit treasury"),
    asset: normalizeAddress(parsed.args.asset, "SettlementSplit asset"),
    workerAmountRaw: parsed.args.workerAmount.toString(),
    protocolFeeAmountRaw: parsed.args.protocolFeeAmount.toString(),
    protocolFeeBps: Number(parsed.args.protocolFeeBps)
  };
  if (
    split.jobId !== chainJobId
    || split.worker !== worker
    || split.asset !== asset
    || split.workerAmountRaw !== workerReservation.amountRaw
  ) {
    throw new Error("SettlementSplit does not corroborate the job-bound AAC worker payout.");
  }
  const expectedReservations = split.protocolFeeAmountRaw === "0" ? 1 : 2;
  if (reservations.length !== expectedReservations) {
    throw new Error(
      `SettlementSplit expects ${expectedReservations} ReservationSettled logs, found ${reservations.length}.`
    );
  }
  if (split.protocolFeeAmountRaw !== "0") {
    const feeMatches = reservations.filter((entry) =>
      entry.recipient === split.treasuryAccount
      && entry.asset === asset
      && entry.amountRaw === split.protocolFeeAmountRaw
    );
    if (feeMatches.length !== 1) {
      throw new Error("AAC fee ReservationSettled does not corroborate SettlementSplit.");
    }
  }
  return settlementRecord(split);
}

function settlementFromLegacyLog({ worker, asset, releasedAmountRaw, reservations, workerReservation }) {
  if (reservations.length !== 1) {
    throw new Error(`Legacy payout has ${reservations.length} ReservationSettled logs; expected one fee-free worker payout.`);
  }
  if (workerReservation.amountRaw !== releasedAmountRaw) {
    throw new Error("Legacy JobClosed released amount does not corroborate AAC ReservationSettled.");
  }
  return settlementRecord({
    worker,
    asset,
    workerAmountRaw: workerReservation.amountRaw,
    protocolFeeAmountRaw: "0",
    protocolFeeBps: 0
  });
}

async function resolveFinalSettlementProof({ session, provider, deployment, chainJobId, latestBlock }) {
  let preferredEscrow;
  const recordedTxHash = validTxHash(session?.payoutTx?.txHash)
    ? session.payoutTx.txHash.toLowerCase()
    : undefined;
  if (recordedTxHash) {
    const recorded = await fetchTransactionProof(provider, recordedTxHash);
    preferredEscrow = normalizeDeclaredEscrow(
      recorded.transaction.to ?? recorded.receipt.to,
      deployment
    );
    if (hasJobClosed(recorded.receipt, preferredEscrow, chainJobId)) {
      return recorded;
    }
  }

  // A legacy receipt may point at the initial approved=false rejection while
  // the session later resolves through dispute. The terminal JobClosed event,
  // not the stale recorded txHash, identifies the actual payout transaction.
  const txHash = await discoverSettlementTransaction({
    provider,
    deployment,
    chainJobId,
    latestBlock,
    preferredEscrow
  });
  return fetchTransactionProof(provider, txHash);
}

async function fetchTransactionProof(provider, txHash) {
  const [transaction, receipt] = await Promise.all([
    provider.getTransaction(txHash),
    provider.getTransactionReceipt(txHash)
  ]);
  if (!transaction || !receipt) throw new Error(`Transaction receipt ${txHash} is unavailable.`);
  if (Number(receipt.status) !== 1) throw new Error(`Transaction ${txHash} did not succeed.`);
  return { txHash, transaction, receipt };
}

function hasJobClosed(receipt, escrowAddress, chainJobId) {
  return (receipt.logs ?? []).some((log) =>
    normalizeAddress(log.address, "receipt log address") === escrowAddress
    && String(log?.topics?.[0] ?? "").toLowerCase() === JOB_CLOSED_TOPIC0
    && String(log?.topics?.[1] ?? "").toLowerCase() === chainJobId
  );
}

function decodeJobClosed(receipt, escrowAddress, chainJobId) {
  const matches = (receipt.logs ?? []).filter((log) =>
    normalizeAddress(log.address, "receipt log address") === escrowAddress
    && String(log?.topics?.[0] ?? "").toLowerCase() === JOB_CLOSED_TOPIC0
    && String(log?.topics?.[1] ?? "").toLowerCase() === chainJobId
  );
  if (matches.length !== 1) {
    throw new Error(`Settlement receipt has ${matches.length} job-bound JobClosed logs; expected exactly one.`);
  }
  let parsed;
  try {
    parsed = JOB_CLOSED_INTERFACE.parseLog({ topics: matches[0].topics, data: matches[0].data });
  } catch (error) {
    throw new Error(`JobClosed log does not match the deployed ABI: ${error?.message ?? error}`);
  }
  return {
    worker: normalizeAddress(parsed.args.worker, "JobClosed worker"),
    releasedAmountRaw: parsed.args.releasedAmount.toString()
  };
}

function settlementRecord({
  worker,
  treasuryAccount = undefined,
  asset,
  workerAmountRaw,
  protocolFeeAmountRaw,
  protocolFeeBps
}) {
  return {
    worker,
    ...(treasuryAccount ? { treasuryAccount } : {}),
    asset,
    assetSymbol: DEFAULT_ESCROW_ASSET.symbol,
    workerAmount: Number(formatUnits(workerAmountRaw, DEFAULT_ESCROW_ASSET.decimals)),
    workerAmountRaw,
    protocolFeeAmount: Number(formatUnits(protocolFeeAmountRaw, DEFAULT_ESCROW_ASSET.decimals)),
    protocolFeeAmountRaw,
    protocolFeeBps
  };
}

async function discoverSettlementTransaction({
  provider,
  deployment,
  chainJobId,
  latestBlock,
  preferredEscrow = undefined
}) {
  if (!Number.isInteger(latestBlock) || latestBlock <= 0) {
    throw new Error("Latest block is required to discover a missing payout transaction.");
  }
  const ranges = [
    {
      address: deployment.contracts.escrowCore,
      fromBlock: deployment.deploymentBlocks?.escrowCoreV2
    },
    ...(deployment.contracts.legacyEscrowCore
      ? [{ address: deployment.contracts.legacyEscrowCore, fromBlock: deployment.deploymentBlocks?.escrowCore }]
      : [])
  ].filter((range) => !preferredEscrow || normalizeAddress(range.address, "escrow lookup address") === preferredEscrow);
  const matches = [];
  for (const range of ranges) {
    if (!Number.isInteger(Number(range.fromBlock))) {
      throw new Error(`Deployment block is unreadable for escrow ${range.address}.`);
    }
    matches.push(...await getLogsChunked(provider, {
      address: range.address,
      topics: [JOB_CLOSED_TOPIC0, chainJobId],
      fromBlock: Number(range.fromBlock),
      toBlock: latestBlock
    }));
  }
  const unique = [...new Set(matches.map((log) => String(log.transactionHash ?? "").toLowerCase()).filter(validTxHash))];
  if (unique.length !== 1) {
    throw new Error(`JobClosed lookup for ${chainJobId} found ${unique.length} settlement transactions; expected one.`);
  }
  return unique[0];
}

function normalizeDeclaredEscrow(value, deployment) {
  const address = normalizeAddress(value, "recorded settlement transaction target");
  const declared = [
    deployment.contracts.escrowCore,
    deployment.contracts.legacyEscrowCore
  ].filter(Boolean).map((entry) => normalizeAddress(entry, "declared escrow"));
  if (!declared.includes(address)) {
    throw new Error(`Recorded payout transaction targets undeclared escrow ${address}.`);
  }
  return address;
}

async function getLogsChunked(provider, { address, topics, fromBlock, toBlock }) {
  const logs = [];
  for (let start = fromBlock; start <= toBlock; start += LOG_QUERY_CHUNK_SIZE) {
    const end = Math.min(toBlock, start + LOG_QUERY_CHUNK_SIZE - 1);
    logs.push(...await provider.getLogs({ address, topics, fromBlock: start, toBlock: end }));
  }
  return logs;
}

async function collectSessions(stateStore, pageSize, maxRecords) {
  const records = [];
  for (let offset = 0; offset < maxRecords; offset += pageSize) {
    const page = await stateStore.listRecentSessions(pageSize, offset);
    if (!Array.isArray(page)) throw new Error("Payout receipt backfill state store returned a non-array page.");
    records.push(...page);
    if (page.length < pageSize) return records;
  }
  throw new Error(`Payout receipt backfill exceeded the ${maxRecords}-session safety bound.`);
}

function normalizeChainJobId(session) {
  const value = session?.chainJobId ?? session?.jobId;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Session has no job identity for chain lookup.");
  }
  return /^0x[a-fA-F0-9]{64}$/u.test(value) ? value.toLowerCase() : id(value).toLowerCase();
}

function normalizeAddress(value, label) {
  const normalized = String(value ?? "").toLowerCase();
  if (!/^0x[a-f0-9]{40}$/u.test(normalized)) throw new Error(`${label} is not a 20-byte EVM address.`);
  return normalized;
}

function validTxHash(value) {
  return typeof value === "string" && /^0x[a-fA-F0-9]{64}$/u.test(value);
}

function numberValue(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new Error(`Invalid chain block number ${value}.`);
  return number;
}

function assertDependencies({ stateStore, provider, deployment, expectedChainId }) {
  if (!stateStore?.getSession || !stateStore?.upsertSession || !stateStore?.listRecentSessions) {
    throw new Error("Payout receipt backfill requires session read/write state-store methods.");
  }
  if (!provider?.getNetwork || !provider?.getTransaction || !provider?.getTransactionReceipt) {
    throw new Error("Payout receipt backfill requires a readable EVM provider.");
  }
  if (!deployment?.contracts?.agentAccountCore || !deployment?.contracts?.escrowCore || !deployment?.contracts?.token) {
    throw new Error("Payout receipt backfill requires a readable deployment manifest.");
  }
  if (expectedChainId === undefined || expectedChainId === null) {
    throw new Error("Payout receipt backfill requires an expected chain id.");
  }
}
