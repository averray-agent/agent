import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { id } from "ethers";

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
    feeRecipient: POSTER,
    feeSemantics: "poster_additive",
    feeExplanation:
      "The poster reserves the full worker reward plus the protocol fee; the worker receives the full advertised reward.",
    posterReserveFormula:
      "reward + opsReserve + contingencyReserve + floor(reward * protocolFeeBps / 10000)",
    minRewardUsdc: "1.25",
    draftTtlHours: 19,
    quotePersistence: "demand_signal_only_until_funded",
    quoteIdentity: "poster_and_content_hash",
    availability: {
      protocolFeeBps: { status: "available" },
      feeRecipient: { status: "available" }
    }
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
  assert.deepEqual(payload.workerFacts.gasPolicy, {
    operatorBrokeredGas: false,
    appliesTo: "all externally posted jobs",
    workerPays: ["claimJob", "submitWork"],
    apiBehavior:
      "The claim and submit endpoints validate first, then return an exact direct-wallet transaction recipe. After the worker broadcasts it, retry the same request to converge the durable session.",
    curatedException:
      "Operator-brokered gas remains available only to explicitly sponsored curated starter inventory; poster volume never spends that subsidy."
  });
  assert.equal(payload.workerFacts.disputeWindow.seconds, 123_456);
  assert.deepEqual(payload.workerFacts.disputeWindow.remedy, {
    action: "Open the dispute from the recorded worker wallet before the dispute window ends.",
    onChain: {
      available: true,
      contract: "EscrowCore",
      address: ESCROW,
      abiFragment: "function openDispute(bytes32 jobId)",
      signature: "openDispute(bytes32 jobId)",
      args: ["<jobId>"],
      value: "0"
    },
    brokeredPath: {
      available: false,
      reason: "no_worker_reachable_brokered_open_dispute_route"
    }
  });
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
  const funding = payload.flow.find((step) => step.id === "fund");
  const quote = payload.flow.find((step) => step.id === "draft");
  assert.match(quote.action, /No draft or claimable job persists before finalized funding/u);
  assert.ok(quote.returns.includes("fundingRequirement.posterReservedRaw"));
  assert.ok(quote.returns.includes("persisted=false"));
  assert.equal(funding.exactPosterReservedRaw, "the quote response fundingRequirement.posterReservedRaw");
  assert.equal(
    funding.posterReservedRawFormula,
    "rewardRaw + opsReserveRaw + contingencyReserveRaw + floor(rewardRaw * economics.protocolFeeBps / 10000)"
  );
  assert.equal(
    funding.depositAmountFormula,
    "max(posterReservedRaw - positions(poster, token).liquid, 0)"
  );
  assert.deepEqual(funding.positionRead, {
    contract: "agentAccountCore",
    contractName: "AgentAccountCore",
    address: ACCOUNTS,
    abiFragment:
      "function positions(address account, address asset) view returns (uint256 liquid, uint256 reserved, uint256 strategyAllocated, uint256 collateralLocked, uint256 jobStakeLocked, uint256 debtOutstanding)",
    args: ["<poster EVM address>", TOKEN],
    resultField: "liquid"
  });
  assert.deepEqual(funding.writes[0], {
    contract: "token",
    address: TOKEN,
    abiFragment: "function approve(address spender, uint256 amount) returns (bool)",
    method: "approve",
    spender: "agentAccountCore",
    args: [ACCOUNTS, "<depositAmountRaw>"],
    skipWhen: "depositAmountRaw == 0"
  });
  assert.deepEqual(funding.writes[1], {
    contract: "agentAccountCore",
    contractName: "AgentAccountCore",
    address: ACCOUNTS,
    abiFragment: "function deposit(address asset, uint256 amount)",
    method: "deposit",
    asset: "token",
    args: [TOKEN, "<depositAmountRaw>"],
    skipWhen: "depositAmountRaw == 0"
  });
  const human = payload.verification.modes.find((mode) => mode.id === "human_fallback");
  assert.equal(human.reviewPath, "dispute_arbitration");
  assert.match(human.verdicts.dismissed, /^Approve:/u);
  assert.match(human.verdicts.upheld, /^Reject:/u);
  assert.deepEqual(payload.verification.templateRouting.fix_with_pull_request, {
    verifierMode: "github_pr",
    gate: "automated_live_github",
    disclosure:
      "Checks the public PR against the selected repository and issue, requires its Averray disclosure footer to match the actual claimant wallet or claim session, and re-derives live CI/check state and submitted test evidence. A readable missing or mismatched claimant binding is rejected; unreadable or ambiguous GitHub evidence escalates to human review and never auto-approves."
  });
  assert.deepEqual(payload.verification.templateRouting.audit_and_implementation_report, {
    verifierMode: "human_fallback",
    gate: "human_review",
    disclosure:
      "Open-ended audit reports require a human decision and are not auto-approved by the GitHub PR verifier."
  });
  const githubPr = payload.verification.modes.find((mode) => mode.id === "github_pr");
  assert.equal(githubPr.gate, "automated_live_github");
  assert.ok(githubPr.checks.includes("Averray disclosure footer identifies the actual claimant wallet or claim session"));
  assert.deepEqual(githubPr.claimantBinding, {
    required: true,
    acceptedIdentifiers: ["claimant_wallet", "claim_session_id"],
    footerFormat: {
      header: [
        "This contribution was prepared by an autonomous agent operating on the",
        "Averray platform."
      ],
      walletLine: "Agent identity: <claimant EVM wallet>",
      sessionLine: "Claim session:  <claim session id>",
      matchRule: "Include at least one claimant line; its value must exactly match the wallet or session returned by the claim."
    },
    readableMismatch: "rejected",
    unreadableBody: "human_fallback"
  });
  assert.equal(githubPr.failureMode, "human_fallback");
  assert.match(githubPr.failureBehavior, /never auto-approves/iu);
  assert.equal(payload.docs.workedExample, "https://github.com/averray-agent/agent/pull/874");
  assert.deepEqual(payload.liveReads, {
    asOf: "2026-08-01T08:00:00.000Z",
    protocolFeeBps: { status: "available" },
    feeRecipient: { status: "available" },
    claimBond: { status: "available" },
    disputeWindow: { status: "available" }
  });
});

test("poster onboarding derives observed funding error selectors from contract signatures", async () => {
  const [agentAccountSource, escrowSource, payload] = await Promise.all([
    readFile(new URL("../../../contracts/AgentAccountCore.sol", import.meta.url), "utf8"),
    readFile(new URL("../../../contracts/EscrowCore.sol", import.meta.url), "utf8"),
    makeService().getPosterOnboarding()
  ]);
  assert.match(agentAccountSource, /error InsufficientLiquidity\(\);/u);
  assert.match(escrowSource, /error InvalidState\(\);/u);
  assert.deepEqual(payload.failureModes, [
    {
      selector: id("InsufficientLiquidity()").slice(0, 10),
      signature: "InsufficientLiquidity()",
      meaning: "AgentAccountCore liquid is below fundingRequirement.posterReservedRaw.",
      response:
        "Deposit the difference between fundingRequirement.posterReservedRaw and positions(poster, token).liquid, then retry the unchanged funding calldata."
    },
    {
      selector: id("InvalidState()").slice(0, 10),
      signature: "InvalidState()",
      meaning: "This jobId already exists on chain.",
      response:
        "Do not deposit again—the escrow for this jobId is already funded. Read GET /jobs/draft/:id: status 'live' means the watcher has materialized it and there is nothing to do; status 'mismatch' means the existing on-chain job was funded with different terms and will never materialize, so the operator-mediated ~7-day cancellation rescue is the only recovery."
    }
  ]);
  assert.equal(payload.failureModes[0].selector, "0xbb55fd27");
  assert.equal(payload.failureModes[1].selector, "0xbaf3f0f7");
  assert.match(payload.failureModes[1].response, /status 'live'.*nothing to do/iu);
  assert.match(payload.failureModes[1].response, /status 'mismatch'.*never materialize.*~7-day cancellation rescue/iu);
});

test("poster withdrawal guidance distinguishes failed liquid funding from succeeded reserved funding", async () => {
  const payload = await makeService().getPosterOnboarding();

  assert.deepEqual(payload.posterFacts.withdrawal, {
    httpRouteAvailable: false,
    explanation:
      "Recovery depends on funding state. After funding fails, the deposit remains in AgentAccountCore liquid and the poster can withdraw it immediately on chain without an operator. After funding succeeds, the amount is reserved and AgentAccountCore.withdraw cannot release it; the operator-mediated cancellation rescue is the only recovery path.",
    whenFundingFailed: {
      positionState: "liquid",
      withdrawalAvailable: true,
      operatorRequired: false,
      action: "Withdraw the liquid amount directly from the poster wallet on chain."
    },
    whenFundingSucceeded: {
      positionState: "reserved",
      withdrawalAvailable: false,
      operatorRequired: true,
      action:
        "Do not call withdraw for reserved job funding; request the operator-mediated ~7-day cancellation rescue, which refunds only the recorded poster."
    },
    onChain: {
      available: true,
      contract: "AgentAccountCore",
      address: ACCOUNTS,
      abiFragment: "function withdraw(address asset, uint256 amount)",
      args: [TOKEN, "<amountRaw>"],
      value: "0",
      recipient: "msg.sender (the poster wallet)",
      requiresPosterGas: true
    }
  });
  assert.match(payload.posterFacts.withdrawal.explanation, /fails.*liquid.*immediately.*without an operator/iu);
  assert.match(payload.posterFacts.withdrawal.explanation, /succeeds.*reserved.*cannot release/iu);
});

test("poster funding instructions bind both directions of every watcher term", async () => {
  const payload = await makeService().getPosterOnboarding();
  const funding = payload.flow.find((step) => step.id === "fund");

  assert.match(funding.action, /byte-for-byte unchanged/u);
  assert.deepEqual(funding.exactTerms, {
    required: true,
    fields: [
      "specHash",
      "poster",
      "asset",
      "reward",
      "opsReserve",
      "contingencyReserve"
    ],
    mismatchResult: {
      status: "mismatch",
      permanent: true,
      recovery: "operator-mediated on request, ~7 days, refunds only ever to the recorded poster"
    },
    warning:
      "Any deviation in either direction permanently mismatches the quote. Raising the reward is not generosity: it strands the reserved funding identically to a deliberate mutation and requires the same operator-mediated ~7-day rescue."
  });
  assert.match(funding.exactTerms.warning, /Raising the reward is not generosity/iu);
});

test("worker onboarding documents self-deposit, mock fund limits, direct withdrawal, validation, and TTL truth", async () => {
  const payload = await makeService().getWorkerDoorOnboarding();

  assert.equal(payload.preflight.path, "/jobs/preflight?jobId=X");
  assert.equal(
    payload.selfDeposit.requiredClaimLockRawFormula,
    "parseUnits(preflight.totalClaimLock, token.decimals)"
  );
  assert.equal(
    payload.selfDeposit.depositAmountRawFormula,
    "max(requiredClaimLockRaw - positions(worker, token).liquid, 0)"
  );
  assert.deepEqual(payload.selfDeposit.positionRead, {
    contract: "AgentAccountCore",
    address: ACCOUNTS,
    abiFragment:
      "function positions(address account, address asset) view returns (uint256 liquid, uint256 reserved, uint256 strategyAllocated, uint256 collateralLocked, uint256 jobStakeLocked, uint256 debtOutstanding)",
    args: ["<worker EVM address>", TOKEN],
    resultField: "liquid"
  });
  assert.deepEqual(payload.selfDeposit.writes, [
    {
      contract: "token",
      address: TOKEN,
      abiFragment: "function approve(address spender, uint256 amount) returns (bool)",
      method: "approve",
      args: [ACCOUNTS, "<depositAmountRaw>"],
      skipWhen: "depositAmountRaw == 0"
    },
    {
      contract: "AgentAccountCore",
      address: ACCOUNTS,
      abiFragment: "function deposit(address asset, uint256 amount)",
      method: "deposit",
      args: [TOKEN, "<depositAmountRaw>"],
      skipWhen: "depositAmountRaw == 0"
    }
  ]);
  assert.equal(payload.accountFund.path, "/account/fund");
  assert.equal(payload.accountFund.generalWorkerFundingPath, false);
  assert.match(payload.accountFund.mainnetConstraint, /not auto-mintable/u);
  assert.deepEqual(payload.withdrawal.onChain, {
    available: true,
    contract: "AgentAccountCore",
    address: ACCOUNTS,
    abiFragment: "function withdraw(address asset, uint256 amount)",
    args: [TOKEN, "<amountRaw>"],
    value: "0",
    recipient: "msg.sender (the worker wallet)",
    requiresWorkerGas: true
  });
  assert.equal(payload.withdrawal.httpRouteAvailable, false);
  assert.equal(payload.submissionValidation.path, "/jobs/validate-submission");
  assert.equal(payload.submissionValidation.requiresAuth, false);
  assert.equal(payload.submissionValidation.when, "before_claim_or_submit");
  assert.equal(payload.claimTtl.source, "job_definition");
  assert.match(payload.claimTtl.policy, /do not infer task duration/u);
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
  assert.equal(
    externalBounties.disputeWindow.remedy.onChain.signature,
    "openDispute(bytes32 jobId)"
  );
  assert.equal(externalBounties.disputeWindow.remedy.onChain.address, ESCROW);
  assert.equal(externalBounties.disputeWindow.remedy.brokeredPath.available, false);
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
  assert.equal("feeRecipient" in payload.economics, false);
  assert.equal(payload.economics.availability.protocolFeeBps.status, "unavailable");
  assert.equal(payload.economics.availability.feeRecipient.status, "unavailable");
  assert.deepEqual(payload.workerFacts.claimBond.available, false);
  assert.deepEqual(payload.workerFacts.disputeWindow.available, false);
  assert.equal(payload.liveReads.claimBond.status, "unavailable");
  assert.equal(payload.liveReads.feeRecipient.status, "unavailable");

  const [external] = await service.enrichExternalCatalogRows([
    { id: "external-live-1", source: "external", rewardAmount: "1" }
  ]);
  assert.deepEqual(external.claimBond, {
    available: false,
    reason: "live_chain_read_failed",
    preflight: "/jobs/preflight?jobId=external-live-1"
  });
});

test("invalid treasury reads omit only the fee recipient and keep independent fee truth", async () => {
  const payload = await makeService({
    gatewayOverrides: {
      getProtocolFeeConfig: async () => ({
        supported: true,
        protocolFeeBps: 321,
        maxProtocolFeeBps: 999,
        treasuryAccount: "not-an-address"
      })
    }
  }).getPosterOnboarding();

  assert.equal(payload.economics.protocolFeeBps, 321);
  assert.equal("feeRecipient" in payload.economics, false);
  assert.deepEqual(payload.economics.availability.protocolFeeBps, { status: "available" });
  assert.deepEqual(payload.economics.availability.feeRecipient, {
    status: "unavailable",
    reason: "live_fee_recipient_invalid"
  });
});
