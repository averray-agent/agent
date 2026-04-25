import { hexToString } from "viem";

import { ponder } from "ponder:registry";
import schema from "ponder:schema";

import { EscrowCoreAbi } from "../abis/contractsAbi";

const payoutModeLabels = ["single", "milestone"] as const;
const jobStateLabels = ["none", "open", "claimed", "submitted", "rejected", "disputed", "closed"] as const;
const requestKindLabels = ["deposit", "withdraw", "claim"] as const;
const requestStatusLabels = ["unknown", "pending", "succeeded", "failed", "cancelled"] as const;
const zeroHash = `0x${"0".repeat(64)}` as `0x${string}`;
const hasXcmWrapper = Boolean(
  process.env.PONDER_XCM_WRAPPER_ADDRESS?.trim() || process.env.XCM_WRAPPER_ADDRESS?.trim()
);

const decodeBytes32 = (value: string) => {
  try {
    return hexToString(value as `0x${string}`, { size: 32 }).replace(/\u0000/g, "");
  } catch {
    return value;
  }
};

const toEventId = (txHash: string, logIndex: number | bigint) => `${txHash}-${logIndex.toString()}`;
const nullIfZeroHash = (value: `0x${string}`): `0x${string}` | null =>
  value.toLowerCase() === zeroHash ? null : value;

const toTier = (skill: bigint) => {
  if (skill >= 200n) return "elite";
  if (skill >= 100n) return "pro";
  return "starter";
};

const syncJob = async ({
  context,
  event,
  jobId
}: {
  context: any;
  event: any;
  jobId: `0x${string}`;
}) => {
  const live = await context.client.readContract({
    abi: EscrowCoreAbi,
    address: event.log.address,
    functionName: "jobs",
    args: [jobId]
  });

  const [
    poster,
    worker,
    asset,
    verifierMode,
    category,
    specHash,
    reward,
    opsReserve,
    contingencyReserve,
    released,
    claimExpiry,
    claimStake,
    claimStakeBps,
    payoutMode,
    state
  ] = live;

  await context.db
    .insert(schema.job)
    .values({
      id: jobId,
      poster,
      worker: worker === "0x0000000000000000000000000000000000000000" ? null : worker,
      asset,
      category,
      categoryLabel: decodeBytes32(category),
      verifierMode,
      verifierModeLabel: decodeBytes32(verifierMode),
      specHash: nullIfZeroHash(specHash),
      reward,
      opsReserve,
      contingencyReserve,
      released,
      claimExpiry,
      claimStake,
      claimStakeBps,
      payoutMode,
      payoutModeLabel: payoutModeLabels[payoutMode] ?? "unknown",
      state,
      stateLabel: jobStateLabels[state] ?? "unknown",
      createdAtBlock: event.block.number,
      createdAtTimestamp: event.block.timestamp,
      updatedAtBlock: event.block.number,
      updatedAtTimestamp: event.block.timestamp,
      lastTxHash: event.transaction.hash
    })
    .onConflictDoUpdate((row: any) => ({
      worker: row.worker,
      specHash: row.specHash,
      released: row.released,
      claimExpiry: row.claimExpiry,
      claimStake: row.claimStake,
      claimStakeBps: row.claimStakeBps,
      payoutMode: row.payoutMode,
      payoutModeLabel: row.payoutModeLabel,
      state: row.state,
      stateLabel: row.stateLabel,
      updatedAtBlock: row.updatedAtBlock,
      updatedAtTimestamp: row.updatedAtTimestamp,
      lastTxHash: row.lastTxHash
    }));
};

ponder.on("EscrowCore:JobFunded", async ({ event, context }) => {
  await syncJob({ context, event, jobId: event.args.jobId });
  await context.db.insert(schema.jobEvent).values({
    id: toEventId(event.transaction.hash, event.log.logIndex),
    jobId: event.args.jobId,
    kind: "JobFunded",
    actor: event.args.poster,
    amount: event.args.totalReserved,
    evidenceHash: null,
    reasonCode: null,
    txHash: event.transaction.hash,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp
  });
});

ponder.on("EscrowCore:JobCreated", async ({ event, context }) => {
  await syncJob({ context, event, jobId: event.args.jobId });
  await context.db.insert(schema.jobEvent).values({
    id: toEventId(event.transaction.hash, event.log.logIndex),
    jobId: event.args.jobId,
    kind: "JobCreated",
    actor: event.args.poster,
    amount: event.args.totalReserved,
    evidenceHash: null,
    specHash: event.args.specHash,
    reasonCode: null,
    txHash: event.transaction.hash,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp
  });
});

ponder.on("EscrowCore:JobClaimed", async ({ event, context }) => {
  await syncJob({ context, event, jobId: event.args.jobId });
  await context.db.insert(schema.jobEvent).values({
    id: toEventId(event.transaction.hash, event.log.logIndex),
    jobId: event.args.jobId,
    kind: "JobClaimed",
    actor: event.args.worker,
    amount: event.args.claimStake,
    evidenceHash: null,
    reasonCode: null,
    txHash: event.transaction.hash,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp
  });
});

ponder.on("EscrowCore:WorkSubmitted", async ({ event, context }) => {
  await syncJob({ context, event, jobId: event.args.jobId });
  await context.db.insert(schema.jobEvent).values({
    id: toEventId(event.transaction.hash, event.log.logIndex),
    jobId: event.args.jobId,
    kind: "WorkSubmitted",
    actor: event.args.worker,
    amount: null,
    evidenceHash: event.args.evidenceHash,
    reasonCode: null,
    txHash: event.transaction.hash,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp
  });
});

ponder.on("EscrowCore:Submitted", async ({ event, context }) => {
  await syncJob({ context, event, jobId: event.args.jobId });
  await context.db.insert(schema.jobEvent).values({
    id: toEventId(event.transaction.hash, event.log.logIndex),
    jobId: event.args.jobId,
    kind: "Submitted",
    actor: event.args.worker,
    amount: null,
    evidenceHash: event.args.payloadHash,
    payloadHash: event.args.payloadHash,
    reasonCode: null,
    txHash: event.transaction.hash,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp
  });
});

ponder.on("EscrowCore:JobReopened", async ({ event, context }) => {
  await syncJob({ context, event, jobId: event.args.jobId });
  await context.db.insert(schema.jobEvent).values({
    id: toEventId(event.transaction.hash, event.log.logIndex),
    jobId: event.args.jobId,
    kind: "JobReopened",
    actor: null,
    amount: null,
    evidenceHash: null,
    reasonCode: null,
    txHash: event.transaction.hash,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp
  });
});

ponder.on("EscrowCore:JobRejected", async ({ event, context }) => {
  await syncJob({ context, event, jobId: event.args.jobId });
  await context.db.insert(schema.jobEvent).values({
    id: toEventId(event.transaction.hash, event.log.logIndex),
    jobId: event.args.jobId,
    kind: "JobRejected",
    actor: null,
    amount: null,
    evidenceHash: null,
    reasonCode: event.args.reasonCode,
    txHash: event.transaction.hash,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp
  });
});

ponder.on("EscrowCore:Verified", async ({ event, context }) => {
  await syncJob({ context, event, jobId: event.args.jobId });
  await context.db.insert(schema.jobEvent).values({
    id: toEventId(event.transaction.hash, event.log.logIndex),
    jobId: event.args.jobId,
    kind: "Verified",
    actor: event.args.verifier,
    amount: null,
    evidenceHash: null,
    reasoningHash: event.args.reasoningHash,
    approved: event.args.approved,
    reasonCode: event.args.reasonCode,
    txHash: event.transaction.hash,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp
  });
});

ponder.on("EscrowCore:DisputeOpened", async ({ event, context }) => {
  await syncJob({ context, event, jobId: event.args.jobId });
  await context.db.insert(schema.jobEvent).values({
    id: toEventId(event.transaction.hash, event.log.logIndex),
    jobId: event.args.jobId,
    kind: "DisputeOpened",
    actor: event.args.opener,
    amount: null,
    evidenceHash: null,
    reasonCode: null,
    txHash: event.transaction.hash,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp
  });
});

ponder.on("EscrowCore:JobClosed", async ({ event, context }) => {
  await syncJob({ context, event, jobId: event.args.jobId });
  await context.db.insert(schema.jobEvent).values({
    id: toEventId(event.transaction.hash, event.log.logIndex),
    jobId: event.args.jobId,
    kind: "JobClosed",
    actor: event.args.worker,
    amount: event.args.releasedAmount,
    evidenceHash: null,
    reasonCode: null,
    txHash: event.transaction.hash,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp
  });
  const live = await context.db.find(schema.job, { id: event.args.jobId });
  if (live) {
    await context.db.insert(schema.payout).values({
      id: toEventId(event.transaction.hash, event.log.logIndex),
      jobId: event.args.jobId,
      asset: live.asset,
      amount: event.args.releasedAmount,
      recipient: event.args.worker,
      txHash: event.transaction.hash,
      blockNumber: event.block.number,
      timestamp: event.block.timestamp
    });
  }
});

ponder.on("ReputationSBT:BadgeMinted", async ({ event, context }) => {
  await context.db.insert(schema.badgeMint).values({
    id: event.args.tokenId.toString(),
    tokenId: event.args.tokenId,
    account: event.args.account,
    category: event.args.category,
    categoryLabel: decodeBytes32(event.args.category),
    level: event.args.level,
    metadataUri: event.args.metadataURI,
    txHash: event.transaction.hash,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp
  });
});

ponder.on("ReputationSBT:ReputationUpdated", async ({ event, context }) => {
  await context.db
    .insert(schema.reputationSnapshot)
    .values({
      id: toEventId(event.transaction.hash, event.log.logIndex),
      account: event.args.account,
      skill: event.args.skill,
      reliability: event.args.reliability,
      economic: event.args.economic,
      tier: toTier(event.args.skill),
      txHash: event.transaction.hash,
      blockNumber: event.block.number,
      timestamp: event.block.timestamp
    });
});

ponder.on("ReputationSBT:ReputationSlashed", async ({ event, context }) => {
  await context.db.insert(schema.reputationSlash).values({
    id: toEventId(event.transaction.hash, event.log.logIndex),
    account: event.args.account,
    skillDelta: event.args.skillDelta,
    reliabilityDelta: event.args.reliabilityDelta,
    economicDelta: event.args.economicDelta,
    reasonCode: event.args.reasonCode,
    newSkill: event.args.newSkill,
    newReliability: event.args.newReliability,
    newEconomic: event.args.newEconomic,
    txHash: event.transaction.hash,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp
  });

  await context.db.insert(schema.reputationSnapshot).values({
    id: `${toEventId(event.transaction.hash, event.log.logIndex)}-slash`,
    account: event.args.account,
    skill: event.args.newSkill,
    reliability: event.args.newReliability,
    economic: event.args.newEconomic,
    tier: toTier(event.args.newSkill),
    txHash: event.transaction.hash,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp
  });
});

ponder.on("TreasuryPolicy:OutflowRecorded", async ({ event, context }) => {
  await context.db.insert(schema.treasuryOutflow).values({
    id: toEventId(event.transaction.hash, event.log.logIndex),
    day: event.args.day,
    amount: event.args.amount,
    newTotal: event.args.newTotal,
    txHash: event.transaction.hash,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp
  });
});

ponder.on("DiscoveryRegistry:ManifestPublished", async ({ event, context }) => {
  await context.db.insert(schema.manifestPublication).values({
    id: toEventId(event.transaction.hash, event.log.logIndex),
    version: event.args.version,
    hash: event.args.hash,
    publisher: event.args.publisher,
    txHash: event.transaction.hash,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp
  });
});

ponder.on("VerifierRegistry:VerifierAdded", async ({ event, context }) => {
  await context.db.insert(schema.verifierRegistryEvent).values({
    id: toEventId(event.transaction.hash, event.log.logIndex),
    kind: "VerifierAdded",
    verifier: event.args.verifier,
    adminFrom: null,
    adminTo: null,
    txHash: event.transaction.hash,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp
  });
});

ponder.on("VerifierRegistry:VerifierRemoved", async ({ event, context }) => {
  await context.db.insert(schema.verifierRegistryEvent).values({
    id: toEventId(event.transaction.hash, event.log.logIndex),
    kind: "VerifierRemoved",
    verifier: event.args.verifier,
    adminFrom: null,
    adminTo: null,
    txHash: event.transaction.hash,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp
  });
});

ponder.on("VerifierRegistry:AdminTransferred", async ({ event, context }) => {
  await context.db.insert(schema.verifierRegistryEvent).values({
    id: toEventId(event.transaction.hash, event.log.logIndex),
    kind: "AdminTransferred",
    verifier: null,
    adminFrom: event.args.from,
    adminTo: event.args.to,
    txHash: event.transaction.hash,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp
  });
});

ponder.on("DisclosureLog:Disclosed", async ({ event, context }) => {
  await context.db.insert(schema.disclosureEvent).values({
    id: toEventId(event.transaction.hash, event.log.logIndex),
    kind: "Disclosed",
    hash: event.args.hash,
    byWallet: event.args.byWallet,
    txHash: event.transaction.hash,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp
  });
});

ponder.on("DisclosureLog:AutoDisclosed", async ({ event, context }) => {
  await context.db.insert(schema.disclosureEvent).values({
    id: toEventId(event.transaction.hash, event.log.logIndex),
    kind: "AutoDisclosed",
    hash: event.args.hash,
    byWallet: null,
    txHash: event.transaction.hash,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp
  });
});

ponder.on("AgentAccountCore:JobStakeLocked", async ({ event, context }) => {
  await context.db.insert(schema.jobStakeEvent).values({
    id: toEventId(event.transaction.hash, event.log.logIndex),
    account: event.args.account,
    asset: event.args.asset,
    kind: "locked",
    amount: event.args.amount,
    posterAmount: null,
    treasuryAmount: null,
    txHash: event.transaction.hash,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp
  });
});

ponder.on("AgentAccountCore:JobStakeReleased", async ({ event, context }) => {
  await context.db.insert(schema.jobStakeEvent).values({
    id: toEventId(event.transaction.hash, event.log.logIndex),
    account: event.args.account,
    asset: event.args.asset,
    kind: "released",
    amount: event.args.amount,
    posterAmount: null,
    treasuryAmount: null,
    txHash: event.transaction.hash,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp
  });
});

ponder.on("AgentAccountCore:JobStakeSlashed", async ({ event, context }) => {
  await context.db.insert(schema.jobStakeEvent).values({
    id: toEventId(event.transaction.hash, event.log.logIndex),
    account: event.args.account,
    asset: event.args.asset,
    kind: "slashed",
    amount: event.args.amount,
    posterAmount: event.args.posterAmount,
    treasuryAmount: event.args.treasuryAmount,
    txHash: event.transaction.hash,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp
  });
});

if (hasXcmWrapper) {
ponder.on("XcmWrapper:RequestQueued" as any, async ({ event, context }: any) => {
  const kind = Number(event.args.kind);
  await context.db
    .insert(schema.xcmRequest)
    .values({
      id: event.args.requestId,
      strategyId: event.args.strategyId,
      strategyIdLabel: decodeBytes32(event.args.strategyId),
      kind,
      kindLabel: requestKindLabels[kind] ?? "unknown",
      account: event.args.account,
      asset: event.args.asset,
      recipient: event.args.recipient,
      requestedAssets: event.args.assets,
      requestedShares: event.args.shares,
      nonce: BigInt(event.args.nonce),
      status: 1,
      statusLabel: requestStatusLabels[1],
      destinationHash: null,
      messageHash: null,
      maxWeightRefTime: null,
      maxWeightProofSize: null,
      settledAssets: 0n,
      settledShares: 0n,
      remoteRef: null,
      failureCode: null,
      createdAtBlock: event.block.number,
      createdAtTimestamp: event.block.timestamp,
      updatedAtBlock: event.block.number,
      updatedAtTimestamp: event.block.timestamp,
      queuedTxHash: event.transaction.hash,
      lastTxHash: event.transaction.hash
    })
    .onConflictDoUpdate((row: any) => ({
      strategyId: row.strategyId,
      strategyIdLabel: row.strategyIdLabel,
      kind: row.kind,
      kindLabel: row.kindLabel,
      account: row.account,
      asset: row.asset,
      recipient: row.recipient,
      requestedAssets: row.requestedAssets,
      requestedShares: row.requestedShares,
      nonce: row.nonce,
      updatedAtBlock: row.updatedAtBlock,
      updatedAtTimestamp: row.updatedAtTimestamp,
      lastTxHash: row.lastTxHash
    }));

  await context.db.insert(schema.xcmRequestEvent).values({
    id: toEventId(event.transaction.hash, event.log.logIndex),
    requestId: event.args.requestId,
    kind: "queued",
    status: 1,
    statusLabel: requestStatusLabels[1],
    destinationHash: null,
    messageHash: null,
    maxWeightRefTime: null,
    maxWeightProofSize: null,
    settledAssets: null,
    settledShares: null,
    remoteRef: null,
    failureCode: null,
    txHash: event.transaction.hash,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp
  });
});

ponder.on("XcmWrapper:RequestPayloadStored" as any, async ({ event, context }: any) => {
  await context.db
    .insert(schema.xcmRequest)
    .values({
      id: event.args.requestId,
      strategyId: zeroHash,
      strategyIdLabel: "",
      kind: 0,
      kindLabel: "unknown",
      account: "0x0000000000000000000000000000000000000000",
      asset: "0x0000000000000000000000000000000000000000",
      recipient: "0x0000000000000000000000000000000000000000",
      requestedAssets: 0n,
      requestedShares: 0n,
      nonce: 0n,
      status: 0,
      statusLabel: requestStatusLabels[0],
      destinationHash: event.args.destinationHash,
      messageHash: event.args.messageHash,
      maxWeightRefTime: BigInt(event.args.refTime),
      maxWeightProofSize: BigInt(event.args.proofSize),
      settledAssets: 0n,
      settledShares: 0n,
      remoteRef: null,
      failureCode: null,
      createdAtBlock: event.block.number,
      createdAtTimestamp: event.block.timestamp,
      updatedAtBlock: event.block.number,
      updatedAtTimestamp: event.block.timestamp,
      queuedTxHash: event.transaction.hash,
      lastTxHash: event.transaction.hash
    })
    .onConflictDoUpdate((row: any) => ({
      destinationHash: row.destinationHash,
      messageHash: row.messageHash,
      maxWeightRefTime: row.maxWeightRefTime,
      maxWeightProofSize: row.maxWeightProofSize,
      updatedAtBlock: row.updatedAtBlock,
      updatedAtTimestamp: row.updatedAtTimestamp,
      lastTxHash: row.lastTxHash
    }));

  await context.db.insert(schema.xcmRequestEvent).values({
    id: toEventId(event.transaction.hash, event.log.logIndex),
    requestId: event.args.requestId,
    kind: "payload_stored",
    status: null,
    statusLabel: null,
    destinationHash: event.args.destinationHash,
    messageHash: event.args.messageHash,
    maxWeightRefTime: BigInt(event.args.refTime),
    maxWeightProofSize: BigInt(event.args.proofSize),
    settledAssets: null,
    settledShares: null,
    remoteRef: null,
    failureCode: null,
    txHash: event.transaction.hash,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp
  });
});

ponder.on("XcmWrapper:RequestStatusUpdated" as any, async ({ event, context }: any) => {
  const status = Number(event.args.status);
  await context.db
    .insert(schema.xcmRequest)
    .values({
      id: event.args.requestId,
      strategyId: zeroHash,
      strategyIdLabel: "",
      kind: 0,
      kindLabel: "unknown",
      account: "0x0000000000000000000000000000000000000000",
      asset: "0x0000000000000000000000000000000000000000",
      recipient: "0x0000000000000000000000000000000000000000",
      requestedAssets: 0n,
      requestedShares: 0n,
      nonce: 0n,
      status,
      statusLabel: requestStatusLabels[status] ?? "unknown",
      destinationHash: null,
      messageHash: null,
      maxWeightRefTime: null,
      maxWeightProofSize: null,
      settledAssets: event.args.settledAssets,
      settledShares: event.args.settledShares,
      remoteRef: nullIfZeroHash(event.args.remoteRef),
      failureCode: nullIfZeroHash(event.args.failureCode),
      createdAtBlock: event.block.number,
      createdAtTimestamp: event.block.timestamp,
      updatedAtBlock: event.block.number,
      updatedAtTimestamp: event.block.timestamp,
      queuedTxHash: event.transaction.hash,
      lastTxHash: event.transaction.hash
    })
    .onConflictDoUpdate((row: any) => ({
      status: row.status,
      statusLabel: row.statusLabel,
      settledAssets: row.settledAssets,
      settledShares: row.settledShares,
      remoteRef: row.remoteRef,
      failureCode: row.failureCode,
      updatedAtBlock: row.updatedAtBlock,
      updatedAtTimestamp: row.updatedAtTimestamp,
      lastTxHash: row.lastTxHash
    }));

  await context.db.insert(schema.xcmRequestEvent).values({
    id: toEventId(event.transaction.hash, event.log.logIndex),
    requestId: event.args.requestId,
    kind: "status_updated",
    status,
    statusLabel: requestStatusLabels[status] ?? "unknown",
    destinationHash: null,
    messageHash: null,
    maxWeightRefTime: null,
    maxWeightProofSize: null,
    settledAssets: event.args.settledAssets,
    settledShares: event.args.settledShares,
    remoteRef: nullIfZeroHash(event.args.remoteRef),
    failureCode: nullIfZeroHash(event.args.failureCode),
    txHash: event.transaction.hash,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp
  });
});
}
