import { onchainTable } from "ponder";

export const job = onchainTable("job", (p) => ({
  id: p.text().primaryKey(),
  poster: p.hex().notNull(),
  worker: p.hex(),
  asset: p.hex().notNull(),
  category: p.hex().notNull(),
  categoryLabel: p.text().notNull(),
  verifierMode: p.hex().notNull(),
  verifierModeLabel: p.text().notNull(),
  reward: p.bigint().notNull(),
  opsReserve: p.bigint().notNull(),
  contingencyReserve: p.bigint().notNull(),
  released: p.bigint().notNull(),
  claimExpiry: p.bigint().notNull(),
  claimStake: p.bigint().notNull(),
  claimStakeBps: p.integer().notNull(),
  payoutMode: p.integer().notNull(),
  payoutModeLabel: p.text().notNull(),
  state: p.integer().notNull(),
  stateLabel: p.text().notNull(),
  createdAtBlock: p.bigint().notNull(),
  createdAtTimestamp: p.bigint().notNull(),
  updatedAtBlock: p.bigint().notNull(),
  updatedAtTimestamp: p.bigint().notNull(),
  lastTxHash: p.hex().notNull()
}));

export const jobEvent = onchainTable("job_event", (p) => ({
  id: p.text().primaryKey(),
  jobId: p.text().notNull(),
  kind: p.text().notNull(),
  actor: p.hex(),
  amount: p.bigint(),
  evidenceHash: p.hex(),
  reasonCode: p.hex(),
  txHash: p.hex().notNull(),
  blockNumber: p.bigint().notNull(),
  timestamp: p.bigint().notNull()
}));

export const payout = onchainTable("payout", (p) => ({
  id: p.text().primaryKey(),
  jobId: p.text().notNull(),
  asset: p.hex().notNull(),
  amount: p.bigint().notNull(),
  recipient: p.hex().notNull(),
  txHash: p.hex().notNull(),
  blockNumber: p.bigint().notNull(),
  timestamp: p.bigint().notNull()
}));

export const badgeMint = onchainTable("badge_mint", (p) => ({
  id: p.text().primaryKey(),
  tokenId: p.bigint().notNull(),
  account: p.hex().notNull(),
  category: p.hex().notNull(),
  categoryLabel: p.text().notNull(),
  level: p.bigint().notNull(),
  metadataUri: p.text().notNull(),
  txHash: p.hex().notNull(),
  blockNumber: p.bigint().notNull(),
  timestamp: p.bigint().notNull()
}));

export const reputationSnapshot = onchainTable("reputation_snapshot", (p) => ({
  id: p.text().primaryKey(),
  account: p.hex().notNull(),
  skill: p.bigint().notNull(),
  reliability: p.bigint().notNull(),
  economic: p.bigint().notNull(),
  tier: p.text().notNull(),
  txHash: p.hex().notNull(),
  blockNumber: p.bigint().notNull(),
  timestamp: p.bigint().notNull()
}));

export const reputationSlash = onchainTable("reputation_slash", (p) => ({
  id: p.text().primaryKey(),
  account: p.hex().notNull(),
  skillDelta: p.bigint().notNull(),
  reliabilityDelta: p.bigint().notNull(),
  economicDelta: p.bigint().notNull(),
  reasonCode: p.hex().notNull(),
  newSkill: p.bigint().notNull(),
  newReliability: p.bigint().notNull(),
  newEconomic: p.bigint().notNull(),
  txHash: p.hex().notNull(),
  blockNumber: p.bigint().notNull(),
  timestamp: p.bigint().notNull()
}));

export const jobStakeEvent = onchainTable("job_stake_event", (p) => ({
  id: p.text().primaryKey(),
  account: p.hex().notNull(),
  asset: p.hex().notNull(),
  kind: p.text().notNull(),
  amount: p.bigint().notNull(),
  posterAmount: p.bigint(),
  treasuryAmount: p.bigint(),
  txHash: p.hex().notNull(),
  blockNumber: p.bigint().notNull(),
  timestamp: p.bigint().notNull()
}));

export const treasuryOutflow = onchainTable("treasury_outflow", (p) => ({
  id: p.text().primaryKey(),
  day: p.bigint().notNull(),
  amount: p.bigint().notNull(),
  newTotal: p.bigint().notNull(),
  txHash: p.hex().notNull(),
  blockNumber: p.bigint().notNull(),
  timestamp: p.bigint().notNull()
}));

export const xcmRequest = onchainTable("xcm_request", (p) => ({
  id: p.text().primaryKey(),
  strategyId: p.hex().notNull(),
  strategyIdLabel: p.text().notNull(),
  kind: p.integer().notNull(),
  kindLabel: p.text().notNull(),
  account: p.hex().notNull(),
  asset: p.hex().notNull(),
  recipient: p.hex().notNull(),
  requestedAssets: p.bigint().notNull(),
  requestedShares: p.bigint().notNull(),
  nonce: p.bigint().notNull(),
  status: p.integer().notNull(),
  statusLabel: p.text().notNull(),
  destinationHash: p.hex(),
  messageHash: p.hex(),
  maxWeightRefTime: p.bigint(),
  maxWeightProofSize: p.bigint(),
  settledAssets: p.bigint().notNull(),
  settledShares: p.bigint().notNull(),
  remoteRef: p.hex(),
  failureCode: p.hex(),
  createdAtBlock: p.bigint().notNull(),
  createdAtTimestamp: p.bigint().notNull(),
  updatedAtBlock: p.bigint().notNull(),
  updatedAtTimestamp: p.bigint().notNull(),
  queuedTxHash: p.hex().notNull(),
  lastTxHash: p.hex().notNull()
}));

export const xcmRequestEvent = onchainTable("xcm_request_event", (p) => ({
  id: p.text().primaryKey(),
  requestId: p.text().notNull(),
  kind: p.text().notNull(),
  status: p.integer(),
  statusLabel: p.text(),
  destinationHash: p.hex(),
  messageHash: p.hex(),
  maxWeightRefTime: p.bigint(),
  maxWeightProofSize: p.bigint(),
  settledAssets: p.bigint(),
  settledShares: p.bigint(),
  remoteRef: p.hex(),
  failureCode: p.hex(),
  txHash: p.hex().notNull(),
  blockNumber: p.bigint().notNull(),
  timestamp: p.bigint().notNull()
}));
