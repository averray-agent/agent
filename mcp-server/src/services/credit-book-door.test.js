import assert from "node:assert/strict";
import test from "node:test";
import { Wallet } from "ethers";

import { MemoryStateStore } from "../core/state-store.js";
import {
  CREDIT_DEDUCTION_DISCLOSURE,
  CREDIT_PLATFORM_SWEEP_DISCLOSURE,
  CreditBookDoorService
} from "./credit-book-door.js";

const BOOK = "0x1111111111111111111111111111111111111111";
const ACCOUNTS = "0x2222222222222222222222222222222222222222";
const ASSET = "0x3333333333333333333333333333333333333333";
const OPERATOR = "0x4444444444444444444444444444444444444444";
const POSTER = "0x5555555555555555555555555555555555555555";
const CHAIN_ID = 420_420_419;
const NOW = new Date();
const wallet = new Wallet(`0x${"11".repeat(32)}`);

function snapshot(overrides = {}) {
  return {
    blockNumber: 100,
    blockHash: `0x${"66".repeat(32)}`,
    blockTimestamp: Math.floor(NOW.getTime() / 1_000),
    asset: ASSET,
    operator: OPERATOR,
    accounts: ACCOUNTS,
    cashCap: 25_000_000n,
    postingCap: 25_000_000n,
    bookCap: 50_000_000n,
    interestBps: 0n,
    repayBps: 5_000n,
    totalOutstanding: 0n,
    accountedLiquidity: 50_000_000n,
    bookLiquid: 50_000_000n,
    l3Enabled: false,
    l3PosterWallet: POSTER,
    perWalletCapCeiling: 100_000_000n,
    bookCapCeiling: 250_000_000n,
    interestBpsCeiling: 2_000n,
    cashOutstanding: 0n,
    postingOutstanding: 0n,
    cashLoan: null,
    postingLoan: null,
    ...overrides
  };
}

function setup(overrides = {}) {
  const stateStore = new MemoryStateStore();
  const calls = [];
  const service = new CreditBookDoorService({
    creditBookAddress: BOOK,
    agentAccountAddress: ACCOUNTS,
    chainId: CHAIN_ID,
    chainReader: { readSnapshot: async () => snapshot(overrides.snapshot) },
    underwriter: {
      evaluate: async () => overrides.underwriting ?? ({
        available: true,
        source: "decoded_settlement_split_logs",
        trailingNetRaw: "10000000",
        cashLimitRaw: "5000000",
        postingLimitRaw: "10000000",
        disqualified: false
      })
    },
    stateStore,
    gateway: {
      getPooledFundingAccount: async () => POSTER,
      originateCreditBookLoan: async (input) => {
        calls.push(["originate", input]);
        return { loanId: `0x${"77".repeat(32)}`, txHash: `0x${"88".repeat(32)}` };
      },
      createEscrowFundedExternalJob: async (draft) => {
        calls.push(["post", draft]);
        return { jobId: draft.jobId, specHash: draft.specHash, poster: POSTER };
      }
    },
    externalPostingService: overrides.externalPostingService,
    now: () => new Date(NOW)
  });
  return { service, stateStore, calls };
}

test("getCreditInfo exposes receipt-graph limits, live debt, and no invented next payout", async () => {
  const active = {
    loanId: `0x${"99".repeat(32)}`,
    borrower: wallet.address,
    mode: 0,
    principalRaw: 2_000_000n,
    outstandingRaw: 1_000_000n,
    termsHash: `0x${"aa".repeat(32)}`,
    originatedAt: 1_700_000_000,
    closedAt: 0
  };
  const { service } = setup({ snapshot: { cashOutstanding: 1_000_000n, totalOutstanding: 1_000_000n, cashLoan: active } });
  const result = await service.getInfo(wallet.address);
  assert.equal(result.wallet.cash.limit.raw, "5000000");
  assert.equal(result.wallet.cash.headroom.raw, "4000000");
  assert.equal(result.wallet.cash.activeLoan.outstanding.raw, "1000000");
  assert.equal(result.wallet.nextSweep.estimate, null);
  assert.equal(result.wallet.nextSweep.reason, "next_settlement_amount_unknown");
  assert.equal(result.disclosure.deduction, CREDIT_DEDUCTION_DISCLOSURE);
  assert.equal(result.disclosure.platformSweep, CREDIT_PLATFORM_SWEEP_DISCLOSURE);
});

test("consent round-trips exact terms hash, borrower signature, and AAC EIP-712 authorizations", async () => {
  const { service } = setup();
  const deadline = Math.floor(NOW.getTime() / 1_000) + 10 * 24 * 60 * 60;
  const built = await service.buildTransactions(wallet.address, {
    direction: "cash_consent",
    amount: "1000000",
    consentNonce: "nonce0001",
    sweepPlan: [{ amount: "500000", nonce: "9", deadline: String(deadline) }]
  });
  const consentSignature = await wallet.signMessage(built.consent.message);
  const authorization = built.repaymentAuthorizations[0];
  const authorizationSignature = await wallet.signTypedData(
    authorization.typedData.domain,
    authorization.typedData.types,
    authorization.typedData.message
  );
  const stored = await service.storeConsent(wallet.address, {
    terms: built.terms,
    termsHash: built.termsHash,
    consentSignature,
    repaymentAuthorizations: [{
      amount: authorization.amount,
      nonce: authorization.nonce,
      deadline: authorization.deadline,
      signature: authorizationSignature
    }]
  });
  assert.equal(stored.termsHash, built.termsHash);
  assert.equal(stored.wallet, wallet.address);
  assert.equal(stored.repaymentAuthorizations[0].recipient, BOOK);

  await assert.rejects(
    service.storeConsent(wallet.address, {
      terms: { ...built.terms, amountRaw: "1000001" },
      termsHash: built.termsHash,
      consentSignature,
      repaymentAuthorizations: []
    }),
    (error) => error.code === "credit_terms_hash_mismatch"
  );
});

test("current underwriting is rechecked before operator origination", async () => {
  const { service, calls } = setup();
  const deadline = Math.floor(NOW.getTime() / 1_000) + 10 * 24 * 60 * 60;
  const built = await service.buildTransactions(wallet.address, {
    direction: "cash_consent",
    amount: "1000000",
    consentNonce: "nonce0002",
    sweepPlan: [{ amount: "500000", nonce: "10", deadline: String(deadline) }]
  });
  const authorization = built.repaymentAuthorizations[0];
  await service.storeConsent(wallet.address, {
    terms: built.terms,
    termsHash: built.termsHash,
    consentSignature: await wallet.signMessage(built.consent.message),
    repaymentAuthorizations: [{
      amount: authorization.amount,
      nonce: authorization.nonce,
      deadline: authorization.deadline,
      signature: await wallet.signTypedData(
        authorization.typedData.domain,
        authorization.typedData.types,
        authorization.typedData.message
      )
    }]
  });
  const result = await service.originateConsentedLoan(built.termsHash);
  assert.equal(result.origination.amountRaw, "1000000");
  assert.equal(calls[0][0], "originate");
  assert.equal(calls[0][1].termsHash, built.termsHash);
});

test("posting consent refuses the launch flag and always marks the external job non-waived", async () => {
  const disabled = setup();
  await assert.rejects(
    disabled.service.buildTransactions(wallet.address, {
      direction: "posting_consent",
      amount: "1000000",
      consentNonce: "nonce0003",
      jobDefinition: { rewardAmount: "1", onboardingWaiverEligible: false }
    }),
    (error) => error.code === "credit_l3_disabled"
  );

  const enabled = setup({ snapshot: { l3Enabled: true } });
  const built = await enabled.service.buildTransactions(wallet.address, {
    direction: "posting_consent",
    amount: "1000000",
    consentNonce: "nonce0004",
    jobDefinition: { rewardAmount: "1" }
  });
  assert.equal(built.terms.jobDefinition.onboardingWaiverEligible, false);
});

test("enabled L3 sends the exact reserve through the configured external poster and never the borrower", async () => {
  const postingCalls = [];
  const externalPostingService = {
    createDraft: async (borrower, definition, options) => {
      postingCalls.push(["draft", borrower, definition, options]);
      return {
        status: "quoted",
        jobId: `0x${"ab".repeat(32)}`,
        specHash: `0x${"cd".repeat(32)}`,
        fundingRequirement: { posterReservedRaw: "1000000" }
      };
    },
    reconcileFinalizedCreation: async (confirmation) => {
      postingCalls.push(["reconcile", confirmation]);
      return { outcome: "confirmed", jobId: confirmation.jobId };
    }
  };
  const { service, calls } = setup({
    snapshot: { l3Enabled: true },
    externalPostingService
  });
  const deadline = Math.floor(NOW.getTime() / 1_000) + 10 * 24 * 60 * 60;
  const built = await service.buildTransactions(wallet.address, {
    direction: "posting_consent",
    amount: "1000000",
    consentNonce: "nonce0005",
    jobDefinition: { rewardAmount: "1" },
    sweepPlan: [{ amount: "500000", nonce: "11", deadline: String(deadline) }]
  });
  const authorization = built.repaymentAuthorizations[0];
  await service.storeConsent(wallet.address, {
    terms: built.terms,
    termsHash: built.termsHash,
    consentSignature: await wallet.signMessage(built.consent.message),
    repaymentAuthorizations: [{
      amount: authorization.amount,
      nonce: authorization.nonce,
      deadline: authorization.deadline,
      signature: await wallet.signTypedData(
        authorization.typedData.domain,
        authorization.typedData.types,
        authorization.typedData.message
      )
    }]
  });

  const result = await service.originateConsentedLoan(built.termsHash);

  assert.equal(calls[0][0], "originate");
  assert.equal(calls[0][1].borrower, wallet.address);
  assert.equal(calls[0][1].mode, 1);
  assert.equal(postingCalls[0][3].escrowPoster, POSTER);
  assert.equal(postingCalls[0][2].onboardingWaiverEligible, false);
  assert.equal(result.origination.posting.outcome, "confirmed");
});
