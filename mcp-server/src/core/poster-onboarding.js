import { getAddress, id, isAddress } from "ethers";

import {
  buildExternalPostingMoneyContext,
  EXTERNAL_POSTING_ACCOUNT_DEPOSIT_ABI,
  EXTERNAL_POSTING_ERC20_APPROVE_ABI
} from "./external-posting-service.js";
import { decimalToBaseUnits } from "./platform-service-helpers.js";

const POSTER_ONBOARDING_CACHE_MS = 30_000;
const BPS_DENOMINATOR = 10_000n;
const GUIDE_URL = "https://github.com/averray-agent/agent/blob/main/docs/POSTER_GUIDE.md";
const DOGFOOD_EVIDENCE_URL = "https://github.com/averray-agent/agent/pull/874";
const AGENT_ACCOUNT_WITHDRAW_ABI = "function withdraw(address asset, uint256 amount)";
const AGENT_ACCOUNT_POSITIONS_ABI =
  "function positions(address account, address asset) view returns (uint256 liquid, uint256 reserved, uint256 strategyAllocated, uint256 collateralLocked, uint256 jobStakeLocked, uint256 debtOutstanding)";
const OPEN_DISPUTE_ABI = "function openDispute(bytes32 jobId)";
const OPEN_DISPUTE_SIGNATURE = "openDispute(bytes32 jobId)";
const INSUFFICIENT_LIQUIDITY_ERROR_SIGNATURE = "InsufficientLiquidity()";
const INVALID_STATE_ERROR_SIGNATURE = "InvalidState()";

export function createPosterOnboardingService({
  authConfig,
  externalPostingService,
  gateway,
  verifierService,
  publicBaseUrl = "https://api.averray.com",
  now = () => new Date(),
  cacheMs = POSTER_ONBOARDING_CACHE_MS
} = {}) {
  let cached;
  let refreshPromise;
  const normalizedBaseUrl = String(publicBaseUrl ?? "").trim().replace(/\/+$/u, "");

  async function getSnapshot() {
    const nowMs = now().getTime();
    if (cached && cached.expiresAtMs > nowMs) {
      return cached.value;
    }
    if (refreshPromise) {
      return refreshPromise;
    }

    refreshPromise = buildSnapshot({
      authConfig,
      externalPostingService,
      gateway,
      verifierService,
      publicBaseUrl: normalizedBaseUrl,
      now
    })
      .then((value) => {
        cached = {
          expiresAtMs: nowMs + Math.max(0, Number(cacheMs) || 0),
          value
        };
        return value;
      })
      .finally(() => {
        refreshPromise = undefined;
      });

    return refreshPromise;
  }

  return {
    async getPosterOnboarding() {
      return getSnapshot();
    },

    async getExternalBountiesOnboarding() {
      return externalBountiesFromSnapshot(await getSnapshot());
    },

    async getWorkerDoorOnboarding() {
      return workerDoorFromSnapshot(await getSnapshot());
    },

    async enrichExternalCatalogRows(jobs = []) {
      const snapshot = await getSnapshot();
      return jobs.map((job) => isExternalJob(job)
        ? {
            ...job,
            claimBond: buildClaimBond(job, snapshot)
          }
        : job);
    }
  };
}

async function buildSnapshot({
  authConfig,
  externalPostingService,
  gateway,
  verifierService,
  publicBaseUrl,
  now
}) {
  const config = externalPostingService?.config ?? {};
  const chainId = normalizeChainId(authConfig?.chainId);
  const moneyContext = config.usdcAsset
    ? buildExternalPostingMoneyContext({ chainId, asset: config.usdcAsset })
    : undefined;
  const token = moneyContext?.asset;
  const asOf = now().toISOString();
  const chainEnabled = Boolean(gateway?.isEnabled?.());
  const unavailableReason = chainEnabled ? "live_chain_read_failed" : "blockchain_gateway_disabled";
  const [protocolFeeRead, claimBondRead, disputeWindowRead] = await Promise.all([
    readLiveFact(
      () => gateway?.getProtocolFeeConfig?.(),
      unavailableReason
    ),
    readLiveFact(
      async () => {
        const [stakeBps, economics] = await Promise.all([
          gateway?.getDefaultClaimStakeBps?.(),
          gateway?.getClaimEconomicsConfig?.({ requireBondInputs: true })
        ]);
        const minFeeRaw = economics?.minClaimFeeRawByAsset?.[token?.symbol];
        if (!isNonNegativeInteger(stakeBps)
          || !isNonNegativeInteger(economics?.claimFeeBps)
          || !isRawAmount(minFeeRaw)) {
          throw new Error("live claim-bond policy inputs are incomplete");
        }
        return {
          stakeBps: Number(stakeBps),
          feeBps: Number(economics.claimFeeBps),
          minFeeRaw: String(minFeeRaw)
        };
      },
      unavailableReason
    ),
    readLiveFact(
      () => gateway?.getDisputeWindowSeconds?.(),
      unavailableReason
    )
  ]);
  const feeRecipientRead = projectFeeRecipientRead(protocolFeeRead);

  if (protocolFeeRead.available) {
    if (protocolFeeRead.value?.supported !== true) {
      protocolFeeRead.available = false;
      protocolFeeRead.reason = "protocol_fee_read_not_supported";
      delete protocolFeeRead.value;
    } else if (!isNonNegativeInteger(protocolFeeRead.value.protocolFeeBps)
      || !isRawAmount(protocolFeeRead.value.posterFeeFloorRaw)) {
      protocolFeeRead.available = false;
      protocolFeeRead.reason = "live_protocol_fee_invalid";
      delete protocolFeeRead.value;
    }
  }
  if (disputeWindowRead.available && !isPositiveInteger(disputeWindowRead.value)) {
    disputeWindowRead.available = false;
    disputeWindowRead.reason = "live_dispute_window_invalid";
    delete disputeWindowRead.value;
  }

  const liveReads = {
    asOf,
    protocolFeeBps: liveReadStatus(protocolFeeRead),
    feeRecipient: liveReadStatus(feeRecipientRead),
    claimBond: liveReadStatus(claimBondRead),
    disputeWindow: liveReadStatus(disputeWindowRead)
  };
  const verificationModes = verifierService?.listHandlers?.() ?? [];
  const mode = config.mode ?? "closed";
  const v3Active = protocolFeeRead.value?.gasRetentionSupported === true;
  const workerFacts = buildWorkerFacts({
    claimBondRead,
    disputeWindowRead,
    token,
    escrowCore: config.escrowCoreAddress,
    agentAccountCore: gateway?.config?.agentAccountAddress,
    publicBaseUrl
  });
  const posterFacts = buildPosterFacts({
    token,
    agentAccountCore: gateway?.config?.agentAccountAddress,
    v3Active
  });

  return {
    version: "poster-onboarding-v1",
    chainId,
    ...(moneyContext ? { chain: moneyContext.chain } : {}),
    escrowCore: config.escrowCoreAddress,
    agentAccountCore: gateway?.config?.agentAccountAddress,
    token,
    mode,
    minimumRewardUsdc: config.minRewardUsdc,
    ...(mode === "open" ? {} : { allowlistEnrollment: enrollmentText(mode) }),
    economics: {
      ...(protocolFeeRead.available
        ? {
            protocolFeeBps: Number(protocolFeeRead.value.protocolFeeBps),
            posterFeeBps: Number(protocolFeeRead.value.protocolFeeBps),
            posterFeeFloorRaw: String(protocolFeeRead.value.posterFeeFloorRaw)
          }
        : {}),
      ...(feeRecipientRead.available
        ? { feeRecipient: feeRecipientRead.value }
        : {}),
      feeSemantics: "poster_additive",
      feeExplanation:
        "The poster reserves the full worker reward plus max(posterFeeBps, posterFeeFloorRaw); worker gas retention is separate and applies only to brokered successful work.",
      posterReserveFormula:
        "reward + opsReserve + contingencyReserve + max(floor(reward * posterFeeBps / 10000), posterFeeFloorRaw)",
      minRewardUsdc: config.minRewardUsdc,
      draftTtlHours: config.draftTtlHours,
      quotePersistence: "demand_signal_only_until_funded",
      quoteIdentity: "poster_and_content_hash",
      availability: {
        protocolFeeBps: liveReads.protocolFeeBps,
        feeRecipient: liveReads.feeRecipient
      }
    },
    flow: buildPostingFlow({
      publicBaseUrl,
      token,
      agentAccountCore: gateway?.config?.agentAccountAddress,
      escrowCore: config.escrowCoreAddress,
      v3Active
    }),
    verification: buildVerification(verificationModes),
    failureModes: buildFailureModes(v3Active),
    posterFacts,
    workerFacts,
    cancellation: buildCancellation(
      v3Active,
      config.escrowCoreAddress
    ),
    docs: {
      guide: GUIDE_URL,
      workedExample: DOGFOOD_EVIDENCE_URL
    },
    liveReads
  };
}

function buildPostingFlow({ publicBaseUrl, token, agentAccountCore, escrowCore, v3Active = false }) {
  return [
    {
      id: "siwe",
      action: "Authenticate the poster wallet with SIWE.",
      requests: [
        { method: "POST", path: "/auth/nonce", body: { wallet: "<poster EVM address>" } },
        {
          action: "Sign the returned EIP-4361 message with personal_sign; never send the private key.",
          method: "wallet.personal_sign"
        },
        {
          method: "POST",
          path: "/auth/verify",
          body: { message: "<exact nonce response message>", signature: "<wallet signature>" },
          returns: ["token", "wallet", "expiresAt"]
        }
      ]
    },
    {
      id: "draft",
      action: "Request a deterministic escrow funding quote with the SIWE bearer token. No draft or claimable job persists before finalized funding; only the demand attempt is recorded.",
      method: "POST",
      path: "/jobs/draft",
      authorization: "Bearer <token>",
      body: {
        definition: {
          title: "Audit and report on <repository task>",
          description: "<task and acceptance criteria>",
          category: "coding",
          tier: "starter",
          jobType: "work",
          requiredRole: "worker",
          rewardAmount: "<USDC amount at or above minimumRewardUsdc>",
          rewardAsset: "USDC",
          verifierMode: "<one verification.modes[].id>",
          escalationMessage: "<human_fallback maintainer review instruction>",
          acceptanceCriteria: ["<objective acceptance criterion>"],
          inputSchemaRef: "schema://jobs/coding-input",
          outputSchemaRef: "schema://jobs/coding-output",
          input: {
            task: "<work request>",
            acceptanceCriteria: ["<objective acceptance criterion>"],
            repo: "<owner/repository>"
          }
        }
      },
      returns: [
        "draftId",
        "jobId",
        "specHash",
        "calldata",
        "escrowAddress",
        "fundingRequirement.posterReservedRaw",
        "fundingRequirement.workerReceivesRaw",
        "fundingRequirement.protocolFeeRaw",
        "expiresAt",
        "status=quoted",
        "persisted=false"
      ]
    },
    {
      id: "fund",
      action:
        "Fund from the poster wallet: approve the token to AgentAccountCore, deposit enough AAC liquid, then submit the returned non-waived createSinglePayoutJob calldata byte-for-byte unchanged.",
      exactTerms: {
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
          recovery: v3Active
            ? "the recorded poster calls cancelOpenJob after the 1h floor for an instant refund"
            : "operator-mediated on request, ~7 days, refunds only ever to the recorded poster"
        },
        warning: v3Active
          ? "Any deviation in either direction permanently mismatches the quote. Raising the reward is not generosity: it strands the reserved funding identically to a deliberate mutation; the recorded poster must cancel the Open job after the 1h floor."
          : "Any deviation in either direction permanently mismatches the quote. Raising the reward is not generosity: it strands the reserved funding identically to a deliberate mutation and requires the same operator-mediated ~7-day rescue."
      },
      exactPosterReservedRaw: "the quote response fundingRequirement.posterReservedRaw",
      posterReservedRawFormula:
        "rewardRaw + opsReserveRaw + contingencyReserveRaw + max(floor(rewardRaw * economics.posterFeeBps / 10000), economics.posterFeeFloorRaw)",
      depositAmountFormula:
        "max(posterReservedRaw - positions(poster, token).liquid, 0)",
      positionRead: {
        contract: "agentAccountCore",
        contractName: "AgentAccountCore",
        ...(agentAccountCore ? { address: agentAccountCore } : {}),
        abiFragment: AGENT_ACCOUNT_POSITIONS_ABI,
        args: ["<poster EVM address>", token?.address ?? "<token address>"],
        resultField: "liquid"
      },
      writes: [
        {
          contract: "token",
          ...(token?.address ? { address: token.address } : {}),
          abiFragment: EXTERNAL_POSTING_ERC20_APPROVE_ABI,
          method: "approve",
          spender: "agentAccountCore",
          args: [agentAccountCore ?? "<AgentAccountCore address>", "<depositAmountRaw>"],
          skipWhen: "depositAmountRaw == 0"
        },
        {
          contract: "agentAccountCore",
          contractName: "AgentAccountCore",
          ...(agentAccountCore ? { address: agentAccountCore } : {}),
          abiFragment: EXTERNAL_POSTING_ACCOUNT_DEPOSIT_ABI,
          method: "deposit",
          asset: "token",
          args: [token?.address ?? "<token address>", "<depositAmountRaw>"],
          skipWhen: "depositAmountRaw == 0"
        },
        {
          contract: "escrowCore",
          ...(escrowCore ? { address: escrowCore } : {}),
          method: "createSinglePayoutJob",
          calldataSource: "the draft response calldata",
          value: "0",
          protocolFeeWaived: false,
          invariant: "The calldata specHash must equal the draft specHash."
        }
      ]
    },
    {
      id: "watch",
      action: "Poll the quote until the finalized-event watcher matches jobId, poster, funding terms, and specHash, then materializes both the draft record and live catalog job.",
      method: "GET",
      path: "/jobs/draft/:id",
      authorization: "Bearer <token>",
      terminalStatus: "live",
      liveCatalogResult: {
        path: "/jobs?source=external",
        source: "external"
      }
    },
    {
      id: "delist",
      action: "Operator safety backstop: remove the catalog projection without touching on-chain escrow.",
      method: "POST",
      path: "/admin/jobs/external/:jobId/delist",
      authorization: "admin SIWE bearer token",
      note: "This is operator-only; posters cannot use it as a refund or cancellation route."
    },
    {
      id: "schema-discovery",
      action: "Resolve the built-in schema references before creating a draft.",
      paths: [
        `${publicBaseUrl || ""}/schemas/jobs`,
        `${publicBaseUrl || ""}/schemas/jobs/:name.json`
      ]
    }
  ];
}

function buildVerification(modes) {
  const normalized = [...new Set(modes.map((mode) => String(mode).trim()).filter(Boolean))];
  return {
    templateRouting: {
      fix_with_pull_request: {
        verifierMode: "github_pr",
        gate: "automated_live_github",
        disclosure:
          "Checks the public PR against the selected repository and issue, requires its Averray disclosure footer to match the actual claimant wallet or claim session, and re-derives live CI/check state and submitted test evidence. A readable missing or mismatched claimant binding is rejected; unreadable or ambiguous GitHub evidence escalates to human review and never auto-approves."
      },
      audit_and_implementation_report: {
        verifierMode: "human_fallback",
        gate: "human_review",
        disclosure:
          "Open-ended audit reports require a human decision and are not auto-approved by the GitHub PR verifier."
      }
    },
    modes: normalized.map((id) => {
      if (id === "human_fallback") {
        return {
          id,
          gate: "human_review",
          reviewPath: "dispute_arbitration",
          expectedVerifierOutcome: {
            outcome: "disputed",
            reasonCode: "HUMAN_REVIEW_REQUIRED"
          },
          verdicts: {
            dismissed: "Approve: dismiss the rejection and pay the worker the approved payout.",
            upheld: "Reject: uphold the rejection and slash the worker bond.",
            split: "Resolve with a partial worker payout chosen by the arbitrator."
          }
        };
      }
      if (id === "github_pr") {
        return {
          id,
          gate: "automated_live_github",
          checks: [
            "public pull request exists",
            "pull request repository matches the job issue repository",
            "pull request references the selected issue",
            "Averray disclosure footer identifies the actual claimant wallet or claim session",
            "live merge and CI/check state",
            "submitted test evidence"
          ],
          claimantBinding: {
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
          },
          success: "Automatically approves only when the live GitHub evidence reaches the configured score without required blockers.",
          failureMode: "human_fallback",
          failureBehavior:
            "GitHub unreachable, rate-limited, private, partially unreadable, or an ambiguous score enters human review and never auto-approves."
        };
      }
      return { id };
    })
  };
}

function buildFailureModes(v3Active = false) {
  return [
    {
      selector: errorSelector(INSUFFICIENT_LIQUIDITY_ERROR_SIGNATURE),
      signature: INSUFFICIENT_LIQUIDITY_ERROR_SIGNATURE,
      meaning: "AgentAccountCore liquid is below fundingRequirement.posterReservedRaw.",
      response:
        "Deposit the difference between fundingRequirement.posterReservedRaw and positions(poster, token).liquid, then retry the unchanged funding calldata."
    },
    {
      selector: errorSelector(INVALID_STATE_ERROR_SIGNATURE),
      signature: INVALID_STATE_ERROR_SIGNATURE,
      meaning: "This jobId already exists on chain.",
      response: v3Active
        ? "Do not deposit again—the escrow for this jobId is already funded. Read GET /jobs/draft/:id: status 'live' means the watcher has materialized it and there is nothing to do; status 'mismatch' means the existing on-chain job was funded with different terms and will never materialize, so the recorded poster must call cancelOpenJob after the 1h floor for an instant refund."
        : "Do not deposit again—the escrow for this jobId is already funded. Read GET /jobs/draft/:id: status 'live' means the watcher has materialized it and there is nothing to do; status 'mismatch' means the existing on-chain job was funded with different terms and will never materialize, so the operator-mediated ~7-day cancellation rescue is the only recovery."
    }
  ];
}

function buildPosterFacts({ token, agentAccountCore, v3Active = false }) {
  const tokenAddress = token?.address ?? "<token address>";
  return {
    withdrawal: {
      httpRouteAvailable: false,
      explanation: v3Active
        ? "Recovery depends on funding state. After funding fails, the deposit remains in AgentAccountCore liquid and the poster can withdraw it immediately. After funding succeeds, AgentAccountCore.withdraw cannot release reserved funds; the recorded poster can cancel an Open job after 1h for an instant refund."
        : "Recovery depends on funding state. After funding fails, the deposit remains in AgentAccountCore liquid and the poster can withdraw it immediately on chain without an operator. After funding succeeds, the amount is reserved and AgentAccountCore.withdraw cannot release it; the operator-mediated cancellation rescue is the only recovery path.",
      whenFundingFailed: {
        positionState: "liquid",
        withdrawalAvailable: true,
        operatorRequired: false,
        action: "Withdraw the liquid amount directly from the poster wallet on chain."
      },
      whenFundingSucceeded: {
        positionState: "reserved",
        withdrawalAvailable: false,
        operatorRequired: !v3Active,
        ...(v3Active ? { cancellationAvailable: true } : {}),
        action: v3Active
          ? "Do not call withdraw for reserved job funding; the recorded poster calls cancelOpenJob after the 1h floor for an instant refund."
          : "Do not call withdraw for reserved job funding; request the operator-mediated ~7-day cancellation rescue, which refunds only the recorded poster."
      },
      onChain: {
        available: Boolean(agentAccountCore && token?.address),
        contract: "AgentAccountCore",
        ...(agentAccountCore ? { address: agentAccountCore } : {}),
        abiFragment: AGENT_ACCOUNT_WITHDRAW_ABI,
        args: [tokenAddress, "<amountRaw>"],
        value: "0",
        recipient: "msg.sender (the poster wallet)",
        requiresPosterGas: true
      }
    }
  };
}

function buildWorkerFacts({
  claimBondRead,
  disputeWindowRead,
  token,
  escrowCore,
  agentAccountCore,
  publicBaseUrl
}) {
  const remedy = buildWorkerDisputeRemedy(escrowCore);
  const disputeWindow = disputeWindowRead.available
    ? {
        available: true,
        seconds: Number(disputeWindowRead.value),
        duration: formatDuration(Number(disputeWindowRead.value)),
        warning:
          "For a rejected human-review submission, the worker must open a dispute before this live on-chain window ends or the rejection can be finalized and the bond slashed.",
        remedy
      }
    : {
        available: false,
        reason: disputeWindowRead.reason,
        remedy
      };
  const claimBond = claimBondRead.available
    ? {
        available: true,
        asset: token?.symbol,
        stakeBps: claimBondRead.value.stakeBps,
        feeBps: claimBondRead.value.feeBps,
        minFeeRaw: claimBondRead.value.minFeeRaw,
        semantics:
          "Stake plus claim fee is locked from the worker's AgentAccountCore liquid balance at claim, returned in full on successful resolution, and forfeitable on slash."
      }
    : {
        available: false,
        reason: claimBondRead.reason
      };
  const tokenAddress = token?.address ?? "<token address>";
  const accountAddress = agentAccountCore ?? "<AgentAccountCore address>";
  const positionRead = {
    contract: "AgentAccountCore",
    ...(agentAccountCore ? { address: agentAccountCore } : {}),
    abiFragment: AGENT_ACCOUNT_POSITIONS_ABI,
    args: ["<worker EVM address>", tokenAddress],
    resultField: "liquid"
  };

  return {
    claimBond,
    gasPolicy: {
      operatorBrokeredGas: false,
      appliesTo: "all externally posted jobs",
      workerPays: ["claimJob", "submitWork"],
      apiBehavior:
        "The claim and submit endpoints validate first, then return an exact direct-wallet transaction recipe. After the worker broadcasts it, retry the same request to converge the durable session.",
      curatedException:
        "Operator-brokered gas remains available only to explicitly sponsored curated starter inventory; poster volume never spends that subsidy."
    },
    catalogEstimate:
      "External catalog claimBond is a live policy estimate; wallet-specific eligibility and shortfall come only from preflight.",
    preflight: {
      method: "GET",
      path: "/jobs/preflight?jobId=X",
      url: `${publicBaseUrl || ""}/jobs/preflight?jobId=X`,
      authorization: "worker SIWE bearer token"
    },
    selfDeposit: {
      requiredWhenLiquidIsShort: true,
      routeAvailable: false,
      explanation:
        "AgentAccountCore has no depositFor path: the worker must approve the token and self-deposit into AgentAccountCore, paying that deposit transaction's gas. A brokered claim does not broker the deposit.",
      requiredClaimLockRawFormula: "parseUnits(preflight.totalClaimLock, token.decimals)",
      depositAmountRawFormula:
        "max(requiredClaimLockRaw - positions(worker, token).liquid, 0)",
      positionRead,
      writes: [
        {
          contract: "token",
          ...(token?.address ? { address: token.address } : {}),
          abiFragment: EXTERNAL_POSTING_ERC20_APPROVE_ABI,
          method: "approve",
          args: [accountAddress, "<depositAmountRaw>"],
          skipWhen: "depositAmountRaw == 0"
        },
        {
          contract: "AgentAccountCore",
          ...(agentAccountCore ? { address: agentAccountCore } : {}),
          abiFragment: EXTERNAL_POSTING_ACCOUNT_DEPOSIT_ABI,
          method: "deposit",
          args: [tokenAddress, "<depositAmountRaw>"],
          skipWhen: "depositAmountRaw == 0"
        }
      ]
    },
    accountFund: {
      method: "POST",
      path: "/account/fund",
      generalWorkerFundingPath: false,
      purpose:
        "Development/test convenience only: in chain mode it is restricted to the configured backend signer and auto-mintable mock assets.",
      mainnetConstraint:
        "Mainnet USDC is not auto-mintable, so workers must use the self-deposit transactions above. Route capability does not imply that an arbitrary wallet or asset can be funded."
    },
    withdrawal: {
      httpRouteAvailable: false,
      explanation:
        "Withdraw directly from the worker wallet on-chain. Only liquid AAC balance is withdrawable; reserved reward funding, collateral, strategy allocations, job stake, and debt constraints remain enforced by AgentAccountCore.",
      onChain: {
        available: Boolean(agentAccountCore && token?.address),
        contract: "AgentAccountCore",
        ...(agentAccountCore ? { address: agentAccountCore } : {}),
        abiFragment: AGENT_ACCOUNT_WITHDRAW_ABI,
        args: [tokenAddress, "<amountRaw>"],
        value: "0",
        recipient: "msg.sender (the worker wallet)",
        requiresWorkerGas: true
      }
    },
    submissionValidation: {
      when: "before_claim_or_submit",
      method: "POST",
      path: "/jobs/validate-submission",
      requiresAuth: false,
      body: { jobId: "<jobId>", submission: "<candidate schema object>" },
      effect: "Read-only schema validation; it neither claims the job nor stores the submission."
    },
    claimTtl: {
      source: "job_definition",
      inspect: "GET /jobs/definition?jobId=X -> claimTtlSeconds",
      policy:
        "Curated ingestion owns a source-specific TTL; external posters may request a longer TTL. Tier/category do not infer task duration because task complexity is not reliably derivable from those labels."
    },
    disputeWindow
  };
}

function errorSelector(signature) {
  return id(signature).slice(0, 10);
}

function buildWorkerDisputeRemedy(escrowCore) {
  return {
    action: "Open the dispute from the recorded worker wallet before the dispute window ends.",
    onChain: escrowCore
      ? {
          available: true,
          contract: "EscrowCore",
          address: escrowCore,
          abiFragment: OPEN_DISPUTE_ABI,
          signature: OPEN_DISPUTE_SIGNATURE,
          args: ["<jobId>"],
          value: "0"
        }
      : {
          available: false,
          reason: "escrow_core_unavailable",
          abiFragment: OPEN_DISPUTE_ABI,
          signature: OPEN_DISPUTE_SIGNATURE
        },
    brokeredPath: {
      available: false,
      reason: "no_worker_reachable_brokered_open_dispute_route"
    }
  };
}

function externalBountiesFromSnapshot(snapshot) {
  const humanFallback = snapshot.verification.modes.find((mode) => mode.id === "human_fallback");
  return {
    mode: snapshot.mode,
    posterOnboarding: "/poster/onboarding",
    claimBond: snapshot.workerFacts.claimBond,
    bondSemantics: snapshot.workerFacts.claimBond.semantics
      ?? "Live claim-bond inputs are unavailable; do not assume a zero bond.",
    catalogEstimate: snapshot.workerFacts.catalogEstimate,
    preflight: snapshot.workerFacts.preflight,
    gasPolicy: snapshot.workerFacts.gasPolicy,
    selfDeposit: snapshot.workerFacts.selfDeposit,
    disputeWindow: snapshot.workerFacts.disputeWindow,
    cancellation: snapshot.cancellation,
    humanFallback: humanFallback ?? {
      id: "human_fallback",
      available: false,
      reason: "verifier_mode_not_configured"
    },
    liveReads: {
      claimBond: snapshot.liveReads.claimBond,
      disputeWindow: snapshot.liveReads.disputeWindow
    }
  };
}

function workerDoorFromSnapshot(snapshot) {
  return {
    claimBond: snapshot.workerFacts.claimBond,
    preflight: snapshot.workerFacts.preflight,
    selfDeposit: snapshot.workerFacts.selfDeposit,
    accountFund: snapshot.workerFacts.accountFund,
    withdrawal: snapshot.workerFacts.withdrawal,
    submissionValidation: snapshot.workerFacts.submissionValidation,
    claimTtl: snapshot.workerFacts.claimTtl,
    disputeWindow: snapshot.workerFacts.disputeWindow,
    liveReads: {
      claimBond: snapshot.liveReads.claimBond,
      disputeWindow: snapshot.liveReads.disputeWindow
    }
  };
}

function buildCancellation(v3Active = false, escrowCore = undefined) {
  if (v3Active) {
    return {
      selfServeCancel: true,
      method: "cancelOpenJob(bytes32)",
      onChain: {
        address: escrowCore,
        abiFragment: "function cancelOpenJob(bytes32 jobId)",
        args: ["<jobId>"],
        value: "0"
      },
      scope: "any Open job",
      minimumOpenSeconds: 3_600,
      refund: "instant refund of unreleased reward, poster fee, ops reserve, and contingency reserve to the recorded poster",
      race: "a claim that lands first blocks cancellation until the existing timeout lifecycle reopens the job",
      fallback: "operator tombstone rescue remains available for non-Open strandings and legacy stock"
    };
  }
  return {
    selfServeCancel: false,
    rescue: "operator-mediated on request, ~7 days, refunds only ever to the recorded poster",
    plannedSelfServeCancel: "cancelOpenJob, next EscrowCore deployment window"
  };
}

function buildClaimBond(job, snapshot) {
  const facts = snapshot.workerFacts.claimBond;
  if (facts.available !== true) {
    return {
      available: false,
      reason: facts.reason ?? "live_claim_bond_unavailable",
      preflight: `/jobs/preflight?jobId=${encodeURIComponent(job?.id ?? "")}`
    };
  }

  try {
    const rewardRaw = decimalToBaseUnits(
      job?.rewardAmount,
      snapshot.token?.decimals,
      "external job reward"
    );
    const stakeRaw = applyBpsFloor(rewardRaw, facts.stakeBps);
    const percentageFeeRaw = applyBpsFloor(rewardRaw, facts.feeBps);
    const minimumFeeRaw = BigInt(facts.minFeeRaw);
    const feeRaw = percentageFeeRaw > minimumFeeRaw ? percentageFeeRaw : minimumFeeRaw;
    return {
      available: true,
      asset: snapshot.token?.symbol,
      stakeRaw: stakeRaw.toString(),
      stakeBps: facts.stakeBps,
      feeRaw: feeRaw.toString(),
      feeBps: facts.feeBps,
      totalRaw: (stakeRaw + feeRaw).toString(),
      source: "live_policy_estimate",
      perWalletTruth: `/jobs/preflight?jobId=${encodeURIComponent(job?.id ?? "")}`
    };
  } catch (error) {
    return {
      available: false,
      reason: "external_reward_unreadable",
      detail: error?.message,
      preflight: `/jobs/preflight?jobId=${encodeURIComponent(job?.id ?? "")}`
    };
  }
}

async function readLiveFact(read, fallbackReason) {
  try {
    if (typeof read !== "function") {
      return { available: false, reason: fallbackReason };
    }
    const value = await read();
    if (value === undefined || value === null) {
      return { available: false, reason: fallbackReason };
    }
    return { available: true, value };
  } catch (error) {
    return {
      available: false,
      reason: fallbackReason,
      error: error?.code ?? error?.message ?? "read_failed"
    };
  }
}

function projectFeeRecipientRead(protocolFeeRead) {
  if (!protocolFeeRead.available) {
    return { ...protocolFeeRead };
  }
  if (protocolFeeRead.value?.supported !== true) {
    return {
      available: false,
      reason: "protocol_fee_read_not_supported"
    };
  }
  const treasuryAccount = protocolFeeRead.value?.treasuryAccount;
  if (typeof treasuryAccount !== "string" || !isAddress(treasuryAccount)) {
    return {
      available: false,
      reason: "live_fee_recipient_invalid"
    };
  }
  return {
    available: true,
    value: getAddress(treasuryAccount)
  };
}

function liveReadStatus(read) {
  return read.available
    ? { status: "available" }
    : {
        status: "unavailable",
        reason: read.reason,
        ...(read.error ? { error: read.error } : {})
      };
}

function enrollmentText(mode) {
  return mode === "allowlist"
    ? "Posting requires operator enrollment in the live allowlist; contact the Averray operator before creating a draft."
    : "External posting is currently closed; contact the Averray operator for enrollment and opening plans.";
}

function formatDuration(seconds) {
  const value = Number(seconds);
  if (value > 0 && value % 86_400 === 0) {
    const days = value / 86_400;
    return `${days} day${days === 1 ? "" : "s"}`;
  }
  if (value > 0 && value % 3_600 === 0) {
    const hours = value / 3_600;
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return `${value} seconds`;
}

function applyBpsFloor(raw, bps) {
  return (raw * BigInt(bps)) / BPS_DENOMINATOR;
}

function isExternalJob(job) {
  return job?.source === "external" || job?.source?.type === "external";
}

function isNonNegativeInteger(value) {
  return Number.isInteger(Number(value)) && Number(value) >= 0;
}

function isPositiveInteger(value) {
  return Number.isInteger(Number(value)) && Number(value) > 0;
}

function isRawAmount(value) {
  return /^\d+$/u.test(String(value ?? ""));
}

function normalizeChainId(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : value;
}
