import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createPosterOnboardingService } from "./poster-onboarding.js";

const ESCROW = "0x590EbE304E0C7672e2abF3161177D2B94a2aC3fC";
const ACCOUNTS = "0xB1350932bf85E7ffd0599E9a3CC7b55718D89E57";
const TOKEN = "0x0000053900000000000000000000000001200000";
const POSTER = "0x089a0A57D001bACb8473161e007F0bAbC1768CeE";

function makeService({
  mode = "allowlist",
  protocolFeeBps = 321,
  stakeBps = 654,
  feeBps = 87,
  minFeeRaw = "12345",
  disputeWindowSeconds = 123_456,
  gatewayOverrides = {}
} = {}) {
  return createPosterOnboardingService({
    authConfig: { chainId: "420420419" },
    externalPostingService: {
      config: {
        mode,
        allowlist: new Set([POSTER.toLowerCase()]),
        minRewardUsdc: "1.25",
        draftTtlHours: 19,
        maxOpenDrafts: 7,
        escrowCoreAddress: ESCROW,
        usdcAsset: { symbol: "USDC", address: TOKEN, decimals: 6 }
      }
    },
    gateway: {
      config: { agentAccountAddress: ACCOUNTS },
      isEnabled: () => true,
      getProtocolFeeConfig: async () => ({
        supported: true,
        protocolFeeBps,
        maxProtocolFeeBps: 999,
        treasuryAccount: POSTER
      }),
      getDefaultClaimStakeBps: async () => stakeBps,
      getClaimEconomicsConfig: async (options) => {
        assert.deepEqual(options, { requireBondInputs: true });
        return {
          claimFeeBps: feeBps,
          minClaimFeeRawByAsset: { USDC: minFeeRaw }
        };
      },
      getDisputeWindowSeconds: async () => disputeWindowSeconds,
      ...gatewayOverrides
    },
    verifierService: {
      listHandlers: () => ["benchmark", "deterministic", "human_fallback", "github_pr"]
    },
    publicBaseUrl: "https://api.example.com",
    now: () => new Date("2026-08-01T08:00:00.000Z"),
    cacheMs: 0
  });
}

test("poster onboarding renders closed, allowlist, and open modes from live config", async () => {
  for (const mode of ["closed", "allowlist", "open"]) {
    const payload = await makeService({ mode }).getPosterOnboarding();
    assert.equal(payload.mode, mode);
    assert.equal("allowlistEnrollment" in payload, mode !== "open");
    if (mode === "allowlist") {
      assert.match(payload.allowlistEnrollment, /requires operator enrollment/iu);
    }
    if (mode === "closed") {
      assert.match(payload.allowlistEnrollment, /currently closed/iu);
    }
  }
});

test("poster onboarding is a clean-room machine recipe backed by non-default live economics", async () => {
  const payload = await makeService().getPosterOnboarding();

  assert.equal(payload.chainId, 420420419);
  assert.equal(payload.escrowCore, ESCROW);
  assert.equal(payload.agentAccountCore, ACCOUNTS);
  assert.deepEqual(payload.token, { symbol: "USDC", address: TOKEN, decimals: 6 });
  assert.deepEqual(payload.economics, {
    protocolFeeBps: 321,
    feeSemantics: "poster_additive",
    feeExplanation:
      "The poster reserves the full worker reward plus the protocol fee; the worker receives the full advertised reward.",
    posterReserveFormula:
      "reward + opsReserve + contingencyReserve + floor(reward * protocolFeeBps / 10000)",
    minRewardUsdc: "1.25",
    draftTtlHours: 19,
    maxOpenDrafts: 7,
    availability: { protocolFeeBps: { status: "available" } }
  });
  assert.deepEqual(payload.workerFacts.claimBond, {
    available: true,
    asset: "USDC",
    stakeBps: 654,
    feeBps: 87,
    minFeeRaw: "12345",
    semantics:
      "Stake plus claim fee is locked from the worker's AgentAccountCore liquid balance at claim, returned in full on successful resolution, and forfeitable on slash."
  });
  assert.equal(payload.workerFacts.disputeWindow.seconds, 123_456);
  assert.equal(payload.workerFacts.preflight.path, "/jobs/preflight?jobId=X");
  assert.equal(payload.workerFacts.selfDeposit.routeAvailable, false);
  assert.deepEqual(payload.cancellation, {
    selfServeCancel: false,
    rescue: "operator-mediated on request, ~7 days, refunds only ever to the recorded poster",
    plannedSelfServeCancel: "cancelOpenJob, next EscrowCore deployment window"
  });
  assert.deepEqual(payload.flow.map((step) => step.id), [
    "siwe",
    "draft",
    "fund",
    "watch",
    "delist",
    "schema-discovery"
  ]);
  const human = payload.verification.modes.find((mode) => mode.id === "human_fallback");
  assert.equal(human.reviewPath, "dispute_arbitration");
  assert.match(human.verdicts.dismissed, /^Approve:/u);
  assert.match(human.verdicts.upheld, /^Reject:/u);
  assert.equal(payload.docs.workedExample, "https://github.com/averray-agent/agent/pull/874");
  assert.deepEqual(payload.liveReads, {
    asOf: "2026-08-01T08:00:00.000Z",
    protocolFeeBps: { status: "available" },
    claimBond: { status: "available" },
    disputeWindow: { status: "available" }
  });
});

test("external onboarding and catalog claim bonds reuse live facts without static fee or bond constants", async () => {
  const service = makeService({
    stakeBps: 654,
    feeBps: 87,
    minFeeRaw: "12345"
  });
  const externalBounties = await service.getExternalBountiesOnboarding();
  assert.equal(externalBounties.claimBond.stakeBps, 654);
  assert.equal(externalBounties.claimBond.feeBps, 87);
  assert.equal(externalBounties.disputeWindow.seconds, 123_456);
  assert.deepEqual(externalBounties.cancellation, {
    selfServeCancel: false,
    rescue: "operator-mediated on request, ~7 days, refunds only ever to the recorded poster",
    plannedSelfServeCancel: "cancelOpenJob, next EscrowCore deployment window"
  });

  const [external, curated] = await service.enrichExternalCatalogRows([
    {
      id: "external-live-1",
      source: { type: "external", poster: { wallet: POSTER } },
      rewardAmount: "2.5",
      rewardAsset: "USDC"
    },
    { id: "curated-1", source: { type: "github_issue" }, rewardAmount: 2.5 }
  ]);
  assert.deepEqual(external.claimBond, {
    available: true,
    asset: "USDC",
    stakeRaw: "163500",
    stakeBps: 654,
    feeRaw: "21750",
    feeBps: 87,
    totalRaw: "185250",
    source: "live_policy_estimate",
    perWalletTruth: "/jobs/preflight?jobId=external-live-1"
  });
  assert.equal(external.source.poster.wallet, POSTER);
  assert.equal("claimBond" in curated, false);

  const source = await readFile(new URL("./poster-onboarding.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /protocolFeeBps\s*:\s*\d/gu);
  assert.doesNotMatch(source, /stakeBps\s*:\s*\d/gu);
  assert.doesNotMatch(source, /feeBps\s*:\s*\d/gu);
});

test("failed live reads omit confident values and leave honest unavailable markers", async () => {
  const unavailable = async () => {
    throw new Error("RPC unavailable");
  };
  const service = makeService({
    gatewayOverrides: {
      getProtocolFeeConfig: unavailable,
      getDefaultClaimStakeBps: unavailable,
      getClaimEconomicsConfig: unavailable,
      getDisputeWindowSeconds: unavailable
    }
  });
  const payload = await service.getPosterOnboarding();

  assert.equal("protocolFeeBps" in payload.economics, false);
  assert.equal(payload.economics.availability.protocolFeeBps.status, "unavailable");
  assert.deepEqual(payload.workerFacts.claimBond.available, false);
  assert.deepEqual(payload.workerFacts.disputeWindow.available, false);
  assert.equal(payload.liveReads.claimBond.status, "unavailable");

  const [external] = await service.enrichExternalCatalogRows([
    { id: "external-live-1", source: "external", rewardAmount: "1" }
  ]);
  assert.deepEqual(external.claimBond, {
    available: false,
    reason: "live_chain_read_failed",
    preflight: "/jobs/preflight?jobId=external-live-1"
  });
});
