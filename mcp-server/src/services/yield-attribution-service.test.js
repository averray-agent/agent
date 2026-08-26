import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { Interface } from "ethers";

import { DEPOSIT_POOL_ABI, ERC20_MOCK_ABI } from "../blockchain/abis.js";
import { MemoryStateStore } from "../core/state-store.js";
import {
  YIELD_SUBSIDY_ATTESTATION,
  EvmYieldAttributionChainReader,
  YieldAttributionService,
  buildYieldAttribution
} from "./yield-attribution-service.js";

const POOL = "0x1111111111111111111111111111111111111111";
const ASSET = "0x0000053900000000000000000000000001200000";
const OPERATOR = "0x2222222222222222222222222222222222222222";
const EARLY = "0x3333333333333333333333333333333333333333";
const LATE = "0x4444444444444444444444444444444444444444";
const TX_HASH = `0x${"ab".repeat(32)}`;

function snapshot(overrides = {}) {
  return {
    blockNumber: 200,
    totalAssets: 10_000_000n,
    totalSupply: 10_000_000n,
    bufferAssets: 10_000_000n,
    deployedPrincipal: 0n,
    venueMarkedAssets: null,
    ...overrides
  };
}

function subsidy(amountRaw = "1000000") {
  return {
    txHash: TX_HASH,
    amountRaw,
    timestamp: "2026-08-25T12:00:00.000Z",
    blockNumber: 150,
    chainId: 420_420_419
  };
}

function deposit(owner, assetsRaw, sharesRaw, blockNumber) {
  return {
    type: "Deposit",
    owner,
    assetsRaw: String(assetsRaw),
    sharesRaw: String(sharesRaw),
    blockNumber,
    logIndex: 1,
    txHash: `0x${String(blockNumber).padStart(64, "0")}`
  };
}

test("ledger mutation attributes a subsidy-only NAV rise to operator-added assets instead of venue earnings", () => {
  const events = [deposit(EARLY, 10_000_000, 10_000_000, 100)];
  const live = snapshot({ totalAssets: 11_000_000n, bufferAssets: 11_000_000n });
  const withoutAttestation = buildYieldAttribution({ snapshot: live, events });
  const withAttestation = buildYieldAttribution({ snapshot: live, events, ledgerEntries: [subsidy()] });

  assert.equal(withoutAttestation.gain.venueEarned.raw, "1000000");
  assert.equal(withoutAttestation.gain.operatorAdded.raw, "0");
  assert.equal(withAttestation.gain.cumulativeNav.raw, withoutAttestation.gain.cumulativeNav.raw);
  assert.equal(withAttestation.gain.venueEarned.raw, "0", "the ledger mutation must remove the donation from venue earnings");
  assert.equal(withAttestation.gain.operatorAdded.raw, "1000000");
});

test("served attribution carries the exact operator attestation beside independently verifiable transaction proof", async () => {
  const token = new Interface(ERC20_MOCK_ABI);
  const store = new MemoryStateStore();
  const service = new YieldAttributionService({
    poolAddress: POOL,
    assetAddress: ASSET,
    chainId: 420_420_419,
    stateStore: store,
    chainReader: { async readHistory() { return []; } },
    provider: {
      async getTransaction(hash) {
        assert.equal(hash, TX_HASH);
        return {
          hash,
          to: ASSET,
          from: OPERATOR,
          value: 0n,
          data: token.encodeFunctionData("transfer", [POOL, 1_000_000n])
        };
      },
      async getTransactionReceipt() {
        return { status: 1, blockNumber: 150, blockHash: `0x${"cd".repeat(32)}` };
      },
      async getBlock() {
        return { timestamp: 1_777_000_000, hash: `0x${"cd".repeat(32)}` };
      }
    },
    now: () => new Date("2026-08-25T12:05:00.000Z")
  });

  const captured = await service.attestSubsidy({ txHash: TX_HASH.toUpperCase().replace("0X", "0x"), attestedBy: OPERATOR });
  const served = buildYieldAttribution({
    snapshot: snapshot({ totalAssets: 1_000_000n, bufferAssets: 1_000_000n }),
    ledgerEntries: await store.listYieldSubsidyEntries()
  });

  assert.equal(captured.created, true);
  assert.equal(captured.attestation, YIELD_SUBSIDY_ATTESTATION);
  assert.equal(served.subsidyLedger.attestation, YIELD_SUBSIDY_ATTESTATION);
  assert.deepEqual(served.subsidyLedger.entries[0].verification, {
    method: "transaction_hash",
    chainId: 420_420_419
  });
  assert.equal(served.subsidyLedger.entries[0].txHash, TX_HASH);
});

test("the split ratio always sums to exactly 10000 bps", () => {
  // 0.5 venue-earned against 1.0 operator-added: independent floor division
  // yields 3333 + 6666 = 9999. The complement derivation must close the gap,
  // because a reader WILL add the two numbers on a trust surface.
  const events = [deposit(EARLY, 10_000_000, 10_000_000, 100)];
  const live = snapshot({ totalAssets: 11_500_000n, bufferAssets: 11_500_000n });
  const attributed = buildYieldAttribution({ snapshot: live, events, ledgerEntries: [subsidy()] });
  assert.equal(attributed.gain.venueEarned.raw, "500000");
  assert.equal(attributed.gain.operatorAdded.raw, "1000000");
  const ratio = attributed.splitRatio;
  assert.equal(ratio.status, "available");
  assert.equal(BigInt(ratio.venueEarnedBps) + BigInt(ratio.operatorAddedBps), 10_000n);
  assert.equal(ratio.venueEarnedBps, "3333");
  assert.equal(ratio.operatorAddedBps, "6667");
});

test("subsidy disclosure never claims the operator-attested list is chain sourced or exhaustive", () => {
  const attribution = buildYieldAttribution({
    snapshot: snapshot({ totalAssets: 11_000_000n, bufferAssets: 11_000_000n }),
    events: [deposit(EARLY, 10_000_000, 10_000_000, 100)],
    ledgerEntries: [subsidy()]
  });
  const disclosure = JSON.stringify(attribution.subsidyLedger).toLowerCase();

  assert.doesNotMatch(disclosure, /chain-derived|chain derived|reconciled|\bcomplete\b/u);
  assert.match(disclosure, /operator-attested/u);
  assert.match(disclosure, /independently verifiable by transaction hash/u);
});

test("entry-price attribution does not credit a later entrant with gain earned before its deposit", () => {
  const events = [
    deposit(EARLY, 10_000_000, 10_000_000, 100),
    // The pool gained 2 USDC before this deposit, so 6 USDC buys 5 shares.
    deposit(LATE, 6_000_000, 5_000_000, 180)
  ];
  const live = snapshot({
    totalAssets: 18_000_000n,
    totalSupply: 15_000_000n,
    bufferAssets: 18_000_000n,
    wallet: { shares: 5_000_000n }
  });
  const attribution = buildYieldAttribution({ snapshot: live, events, wallet: LATE });

  assert.equal(attribution.gain.cumulativeNav.raw, "2000000");
  assert.equal(attribution.wallet.entryPrice.assetsPerShare.raw, "1200000");
  assert.equal(attribution.wallet.currentValue.raw, "6000000");
  assert.equal(attribution.wallet.gain.raw, "0");
});

test("zero deployment zero subsidy and zero gain serve a legible zero state", () => {
  const attribution = buildYieldAttribution({
    snapshot: snapshot({
      totalAssets: 0n,
      totalSupply: 0n,
      bufferAssets: 0n,
      wallet: { shares: 0n }
    }),
    wallet: EARLY
  });

  assert.equal(attribution.status, "zero");
  assert.equal(attribution.statement, "No deployed principal, operator-added assets, or cumulative NAV gain are recorded for this pool.");
  assert.equal(attribution.gain.cumulativeNav.raw, "0");
  assert.equal(attribution.gain.venueEarned.raw, "0");
  assert.equal(attribution.gain.operatorAdded.raw, "0");
  assert.equal(attribution.subsidyLedger.entryCount, 0);
  assert.deepEqual(attribution.subsidyLedger.entries, []);
  assert.equal(attribution.wallet.status, "no_position");
});

test("yield attribution remains read-only and exposes no contract balance position allocation or settlement mutation", async () => {
  const serviceSource = await readFile(new URL("./yield-attribution-service.js", import.meta.url), "utf8");
  const routeSource = await readFile(new URL("../protocols/http/admin-yield-subsidy-routes.js", import.meta.url), "utf8");
  const source = `${serviceSource}\n${routeSource}`;

  assert.doesNotMatch(source, /sendTransaction|resolveSinglePayout|resolveMilestone|allocateIdleFunds|deallocate|settleRequest/u);
  assert.doesNotMatch(source, /\.transfer\s*\(/u, "the service may decode transfer calldata but never invoke a token transfer");
  assert.match(source, /getTransactionReceipt/u);
  assert.match(source, /putYieldSubsidyEntry/u, "the only write is the operator-attested disclosure entry");
});

test("yield attribution history reader decodes deposits withdrawals and operator principal from deployment onward", async () => {
  const pool = new Interface(DEPOSIT_POOL_ABI);
  const encoded = [
    ["Deposit", [OPERATOR, EARLY, 10_000_000n, 10_000_000n]],
    ["Withdraw", [EARLY, EARLY, EARLY, 1_000_000n, 1_000_000n]],
    ["OperatorPrincipalContributed", [2_000_000n, 2_000_000n, 2_000_000n]]
  ].map(([name, args], index) => {
    const event = pool.encodeEventLog(pool.getEvent(name), args);
    return {
      address: POOL,
      topics: event.topics,
      data: event.data,
      blockNumber: 100 + index,
      index,
      transactionHash: `0x${String(index + 1).padStart(64, "0")}`
    };
  });
  const calls = [];
  const reader = new EvmYieldAttributionChainReader({
    async getLogs(query) {
      calls.push(query);
      return encoded.filter((event) => event.blockNumber >= query.fromBlock && event.blockNumber <= query.toBlock);
    }
  }, { deploymentBlock: 100, logChunkBlocks: 2 });

  const events = await reader.readHistory({ poolAddress: POOL, toBlock: 102 });
  assert.deepEqual(events.map((event) => event.type), ["Deposit", "Withdraw", "OperatorPrincipalContributed"]);
  assert.equal(events[0].owner, EARLY);
  assert.equal(events[1].sharesRaw, "1000000");
  assert.equal(events[2].assetsRaw, "2000000");
  assert.deepEqual(calls.map(({ fromBlock, toBlock }) => [fromBlock, toBlock]), [[100, 101], [102, 102]]);
});
