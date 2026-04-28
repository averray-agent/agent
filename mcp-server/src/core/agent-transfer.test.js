import test from "node:test";
import assert from "node:assert/strict";

import { AccountMutationService } from "./account-mutation-service.js";
import { ConflictError, InsufficientLiquidityError, ValidationError } from "./errors.js";

function makeService() {
  const accounts = new Map();
  const getAccountSummary = async (wallet) => {
    const existing = accounts.get(wallet);
    if (existing) return existing;
    const blank = {
      wallet,
      liquid: {},
      reserved: {},
      strategyAllocated: {},
      strategyShares: {},
      strategyActivity: {},
      strategyPending: {},
      strategyAccounting: {},
      treasuryTimeline: [],
      collateralLocked: {},
      jobStakeLocked: {},
      debtOutstanding: {}
    };
    accounts.set(wallet, blank);
    return blank;
  };
  const service = new AccountMutationService(accounts, undefined, getAccountSummary);
  return { service, accounts, getAccountSummary };
}

async function fund(accounts, wallet, asset, amount) {
  const existing = accounts.get(wallet) ?? {
    wallet,
    liquid: {},
    reserved: {},
    strategyAllocated: {},
    strategyShares: {},
    strategyActivity: {},
    strategyPending: {},
    strategyAccounting: {},
    treasuryTimeline: [],
    collateralLocked: {},
    jobStakeLocked: {},
    debtOutstanding: {}
  };
  existing.liquid[asset] = (existing.liquid[asset] ?? 0) + amount;
  accounts.set(wallet, existing);
}

test("agentTransfer moves liquid balance from one agent to another", async () => {
  const { service, accounts } = makeService();
  await fund(accounts, "0xAlice", "DOT", 100);

  const result = await service.agentTransfer("0xAlice", "0xBob", "DOT", 30);
  assert.equal(result.from.liquid.DOT, 70);
  assert.equal(result.to.liquid.DOT, 30);
  assert.equal(accounts.get("0xAlice").liquid.DOT, 70);
  assert.equal(accounts.get("0xBob").liquid.DOT, 30);
});

test("agentTransfer rejects zero and negative amounts", async () => {
  const { service, accounts } = makeService();
  await fund(accounts, "0xAlice", "DOT", 10);
  await assert.rejects(
    () => service.agentTransfer("0xAlice", "0xBob", "DOT", 0),
    ValidationError
  );
  await assert.rejects(
    () => service.agentTransfer("0xAlice", "0xBob", "DOT", -5),
    ValidationError
  );
});

test("agentTransfer rejects self-transfer", async () => {
  const { service, accounts } = makeService();
  await fund(accounts, "0xAlice", "DOT", 10);
  await assert.rejects(
    () => service.agentTransfer("0xalice", "0xALICE", "DOT", 1),
    ValidationError
  );
});

test("agentTransfer rejects when sender has insufficient liquid", async () => {
  const { service, accounts } = makeService();
  await fund(accounts, "0xAlice", "DOT", 2);
  await assert.rejects(
    () => service.agentTransfer("0xAlice", "0xBob", "DOT", 5),
    (err) => err instanceof InsufficientLiquidityError
  );
  // Alice's balance must not have moved on failed transfer.
  assert.equal(accounts.get("0xAlice").liquid.DOT, 2);
  assert.equal(accounts.get("0xBob")?.liquid?.DOT ?? 0, 0);
});

test("agentTransfer delegates to blockchain gateway when enabled", async () => {
  const calls = [];
  const gateway = {
    isEnabled: () => true,
    sendToAgent: async (...args) => {
      calls.push(args);
    }
  };
  const accounts = new Map();
  const getAccountSummary = async (wallet) => ({
    wallet,
    liquid: { DOT: wallet === "0xAlice" ? 50 : 10 },
    reserved: {},
    strategyAllocated: {},
    collateralLocked: {},
    jobStakeLocked: {},
    debtOutstanding: {}
  });
  const service = new AccountMutationService(accounts, gateway, getAccountSummary);

  const result = await service.agentTransfer("0xAlice", "0xBob", "DOT", 5);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ["0xAlice", "0xBob", "DOT", 5]);
  // When the gateway is enabled, the in-memory map isn't the source of
  // truth; we just return the fresh summaries from the gateway.
  assert.equal(result.from.liquid.DOT, 50);
  assert.equal(result.to.liquid.DOT, 10);
});

test("allocateIdleFunds moves liquid DOT into the strategy bucket", async () => {
  const { service, accounts } = makeService();
  await fund(accounts, "0xAlice", "DOT", 20);

  const updated = await service.allocateIdleFunds("0xAlice", "DOT", 6, "mock-vdot");
  assert.equal(updated.liquid.DOT, 14);
  assert.equal(updated.strategyAllocated.DOT, 6);
  assert.equal(updated.strategyShares["mock-vdot"], 6);
  assert.equal(updated.strategyActivity["mock-vdot"].action, "allocate");
  assert.equal(updated.strategyAccounting["mock-vdot"].principal, 6);
  assert.equal(updated.treasuryTimeline[0].type, "allocate");
});

test("allocateIdleFunds rejects zero and negative amounts", async () => {
  const { service } = makeService();
  await assert.rejects(() => service.allocateIdleFunds("0xAlice", "DOT", 0), ValidationError);
  await assert.rejects(() => service.allocateIdleFunds("0xAlice", "DOT", -1), ValidationError);
});

test("requestStrategyDeposit delegates async lanes to the blockchain gateway and records pending state", async () => {
  const calls = [];
  const gateway = {
    isEnabled: () => true,
    requestStrategyDeposit: async (...args) => {
      calls.push(args);
      return {
        wallet: "0xAlice",
        liquid: { DOT: 14 },
        reserved: {},
        strategyAllocated: { DOT: 0 },
        collateralLocked: {},
        jobStakeLocked: {},
        debtOutstanding: {},
        requestId: "0xreq",
        xcmRequest: { statusLabel: "pending", requestedAssets: 6 },
        strategyRequest: { strategyId: "0xstrategy", requestedAssets: 6, requestedShares: 0 }
      };
    }
  };
  const accounts = new Map();
  const getAccountSummary = async (wallet) => ({
    wallet,
    liquid: { DOT: 14 },
    reserved: {},
    strategyAllocated: { DOT: 0 },
    strategyShares: {},
    strategyActivity: {},
    strategyPending: {},
    strategyAccounting: {},
    treasuryTimeline: [],
    collateralLocked: {},
    jobStakeLocked: {},
    debtOutstanding: {}
  });
  const service = new AccountMutationService(accounts, gateway, getAccountSummary);

  const updated = await service.requestStrategyDeposit(
    "0xAlice",
    "DOT",
    6,
    "0xstrategy",
    { strategyId: "0xstrategy", executionMode: "async_xcm", asset: "0xdot" },
    { nonce: 7 }
  );

  assert.equal(calls.length, 1);
  assert.equal(updated.requestId, "0xreq");
  assert.equal(updated.strategyPending["0xstrategy"].pendingDepositAssets, 6);
  assert.equal(updated.strategyActivity["0xstrategy"].action, "allocate_requested");
  assert.equal(updated.treasuryTimeline[0].type, "allocate_requested");
});

test("borrow uses live borrow capacity and updates liquid plus debt", async () => {
  const { service, accounts } = makeService();
  const account = await service.getAccountSummary("0xAlice");
  account.collateralLocked.DOT = 15;
  account.debtOutstanding.DOT = 0;
  accounts.set("0xAlice", account);

  const updated = await service.borrow("0xAlice", "DOT", 5);
  assert.equal(updated.liquid.DOT, 5);
  assert.equal(updated.debtOutstanding.DOT, 5);
});

test("repay reduces debt and deposited liquid", async () => {
  const { service, accounts } = makeService();
  const account = await service.getAccountSummary("0xAlice");
  account.liquid.DOT = 8;
  account.debtOutstanding.DOT = 5;
  accounts.set("0xAlice", account);

  const updated = await service.repay("0xAlice", "DOT", 3);
  assert.equal(updated.liquid.DOT, 5);
  assert.equal(updated.debtOutstanding.DOT, 2);
});

test("deallocateIdleFunds unwinds routed DOT back to liquid", async () => {
  const { service, accounts } = makeService();
  await fund(accounts, "0xAlice", "DOT", 12);
  await service.allocateIdleFunds("0xAlice", "DOT", 5, "mock-vdot");

  const updated = await service.deallocateIdleFunds("0xAlice", "DOT", 3, "mock-vdot");
  assert.equal(updated.liquid.DOT, 10);
  assert.equal(updated.strategyAllocated.DOT, 2);
  assert.equal(updated.strategyShares["mock-vdot"], 2);
  assert.equal(updated.strategyActivity["mock-vdot"].action, "deallocate");
  assert.equal(updated.strategyAccounting["mock-vdot"].principal, 2);
  assert.equal(updated.treasuryTimeline[0].type, "deallocate");
});

test("deallocateIdleFunds rejects when strategy shares are insufficient", async () => {
  const { service, accounts } = makeService();
  await fund(accounts, "0xAlice", "DOT", 5);
  await service.allocateIdleFunds("0xAlice", "DOT", 2, "mock-vdot");

  await assert.rejects(
    () => service.deallocateIdleFunds("0xAlice", "DOT", 3, "mock-vdot"),
    (err) => err instanceof ConflictError
  );
});

test("requestStrategyWithdraw delegates async lanes to the blockchain gateway and records pending shares", async () => {
  const gateway = {
    isEnabled: () => true,
    requestStrategyWithdraw: async () => ({
      wallet: "0xAlice",
      liquid: { DOT: 5 },
      reserved: {},
      strategyAllocated: { DOT: 10 },
      collateralLocked: {},
      jobStakeLocked: {},
      debtOutstanding: {},
      requestId: "0xwithdraw",
      requestedShares: 4,
      xcmRequest: { statusLabel: "pending", requestedShares: 4 },
      strategyRequest: { strategyId: "0xstrategy", requestedAssets: 3, requestedShares: 4 }
    })
  };
  const accounts = new Map();
  const getAccountSummary = async (wallet) => ({
    wallet,
    liquid: { DOT: 5 },
    reserved: {},
    strategyAllocated: { DOT: 10 },
    strategyShares: { "0xstrategy": 10 },
    strategyActivity: {},
    strategyPending: {},
    strategyAccounting: {},
    treasuryTimeline: [],
    collateralLocked: {},
    jobStakeLocked: {},
    debtOutstanding: {}
  });
  const service = new AccountMutationService(accounts, gateway, getAccountSummary);

  const updated = await service.requestStrategyWithdraw(
    "0xAlice",
    "DOT",
    3,
    "0xstrategy",
    { strategyId: "0xstrategy", executionMode: "async_xcm", asset: "0xdot" },
    { nonce: 8, recipient: "0xReceiver" }
  );

  assert.equal(updated.requestId, "0xwithdraw");
  assert.equal(updated.strategyPending["0xstrategy"].pendingWithdrawalShares, 4);
  assert.equal(updated.strategyActivity["0xstrategy"].action, "deallocate_requested");
  assert.equal(updated.treasuryTimeline[0].type, "deallocate_requested");
});

test("recordStrategySnapshots updates mark-to-market and appends a yield event on change", async () => {
  const { service, accounts } = makeService();
  await fund(accounts, "0xAlice", "DOT", 10);
  await service.allocateIdleFunds("0xAlice", "DOT", 5, "mock-vdot");

  await service.recordStrategySnapshots("0xAlice", [{
    strategyId: "mock-vdot",
    assetSymbol: "DOT",
    shares: 5,
    currentValue: 5,
    sharePrice: 1
  }]);
  const timelineBefore = accounts.get("0xAlice").treasuryTimeline.length;

  await service.recordStrategySnapshots("0xAlice", [{
    strategyId: "mock-vdot",
    assetSymbol: "DOT",
    shares: 5,
    currentValue: 5.5,
    sharePrice: 1.1
  }]);

  const updated = accounts.get("0xAlice");
  assert.equal(updated.strategyAccounting["mock-vdot"].markValue, 5.5);
  assert.equal(updated.strategyAccounting["mock-vdot"].sharePrice, 1.1);
  assert.equal(updated.treasuryTimeline.length, timelineBefore + 1);
  assert.equal(updated.treasuryTimeline[0].type, "yield_mark");
});

test("recordAsyncStrategySettlement updates accounting and clears pending state", async () => {
  const { service, accounts } = makeService();
  const account = await service.getAccountSummary("0xAlice");
  account.strategyPending["0xstrategy"] = {
    asset: "DOT",
    pendingDepositAssets: 6,
    pendingWithdrawalShares: 0
  };
  accounts.set("0xAlice", account);

  const updated = await service.recordAsyncStrategySettlement({
    requestId: "0xreq",
    strategyRequest: {
      account: "0xAlice",
      strategyId: "0xstrategy",
      assetSymbol: "DOT",
      kindLabel: "deposit",
      statusLabel: "succeeded",
      requestedAssets: 6,
      settledAssets: 6
    }
  });

  assert.equal(updated.strategyPending["0xstrategy"].pendingDepositAssets, 0);
  assert.equal(updated.strategyAccounting["0xstrategy"].principal, 6);
  assert.equal(updated.treasuryTimeline[0].type, "allocate");
});
