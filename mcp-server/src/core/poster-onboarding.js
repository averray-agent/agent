import { decimalToBaseUnits } from "./platform-service-helpers.js";

const POSTER_ONBOARDING_CACHE_MS = 30_000;
const BPS_DENOMINATOR = 10_000n;
const GUIDE_URL = "https://github.com/averray-agent/agent/blob/main/docs/POSTER_GUIDE.md";
const DOGFOOD_EVIDENCE_URL = "https://github.com/averray-agent/agent/pull/874";

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
  const token = config.usdcAsset
    ? {
        symbol: config.usdcAsset.symbol,
        address: config.usdcAsset.address,
        decimals: config.usdcAsset.decimals
      }
    : undefined;
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

  if (protocolFeeRead.available) {
    if (protocolFeeRead.value?.supported !== true) {
      protocolFeeRead.available = false;
      protocolFeeRead.reason = "protocol_fee_read_not_supported";
      delete protocolFeeRead.value;
    } else if (!isNonNegativeInteger(protocolFeeRead.value.protocolFeeBps)) {
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
    claimBond: liveReadStatus(claimBondRead),
    disputeWindow: liveReadStatus(disputeWindowRead)
  };
  const verificationModes = verifierService?.listHandlers?.() ?? [];
  const mode = config.mode ?? "closed";
  const workerFacts = buildWorkerFacts({
    claimBondRead,
    disputeWindowRead,
    token,
    publicBaseUrl
  });

  return {
    version: "poster-onboarding-v1",
    chainId: normalizeChainId(authConfig?.chainId),
    escrowCore: config.escrowCoreAddress,
    agentAccountCore: gateway?.config?.agentAccountAddress,
    token,
    mode,
    ...(mode === "open" ? {} : { allowlistEnrollment: enrollmentText(mode) }),
    economics: {
      ...(protocolFeeRead.available
        ? { protocolFeeBps: Number(protocolFeeRead.value.protocolFeeBps) }
        : {}),
      feeSemantics: "poster_additive",
      feeExplanation:
        "The poster reserves the full worker reward plus the protocol fee; the worker receives the full advertised reward.",
      posterReserveFormula:
        "reward + opsReserve + contingencyReserve + floor(reward * protocolFeeBps / 10000)",
      minRewardUsdc: config.minRewardUsdc,
      draftTtlHours: config.draftTtlHours,
      maxOpenDrafts: config.maxOpenDrafts,
      availability: {
        protocolFeeBps: liveReads.protocolFeeBps
      }
    },
    flow: buildPostingFlow({ publicBaseUrl }),
    verification: buildVerification(verificationModes),
    workerFacts,
    docs: {
      guide: GUIDE_URL,
      workedExample: DOGFOOD_EVIDENCE_URL
    },
    liveReads
  };
}

function buildPostingFlow({ publicBaseUrl }) {
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
      action: "Create a deterministic external-job draft with the SIWE bearer token.",
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
          rewardAmount: "<USDC amount at or above economics.minRewardUsdc>",
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
      returns: ["draftId", "jobId", "specHash", "calldata", "expiresAt", "status"]
    },
    {
      id: "fund",
      action:
        "Fund from the poster wallet: approve the token to AgentAccountCore, deposit enough AAC liquid, then submit the returned non-waived createSinglePayoutJob calldata unchanged.",
      writes: [
        { contract: "token", method: "approve", spender: "agentAccountCore" },
        { contract: "agentAccountCore", method: "deposit", asset: "token" },
        {
          contract: "escrowCore",
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
      action: "Poll the authenticated draft until the finalized-event watcher matches jobId, poster, funding terms, and specHash.",
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
    modes: normalized.map((id) => id === "human_fallback"
      ? {
          id,
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
        }
      : { id })
  };
}

function buildWorkerFacts({ claimBondRead, disputeWindowRead, token, publicBaseUrl }) {
  const disputeWindow = disputeWindowRead.available
    ? {
        available: true,
        seconds: Number(disputeWindowRead.value),
        duration: formatDuration(Number(disputeWindowRead.value)),
        warning:
          "For a rejected human-review submission, the worker must open a dispute before this live on-chain window ends or the rejection can be finalized and the bond slashed."
      }
    : {
        available: false,
        reason: disputeWindowRead.reason
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

  return {
    claimBond,
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
        "AgentAccountCore has no depositFor path: the worker must approve the token and self-deposit into AgentAccountCore, paying that deposit transaction's gas. A brokered claim does not broker the deposit."
    },
    disputeWindow
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
    selfDeposit: snapshot.workerFacts.selfDeposit,
    disputeWindow: snapshot.workerFacts.disputeWindow,
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
