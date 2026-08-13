import assert from "node:assert/strict";
import test from "node:test";
import { Interface } from "ethers";

import { CREDIT_POOL_ABI, DEPOSIT_POOL_V2_ABI } from "../blockchain/abis.js";
import { CREDIT_POOL_RISK_DISCLOSURE } from "../core/credit-pool-disclosure.js";
import { CreditPoolDoorService } from "./credit-pool-door.js";

const CREDIT = "0x1111111111111111111111111111111111111111";
const DEPOSIT = "0x2222222222222222222222222222222222222222";
const ASSET = "0x3333333333333333333333333333333333333333";
const WALLET = "0x4444444444444444444444444444444444444444";
const LOAN_ID = `0x${"55".repeat(32)}`;

function snapshot(overrides = {}) {
  return {
    blockNumber: 123,
    blockHash: `0x${"66".repeat(32)}`,
    blockTimestamp: 1_700_000_000,
    asset: ASSET,
    operator: "0x7777777777777777777777777777777777777777",
    totalAssets: 20_000_000n,
    totalSupply: 20_000_000n,
    bufferAssets: 20_000_000n,
    principalOutstanding: 0n,
    totalPledgedShares: 0n,
    defaults: 0n,
    ltvBps: 8_000n,
    interestBps: 0n,
    totalAssetCap: 250_000_000n,
    perLenderCap: 100_000_000n,
    maxLtvBps: 9_000n,
    maxInterestBps: 2_000n,
    platformFeeBps: 0n,
    disclosure: CREDIT_POOL_RISK_DISCLOSURE,
    wallet: {
      assetBalance: 12_000_000n,
      allowance: 0n,
      lenderShares: 0n,
      lenderAssets: 0n,
      lenderAvailableShares: 0n,
      outstandingDebt: 0n,
      nextLoanNonce: 0n,
      attestationNonce: 0n,
      depositShares: 10_000_000n,
      depositAvailableShares: 10_000_000n,
      pledgedShares: 0n,
      pledgedAssetValue: 0n
    },
    ...overrides
  };
}

function setup(overrides = {}) {
  const calls = [];
  const chainReader = {
    readSnapshot: async () => snapshot(overrides.snapshot),
    estimateGas: async (tx) => { calls.push(tx); return 50_000n; },
    previewLoanId: async () => LOAN_ID,
    convertCreditToShares: async ({ assets }) => assets,
    convertCreditToAssets: async ({ shares }) => shares,
    convertDepositToAssets: async ({ shares }) => shares,
    readLoan: async () => ({
      borrower: WALLET,
      outstandingPrincipal: 5_000_000n,
      outstandingInterest: 0n,
      status: 1
    })
  };
  const service = new CreditPoolDoorService({
    creditPoolAddress: CREDIT,
    depositPoolAddress: DEPOSIT,
    chainId: 420_420_419,
    rpcUrls: ["https://rpc.example"],
    chainReader,
    capacityReader: async () => ({ vestedAssetsRaw: "10000000", vestingAvailable: true, vestingHours: 48 }),
    vestingAttestor: async (input) => { calls.push(["attest", input]); return `0x${"77".repeat(65)}`; },
    now: () => 1_700_000_000_000
  });
  return { service, calls };
}

test("getCreditInfo exposes packet constants, vested-vs-pledged capacity, and mandatory disclosure", async () => {
  const { service } = setup();
  const value = await service.getInfo(WALLET);
  assert.equal(value.available, true);
  assert.equal(value.supply.cap.raw, "250000000");
  assert.equal(value.supply.perLenderCap.raw, "100000000");
  assert.equal(value.schedule.ltvBps, 8000);
  assert.equal(value.schedule.maxLtvBps, 9000);
  assert.equal(value.schedule.interestBps, 0);
  assert.equal(value.schedule.maxInterestBps, 2000);
  assert.equal(value.schedule.platformFeeBps, 0);
  assert.equal(value.wallet.vestedAssets.raw, "10000000");
  assert.equal(value.disclosure.statement, CREDIT_POOL_RISK_DISCLOSURE);
  assert.match(value.repayment.note, /released only after.*full/iu);
  assert.equal(value.boundary.signedTransactionRelay, false);
});

test("getCreditInfo reports remaining loanable capacity after outstanding debt", async () => {
  const { service } = setup({
    snapshot: {
      wallet: {
        ...snapshot().wallet,
        pledgedShares: 10_000_000n,
        pledgedAssetValue: 10_000_000n,
        outstandingDebt: 3_000_000n
      }
    }
  });
  const value = await service.getInfo(WALLET);
  assert.equal(value.wallet.grossWalletLimit.raw, "8000000");
  assert.equal(value.wallet.loanable.raw, "5000000");
  assert.equal(value.wallet.outstanding.raw, "3000000");
});

test("borrow templates decode byte-for-byte to pledge and zero-interest originate intent", async () => {
  const { service } = setup();
  const value = await service.buildTransactions(WALLET, {
    direction: "borrow",
    pledgeShares: "10000000",
    amount: "8000000"
  });
  assert.equal(value.preview.maximumLoan.raw, "8000000");
  assert.equal(value.preview.repaymentAmountAtPilotRate.raw, "8000000");
  assert.deepEqual(value.templates.map((entry) => entry.step), ["pledge", "originate"]);
  const pledge = new Interface(DEPOSIT_POOL_V2_ABI).decodeFunctionData("pledge", value.templates[0].data);
  assert.equal(pledge[0], 10_000_000n);
  assert.equal(pledge[1].toLowerCase(), LOAN_ID);
  const originate = new Interface(CREDIT_POOL_ABI).decodeFunctionData("originate", value.templates[1].data);
  assert.equal(originate[0], 10_000_000n);
  assert.equal(originate[1], 8_000_000n);
  assert.equal(originate[2], 10_000_000n);
  assert.equal(value.templates[1].gasEstimate.status, "requires_prerequisite");
  assert.equal(value.templates.every((entry) => entry.unsigned), true);
});

test("fresh unvested deposits cannot produce an origination template", async () => {
  const { service } = setup();
  service.capacityReader = async () => ({ vestedAssetsRaw: "0", vestingAvailable: true });
  await assert.rejects(
    service.buildTransactions(WALLET, { direction: "borrow", pledgeShares: "10000000", amount: "1" }),
    (error) => error.details?.reason === "LoanLimitExceeded" && error.details.maximum.raw === "0"
  );
});

test("borrow quote subtracts existing debt so vested standing cannot be reused per loan", async () => {
  const { service } = setup({
    snapshot: {
      wallet: {
        ...snapshot().wallet,
        outstandingDebt: 4_000_000n,
        pledgedShares: 5_000_000n,
        pledgedAssetValue: 5_000_000n,
        depositAvailableShares: 5_000_000n
      }
    }
  });
  service.capacityReader = async () => ({ vestedAssetsRaw: "5000000", vestingAvailable: true });
  await assert.rejects(
    service.buildTransactions(WALLET, { direction: "borrow", pledgeShares: "5000000", amount: "1" }),
    (error) => error.details?.reason === "LoanLimitExceeded" && error.details.maximum.raw === "0"
  );
});

test("failed D0 read refuses borrow rather than treating vested capacity as zero or known", async () => {
  const { service } = setup();
  service.capacityReader = async () => ({ vestedAssetsRaw: "0", vestingAvailable: false });
  await assert.rejects(
    service.buildTransactions(WALLET, { direction: "borrow", pledgeShares: "10000000", amount: "1" }),
    (error) => error.details?.reason === "VestingReadUnavailable"
  );
});

test("repay preflight binds the amount to the selected loan, not aggregate wallet debt", async () => {
  const { service } = setup({ snapshot: { wallet: { ...snapshot().wallet, outstandingDebt: 10_000_000n } } });
  await assert.rejects(
    service.buildTransactions(WALLET, { direction: "repay", loanId: LOAN_ID, amount: "5000001" }),
    (error) => error.details?.reason === "RepaymentExceedsOutstanding"
      && error.details.outstanding.raw === "5000000"
  );
});

test("unconfigured profiles return unavailable and never fabricate pool zeros", async () => {
  const service = new CreditPoolDoorService({ chainId: 420_420_419 });
  assert.deepEqual(await service.getInfo(WALLET), {
    schemaVersion: 1,
    available: false,
    reason: "credit_pool_not_configured"
  });
});
