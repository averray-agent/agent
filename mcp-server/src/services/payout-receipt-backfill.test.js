import assert from "node:assert/strict";
import test from "node:test";

import { Interface, id } from "ethers";

import { MemoryStateStore } from "../core/state-store.js";
import {
  RESERVATION_SETTLED_SIGNATURE,
  RESERVATION_SETTLED_TOPIC0,
  backfillPayoutReceipts,
  decodeReservationSettledLog
} from "./payout-receipt-backfill.js";

const CHAIN_ID = 420420419n;
const JOB = "0xa436d6a284a986b090c230e68ab65892d63e26879dca57eac971d4f2558dc607";
const OTHER_JOB = `0x${"44".repeat(32)}`;
const TX = "0xb8d8cc3c57b047de60fea15f79f8e453ad18089626eb43d9417d37939302917e";
const FINAL_TX = "0x7afd7fbf64eb19e4f579b5ab59bc14c9b3546ee7a910bd0ad44da9fc7d123222";
const OTHER_TX = `0x${"55".repeat(32)}`;
const LIVE_REJECTED_INPUT = "0xb08c763ea436d6a284a986b090c230e68ab65892d63e26879dca57eac971d4f2558dc6070000000000000000000000000000000000000000000000000000000000000000d2bb3c59606035b0e4849757f1a6b4f9452aab9d082c63bf1208866fef3d067100000000000000000000000000000000000000000000000000000000000000a0617d5c8d463ed92240ac0c727fda14b38ee01a9a076bb19a95f4123a0cdcd1810000000000000000000000000000000000000000000000000000000000000014697066733a2f2f70656e64696e672d6261646765000000000000000000000000";
const WORKER = "0x9ab8531fbb0948c542a31298fd61335f30064239";
const REAL_WORKER = "0x7e071d5e9fbe0c528eacde83b4662b77a041efb9";
const POSTER = "0x5a6836c6d4d293f6e5377e6c28054f4171915813";
const TREASURY = "0x01e6eed856e989201f4ff6346e18eab7e46c874c";
const AAC = "0xb1350932bf85e7ffd0599e9a3cc7b55718d89e57";
const ESCROW = "0x590ebe304e0c7672e2abf3161177d2b94a2ac3fc";
const LEGACY_ESCROW = "0x9ccd1dbbb5c354cc6218e55d3ce924a4d631c035";
const USDC = "0x0000053900000000000000000000000001200000";
const RESERVATION = new Interface([
  "event ReservationSettled(bytes32 indexed settlementId,address indexed account,address indexed recipient,address asset,uint256 amount)"
]);
const SPLIT = new Interface([
  "event SettlementSplit(bytes32 indexed jobId,address indexed worker,address indexed treasuryAccount,address asset,uint256 workerAmount,uint256 protocolFeeAmount,uint16 protocolFeeBps)"
]);
const RESOLVE = new Interface([
  "function resolveSinglePayout(bytes32 jobId,bool approved,bytes32 reasonCode,string metadataURI,bytes32 reasoningHash)"
]);
const JOB_CLOSED = new Interface([
  "event JobClosed(bytes32 indexed jobId,address indexed worker,uint256 releasedAmount)"
]);
const deployment = {
  profile: "mainnet",
  contracts: {
    agentAccountCore: AAC,
    escrowCore: ESCROW,
    legacyEscrowCore: LEGACY_ESCROW,
    token: USDC
  },
  deploymentBlocks: { escrowCore: 18_647_902, escrowCoreV2: 18_809_168 }
};

test("chain-observed ReservationSettled vector reproduces all five deployed fields", () => {
  const live = decodeReservationSettledLog({
    address: AAC,
    transactionHash: "0x25fa6cd445cabaee33b577f77823b1346ed7b6f69c93cd9c5682c814223ef06e",
    blockNumber: 18_658_932,
    topics: [
      "0x3cdc0be5ec7141f2342208f6404c1b1852936343f0edf1fda179e6c9f46573ee",
      "0x56728cedad867da5e22501d5c7f0978c5ed2f01484babe7cb31f0decefc5c721",
      "0x0000000000000000000000005a6836c6d4d293f6e5377e6c28054f4171915813",
      "0x0000000000000000000000009ab8531fbb0948c542a31298fd61335f30064239"
    ],
    data: "0x000000000000000000000000000005390000000000000000000000000120000000000000000000000000000000000000000000000000000000000000000186a0"
  });

  assert.equal(RESERVATION_SETTLED_SIGNATURE, "ReservationSettled(bytes32,address,address,address,uint256)");
  assert.equal(id(RESERVATION_SETTLED_SIGNATURE), RESERVATION_SETTLED_TOPIC0);
  assert.deepEqual(live, {
    settlementId: "0x56728cedad867da5e22501d5c7f0978c5ed2f01484babe7cb31f0decefc5c721",
    account: POSTER,
    recipient: WORKER,
    asset: USDC,
    amountRaw: "100000",
    txHash: "0x25fa6cd445cabaee33b577f77823b1346ed7b6f69c93cd9c5682c814223ef06e",
    blockNumber: 18_658_932
  });
});

test("legacy approved receipt is dry-run first, then commits an AAC-proven payout", async () => {
  const store = await storeWithSessions([resolvedSession({
    payoutTx: { txHash: TX, blockNumber: 18_658_932, status: 1 }
  })]);
  const provider = fakeProvider({
    [TX]: approvedProof({ jobId: JOB, txHash: TX, escrow: LEGACY_ESCROW, amountRaw: 100_000n })
  });

  const dryRun = await backfillPayoutReceipts({
    stateStore: store,
    provider,
    deployment,
    expectedChainId: CHAIN_ID
  });
  assert.equal(dryRun.mode, "dry-run");
  assert.equal(dryRun.chainVerified, true);
  assert.equal(dryRun.repairedCount, 1);
  assert.equal(dryRun.storedCount, 0);
  assert.equal((await store.getSession("session-1")).payoutTx.settlement, undefined);

  const committed = await backfillPayoutReceipts({
    stateStore: store,
    provider,
    deployment,
    expectedChainId: CHAIN_ID,
    commit: true
  });
  const repaired = await store.getSession("session-1");
  assert.equal(committed.mode, "commit");
  assert.equal(committed.items[0].chainVerified, true);
  assert.equal(repaired.payoutTx.settlement.workerAmountRaw, "100000");
  assert.equal(repaired.payoutTx.settlement.protocolFeeAmountRaw, "0");
});

test("missing canary payoutTx is discovered by JobClosed and corroborated by AAC plus v2 split", async () => {
  const store = await storeWithSessions([resolvedSession({
    sessionId: "canary-session",
    jobId: "worker-canary-1",
    chainJobId: OTHER_JOB
  })]);
  const proof = approvedProof({
    jobId: OTHER_JOB,
    txHash: OTHER_TX,
    escrow: ESCROW,
    amountRaw: 100_000n,
    v2: true
  });
  const provider = fakeProvider({ [OTHER_TX]: proof }, {
    getLogs: async (filter) => filter.address.toLowerCase() === ESCROW
      ? [{ transactionHash: OTHER_TX }]
      : []
  });

  const result = await backfillPayoutReceipts({
    stateStore: store,
    provider,
    deployment,
    expectedChainId: CHAIN_ID,
    commit: true
  });

  assert.equal(result.items[0].txHash, OTHER_TX);
  assert.equal(result.items[0].workerAmountRaw, "100000");
  assert.equal((await store.getSession("canary-session")).payoutTx.settlement.protocolFeeBps, 0);
});

test("stale rejection tx follows JobClosed to the real final payout transaction", async () => {
  const store = await storeWithSessions([resolvedSession({
    wallet: REAL_WORKER,
    payoutTx: { txHash: TX, blockNumber: 18_926_650, status: 1 }
  })]);
  const decodedRejection = RESOLVE.decodeFunctionData("resolveSinglePayout", LIVE_REJECTED_INPUT);
  assert.equal(decodedRejection.jobId.toLowerCase(), JOB);
  assert.equal(decodedRejection.approved, false, "the recorded legacy tx is the rejection leg, not payout proof");
  const provider = fakeProvider({
    [TX]: rejectedProof({ jobId: JOB, txHash: TX, escrow: ESCROW, data: LIVE_REJECTED_INPUT }),
    [FINAL_TX]: liveFinalProof()
  }, {
    getLogs: async (filter) => filter.address.toLowerCase() === ESCROW
      ? [{ transactionHash: FINAL_TX }]
      : []
  });

  const result = await backfillPayoutReceipts({
    stateStore: store,
    provider,
    deployment,
    expectedChainId: CHAIN_ID,
    commit: true
  });
  const repaired = await store.getSession("session-1");

  assert.equal(result.items[0].outcome, "resolved");
  assert.equal(result.items[0].txHash, FINAL_TX);
  assert.equal(result.items[0].workerAmountRaw, "1000000");
  assert.equal(repaired.status, "resolved");
  assert.equal(repaired.payoutTx.txHash, FINAL_TX);
  assert.equal(repaired.payoutTx.settlement.protocolFeeAmountRaw, "50000");
  assert.equal(repaired.payoutTx.settlement.protocolFeeBps, 500);
});

test("approved receipt without AAC ReservationSettled fails closed", async () => {
  const store = await storeWithSessions([resolvedSession({ payoutTx: { txHash: TX } })]);
  const proof = approvedProof({ jobId: JOB, txHash: TX, escrow: LEGACY_ESCROW, amountRaw: 100_000n });
  proof.receipt.logs = proof.receipt.logs.filter((log) => log.address.toLowerCase() !== AAC);
  const provider = fakeProvider({ [TX]: proof });

  await assert.rejects(
    () => backfillPayoutReceipts({
      stateStore: store,
      provider,
      deployment,
      expectedChainId: CHAIN_ID,
      commit: true
    }),
    /0 worker ReservationSettled logs/u
  );
  assert.equal((await store.getSession("session-1")).payoutTx.settlement, undefined);
});

function resolvedSession(overrides = {}) {
  return {
    sessionId: "session-1",
    jobId: JOB,
    chainJobId: JOB,
    wallet: WORKER,
    status: "resolved",
    resolvedAt: "2026-08-01T11:50:31.165Z",
    ...overrides
  };
}

async function storeWithSessions(sessions) {
  const store = new MemoryStateStore();
  for (const session of sessions) await store.upsertSession(session);
  return store;
}

function approvedProof({
  jobId,
  txHash,
  escrow,
  amountRaw,
  worker = WORKER,
  feeRaw = 0n,
  v2 = false
}) {
  const reservation = RESERVATION.encodeEventLog(RESERVATION.getEvent("ReservationSettled"), [
    `0x${"66".repeat(32)}`,
    POSTER,
    worker,
    USDC,
    amountRaw
  ]);
  const logs = [{
    address: AAC,
    transactionHash: txHash,
    blockNumber: 19_000_000,
    ...reservation
  }];
  if (v2) {
    if (feeRaw > 0n) {
      const feeReservation = RESERVATION.encodeEventLog(RESERVATION.getEvent("ReservationSettled"), [
        `0x${"67".repeat(32)}`,
        POSTER,
        TREASURY,
        USDC,
        feeRaw
      ]);
      logs.push({ address: AAC, transactionHash: txHash, blockNumber: 19_000_000, ...feeReservation });
    }
    const split = SPLIT.encodeEventLog(SPLIT.getEvent("SettlementSplit"), [
      jobId,
      worker,
      TREASURY,
      USDC,
      amountRaw,
      feeRaw,
      feeRaw > 0n ? 500 : 0
    ]);
    logs.push({ address: ESCROW, transactionHash: txHash, blockNumber: 19_000_000, ...split });
  }
  const closed = JOB_CLOSED.encodeEventLog(JOB_CLOSED.getEvent("JobClosed"), [
    jobId,
    worker,
    amountRaw
  ]);
  logs.push({ address: escrow, transactionHash: txHash, blockNumber: 19_000_000, ...closed });
  return {
    transaction: {
      hash: txHash,
      to: escrow,
      value: 0n,
      data: RESOLVE.encodeFunctionData("resolveSinglePayout", [
        jobId,
        true,
        `0x${"77".repeat(32)}`,
        "ipfs://pending-badge",
        `0x${"88".repeat(32)}`
      ])
    },
    receipt: { to: escrow, status: 1, blockNumber: 19_000_000, logs }
  };
}

function rejectedProof({ jobId, txHash, escrow, data = undefined }) {
  return {
    transaction: {
      hash: txHash,
      to: escrow,
      value: 0n,
      data: data ?? RESOLVE.encodeFunctionData("resolveSinglePayout", [
        jobId,
        false,
        `0x${"99".repeat(32)}`,
        "ipfs://pending-badge",
        `0x${"aa".repeat(32)}`
      ])
    },
    receipt: { to: escrow, status: 1, blockNumber: 18_926_650, logs: [] }
  };
}

function liveFinalProof() {
  const blockNumber = 18_928_437;
  return {
    transaction: { hash: FINAL_TX, to: ESCROW, value: 0n, data: "0x" },
    receipt: {
      to: ESCROW,
      status: 1,
      blockNumber,
      logs: [
        {
          address: AAC,
          transactionHash: FINAL_TX,
          blockNumber,
          topics: [
            RESERVATION_SETTLED_TOPIC0,
            "0x50f48b3a1f3a6cd388f93f0c298c7bdc38359593f756f586b6e9b509d2aa36fd",
            "0x000000000000000000000000089a0a57d001bacb8473161e007f0babc1768cee",
            "0x0000000000000000000000007e071d5e9fbe0c528eacde83b4662b77a041efb9"
          ],
          data: "0x000000000000000000000000000005390000000000000000000000000120000000000000000000000000000000000000000000000000000000000000000f4240"
        },
        {
          address: AAC,
          transactionHash: FINAL_TX,
          blockNumber,
          topics: [
            RESERVATION_SETTLED_TOPIC0,
            "0xf541d2ab2f5a69b8a814691bf7ca40f6f532a4046464e0a51d3a3d6e81eca4d5",
            "0x000000000000000000000000089a0a57d001bacb8473161e007f0babc1768cee",
            "0x00000000000000000000000001e6eed856e989201f4ff6346e18eab7e46c874c"
          ],
          data: "0x0000000000000000000000000000053900000000000000000000000001200000000000000000000000000000000000000000000000000000000000000000c350"
        },
        {
          address: ESCROW,
          transactionHash: FINAL_TX,
          blockNumber,
          topics: [
            "0x53e36b29276b78a488b807db3589a5f2ecaaf30950db3b11fb53fdfdf2f36e72",
            JOB,
            "0x0000000000000000000000007e071d5e9fbe0c528eacde83b4662b77a041efb9",
            "0x00000000000000000000000001e6eed856e989201f4ff6346e18eab7e46c874c"
          ],
          data: "0x000000000000000000000000000005390000000000000000000000000120000000000000000000000000000000000000000000000000000000000000000f4240000000000000000000000000000000000000000000000000000000000000c35000000000000000000000000000000000000000000000000000000000000001f4"
        },
        {
          address: ESCROW,
          transactionHash: FINAL_TX,
          blockNumber,
          topics: [
            "0x1965adbb1dd230146bba5d3108b689a4f6f22d573d21b8842b56dc421eb41fa4",
            JOB,
            "0x0000000000000000000000007e071d5e9fbe0c528eacde83b4662b77a041efb9"
          ],
          data: "0x00000000000000000000000000000000000000000000000000000000000f4240"
        }
      ]
    }
  };
}

function fakeProvider(proofs, overrides = {}) {
  return {
    async getNetwork() { return { chainId: CHAIN_ID }; },
    async getBlockNumber() { return 19_100_000; },
    async getTransaction(txHash) { return proofs[txHash]?.transaction; },
    async getTransactionReceipt(txHash) { return proofs[txHash]?.receipt; },
    async getLogs() { return []; },
    ...overrides
  };
}
