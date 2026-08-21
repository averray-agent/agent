import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { EventBus } from "../core/event-bus.js";
import { MemoryStateStore } from "../core/state-store.js";
import {
  FIRST_WITHDRAWAL_GAS_GRANT_AMOUNT_WEI,
  FIRST_WITHDRAWAL_GAS_GRANT_MIN_LIQUID_RAW,
  FirstWithdrawalGasGrantService,
  loadFirstWithdrawalGasGrantConfig
} from "./first-withdrawal-gas-grant.js";

const WALLET = "0x1111111111111111111111111111111111111111";
const SECOND_WALLET = "0x2222222222222222222222222222222222222222";
const USDC = "0x0000053900000000000000000000000001200000";

function intent(wallet = WALLET) {
  return {
    wallet,
    assetSymbol: "USDC",
    assetAddress: USDC,
    amountRaw: "250000",
    destination: wallet,
    liveLiquidRaw: "400000"
  };
}

function harness({ dailyCap = 25, liquidRaw = "400000" } = {}) {
  const stateStore = new MemoryStateStore();
  const eventBus = new EventBus({ eventStore: stateStore });
  const transfers = [];
  let liveLiquidRaw = liquidRaw;
  const nativeBalances = new Map();
  const gateway = {
    async getAccountPosition(wallet, asset) {
      assert.equal(asset, "USDC");
      return {
        wallet,
        asset: { symbol: "USDC", address: USDC, decimals: 6 },
        position: { liquidRaw: liveLiquidRaw }
      };
    },
    async sendFirstWithdrawalGasGrant(wallet, amountWei) {
      const before = nativeBalances.get(wallet) ?? 0n;
      const after = before + BigInt(amountWei);
      nativeBalances.set(wallet, after);
      transfers.push({ wallet, amountWei: BigInt(amountWei) });
      return {
        txHash: `0x${String(transfers.length).padStart(64, "0")}`,
        blockNumber: 19_500_000 + transfers.length,
        status: 1,
        walletBalanceBeforeRaw: before.toString(),
        walletBalanceAfterRaw: after.toString(),
        walletBalanceDeltaRaw: (after - before).toString(),
        balanceDeltaVerified: after - before === BigInt(amountWei)
      };
    }
  };
  const service = new FirstWithdrawalGasGrantService({
    gateway,
    stateStore,
    eventBus,
    dailyCap,
    now: () => new Date("2026-08-21T12:00:00.000Z")
  });
  return {
    eventBus,
    gateway,
    nativeBalances,
    service,
    stateStore,
    transfers,
    setLiquidRaw(value) { liveLiquidRaw = String(value); }
  };
}

test("first-withdrawal grant config defaults to 25 and rejects non-positive caps", () => {
  assert.deepEqual(loadFirstWithdrawalGasGrantConfig({}), { dailyCap: 25 });
  assert.deepEqual(loadFirstWithdrawalGasGrantConfig({ FIRST_WITHDRAWAL_GAS_GRANT_DAILY_CAP: "9" }), { dailyCap: 9 });
  assert.throws(
    () => loadFirstWithdrawalGasGrantConfig({ FIRST_WITHDRAWAL_GAS_GRANT_DAILY_CAP: "0" }),
    /FIRST_WITHDRAWAL_GAS_GRANT_DAILY_CAP must be a positive integer/u
  );
});

test("eligibility refuses below-floor AAC liquidity by its stable reason", async () => {
  const { service, transfers } = harness({ liquidRaw: (FIRST_WITHDRAWAL_GAS_GRANT_MIN_LIQUID_RAW - 1n).toString() });
  const result = await service.grantForWithdrawalIntent(intent());

  assert.equal(result.status, "ineligible");
  assert.equal(result.reason, "first_withdrawal_gas_grant_balance_below_floor");
  assert.equal(result.balanceAtGrant.raw, "249999");
  assert.equal(transfers.length, 0);
});

test("lifetime-once is enforced durably across identical retries", async () => {
  const { service, transfers } = harness();
  const first = await service.grantForWithdrawalIntent(intent());
  const retry = await service.grantForWithdrawalIntent(intent());

  assert.equal(first.status, "granted");
  assert.equal(retry.status, "ineligible");
  assert.equal(retry.reason, "first_withdrawal_gas_grant_already_granted");
  assert.equal(retry.priorGrant.txHash, first.txHash);
  assert.equal(transfers.length, 1);
});

test("an ambiguous signer failure remains a lifetime tombstone so retries cannot double-pay", async () => {
  const { gateway, service, stateStore } = harness();
  let attempts = 0;
  gateway.sendFirstWithdrawalGasGrant = async () => {
    attempts += 1;
    throw new Error("receipt RPC unavailable after send");
  };

  await assert.rejects(service.grantForWithdrawalIntent(intent()), /receipt RPC unavailable after send/u);
  const retry = await service.grantForWithdrawalIntent(intent());
  assert.equal(retry.status, "ineligible");
  assert.equal(retry.reason, "first_withdrawal_gas_grant_in_progress");
  assert.equal(attempts, 1);
  const stored = await stateStore.getMutationReceipt(
    "first-withdrawal-gas-grant-lifetime",
    WALLET.toLowerCase()
  );
  assert.equal(stored.status, "sending");
  assert.equal(stored.transferOutcome, "unknown_fail_closed");
});

test("global daily cap refuses a different wallet by its stable reason", async () => {
  const { service, transfers } = harness({ dailyCap: 1 });
  assert.equal((await service.grantForWithdrawalIntent(intent())).status, "granted");

  const refused = await service.grantForWithdrawalIntent(intent(SECOND_WALLET));
  assert.equal(refused.status, "ineligible");
  assert.equal(refused.reason, "first_withdrawal_gas_grant_daily_cap_reached");
  assert.equal(refused.daily.limit, 1);
  assert.equal(refused.daily.reserved, 1);
  assert.equal(transfers.length, 1);
});

test("a granted withdrawal intent proves the worker wallet's 0.03 DOT balance delta and emits non-payout ops evidence", async () => {
  const { eventBus, nativeBalances, service } = harness();
  const result = await service.grantForWithdrawalIntent(intent());
  await eventBus.flush();

  assert.equal(result.amount.raw, FIRST_WITHDRAWAL_GAS_GRANT_AMOUNT_WEI.toString());
  assert.equal(result.walletBalanceDelta.raw, FIRST_WITHDRAWAL_GAS_GRANT_AMOUNT_WEI.toString());
  assert.equal(result.balanceDeltaVerified, true);
  assert.equal(nativeBalances.get(WALLET), FIRST_WITHDRAWAL_GAS_GRANT_AMOUNT_WEI);

  const status = await service.getOpsStatus();
  assert.equal(status.daily.granted, 1);
  assert.equal(status.daily.total.raw, FIRST_WITHDRAWAL_GAS_GRANT_AMOUNT_WEI.toString());
  assert.equal(status.recent[0].wallet, WALLET);
  assert.equal(status.recent[0].balanceAtGrant.raw, "400000");
  assert.equal(status.recent[0].countedAsPayout, false);
  assert.equal(status.recent[0].countedAsRevenue, false);
});

test("granting has no bare faucet call path and requires a live withdrawal intent", async () => {
  const { service, transfers } = harness();
  await assert.rejects(
    service.grantForWithdrawalIntent({ wallet: WALLET }),
    (error) => error?.details?.reason === "first_withdrawal_gas_grant_withdrawal_intent_required"
  );
  assert.equal(transfers.length, 0);

  const routeSource = readFileSync(new URL("../protocols/http/earnings-door-routes.js", import.meta.url), "utf8");
  assert.doesNotMatch(routeSource, /gas-grant|gas\/grant|withdrawal-grant/u, "no standalone faucet endpoint may exist");
  assert.match(routeSource, /\/account\/withdraw\/transactions/u, "grant access stays inside the withdrawal-intent route");
});

function assertLifetimeOnceGuard(source) {
  const grantMethod = source.slice(
    source.indexOf("  async grantForWithdrawalIntent(value)"),
    source.indexOf("  async getOpsStatus()")
  );
  assert.match(
    grantMethod,
    /const existing = await this\.stateStore\.getMutationReceipt\(LIFETIME_BUCKET, lifetimeKey\);[\s\S]*?if \(blocksLifetimeGrant\(existing\)\)/u,
    "lifetime-once receipt check must guard the native transfer"
  );
}

test("mutation drill: removing the lifetime-once check fails by name", () => {
  const source = readFileSync(new URL("./first-withdrawal-gas-grant.js", import.meta.url), "utf8");
  assertLifetimeOnceGuard(source);
  const mutated = source.replace(
    "      if (blocksLifetimeGrant(existing)) {",
    "      if (false && blocksLifetimeGrant(existing)) {"
  );
  assert.notEqual(mutated, source, "lifetime guard mutation must apply");
  assert.throws(
    () => assertLifetimeOnceGuard(mutated),
    /lifetime-once receipt check must guard the native transfer/u
  );
});
