import assert from "node:assert/strict";
import test from "node:test";

import { Wallet, id, parseUnits } from "ethers";

import {
  ExternalPostingService,
  resolveExternalPostingConfig
} from "../core/external-posting-service.js";
import { MemoryStateStore } from "../core/state-store.js";
import { PaymentSettlementError } from "./settlement-adapter.js";
import {
  X402PosterRampService,
  resolveX402PosterRampConfig
} from "./x402-poster-ramp.js";

const POSTER = Wallet.createRandom().address.toLowerCase();
const POOL = "0x2222222222222222222222222222222222222222";
const ESCROW = "0x3333333333333333333333333333333333333333";
const HUB_USDC = "0x0000053900000000000000000000000001200000";
const BASE_USDC = "0x4444444444444444444444444444444444444444";
const PAY_TO = "0x5555555555555555555555555555555555555555";
const NOW = new Date("2026-08-09T12:00:00.000Z");

function definition() {
  return {
    category: "coding",
    tier: "starter",
    rewardAsset: "USDC",
    rewardAmount: "1",
    verifierMode: "benchmark",
    verifierTerms: ["complete", "verified"],
    verifierMinimumMatches: 1,
    inputSchemaRef: "schema://jobs/coding-input",
    outputSchemaRef: "schema://jobs/coding-output",
    input: {
      task: "Implement the requested change.",
      acceptanceCriteria: ["Focused tests pass."]
    },
    claimTtlSeconds: 3600,
    retryLimit: 1
  };
}

function rampConfig(overrides = {}) {
  return resolveX402PosterRampConfig({
    X402_POSTING_MODE: "enabled",
    X402_PUBLIC_ORIGIN: "https://api.example.test",
    X402_PAYMENT_NETWORK: "eip155:8453",
    X402_PAYMENT_ASSET_ADDRESS: BASE_USDC,
    X402_PAYMENT_PAY_TO: PAY_TO,
    X402_PAYMENT_ASSET_EIP712_NAME: "USD Coin",
    X402_PAYMENT_ASSET_EIP712_VERSION: "2",
    X402_POSTING_FLOAT_CAP_USDC: "5",
    X402_POSTING_FLOAT_RETRY_AFTER_SECONDS: "900",
    ...overrides
  });
}

class StubSettlementAdapter {
  constructor({ events, balanceRaw = 10_000_000n, failSettlement = false }) {
    this.events = events;
    this.balanceRaw = balanceRaw;
    this.failSettlement = failSettlement;
  }

  async verify({ requirements }) {
    this.events.push("verify");
    assert.ok(this.balanceRaw >= BigInt(requirements.amount));
    return {
      authorizationId: id("stub-authorization"),
      payer: POSTER,
      expiresAt: "2030-01-01T00:00:00.000Z",
      verifiedAt: NOW.toISOString()
    };
  }

  async settle({ requirements }) {
    this.events.push("settle");
    if (this.failSettlement) {
      throw new PaymentSettlementError(
        "Settlement failed after Hub escrow creation. The job was delisted; request a fresh payment.",
        "payment_settlement_failed",
        { action: "retry_for_fresh_authorization", posterFunds: "not_settled" }
      );
    }
    this.balanceRaw -= BigInt(requirements.amount);
    return {
      receiptId: `0x${"c".repeat(64)}`,
      network: "eip155:8453",
      payer: POSTER,
      amount: requirements.amount,
      settledAt: NOW.toISOString(),
      discovery: { discoverable: true, portable: true, status: "processing" }
    };
  }
}

function makeHarness({ failSettlement = false, afterVerify = undefined, config = rampConfig() } = {}) {
  const events = [];
  const jobs = new Map();
  const catalog = [];
  const hubBalances = new Map([[POSTER, 0n], [POOL, 10_000_000n]]);
  const store = new MemoryStateStore();
  const gateway = {
    async previewProtocolFeeForAsset(_asset, rewardAmount) {
      const rewardRaw = parseUnits(String(rewardAmount), 6);
      return {
        rewardAmountRaw: rewardRaw.toString(),
        protocolFeeAmountRaw: (rewardRaw * 500n / 10_000n).toString(),
        protocolFeeBps: 500
      };
    },
    async getPooledFundingAccount() {
      return POOL;
    },
    async createEscrowFundedExternalJob(draft) {
      events.push("create");
      const requiredRaw = BigInt(draft.fundingRequirement.posterReservedRaw);
      assert.ok(hubBalances.get(POOL) >= requiredRaw);
      hubBalances.set(POOL, hubBalances.get(POOL) - requiredRaw);
      jobs.set(draft.jobId, draft);
      return {
        jobId: draft.jobId,
        specHash: draft.specHash,
        poster: POOL,
        asset: HUB_USDC,
        reward: draft.calldata.args[2],
        opsReserve: draft.calldata.args[3],
        contingencyReserve: draft.calldata.args[4],
        fundedAt: NOW.toISOString(),
        txHash: `0x${"a".repeat(64)}`,
        blockNumber: "123",
        finalized: true
      };
    }
  };
  const platformService = {
    createExternalJobProjection(draft) {
      catalog.push(draft.jobId);
      return draft;
    }
  };
  const externalPostingService = new ExternalPostingService({
    stateStore: store,
    platformService,
    gateway,
    config: resolveExternalPostingConfig({
      EXTERNAL_POSTING_MODE: "open",
      EXTERNAL_POSTING_MIN_REWARD_USDC: "1",
      EXTERNAL_POSTING_MAX_REWARD_USDC: "10000",
      ESCROW_CORE_ADDRESS: ESCROW,
      SUPPORTED_ASSETS_JSON: JSON.stringify([
        { symbol: "USDC", address: HUB_USDC, decimals: 6 }
      ])
    }),
    now: () => NOW
  });
  const settlementAdapter = new StubSettlementAdapter({ events, failSettlement });
  const siwxAdapter = {
    async issueChallenge() {
      return { info: { nonce: "challenge" }, supportedChains: [], schema: {} };
    },
    async verifyHeader() {
      return { wallet: POSTER, chainId: "eip155:8453", authenticatedAt: NOW.toISOString() };
    }
  };
  const ramp = new X402PosterRampService({
    config,
    settlementAdapter,
    externalPostingService,
    stateStore: store,
    gateway,
    siwxAdapter,
    now: () => NOW,
    afterVerify
  });
  return {
    catalog,
    events,
    externalPostingService,
    gateway,
    hubBalances,
    jobs,
    ramp,
    settlementAdapter,
    store
  };
}

test("a second stub adapter proves verify -> create -> settle and only then lists the job", async () => {
  const { catalog, events, hubBalances, ramp, settlementAdapter, store } = makeHarness();
  const initialBalance = settlementAdapter.balanceRaw;
  const result = await ramp.post({
    payload: { definition: definition() },
    paymentProof: "opaque-payment",
    signInProof: "opaque-sign-in"
  });

  assert.deepEqual(events, ["verify", "create", "settle"]);
  assert.equal(catalog.length, 1);
  assert.equal(result.status, "live");
  assert.equal(result.fundingRail, "x402");
  assert.equal(result.payment.discoverable, true);
  assert.equal(settlementAdapter.balanceRaw, initialBalance - 1_050_000n);
  assert.equal(hubBalances.get(POSTER), 0n, "the external poster never holds Hub funds");
  assert.equal(hubBalances.get(POOL), 8_950_000n, "the pooled account fronts exact escrow");
  const [signal] = await store.listExternalPostingDemandSignals();
  assert.equal(signal.fundingRail, "x402");
  assert.equal(signal.fundingStatus, "funded");
});

test("process death after verify leaves poster balance unchanged and creates no Hub job", async () => {
  const processDeath = new Error("simulated process death after verify");
  const { catalog, events, hubBalances, jobs, ramp, settlementAdapter, store } = makeHarness({
    afterVerify: async () => { throw processDeath; }
  });
  const initialBalance = settlementAdapter.balanceRaw;

  await assert.rejects(
    ramp.post({
      payload: { definition: definition() },
      paymentProof: "opaque-payment",
      signInProof: "opaque-sign-in"
    }),
    processDeath
  );
  assert.deepEqual(events, ["verify"]);
  assert.equal(jobs.size, 0);
  assert.equal(catalog.length, 0);
  assert.equal(settlementAdapter.balanceRaw, initialBalance);
  assert.equal(hubBalances.get(POSTER), 0n);
  assert.equal(hubBalances.get(POOL), 10_000_000n);
  assert.equal((await store.listExternalPaymentFundings()).length, 0);
});

test("settlement failure after creation delists and records the loss as the platform's", async () => {
  const {
    catalog,
    events,
    externalPostingService,
    ramp,
    settlementAdapter,
    store
  } = makeHarness({ failSettlement: true });
  const initialBalance = settlementAdapter.balanceRaw;

  await assert.rejects(
    ramp.post({
      payload: { definition: definition() },
      paymentProof: "opaque-payment",
      signInProof: "opaque-sign-in"
    }),
    (error) => error.code === "payment_settlement_failed"
  );
  assert.deepEqual(events, ["verify", "create", "settle"]);
  assert.equal(catalog.length, 0);
  assert.equal(settlementAdapter.balanceRaw, initialBalance);
  const [funding] = await store.listExternalPaymentFundings();
  assert.equal(funding.status, "platform_loss");
  assert.equal(funding.lossOwner, "platform");
  assert.equal(await store.isExternalJobDelisted(funding.jobId), true);
  const [signal] = await store.listExternalPostingDemandSignals();
  assert.equal(signal.fundingRail, "x402");
  assert.equal(signal.platformLoss, true);

  const repeatedObservation = await externalPostingService.reconcileFinalizedCreation({
    jobId: funding.jobId,
    specHash: signal.quote.specHash,
    poster: POOL,
    asset: HUB_USDC,
    reward: signal.quote.calldata.args[2],
    opsReserve: signal.quote.calldata.args[3],
    contingencyReserve: signal.quote.calldata.args[4],
    fundedAt: NOW.toISOString(),
    txHash: funding.hubTxHash,
    blockNumber: funding.hubBlockNumber,
    finalized: true
  });
  assert.equal(repeatedObservation.outcome, "settlement_failed");
  assert.equal((await store.getExternalJobDraft(funding.draftId)).status, "settlement_failed");
});

test("configured float cap refuses a new 402 with a reason and exact retry time", async () => {
  const { ramp, store } = makeHarness({
    config: rampConfig({ X402_POSTING_FLOAT_CAP_USDC: "1.05" })
  });
  await store.upsertExternalPaymentFunding({
    id: id("existing-funding"),
    status: "settled",
    reservedRaw: "1050000",
    createdAt: NOW.toISOString()
  });

  await assert.rejects(
    ramp.paymentRequired({ definition: definition() }),
    (error) => {
      assert.equal(error.code, "x402_float_exhausted");
      assert.equal(error.details.reason, "configured_pooled_float_cap_exhausted");
      assert.equal(error.details.retryAt, "2026-08-09T12:15:00.000Z");
      assert.equal(error.details.posterFunds, "unchanged");
      return true;
    }
  );
});

test("float accounting scans every durable page instead of silently stopping at a limit", async () => {
  const { ramp, store } = makeHarness();
  for (let index = 0; index < 1_005; index += 1) {
    await store.upsertExternalPaymentFunding({
      id: `0x${index.toString(16).padStart(64, "0")}`,
      status: "settled",
      reservedRaw: "1",
      createdAt: new Date(NOW.getTime() + index).toISOString()
    });
  }

  assert.equal(await ramp.committedFloatRaw(), 1_005n);
});

test("Bazaar advertises a portable route without publishing poster-specific job content", async () => {
  const { ramp } = makeHarness();
  const payload = { definition: definition() };
  payload.definition.input.task = "private poster-specific task 8e0cb";

  const challenge = await ramp.paymentRequired(payload);

  assert.equal(challenge.statusCode, 402);
  assert.equal(challenge.body.discoverable, true);
  assert.equal(challenge.body.portableListing, true);
  assert.equal(challenge.body.extensions.bazaar.discoverable, true);
  assert.equal(challenge.body.extensions.bazaar.portable, true);
  assert.equal(challenge.body.extensions.bazaar.info.input.method, "POST");
  assert.doesNotMatch(JSON.stringify(challenge.body.extensions.bazaar), /8e0cb/u);
});

test("float cap has no default and must be supplied by the bank lane", () => {
  assert.throws(
    () => resolveX402PosterRampConfig({
      X402_POSTING_MODE: "enabled",
      X402_PUBLIC_ORIGIN: "https://api.example.test",
      X402_PAYMENT_NETWORK: "eip155:8453",
      X402_PAYMENT_ASSET_ADDRESS: BASE_USDC,
      X402_PAYMENT_PAY_TO: PAY_TO,
      X402_PAYMENT_ASSET_EIP712_NAME: "USD Coin",
      X402_PAYMENT_ASSET_EIP712_VERSION: "2",
      X402_POSTING_FLOAT_RETRY_AFTER_SECONDS: "900"
    }),
    /FLOAT_CAP_USDC is required/u
  );
});

// The advertised `extra` IS the payer's EIP-712 domain. We shipped a hardcoded
// { name: "USDC", version: "2" }; Base USDC has symbol() "USDC" but name()
// "USD Coin", so every payer signed a digest the token does not recognise, the
// signature recovered to a different address, and the facilitator returned a flat
// payment_verification_failed. The ramp could not take a payment from anyone.
test("the advertised EIP-712 domain comes from config, not a hardcoded guess", () => {
  const service = new X402PosterRampService({
    config: rampConfig({
      X402_PAYMENT_ASSET_EIP712_NAME: "USD Coin",
      X402_PAYMENT_ASSET_EIP712_VERSION: "2"
    }),
    settlementAdapter: new StubSettlementAdapter({ events: [] }),
    externalPostingService: {},
    stateStore: new MemoryStateStore(),
    gateway: {}
  });
  assert.deepEqual(service.paymentRequirements(1_050_000n).extra, {
    name: "USD Coin",
    version: "2"
  });
});

test("a different asset advertises its own domain rather than USDC's", () => {
  const service = new X402PosterRampService({
    config: rampConfig({
      X402_PAYMENT_ASSET_EIP712_NAME: "Some Other Token",
      X402_PAYMENT_ASSET_EIP712_VERSION: "1"
    }),
    settlementAdapter: new StubSettlementAdapter({ events: [] }),
    externalPostingService: {},
    stateStore: new MemoryStateStore(),
    gateway: {}
  });
  assert.deepEqual(service.paymentRequirements(1n).extra, {
    name: "Some Other Token",
    version: "1"
  });
});

// No default, because the default was the bug. Silence must be impossible.
test("the EIP-712 domain has no default and must be supplied", () => {
  assert.throws(
    () => rampConfig({ X402_PAYMENT_ASSET_EIP712_NAME: undefined }),
    /X402_PAYMENT_ASSET_EIP712_NAME is required.*DOMAIN_SEPARATOR/su
  );
  assert.throws(
    () => rampConfig({ X402_PAYMENT_ASSET_EIP712_VERSION: "  " }),
    /X402_PAYMENT_ASSET_EIP712_VERSION is required.*DOMAIN_SEPARATOR/su
  );
});

// EIP-712 hashes the domain strings byte for byte, so a trim is a different
// domain, not a tidier one.
test("domain strings are carried verbatim, including surrounding whitespace", () => {
  const config = rampConfig({ X402_PAYMENT_ASSET_EIP712_NAME: " USD Coin " });
  assert.equal(config.assetEip712Name, " USD Coin ");
});

test("poster ramp settlement is pinned to Base and never bridges per job", () => {
  assert.throws(
    () => resolveX402PosterRampConfig({
      X402_POSTING_MODE: "enabled",
      X402_PUBLIC_ORIGIN: "https://api.example.test",
      X402_PAYMENT_NETWORK: "eip155:420420419",
      X402_PAYMENT_ASSET_ADDRESS: BASE_USDC,
      X402_PAYMENT_PAY_TO: PAY_TO,
      X402_PAYMENT_ASSET_EIP712_NAME: "USD Coin",
      X402_PAYMENT_ASSET_EIP712_VERSION: "2",
      X402_POSTING_FLOAT_CAP_USDC: "5",
      X402_POSTING_FLOAT_RETRY_AFTER_SECONDS: "900"
    }),
    /must be eip155:8453 \(Base\).*bridging/u
  );
});
