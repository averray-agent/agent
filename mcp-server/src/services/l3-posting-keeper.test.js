import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { Wallet, parseUnits } from "ethers";

import {
  ExternalPostingService,
  resolveExternalPostingConfig
} from "../core/external-posting-service.js";
import { MemoryStateStore } from "../core/state-store.js";
import { CreditBookDoorService } from "./credit-book-door.js";
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

function createHarness({ enabled = true, trailingNetRaw = "10000000" } = {}) {
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
    postingLimitRaw: BigInt(trailingNetRaw) < 25_000_000n ? trailingNetRaw : "25000000",
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
      const recipient = chain.posterWallet;
      const principalRecipient = chain.posterWallet;
      balances.set(principalRecipient, balances.get(principalRecipient) + amountRaw);
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
      return { loanId, recipient, txHash: `0x${"88".repeat(32)}`, status: 1 };
    },
    async createEscrowFundedExternalJob(draft) {
      calls.push(["poster-door", draft.definition]);
      const amountRaw = BigInt(draft.fundingRequirement.posterReservedRaw);
      balances.set(POSTER, balances.get(POSTER) - amountRaw);
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
      EXTERNAL_POSTING_MODE: "open",
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
  const createDraft = externalPostingService.createDraft.bind(externalPostingService);
  externalPostingService.createDraft = async (wallet, payload, options) => {
    calls.push(["poster-door-validate", wallet, options.escrowPoster]);
    return createDraft(wallet, payload, options);
  };
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
    keeper,
    stateStore,
    setUnderwriting(value) { underwriting = value; },
    async storeConsent({ nonce = "posting01", definition = jobDefinition() } = {}) {
      const deadline = Math.floor(NOW.getTime() / 1_000) + 10 * 24 * 60 * 60;
      const built = await creditBookDoor.buildTransactions(borrower.address, {
        direction: "posting_consent",
        amount: "1050000",
        consentNonce: nonce,
        jobDefinition: definition,
        sweepPlan: [{ amount: "525000", nonce: "9", deadline: String(deadline) }]
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
      balances.set(POSTER, balances.get(POSTER) + amountRaw);
      balances.set(POSTER, balances.get(POSTER) - amountRaw);
      chain.bookLiquid += amountRaw;
      calls.push(["existing-admin-agent-transfer", POSTER, BOOK, amountRaw]);
    }
  };
}

test("flag-off: every L3 keeper entry point refuses l3_disabled", async () => {
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

test("L3 loop: principal lands at poster and borrower balance stays unchanged", async () => {
  const h = createHarness();
  const built = await h.storeConsent();
  const requested = await h.keeper.enqueue({ termsHash: built.termsHash });
  const posted = await h.keeper.advance(requested.id);

  assert.equal(posted.status, "posted");
  assert.equal(h.balances.get(borrower.address), 0n, "borrower must never receive POSTING principal");
  assert.equal(h.balances.get(POSTER), 0n, "poster principal is reserved by the real poster-door path");
  assert.deepEqual(h.calls.map(([name]) => name).slice(0, 3), [
    "poster-door-validate",
    "originate",
    "poster-door"
  ]);
  assert.equal(requested.borrower, borrower.address, "request remains borrower-attributed");
  assert.deepEqual(
    requested.jobDefinition,
    built.terms.jobDefinition,
    "the borrower-signed job definition is preserved verbatim"
  );
  assert.equal(h.calls[0][1], POSTER, "the existing poster door runs as the live poster identity");
  assert.equal(h.calls[0][2], POSTER, "poster-door funding remains bound to the live poster");
  assert.deepEqual(h.calls[2][1].input, jobDefinition().input);
  assert.equal(h.calls[2][1].onboardingWaiverEligible, false);
  assert.equal(h.calls[2][1].requiresSponsoredGas, false);

  h.cancelAndConsentTransfer();
  const repaid = await h.keeper.reconcile(requested.id);

  assert.equal(repaid.status, "repaid");
  assert.equal(h.chain.postingLoan, null);
  assert.equal(h.chain.bookLiquid, 50_000_000n);
  assert.equal(h.chain.accountedLiquidity, 50_000_000n);
  assert.deepEqual(h.calls.map(([name]) => name), [
    "poster-door-validate",
    "originate",
    "poster-door",
    "existing-admin-agent-transfer",
    "repayFromRefund"
  ]);
});

test("cancelled L3 job waits for the existing consent-transfer rail before repayment", async () => {
  const h = createHarness();
  const built = await h.storeConsent();
  const request = await h.keeper.enqueue({ termsHash: built.termsHash });
  await h.keeper.advance(request.id);
  h.chain.job.state = 7;

  const waiting = await h.keeper.reconcile(request.id);

  assert.equal(waiting.status, "awaiting_refund_transfer");
  assert.equal(waiting.refund.transport, "existing_consent_gated_admin_agent_transfer");
  assert.equal(h.calls.some(([name]) => name === "repayFromRefund"), false);
});

test("underwrite bounds: zero net earnings and a second concurrent request are named refusals", async () => {
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

test("L3 mutation drill anchors each occur exactly once before mutation is trusted", () => {
  const keeperSource = readFileSync(new URL("./l3-posting-keeper.js", import.meta.url), "utf8");
  const doorSource = readFileSync(new URL("./credit-book-door.js", import.meta.url), "utf8");
  const testSource = readFileSync(new URL("./l3-posting-keeper.test.js", import.meta.url), "utf8");
  const flagAnchor = "if (!control.enabled) {";
  const recipientAnchor = "getAddress(originated.recipient) !== getAddress(info.book.l3PosterWallet)";
  const principalRouteAnchor = ["const principalRecipient = ", "chain.posterWallet;"].join("");
  assert.equal(keeperSource.split(flagAnchor).length - 1, 1, "flag-check anchorOccurrences=1");
  assert.equal(doorSource.split(recipientAnchor).length - 1, 1, "principal-route anchorOccurrences=1");
  assert.equal(testSource.split(principalRouteAnchor).length - 1, 1, "principal-redirection anchorOccurrences=1");
});
