import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { Wallet, keccak256, parseUnits, toUtf8Bytes } from "ethers";

import { canonicalizeContent } from "../core/canonical-content.js";
import {
  ExternalPostingService,
  resolveExternalPostingConfig
} from "../core/external-posting-service.js";
import { MemoryStateStore } from "../core/state-store.js";
import { CreditBookDoorService } from "./credit-book-door.js";
import { CreditBookKeeperService } from "./credit-book-keeper.js";
import {
  L3_DISABLED_REASON,
  L3PostingKeeperService
} from "./l3-posting-keeper.js";

const BOOK = "0x70441c9131Bc47c96E8D839C5B30850924838099";
const ACCOUNTS = "0x2222222222222222222222222222222222222222";
const ASSET = "0x0000053900000000000000000000000001200000";
const OPERATOR = "0x4444444444444444444444444444444444444444";
const POSTER = "0x5555555555555555555555555555555555555555";
const ESCROW = "0x6666666666666666666666666666666666666666";
const CHAIN_ID = 420_420_419;
const NOW = new Date("2026-08-21T12:00:00.000Z");
const borrower = new Wallet(`0x${"11".repeat(32)}`);

function jobDefinition(overrides = {}) {
  return {
    category: "coding",
    tier: "starter",
    rewardAsset: "USDC",
    rewardAmount: "1.0",
    verifierMode: "benchmark",
    verifierTerms: ["complete", "verified"],
    verifierMinimumMatches: 1,
    inputSchemaRef: "schema://jobs/coding-input",
    outputSchemaRef: "schema://jobs/coding-output",
    input: {
      task: "Implement the requested change.",
      acceptanceCriteria: ["The focused tests pass."]
    },
    claimTtlSeconds: 3600,
    retryLimit: 1,
    ...overrides
  };
}

function createHarness({
  enabled = true,
  trailingNetRaw = "10000000",
  postingLimitRaw = trailingNetRaw,
  principalRecipient = POSTER
} = {}) {
  const stateStore = new MemoryStateStore();
  const calls = [];
  const balances = new Map([
    [borrower.address, 0n],
    [POSTER, 0n]
  ]);
  const chain = {
    enabled,
    posterWallet: POSTER,
    accountedLiquidity: 50_000_000n,
    bookLiquid: 50_000_000n,
    totalOutstanding: 0n,
    postingOutstanding: 0n,
    postingLoan: null,
    job: null
  };
  let underwriting = {
    available: true,
    source: "decoded_settlement_split_logs",
    trailingNetRaw,
    cashLimitRaw: (BigInt(trailingNetRaw) / 2n).toString(),
    postingLimitRaw,
    disqualified: false
  };
  const snapshot = () => ({
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
    totalOutstanding: chain.totalOutstanding,
    accountedLiquidity: chain.accountedLiquidity,
    bookLiquid: chain.bookLiquid,
    l3Enabled: chain.enabled,
    l3PosterWallet: chain.posterWallet,
    perWalletCapCeiling: 100_000_000n,
    bookCapCeiling: 250_000_000n,
    interestBpsCeiling: 2_000n,
    cashOutstanding: 0n,
    postingOutstanding: chain.postingOutstanding,
    cashLoan: null,
    postingLoan: chain.postingLoan
  });
  const gateway = {
    async previewProtocolFeeForAsset(_asset, rewardAmount) {
      const rewardRaw = parseUnits(String(rewardAmount), 6);
      return {
        rewardAmountRaw: rewardRaw.toString(),
        protocolFeeAmountRaw: (rewardRaw * 500n / 10_000n).toString(),
        protocolFeeBps: 500,
        posterFeeFloorRaw: "0"
      };
    },
    async getPooledFundingAccount() {
      return POSTER;
    },
    async originateCreditBookLoan(input) {
      calls.push(["originate", input]);
      const amountRaw = BigInt(input.amountRaw);
      balances.set(principalRecipient, (balances.get(principalRecipient) ?? 0n) + amountRaw);
      chain.bookLiquid -= amountRaw;
      chain.accountedLiquidity -= amountRaw;
      chain.totalOutstanding += amountRaw;
      chain.postingOutstanding += amountRaw;
      const loanId = `0x${"77".repeat(32)}`;
      chain.postingLoan = {
        loanId,
        borrower: input.borrower,
        mode: 1,
        principalRaw: amountRaw,
        outstandingRaw: amountRaw,
        termsHash: input.termsHash,
        originatedAt: Math.floor(NOW.getTime() / 1_000),
        closedAt: 0
      };
      return { loanId, recipient: principalRecipient, txHash: `0x${"88".repeat(32)}`, status: 1 };
    },
    async createEscrowFundedExternalJob(draft) {
      calls.push(["poster-door", draft]);
      const amountRaw = BigInt(draft.fundingRequirement.posterReservedRaw);
      balances.set(POSTER, (balances.get(POSTER) ?? 0n) - amountRaw);
      chain.job = { jobId: draft.jobId, state: 1, poster: POSTER };
      return {
        jobId: draft.jobId,
        specHash: draft.specHash,
        poster: POSTER,
        asset: ASSET,
        reward: draft.fundingRequirement.rewardRaw,
        opsReserve: draft.fundingRequirement.opsReserveRaw,
        contingencyReserve: draft.fundingRequirement.contingencyReserveRaw,
        fundedAt: NOW.toISOString(),
        txHash: `0x${"99".repeat(32)}`,
        blockNumber: "101",
        finalized: true
      };
    },
    async getJob(jobId) {
      assert.equal(jobId, chain.job.jobId);
      return chain.job;
    },
    async isSendToAgentAuthorizationUsed() {
      return false;
    },
    async submitAuthorizedAgentTransfer(input) {
      calls.push(["authorized-sweep-transfer", input]);
      chain.bookLiquid += BigInt(input.amountRaw);
      return { txHash: `0x${"ab".repeat(32)}`, status: 1 };
    },
    async recordCreditBookSweep(loanId, amountRawInput) {
      const amountRaw = BigInt(amountRawInput);
      calls.push(["recordSweepRepayment", loanId, amountRaw]);
      chain.accountedLiquidity += amountRaw;
      chain.totalOutstanding -= amountRaw;
      chain.postingOutstanding -= amountRaw;
      chain.postingLoan.outstandingRaw -= amountRaw;
      if (chain.postingLoan.outstandingRaw === 0n) chain.postingLoan = null;
      return { txHash: `0x${"ac".repeat(32)}`, status: 1 };
    },
    async recordCreditBookRefund(loanId) {
      calls.push(["repayFromRefund", loanId]);
      const amountRaw = chain.postingLoan.outstandingRaw;
      chain.accountedLiquidity += amountRaw;
      chain.totalOutstanding -= amountRaw;
      chain.postingOutstanding -= amountRaw;
      chain.postingLoan = null;
      return { txHash: `0x${"aa".repeat(32)}`, status: 1 };
    }
  };
  const externalPostingService = new ExternalPostingService({
    stateStore,
    gateway,
    config: resolveExternalPostingConfig({
      EXTERNAL_POSTING_MODE: "allowlist",
      EXTERNAL_POSTING_ALLOWLIST: POSTER,
      EXTERNAL_POSTING_MIN_REWARD_USDC: "1",
      EXTERNAL_POSTING_MAX_REWARD_USDC: "10000",
      ESCROW_CORE_ADDRESS: ESCROW,
      SUPPORTED_ASSETS_JSON: JSON.stringify([
        { symbol: "USDC", address: ASSET, decimals: 6 }
      ])
    }),
    now: () => new Date(NOW),
    logger: { warn() {} }
  });
  const creditBookDoor = new CreditBookDoorService({
    creditBookAddress: BOOK,
    agentAccountAddress: ACCOUNTS,
    chainId: CHAIN_ID,
    chainReader: { readSnapshot: async () => snapshot() },
    underwriter: { evaluate: async () => underwriting },
    stateStore,
    gateway,
    externalPostingService,
    now: () => new Date(NOW)
  });
  const chainReader = {
    async readControl() {
      return {
        enabled: chain.enabled,
        posterWallet: chain.posterWallet,
        creditBookAddress: BOOK,
        blockNumber: 100,
        blockHash: `0x${"66".repeat(32)}`
      };
    }
  };
  const keeper = new L3PostingKeeperService({
    creditBookAddress: BOOK,
    chainReader,
    creditBookDoor,
    stateStore,
    gateway,
    now: () => new Date(NOW),
    logger: { warn() {} }
  });

  return {
    balances,
    calls,
    chain,
    creditBookDoor,
    gateway,
    keeper,
    stateStore,
    setUnderwriting(value) { underwriting = value; },
    async storeConsent({
      nonce = "posting01",
      definition = jobDefinition(),
      amountRaw = "1050000"
    } = {}) {
      const deadline = Math.floor(NOW.getTime() / 1_000) + 10 * 24 * 60 * 60;
      const built = await creditBookDoor.buildTransactions(borrower.address, {
        direction: "posting_consent",
        amount: amountRaw,
        consentNonce: nonce,
        jobDefinition: definition,
        sweepPlan: [{ amount: amountRaw, nonce: "9", deadline: String(deadline) }]
      });
      const authorization = built.repaymentAuthorizations[0];
      await creditBookDoor.storeConsent(borrower.address, {
        terms: built.terms,
        termsHash: built.termsHash,
        consentSignature: await borrower.signMessage(built.consent.message),
        repaymentAuthorizations: [{
          amount: authorization.amount,
          nonce: authorization.nonce,
          deadline: authorization.deadline,
          signature: await borrower.signTypedData(
            authorization.typedData.domain,
            authorization.typedData.types,
            authorization.typedData.message
          )
        }]
      });
      return built;
    },
    cancelAndConsentTransfer() {
      chain.job.state = 7;
      const amountRaw = chain.postingLoan.outstandingRaw;
      balances.set(POSTER, (balances.get(POSTER) ?? 0n) + chain.postingLoan.principalRaw);
      balances.set(POSTER, balances.get(POSTER) - amountRaw);
      chain.bookLiquid += amountRaw;
      calls.push(["existing-admin-agent-transfer", POSTER, BOOK, amountRaw]);
    }
  };
}

test("mutation drill: removing the live l3Enabled check fails every flag-off entry point", async () => {
  const h = createHarness({ enabled: false });
  const calls = [
    () => h.keeper.enqueue({ termsHash: `0x${"01".repeat(32)}` }),
    () => h.keeper.get("missing"),
    () => h.keeper.list(),
    () => h.keeper.listRefusals(),
    () => h.keeper.advance("missing"),
    () => h.keeper.reconcile("missing"),
    () => h.keeper.sweep()
  ];
  for (const call of calls) {
    await assert.rejects(call(), (error) => error.code === L3_DISABLED_REASON);
  }
  const refusals = await h.stateStore.listL3PostingRefusals();
  assert.equal(refusals.length, calls.length);
  assert.deepEqual(new Set(refusals.map((item) => item.reason)), new Set(["l3_disabled"]));
});

test("mutation drill: redirecting POSTING principal to the borrower fails the balance assertion", async () => {
  const h = createHarness();
  const built = await h.storeConsent();
  const requested = await h.keeper.enqueue({ termsHash: built.termsHash });
  const posted = await h.keeper.advance(requested.id);

  assert.equal(posted.status, "posted");
  assert.equal(h.balances.get(borrower.address), 0n, "borrower must never receive POSTING principal");
  assert.equal(h.balances.get(POSTER), 0n, "poster principal is reserved by the real poster-door path");
  assert.deepEqual(h.calls.map(([name]) => name).slice(0, 2), ["originate", "poster-door"]);
  assert.deepEqual(h.calls[1][1].definition.input, jobDefinition().input);
  assert.equal(h.calls[1][1].definition.onboardingWaiverEligible, false);
  assert.equal(h.calls[1][1].definition.requiresSponsoredGas, false);
  assert.equal(h.calls[1][1].fundingRequirement.protocolFeeRaw, "50000", "CW-7 fee remains charged");
  assert.equal(h.calls[1][1].fundingRequirement.posterReservedRaw, "1050000");
  const [signal] = await h.stateStore.listExternalPostingDemandSignals();
  assert.equal(signal.wallet, POSTER.toLowerCase());
  assert.equal(signal.quote.escrowPoster, POSTER.toLowerCase());
  assert.equal(requested.termsHash, keccak256(toUtf8Bytes(canonicalizeContent(requested.termsPreimage))));
  assert.deepEqual(requested.termsPreimage, built.terms);

  h.cancelAndConsentTransfer();
  const repaid = await h.keeper.reconcile(requested.id);

  assert.equal(repaid.status, "repaid");
  assert.equal(h.chain.postingLoan, null);
  assert.equal(h.chain.bookLiquid, 50_000_000n);
  assert.equal(h.chain.accountedLiquidity, 50_000_000n);
  assert.deepEqual(h.calls.map(([name]) => name), [
    "originate",
    "poster-door",
    "existing-admin-agent-transfer",
    "repayFromRefund"
  ]);
});

test("recipient mismatch is refused after origination and before the poster door can run", async () => {
  const h = createHarness({ principalRecipient: borrower.address });
  const built = await h.storeConsent();
  const request = await h.keeper.enqueue({ termsHash: built.termsHash });

  await assert.rejects(
    h.keeper.advance(request.id),
    (error) => error.code === "l3_principal_recipient_mismatch"
  );
  assert.equal(h.balances.get(borrower.address), 1_050_000n);
  assert.deepEqual(h.calls.map(([name]) => name), ["originate"]);
});

test("cancelled L3 job waits for the existing consent-transfer rail before repayFromRefund", async () => {
  const h = createHarness();
  const built = await h.storeConsent();
  const request = await h.keeper.enqueue({ termsHash: built.termsHash });
  await h.keeper.advance(request.id);
  h.chain.job.state = 7;

  const waiting = await h.keeper.reconcile(request.id);

  assert.equal(waiting.status, "awaiting_refund_transfer");
  assert.equal(waiting.refund.requiredRaw, "1050000");
  assert.equal(waiting.refund.transport, "existing_consent_gated_admin_agent_transfer");
  assert.equal(h.calls.some(([name]) => name === "repayFromRefund"), false);
});

test("settlement repayment stays on the existing recordSweepRepayment keeper path", async () => {
  const h = createHarness();
  const built = await h.storeConsent();
  const request = await h.keeper.enqueue({ termsHash: built.termsHash });
  await h.keeper.advance(request.id);
  h.chain.job.state = 6;
  const sweepKeeper = new CreditBookKeeperService({
    creditBookDoor: h.creditBookDoor,
    gateway: h.gateway,
    now: () => new Date(NOW),
    logger: { warn() {} }
  });

  const swept = await sweepKeeper.afterSettlement({
    session: { sessionId: "settled-session", wallet: borrower.address },
    payoutTx: {
      settlement: {
        worker: borrower.address,
        workerAmountRaw: "2100000"
      }
    }
  });
  const reconciled = await h.keeper.reconcile(request.id);

  assert.equal(swept.status, "swept");
  assert.equal(swept.sweeps[0].amountRaw, "1050000");
  assert.equal(reconciled.status, "repaid");
  assert.equal(h.chain.postingLoan, null);
  assert.equal(h.chain.bookLiquid, 50_000_000n);
  assert.equal(h.chain.accountedLiquidity, 50_000_000n);
  assert.deepEqual(
    h.calls.slice(-2).map(([name]) => name),
    ["authorized-sweep-transfer", "recordSweepRepayment"]
  );
});

test("underwrite bounds enforce zero, the global 25 USDC ceiling, and one active request", async () => {
  const zero = createHarness();
  const zeroConsent = await zero.storeConsent();
  zero.setUnderwriting({
    available: true,
    source: "decoded_settlement_split_logs",
    trailingNetRaw: "0",
    cashLimitRaw: "0",
    postingLimitRaw: "0",
    disqualified: false
  });
  await assert.rejects(
    zero.keeper.enqueue({ termsHash: zeroConsent.termsHash }),
    (error) => error.code === "l3_underwriting_zero"
  );

  const capped = createHarness({ trailingNetRaw: "100000000", postingLimitRaw: "100000000" });
  const overCap = await capped.storeConsent({ amountRaw: "25000001" });
  await assert.rejects(
    capped.keeper.enqueue({ termsHash: overCap.termsHash }),
    (error) => error.code === "l3_limit_exceeded"
      && error.details?.keeperLimitRaw === "25000000"
  );

  const staleAllowance = createHarness({
    trailingNetRaw: "10000000",
    postingLimitRaw: "100000000"
  });
  const overEarnings = await staleAllowance.storeConsent({ amountRaw: "10000001" });
  await assert.rejects(
    staleAllowance.keeper.enqueue({ termsHash: overEarnings.termsHash }),
    (error) => error.code === "l3_limit_exceeded"
      && error.details?.keeperLimitRaw === "10000000"
  );

  const concurrent = createHarness();
  const first = await concurrent.storeConsent({ nonce: "posting02" });
  await concurrent.keeper.enqueue({ termsHash: first.termsHash });
  const second = await concurrent.storeConsent({
    nonce: "posting03",
    definition: jobDefinition({ input: { task: "Second task", acceptanceCriteria: ["Done"] } })
  });
  await assert.rejects(
    concurrent.keeper.enqueue({ termsHash: second.termsHash }),
    (error) => error.code === "l3_active_request"
  );
});

test("concurrent borrower intake is serialized and returns the named l3_active_request refusal", async () => {
  const h = createHarness();
  const built = await h.storeConsent();
  const lockId = `l3-posting-borrower:${borrower.address.toLowerCase()}`;
  assert.equal(await h.stateStore.acquireClaimLock(lockId, "other-keeper", 300), true);
  await assert.rejects(
    h.keeper.enqueue({ termsHash: built.termsHash }),
    (error) => error.code === "l3_active_request"
  );
  await h.stateStore.releaseClaimLock(lockId, "other-keeper");
});

test("L3 mutation drill anchors each occur exactly once before a red run", () => {
  const keeperSource = readFileSync(new URL("./l3-posting-keeper.js", import.meta.url), "utf8");
  const doorSource = readFileSync(new URL("./credit-book-door.js", import.meta.url), "utf8");
  const flagAnchor = "if (!control.enabled) {";
  const recipientAnchor = "getAddress(originated.recipient) !== getAddress(info.book.l3PosterWallet)";
  assert.equal(keeperSource.split(flagAnchor).length - 1, 1, "flag-check anchorOccurrences=1");
  assert.equal(doorSource.split(recipientAnchor).length - 1, 1, "principal-route anchorOccurrences=1");
});
