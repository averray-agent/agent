import assert from "node:assert/strict";
import test from "node:test";

import { Interface } from "ethers";

import { DEPOSIT_POOL_ABI, ERC20_MOCK_ABI } from "../blockchain/abis.js";
import {
  DEPOSIT_POOL_CAPITAL_SIGNAL_STATEMENT,
  DEPOSIT_POOL_RISK_DISCLOSURE
} from "../core/deposit-pool-disclosure.js";
import {
  DepositPoolDoorService,
  DEPOSIT_POOL_WITHDRAWAL_NOTE
} from "./deposit-pool-door.js";

const POOL = "0x1111111111111111111111111111111111111111";
const ASSET = "0x0000053900000000000000000000000001200000";
const WALLET = "0x2222222222222222222222222222222222222222";

function state(overrides = {}) {
  return {
    blockNumber: 19_200_000,
    blockHash: `0x${"ab".repeat(32)}`,
    asset: ASSET,
    totalAssets: 10_000_000n,
    totalSupply: 10_000_000n,
    bufferAssets: 10_000_000n,
    deployedPrincipal: 0n,
    totalAssetCap: 1_000_000_000n,
    perAgentAssetCap: 100_000_000n,
    wallet: {
      assetBalance: 20_000_000n,
      depositedAssets: 10_000_000n,
      shares: 10_000_000n,
      availableShares: 10_000_000n,
      allowance: 0n
    },
    ...overrides
  };
}

function service({ snapshot = state(), convertToShares, estimateGas, lockedTierService, venueMark } = {}) {
  const estimates = [];
  const reader = {
    async readSnapshot({ wallet }) {
      return {
        ...snapshot,
        ...(wallet ? {} : { wallet: undefined })
      };
    },
    async convertToShares({ assets }) {
      return convertToShares ? convertToShares(assets) : assets;
    },
    async convertToAssets({ shares }) {
      return shares;
    },
    async estimateGas(transaction) {
      estimates.push(transaction);
      return estimateGas ? estimateGas(transaction) : 45_000n;
    }
  };
  return {
    estimates,
    value: new DepositPoolDoorService({
      poolAddress: POOL,
      chainId: 420_420_419,
      rpcUrls: ["https://polkadot-asset-hub-rpc.polkadot.io"],
      chainReader: reader,
      lockedTierService,
      ...(venueMark ? { venueMark } : {}),
      workerExposurePolicy: {
        async capacityForWallet() {
          return {
            vestedAssetsRaw: "10000000",
            openExposureRaiseRaw: "1500000",
            openExposureCapRaw: "4000000",
            externalRewardCeilingRaw: "11000000",
            vestingHours: 48,
            vestingAvailable: true,
            evaluatedAt: "2026-08-13T12:00:00.000Z",
            tranches: [{
              depositedRaw: "10000000",
              remainingRaw: "10000000",
              vestedRaw: "10000000",
              depositedAt: "2026-08-11T12:00:00.000Z",
              blockNumber: 19_380_506,
              logIndex: 1
            }]
          };
        }
      }
    })
  };
}

test("pool info discloses pilot risk and authenticated info reports vested capacity without catalogue allowance", async () => {
  const door = service().value;
  const publicInfo = await door.getInfo();
  const authed = await door.getInfo(WALLET);

  assert.equal(publicInfo.available, true);
  assert.equal(publicInfo.wallet, undefined);
  assert.equal(publicInfo.yieldStatus, "not_yet_earning");
  assert.deepEqual(publicInfo.disclosure, { statement: DEPOSIT_POOL_RISK_DISCLOSURE });
  assert.equal(publicInfo.withdrawal.status, "open");
  assert.equal(publicInfo.withdrawal.note, DEPOSIT_POOL_WITHDRAWAL_NOTE);
  assert.deepEqual(authed.disclosure, { statement: DEPOSIT_POOL_RISK_DISCLOSURE });
  assert.equal(publicInfo.capitalSignal.statement, DEPOSIT_POOL_CAPITAL_SIGNAL_STATEMENT);
  assert.equal(publicInfo.capitalSignal.catalogueEffect, "none");
  assert.deepEqual(authed.wallet.vestedAssets, { raw: "10000000", decimals: 6 });
  assert.deepEqual(authed.wallet.openExposureRaise, { raw: "1500000", decimals: 6 });
  assert.deepEqual(authed.wallet.openExposureCap, { raw: "4000000", decimals: 6 });
  assert.deepEqual(authed.wallet.externalRewardCeiling, { raw: "11000000", decimals: 6 });
  assert.equal(authed.wallet.vesting.durationHours, 48);
  assert.equal(authed.wallet.vesting.withdrawalBurnOrder, "lifo");
  assert.equal("dailyAllowance" in authed.wallet, false);
  assert.equal(JSON.stringify(authed).includes("fromDeposits"), false);
  assert.deepEqual(authed.wallet.perAgentHeadroom, { raw: "90000000", decimals: 6 });
});

test("pool info exposes locked-cohort activation telemetry from the single gate source", async () => {
  const telemetry = {
    lockedTotalRaw: "3820000",
    activationGate: { open: false, statement: "yield inactive — pool below activation threshold." }
  };
  let observedPrincipal;
  const door = service({
    lockedTierService: {
      getPoolTelemetry: async (_wallet, { deployedPrincipalRaw }) => {
        observedPrincipal = deployedPrincipalRaw;
        return telemetry;
      }
    }
  }).value;

  assert.deepEqual((await door.getInfo()).lockedDeposits, telemetry);
  assert.equal(observedPrincipal, 0n);
});

test("profile without a pool returns unavailable without fabricated zero fields", async () => {
  const door = new DepositPoolDoorService({ poolAddress: "", chainId: 420_420_419 });
  const info = await door.getInfo(WALLET);
  const build = await door.buildTransactions(WALLET, { direction: "deposit", assets: "1" });
  assert.deepEqual(info, {
    schemaVersion: 1,
    available: false,
    reason: "deposit_pool_not_configured"
  });
  assert.deepEqual(build, info);
  assert.equal(JSON.stringify(info).includes('"raw":"0"'), false);
  assert.equal(JSON.stringify(build).includes('"raw":"0"'), false);
});

test("deposit templates byte-decode to approve and deposit with exact wallet-bound arguments", async () => {
  const { value: door } = service();
  const quote = await door.buildTransactions(WALLET, { direction: "deposit", assets: "5000000" });
  const token = new Interface(ERC20_MOCK_ABI);
  const pool = new Interface(DEPOSIT_POOL_ABI);

  assert.equal(quote.templates.length, 2);
  const approve = token.parseTransaction({ data: quote.templates[0].data });
  assert.equal(approve.name, "approve");
  assert.equal(approve.args.spender, POOL);
  assert.equal(approve.args.amount, 5_000_000n);
  const deposit = pool.parseTransaction({ data: quote.templates[1].data });
  assert.equal(deposit.name, "deposit");
  assert.equal(deposit.args.assets, 5_000_000n);
  assert.equal(deposit.args.receiver, WALLET);
  assert.deepEqual(quote.preview.expectedShares, { raw: "5000000", decimals: 6 });
  assert.equal(quote.boundary.platformSigns, false);
  assert.equal(quote.boundary.signedTransactionRelay, false);
});

test("deposit preview uses the pool convertToShares lens rather than a second local price model", async () => {
  const { value: door } = service({ convertToShares: (assets) => assets / 2n });
  const quote = await door.buildTransactions(WALLET, { direction: "deposit", assets: "5000000" });
  assert.deepEqual(quote.preview.expectedShares, { raw: "2500000", decimals: 6 });
});

test("sufficient allowance omits approval and says why", async () => {
  const { value: door } = service({
    snapshot: state({ wallet: { ...state().wallet, allowance: 9_000_000n } })
  });
  const quote = await door.buildTransactions(WALLET, { direction: "deposit", assets: "5000000" });
  assert.equal(quote.templates.length, 1);
  assert.equal(quote.templates[0].decoded.function, "deposit(uint256,address)");
  assert.deepEqual(quote.approval, {
    required: false,
    reason: "allowance_already_sufficient",
    allowanceBefore: { raw: "9000000", decimals: 6 },
    allowanceAfter: { raw: "9000000", decimals: 6 }
  });
});

test("deposit quote refuses the same named cap and balance failures as the contract", async () => {
  const totalCapDoor = service({
    snapshot: state({ totalAssets: 999_000_000n, totalSupply: 999_000_000n })
  }).value;
  await assert.rejects(
    () => totalCapDoor.buildTransactions(WALLET, { direction: "deposit", assets: "2000000" }),
    (error) => error.details?.reason === "TotalAssetCapExceeded"
  );

  const agentCapDoor = service({
    snapshot: state({
      wallet: { ...state().wallet, depositedAssets: 99_000_000n, shares: 99_000_000n, availableShares: 99_000_000n }
    })
  }).value;
  await assert.rejects(
    () => agentCapDoor.buildTransactions(WALLET, { direction: "deposit", assets: "2000000" }),
    (error) => error.details?.reason === "AgentAssetCapExceeded"
  );

  const poorDoor = service({
    snapshot: state({ wallet: { ...state().wallet, assetBalance: 1n } })
  }).value;
  await assert.rejects(
    () => poorDoor.buildTransactions(WALLET, { direction: "deposit", assets: "2" }),
    (error) => error.details?.reason === "InsufficientBalance"
  );
});

test("withdraw quote is symmetric and byte-decodes redeem to the authenticated wallet", async () => {
  const { value: door } = service();
  const quote = await door.buildTransactions(WALLET, { direction: "withdraw", shares: "4000000" });
  const pool = new Interface(DEPOSIT_POOL_ABI);
  const redeem = pool.parseTransaction({ data: quote.templates[0].data });
  assert.equal(redeem.name, "redeem");
  assert.equal(redeem.args.shares, 4_000_000n);
  assert.equal(redeem.args.receiver, WALLET);
  assert.equal(redeem.args.owner, WALLET);
  assert.deepEqual(quote.preview.expectedAssets, { raw: "4000000", decimals: 6 });
});

test("withdraw-by-assets rounds shares up and refuses unlocked-share and buffer failures by name", async () => {
  const { value: door } = service();
  const quote = await door.buildTransactions(WALLET, { direction: "withdraw", assets: "3000001" });
  assert.deepEqual(quote.preview.sharesToRedeem, { raw: "3000001", decimals: 6 });

  const locked = service({
    snapshot: state({ wallet: { ...state().wallet, availableShares: 1n } })
  }).value;
  await assert.rejects(
    () => locked.buildTransactions(WALLET, { direction: "withdraw", shares: "2" }),
    (error) => error.details?.reason === "InsufficientUnlockedShares"
  );

  const dry = service({ snapshot: state({ bufferAssets: 1n }) }).value;
  await assert.rejects(
    () => dry.buildTransactions(WALLET, { direction: "withdraw", shares: "2" }),
    (error) => error.details?.reason === "InsufficientBuffer"
  );
});

test("yield truth uses the Packet 5 flip source and stays off before venue deployment", async () => {
  assert.equal((await service().value.getInfo()).yieldStatus, "not_yet_earning");
  assert.equal((await service({ snapshot: state({ deployedPrincipal: 1n }) }).value.getInfo()).yieldStatus, "earning");
});

test("door inputs cannot accept keys, signatures, signed blobs, or relay instructions", async () => {
  const door = service().value;
  await assert.rejects(
    () => door.buildTransactions(WALLET, {
      direction: "deposit",
      assets: "1",
      privateKey: `0x${"11".repeat(32)}`
    }),
    /unsupported field/iu
  );
});

// ── Venue-mark gate ──────────────────────────────────────────────────────────
// Live mainnet state at Asset Hub block 19868506, the block before the external
// deposit at 19868507. The pool quoted 0.994825 carrying its venue leg at a
// 9.500000 cost basis while its own adapter reported 9.400000 landed — an
// honest 0.989946. The depositor received 5.026011 shares instead of 5.050775.
const MISPRICED = {
  blockNumber: 19_868_506,
  totalAssets: 20_395_226n,
  totalSupply: 20_501_328n,
  bufferAssets: 10_895_226n,
  deployedPrincipal: 9_500_000n,
  venueMarkedAssets: 9_400_000n
};

test("deposit is refused when the venue mark contradicts cost basis beyond tolerance", async () => {
  const { value: door } = service({ snapshot: state(MISPRICED) });
  await assert.rejects(
    () => door.buildTransactions(WALLET, { direction: "deposit", assets: "5000000" }),
    (error) => {
      assert.equal(error.details?.reason, "VenueMarkShortfall");
      assert.equal(error.details.venueMark.status, "shortfall_exceeds_tolerance");
      assert.equal(error.details.venueMark.shortfall.raw, "100000");
      assert.equal(error.details.venueMark.costBasis.raw, "9500000");
      assert.equal(error.details.venueMark.marked.raw, "9400000");
      // Truth boundary: this transaction would SUCCEED on chain, at a bad
      // price. Claiming it would revert would be a lie about the chain.
      assert.doesNotMatch(error.message, /would revert/u);
      assert.match(error.message, /overstated price/u);
      return true;
    }
  );
});

test("the venue-mark gate never closes the exit: withdraw still quotes and discloses the mark", async () => {
  const { value: door } = service({ snapshot: state(MISPRICED) });
  const quote = await door.buildTransactions(WALLET, { direction: "withdraw", shares: "1000000" });
  assert.equal(quote.direction, "withdraw");
  assert.equal(quote.templates.length, 1);
  assert.equal(quote.venueMark.status, "shortfall_exceeds_tolerance");
  assert.equal(quote.venueMark.depositsBlocked, true);
  assert.equal(quote.preview.markedSharePrice.assetsPerShare.raw, "989946");
});

test("pool info stays readable under a blocking shortfall and publishes both prices", async () => {
  const { value: door } = service({ snapshot: state(MISPRICED) });
  const info = await door.getInfo(WALLET);
  assert.equal(info.available, true);
  // The quoted price keeps its honest label; the marked price sits beside it,
  // so no read ever shows only the flattering number.
  assert.equal(info.sharePrice.model, "principal-cost-basis");
  assert.equal(info.sharePrice.assetsPerShare.raw, "994824");
  assert.equal(info.markedSharePrice.model, "venue-marked-to-adapter");
  assert.equal(info.markedSharePrice.assetsPerShare.raw, "989946");
  assert.equal(info.venueMark.status, "shortfall_exceeds_tolerance");
  assert.equal(info.venueMark.depositsBlocked, true);
  assert.equal(info.venueMark.source, "venue_adapter_managed_assets");
});

test("an unreadable venue mark with capital deployed refuses deposits rather than assuming health", async () => {
  const { value: door } = service({
    snapshot: state({ ...MISPRICED, venueMarkedAssets: undefined, venueMarkUnreadable: "venue_managed_assets_read_failed" })
  });
  await assert.rejects(
    () => door.buildTransactions(WALLET, { direction: "deposit", assets: "5000000" }),
    (error) => error.details?.venueMark?.status === "unreadable" && error.details.venueMark.depositsBlocked
  );
  const info = await door.getInfo(WALLET);
  assert.equal(info.venueMark.status, "unreadable");
  assert.equal(info.markedSharePrice, null);
});

test("the gate is inert with no capital at the venue and lets a clean deposit through", async () => {
  const { value: door } = service();
  const quote = await door.buildTransactions(WALLET, { direction: "deposit", assets: "5000000" });
  assert.equal(quote.venueMark.status, "not_deployed");
  assert.equal(quote.venueMark.depositsBlocked, false);
  assert.equal(quote.templates.length, 2);
});

test("writing the shortfall off on chain reopens the door with no config change", async () => {
  // writeOffVenueLoss(3, 100000) drops cost basis 9.500000 -> 9.400000 and
  // totalAssets 20.395226 -> 20.295226, matching the adapter exactly.
  const { value: door } = service({
    snapshot: state({ ...MISPRICED, totalAssets: 20_295_226n, deployedPrincipal: 9_400_000n })
  });
  const quote = await door.buildTransactions(WALLET, { direction: "deposit", assets: "5000000" });
  assert.equal(quote.venueMark.status, "ok");
  assert.equal(quote.venueMark.shortfall.raw, "0");
  assert.equal(quote.templates.length, 2);
});

test("a configured tolerance is honoured in both directions", async () => {
  const tight = service({
    snapshot: state({ ...MISPRICED, venueMarkedAssets: 9_499_000n }),
    venueMark: { toleranceBps: 0, dustFloorRaw: 0n }
  }).value;
  await assert.rejects(
    () => tight.buildTransactions(WALLET, { direction: "deposit", assets: "5000000" }),
    (error) => error.details?.reason === "VenueMarkShortfall"
  );

  const loose = service({
    snapshot: state(MISPRICED),
    venueMark: { toleranceBps: 500, dustFloorRaw: 1_000n }
  }).value;
  // 20.395226 * 500bps = 0.101976, just above the 0.100000 shortfall.
  const quote = await loose.buildTransactions(WALLET, { direction: "deposit", assets: "5000000" });
  assert.equal(quote.venueMark.status, "ok");
  assert.equal(quote.venueMark.tolerance.raw, "1019761");
  assert.equal(quote.templates.length, 2);
});
