import { PlatformService } from "../core/platform-service.js";
import { createStateStore } from "../core/state-store.js";
import {
  createOnboardingSubsidyBudget,
  loadOnboardingSubsidyBudgetConfig
} from "../core/claim-economics.js";
import { createWorkerExposurePolicy } from "../core/worker-exposure.js";
import { loadDepositVestingConfig } from "../core/deposit-vesting.js";
import { createWorkerDailyExposurePolicy } from "../core/worker-daily-exposure.js";
import { createCatalogueDailyBudget } from "../core/catalogue-daily-budget.js";
import {
  assertCatalogueDefinitionsHaveLanes,
  createCatalogueLaneDiscipline,
  loadCatalogueLaneRegistry
} from "../core/catalogue-lane-discipline.js";
import { migrateLegacyBankXcmGenerationState } from "./bank-xcm-watch-migration.js";
import { AccountOverlayStore } from "../core/account-overlay-store.js";
import { PolicyService } from "../core/policy-service.js";
import { BUILTIN_POLICIES } from "../core/builtin-policies.js";
import { BlockchainGateway } from "../blockchain/gateway.js";
import { VerifierService } from "./verifier-service.js";
import { createVerificationShelf } from "./verification-shelf.js";
import { createConfiguredX402VerificationPaymentGate } from "../payments/x402-verification-payment-gate.js";
import { loadLocalEnv } from "./env-loader.js";
import { PimlicoClient } from "./pimlico-client.js";
import { EventBus } from "../core/event-bus.js";
import { EventListener } from "../blockchain/event-listener.js";
import { loadAuthConfig } from "../auth/config.js";
import { validateJwtKmsCredentialAccess } from "../auth/credential-check.js";
import {
  buildKmsCredentialsProvider,
  buildRequiredKmsCredentialsProvider,
  PROFILE_BADGE_RECEIPT_SIGNER,
  PROFILE_JWT_SIGNER,
} from "./aws-credentials.js";
import {
  KmsBadgeReceiptSigner,
  loadBadgeReceiptSigningConfig,
} from "../core/badge-receipt-signing.js";
import { backfillBadgeReceiptSignatures } from "./badge-receipt-backfill.js";
import { backfillWorkReceipts } from "./work-receipt-backfill.js";
import { createAuthMiddleware } from "../auth/middleware.js";
import { createRateLimiter } from "../auth/rate-limit.js";
import { resolveCapabilities, capabilityMatrix } from "../auth/capabilities.js";
import { createLogger } from "../core/logger.js";
import { MetricRegistry } from "../core/metrics.js";
import { createObservability } from "../core/observability.js";
import { createContentRecoveryLog } from "../core/content-recovery-log.js";
import { describeMutationBackendStartup, loadMutationBackendConfig } from "../core/mutation-backend.js";
import { RecurringSchedulerService } from "./recurring-scheduler.js";
import {
  GithubIssueIngestionScheduler,
  loadGithubIssueIngestionConfig
} from "./github-issue-ingestion-scheduler.js";
import {
  WikipediaMaintenanceIngestionScheduler,
  loadWikipediaMaintenanceIngestionConfig
} from "./wikipedia-maintenance-ingestion-scheduler.js";
import {
  OsvAdvisoryIngestionScheduler,
  loadOsvAdvisoryIngestionConfig
} from "./osv-advisory-ingestion-scheduler.js";
import {
  OpenDataIngestionScheduler,
  loadOpenDataIngestionConfig
} from "./open-data-ingestion-scheduler.js";
import {
  StandardsSpecIngestionScheduler,
  loadStandardsSpecIngestionConfig
} from "./standards-spec-ingestion-scheduler.js";
import {
  OpenApiSpecIngestionScheduler,
  loadOpenApiSpecIngestionConfig
} from "./openapi-spec-ingestion-scheduler.js";
import {
  JobSpecHashSweeperService,
  loadJobSpecHashSweeperConfig
} from "./job-spec-hash-sweeper.js";
import { XcmSettlementWatcherService } from "./xcm-settlement-watcher.js";
import { XcmObservationRelayService } from "./xcm-observation-relay.js";
import { VenueBalanceReader } from "./venue-balance-reader.js";
import { XcmBalanceObserverService } from "./xcm-balance-observer.js";
import { createBankXcmV22RuntimeServices } from "./bank-xcm-v22-runtime.js";
import {
  BankLaneFeedService,
  EvmWrapperPauseReader,
  loadBankLaneFeedConfig
} from "./bank-lane-feed.js";
import { TransparencyService } from "./transparency-service.js";
import { DepositPoolObservabilityService } from "./deposit-pool-observability.js";
import { CreditPoolObservabilityService } from "./credit-pool-observability.js";
import { DepositPoolDoorService } from "./deposit-pool-door.js";
import { CreditPoolDoorService } from "./credit-pool-door.js";
import { CreditBookDoorService } from "./credit-book-door.js";
import { CreditBookKeeperService } from "./credit-book-keeper.js";
import { L3PostingKeeperService } from "./l3-posting-keeper.js";
import { EvmReceiptGraphReader, ReceiptGraphUnderwriter } from "./receipt-graph-underwriter.js";
import {
  UpstreamStatusPollerService,
  loadUpstreamStatusPollerConfig
} from "./upstream-status-poller.js";
import {
  BootstrapSelfReportSchedulerService,
  loadBootstrapSelfReportSchedulerConfig
} from "./bootstrap-self-report-scheduler.js";
import {
  JobStaleSweeperService,
  loadJobStaleSweeperConfig
} from "./job-stale-sweeper.js";
import {
  SubmittedJobAutoVerifierService,
  loadSubmittedJobAutoVerifierConfig
} from "./submitted-job-auto-verifier.js";
import {
  FirstExternalAgentAlertService,
  loadFirstExternalAgentAlertConfig
} from "./first-external-agent-alert.js";
import { normaliseStrategyAssetConfig } from "./strategy-asset-config.js";
import { BOOTSTRAP_JOBS } from "./bootstrap-jobs.js";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError } from "../core/errors.js";
import { resolveHubNetwork } from "../core/discovery-manifest.js";
import { EarningsDoorService } from "./earnings-door.js";
import {
  FirstWithdrawalGasGrantService,
  loadFirstWithdrawalGasGrantConfig
} from "./first-withdrawal-gas-grant.js";
import { assertMainnetSignerPosture, assertChainIdMatchesRpc } from "./startup-guards.js";
import { createRewardBankHealthProvider } from "../core/health-capability.js";
import {
  ExternalPostingService,
  resolveExternalPostingConfig
} from "../core/external-posting-service.js";
import { createConfiguredSettlementAdapter } from "../payments/adapters/index.js";
import {
  resolveX402PosterRampConfig,
  X402PosterRampService
} from "../payments/x402-poster-ramp.js";
import { PosterReviewService } from "../core/poster-review-service.js";
import { createSelfIdentityRegistry } from "../core/self-identity-registry.js";
import {
  ExternalPostingWatcherService,
  resolveExternalPostingWatcherConfig
} from "./external-posting-watcher.js";
import {
  ExternalPosterReviewEscalatorService,
  loadExternalPosterReviewEscalatorConfig
} from "./external-poster-review-escalator.js";

const moduleDir = dirname(fileURLToPath(import.meta.url));
loadLocalEnv(process.cwd(), resolve(moduleDir, "../../"));

const jobs = BOOTSTRAP_JOBS;

const profiles = new Map([
  ["0xagent", {
    wallet: "0xagent",
    capabilities: ["claim_job", "submit_work", "allocate_idle_funds"],
    supportedProtocols: ["mcp", "http"],
    preferredCategories: ["coding", "governance"],
    preferredRiskLevel: "low",
    verifierCompatibility: ["benchmark", "deterministic", "human_fallback", "github_pr", "witness"],
    minLiquidReserve: 10,
    autoUnwindStrategies: false
  }]
]);

// Demo seed for the legacy "0xagent" fixture wallet. Not a real wallet,
// not used in production traffic; production wallets are SIWE-derived
// `0x…` addresses populated through `getStoredAccount(wallet)` at request
// time. Both factories below wrap this seed in an `AccountOverlayStore`
// so writes mirror out to the durable state-store backing.
const SEED_DEV_OVERLAY = ["0xagent", {
  wallet: "0xagent",
  liquid: { USDC: 25 },
  reserved: { USDC: 0 },
  strategyAllocated: {},
  collateralLocked: { USDC: 10 },
  jobStakeLocked: { USDC: 0 },
  debtOutstanding: { USDC: 0 }
}];

const reputations = new Map([
  ["0xagent", {
    skill: 50,
    reliability: 75,
    economic: 25,
    tier: "starter"
  }]
]);

export function createPlatformService() {
  const gateway = new BlockchainGateway();
  const stateStore = createStateStore();
  const subsidyConfig = loadOnboardingSubsidyBudgetConfig();
  const onboardingSubsidyBudget = createOnboardingSubsidyBudget({ stateStore, config: subsidyConfig });
  const workerExposurePolicy = createWorkerExposurePolicy({
    stateStore,
    blockchainGateway: gateway,
    gasEstimateUsdc: subsidyConfig.gasEstimateUsdc
  });
  const workerDailyExposurePolicy = createWorkerDailyExposurePolicy({
    stateStore,
    workerExposurePolicy
  });
  const catalogueDailyBudget = createCatalogueDailyBudget({ stateStore });
  const catalogueLaneRegistry = loadCatalogueLaneRegistry();
  const selfIdentityRegistry = createSelfIdentityRegistry();
  assertCatalogueDefinitionsHaveLanes(jobs, catalogueLaneRegistry);
  const eventBus = new EventBus({ eventStore: stateStore });
  const accounts = new AccountOverlayStore({ stateStore });
  accounts.seed(...SEED_DEV_OVERLAY);
  // No hydrate here — test factory uses a fresh in-memory state-store
  // every construction; nothing to hydrate from. createPlatformRuntime
  // below hydrates against the production durable store.
  const platformService = new PlatformService(
    jobs,
    profiles,
    accounts,
    reputations,
    gateway,
    stateStore,
    eventBus,
    undefined,
    onboardingSubsidyBudget,
    workerExposurePolicy,
    workerDailyExposurePolicy,
    catalogueDailyBudget
  );
  platformService.setCatalogueLaneDiscipline(createCatalogueLaneDiscipline({
    stateStore,
    registry: catalogueLaneRegistry,
    gasEstimateUsdc: subsidyConfig.gasEstimateUsdc,
    selfIdentityRegistry
  }));
  return platformService;
}

export function createDepositPoolDoor({
  gateway,
  authConfig,
  chainReader,
  workerExposurePolicy,
  env = process.env
} = {}) {
  return new DepositPoolDoorService({
    poolAddress: gateway.config.depositPoolAddress,
    chainId: authConfig.chainId,
    // The door advertises the canonical public RPC from onboarding. Never
    // echo configured backend providers: those may carry private API tokens.
    rpcUrls: [resolveHubNetwork(authConfig.chainId).rpcUrl],
    provider: gateway.provider,
    chainReader,
    workerExposurePolicy,
    vestingHours: loadDepositVestingConfig(env).vestingHours
  });
}

export function createEarningsDoor({
  gateway,
  authConfig,
  stateStore,
  eventBus,
  workerExposurePolicy,
  chainReader,
  env = process.env
} = {}) {
  const gasGrantService = new FirstWithdrawalGasGrantService({
    gateway,
    stateStore,
    eventBus,
    ...loadFirstWithdrawalGasGrantConfig(env)
  });
  return new EarningsDoorService({
    agentAccountAddress: gateway.config.agentAccountAddress,
    chainId: authConfig.chainId,
    rpcUrls: [resolveHubNetwork(authConfig.chainId).rpcUrl],
    gateway,
    stateStore,
    eventBus,
    workerExposurePolicy,
    gasGrantService,
    provider: gateway.provider,
    chainReader
  });
}

export function createCreditPoolDoor({ gateway, authConfig, chainReader, workerExposurePolicy, creditBookDoor } = {}) {
  return new CreditPoolDoorService({
    creditPoolAddress: gateway.config.creditPoolAddress,
    depositPoolAddress: gateway.config.depositPoolV2Address,
    chainId: authConfig.chainId,
    rpcUrls: [resolveHubNetwork(authConfig.chainId).rpcUrl],
    provider: gateway.provider,
    chainReader,
    capacityReader: (wallet) => workerExposurePolicy.capacityForWallet(wallet),
    vestingAttestor: (input) => gateway.signCreditVestingAttestation(input),
    creditBookDoor
  });
}

export async function createPlatformRuntime() {
  const logger = createLogger({
    name: "agent-platform",
    level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "production" ? "info" : "debug")
  });
  const metrics = initStep("init-metrics", logger, () => createMetrics());
  const observability = await createObservability({ logger });

  // Each init step is wrapped so a failing step logs a structured error with
  // the step name before the process exits. Without this, a cryptic stack
  // trace is the only signal that a required env var was missing.
  const authConfig = initStep("load-auth-config", logger, () => loadAuthConfig());
  const selfIdentityRegistry = initStep("load-self-identity-registry", logger, () =>
    createSelfIdentityRegistry({ env: process.env, authConfig })
  );
  if (authConfig.kmsJwt) {
    authConfig.kmsJwt.logger = logger;
  }

  const badgeReceiptSigningConfig = initStep("load-badge-receipt-signing-config", logger, () =>
    loadBadgeReceiptSigningConfig(process.env)
  );
  let badgeReceiptSigner;
  if (badgeReceiptSigningConfig) {
    const credentialsProvider = buildRequiredKmsCredentialsProvider({ profile: PROFILE_BADGE_RECEIPT_SIGNER });
    badgeReceiptSigner = initStep("init-badge-receipt-signer", logger, () =>
      new KmsBadgeReceiptSigner(badgeReceiptSigningConfig, { credentialsProvider })
    );
    try {
      const integrity = await badgeReceiptSigner.initialize();
      logger.info?.(
        { keyId: integrity.keyId, fingerprint: integrity.fingerprint, kid: badgeReceiptSigningConfig.kid },
        "badge_receipt_signer.integrity_verified"
      );
    } catch (error) {
      logger.error(
        { step: "verify-badge-receipt-signer-integrity", err: error instanceof Error ? error : new Error(String(error)) },
        "bootstrap.init_failed"
      );
      throw error;
    }
  }

  // Phase 5a prep — verify the AWS credential chain can actually reach
  // the JWT KMS key before declaring the backend healthy. Without this
  // a misconfigured credential chain (most common future failure mode:
  // a botched IAM Roles Anywhere cert install) lets the backend boot
  // green and only surface as a 500 on the next user-facing SIWE
  // refresh. Skipped automatically under JWT_BACKEND=hmac (no kmsJwt
  // config) and bypassable via JWT_KMS_CREDENTIAL_CHECK_SKIP=1 for
  // tests / disconnected dev environments.
  if (authConfig.kmsJwt) {
    try {
      // Build the same Roles Anywhere credentials-provider the runtime
      // KmsJwtSigner uses (see getKmsSigner in auth/jwt.js). Without it
      // the boot check falls through to the SDK default chain — which
      // disagrees with the runtime path once AWS_USE_ROLES_ANYWHERE=true
      // and static AWS_*_ACCESS_KEY_* env vars are absent (the Phase 5a
      // Stage 2C-3 outage in #455/#456).
      const credentialsProvider = buildKmsCredentialsProvider({ profile: PROFILE_JWT_SIGNER });
      await validateJwtKmsCredentialAccess(authConfig.kmsJwt, { logger, credentialsProvider });
    } catch (error) {
      logger.error(
        { step: "validate-jwt-kms-credentials", err: error instanceof Error ? error : new Error(String(error)) },
        "bootstrap.init_failed",
      );
      throw error;
    }
  }

  const mutationBackendConfig = initStep("load-mutation-backend-config", logger, () =>
    loadMutationBackendConfig(process.env)
  );
  const gateway = initStep("init-blockchain-gateway", logger, () => new BlockchainGateway(undefined, { logger }));
  logger.info(
    describeMutationBackendStartup(mutationBackendConfig, gateway),
    "mutation_backend.configured"
  );
  // Refuse to boot a real on-chain broker behind permissive auth (pre-audit
  // #7). Permissive mode accepts an unauthenticated `?wallet=` and resolves
  // that wallet's roles with no signature — harmless against a disabled
  // gateway, but with chain brokering live it lets any caller broker on-chain
  // operations as any allowlisted wallet.
  initStep("check-auth-brokering-posture", logger, () =>
    assertSafeAuthBrokeringPosture({ authConfig, gateway, env: process.env, logger })
  );
  // B-02 — on mainnet the on-chain broker must sign via KMS, never a local
  // hot key. Fail-closed launch gate; no-op off mainnet / gateway disabled.
  initStep("check-mainnet-signer-posture", logger, () =>
    assertMainnetSignerPosture({ authConfig, gateway, env: process.env })
  );
  // D-02 — verify the RPC actually serves the configured chain id before the
  // backend brokers anything. Async (an eth_chainId call), so it mirrors the
  // KMS-credential check's try/catch rather than the sync initStep wrapper.
  try {
    await assertChainIdMatchesRpc({ authConfig, gateway, logger });
  } catch (error) {
    logger.error(
      { step: "check-chain-id-match", err: error instanceof Error ? error : new Error(String(error)) },
      "bootstrap.init_failed"
    );
    throw error;
  }
  const pimlicoClient = initStep("init-pimlico-client", logger, () => new PimlicoClient());
  const stateStore = initStep("init-state-store", logger, () => createStateStore(process.env, { logger }));
  const onboardingSubsidyBudget = initStep(
    "init-onboarding-subsidy-budget",
    logger,
    () => createOnboardingSubsidyBudget({ stateStore, env: process.env })
  );
  const workerExposurePolicy = initStep(
    "init-worker-exposure-policy",
    logger,
    () => createWorkerExposurePolicy({
      stateStore,
      blockchainGateway: gateway,
      gasEstimateUsdc: loadOnboardingSubsidyBudgetConfig(process.env).gasEstimateUsdc,
      env: process.env,
      logger
    })
  );
  const workerDailyExposurePolicy = initStep(
    "init-worker-daily-exposure-policy",
    logger,
    () => createWorkerDailyExposurePolicy({
      stateStore,
      workerExposurePolicy,
      env: process.env
    })
  );
  const catalogueDailyBudget = initStep(
    "init-catalogue-daily-budget",
    logger,
    () => createCatalogueDailyBudget({ stateStore, env: process.env })
  );
  const catalogueLaneRegistry = initStep("init-catalogue-lane-registry", logger, () => {
    const registry = loadCatalogueLaneRegistry(process.env);
    assertCatalogueDefinitionsHaveLanes(jobs, registry);
    return registry;
  });
  try {
    await migrateLegacyBankXcmGenerationState(stateStore, { logger });
  } catch (error) {
    logger.error(
      { step: "migrate-bank-xcm-generation-scope", err: error instanceof Error ? error : new Error(String(error)) },
      "bootstrap.init_failed"
    );
    throw error;
  }
  const contentRecoveryLog = initStep("init-content-recovery-log", logger, () =>
    createContentRecoveryLog(process.env, { logger })
  );
  const eventBus = initStep("init-event-bus", logger, () => new EventBus({ eventStore: stateStore, logger }));
  const accounts = initStep("init-account-overlay-store", logger, () => {
    const store = new AccountOverlayStore({ stateStore, logger });
    store.seed(...SEED_DEV_OVERLAY);
    return store;
  });
  // Hydrate the overlay cache from durable state-store before any HTTP
  // route is wired. Persisted writes from previous process incarnations
  // will overwrite the dev seed where wallets overlap, which is the
  // intended semantic — production writes always win over the static
  // demo fixture.
  const overlayHydration = await accounts.hydrate();
  logger.info?.(overlayHydration, "account-overlay.hydrate");
  const policyService = initStep("init-policy-service", logger, () =>
    new PolicyService({ stateStore, seedPolicies: BUILTIN_POLICIES, logger })
  );
  // Hydrate operator-proposed policies before any /policies route is
  // exposed. Built-in policies are seed data and don't need hydration.
  const policyHydration = await policyService.hydrate();
  logger.info?.(policyHydration, "policy.hydrate");
  const platformService = initStep(
    "init-platform-service",
    logger,
    () => new PlatformService(
      jobs,
      profiles,
      accounts,
      reputations,
      gateway,
      stateStore,
      eventBus,
      undefined,
      onboardingSubsidyBudget,
      workerExposurePolicy,
      workerDailyExposurePolicy,
      catalogueDailyBudget
    )
  );
  const catalogueLaneDiscipline = initStep("init-catalogue-lane-discipline", logger, () =>
    createCatalogueLaneDiscipline({
      stateStore,
      registry: catalogueLaneRegistry,
      gasEstimateUsdc: loadOnboardingSubsidyBudgetConfig(process.env).gasEstimateUsdc,
      selfIdentityRegistry,
      logger
    })
  );
  platformService.setCatalogueLaneDiscipline(catalogueLaneDiscipline);
  const rewardBankHealthProvider = initStep(
    "init-reward-bank-health-provider",
    logger,
    () => createRewardBankHealthProvider({
      gateway,
      env: process.env
    })
  );
  platformService.setRewardBankHealthProvider(rewardBankHealthProvider);
  platformService.verificationIngestionService.setBadgeReceiptSigner(badgeReceiptSigner);
  platformService.verificationIngestionService.setPolicyService(policyService);
  platformService.verificationIngestionService.setSelfIdentityRegistry(selfIdentityRegistry);
  try {
    await backfillWorkReceipts({
      stateStore,
      verificationIngestionService: platformService.verificationIngestionService,
      logger
    });
  } catch (error) {
    // Historical coverage is explicitly best-effort. Forward receipt emission
    // remains fail-closed in production inside verification ingestion.
    logger.warn?.(
      { step: "backfill-work-receipts", err: error instanceof Error ? error : new Error(String(error)) },
      "bootstrap.backfill_incomplete"
    );
  }
  if (badgeReceiptSigner) {
    try {
      await backfillBadgeReceiptSignatures({ stateStore, signer: badgeReceiptSigner, logger });
    } catch (error) {
      logger.error(
        { step: "backfill-badge-receipt-signatures", err: error instanceof Error ? error : new Error(String(error)) },
        "bootstrap.init_failed"
      );
      throw error;
    }
  }
  const verifierService = initStep(
    "init-verifier-service",
    logger,
    () => new VerifierService(platformService, stateStore, gateway, undefined, { eventBus, logger })
  );
  const verificationPaymentGate = initStep(
    "init-verification-payment-gate",
    logger,
    () => createConfiguredX402VerificationPaymentGate(process.env, { logger })
  );
  const {
    verificationProfileRegistry,
    verificationRunService,
    verificationRunFinalizer,
    mcpEgressGrantVerifier
  } = await initStepAsync(
    "init-verification-shelf",
    logger,
    () => createVerificationShelf({ stateStore, logger, paymentGate: verificationPaymentGate, authConfig })
  );
  const externalPostingConfig = initStep(
    "load-external-posting-config",
    logger,
    () => resolveExternalPostingConfig(process.env)
  );
  const externalPostingService = initStep("init-external-posting-service", logger, () =>
    new ExternalPostingService({
      stateStore,
      platformService,
      gateway,
      config: externalPostingConfig,
      logger,
      eventBus
    })
  );
  const receiptGraphUnderwriter = initStep("init-receipt-graph-underwriter", logger, () =>
    new ReceiptGraphUnderwriter({
      reader: new EvmReceiptGraphReader({
        provider: gateway.provider,
        escrowAddresses: [gateway.config.escrowCoreAddress, gateway.config.legacyEscrowCoreAddress],
        accountAddress: gateway.config.agentAccountAddress
      })
    })
  );
  const creditBookDoor = initStep("init-credit-book-door", logger, () =>
    new CreditBookDoorService({
      creditBookAddress: gateway.config.creditBookAddress,
      agentAccountAddress: gateway.config.agentAccountAddress,
      chainId: authConfig.chainId,
      provider: gateway.provider,
      underwriter: receiptGraphUnderwriter,
      stateStore,
      gateway,
      externalPostingService,
      siweDomain: authConfig.domain,
      publicBaseUrl: process.env.PUBLIC_BASE_URL ?? `https://${authConfig.domain}`
    })
  );
  const creditBookKeeper = initStep("init-credit-book-keeper", logger, () =>
    new CreditBookKeeperService({
      creditBookDoor,
      gateway,
      logger
    })
  );
  verifierService.setCreditBookKeeper(creditBookKeeper);
  const l3PostingKeeper = initStep("init-l3-posting-keeper", logger, () =>
    new L3PostingKeeperService({
      creditBookAddress: gateway.config.creditBookAddress,
      provider: gateway.config.creditBookAddress ? gateway.provider : undefined,
      creditBookDoor,
      stateStore,
      gateway,
      eventBus,
      logger
    })
  );
  l3PostingKeeper.start();
  const x402PosterRampConfig = initStep(
    "load-x402-poster-ramp-config",
    logger,
    () => resolveX402PosterRampConfig(process.env)
  );
  const x402PosterRamp = x402PosterRampConfig.enabled
    ? initStep("init-x402-poster-ramp", logger, () => new X402PosterRampService({
        config: x402PosterRampConfig,
        settlementAdapter: createConfiguredSettlementAdapter(process.env),
        externalPostingService,
        stateStore,
        gateway
      }))
    : undefined;
  const posterReviewService = initStep("init-poster-review-service", logger, () =>
    new PosterReviewService({
      platformService,
      stateStore,
      gateway,
      verifierService,
      eventBus,
      config: externalPostingConfig,
      logger
    })
  );
  const externalPostingWatcher = initStep("init-external-posting-watcher", logger, () =>
    new ExternalPostingWatcherService(
      externalPostingService,
      stateStore,
      eventBus,
      {
        ...resolveExternalPostingWatcherConfig(process.env),
        logger
      }
    )
  );
  const eventListener = initStep("init-event-listener", logger, () =>
    gateway.isEnabled() ? new EventListener(gateway, eventBus, stateStore) : undefined
  );
  const recurringScheduler = initStep("init-recurring-scheduler", logger, () =>
    new RecurringSchedulerService(platformService, eventBus, {
      enabled: parseBooleanEnv(process.env.RECURRING_SCHEDULER_ENABLED),
      logger
    })
  );
  const githubIssueIngestionScheduler = initStep("init-github-issue-ingestion-scheduler", logger, () =>
    new GithubIssueIngestionScheduler(platformService, eventBus, {
      ...loadGithubIssueIngestionConfig(process.env),
      logger
    })
  );
  const wikipediaMaintenanceIngestionScheduler = initStep("init-wikipedia-maintenance-ingestion-scheduler", logger, () =>
    new WikipediaMaintenanceIngestionScheduler(platformService, eventBus, {
      ...loadWikipediaMaintenanceIngestionConfig(process.env),
      logger
    })
  );
  const osvAdvisoryIngestionScheduler = initStep("init-osv-advisory-ingestion-scheduler", logger, () =>
    new OsvAdvisoryIngestionScheduler(platformService, eventBus, {
      ...loadOsvAdvisoryIngestionConfig(process.env),
      logger
    })
  );
  const openDataIngestionScheduler = initStep("init-open-data-ingestion-scheduler", logger, () =>
    new OpenDataIngestionScheduler(platformService, eventBus, {
      ...loadOpenDataIngestionConfig(process.env),
      logger
    })
  );
  const standardsSpecIngestionScheduler = initStep("init-standards-spec-ingestion-scheduler", logger, () =>
    new StandardsSpecIngestionScheduler(platformService, eventBus, {
      ...loadStandardsSpecIngestionConfig(process.env),
      logger
    })
  );
  const openApiSpecIngestionScheduler = initStep("init-openapi-spec-ingestion-scheduler", logger, () =>
    new OpenApiSpecIngestionScheduler(platformService, eventBus, {
      ...loadOpenApiSpecIngestionConfig(process.env),
      logger
    })
  );
  const jobSpecHashSweeper = initStep("init-job-spec-hash-sweeper", logger, () =>
    new JobSpecHashSweeperService(platformService, eventBus, {
      ...loadJobSpecHashSweeperConfig(process.env, { gatewayEnabled: gateway.isEnabled() }),
      logger
    })
  );
  const xcmSettlementWatcher = initStep("init-xcm-settlement-watcher", logger, () =>
    new XcmSettlementWatcherService(platformService, stateStore, eventBus, {
      enabled: process.env.XCM_SETTLEMENT_WATCHER_ENABLED === undefined
        ? gateway.isEnabled()
        : parseBooleanEnv(process.env.XCM_SETTLEMENT_WATCHER_ENABLED),
      pollIntervalMs: parsePositiveInt(process.env.XCM_SETTLEMENT_WATCHER_POLL_MS, 15_000),
      expectedWrapper: gateway.config.xcmWrapperAddress,
      logger
    })
  );
  const venueBalanceReader = initStep("init-venue-balance-reader", logger, () => new VenueBalanceReader());
  const bankXcmFlowRequested = parseBooleanEnv(process.env.BANK_XCM_FLOW_ENABLED);
  const bankUsdcAsset = gateway.config.supportedAssets?.find(
    (asset) => String(asset.symbol ?? "").toUpperCase() === "USDC"
  );
  const bankLaneFeed = initStep("init-bank-lane-feed", logger, () => {
    const config = loadBankLaneFeedConfig(process.env);
    const withdrawTarget = bankXcmFlowRequested && gateway.hasXcmWrapper() && bankUsdcAsset?.address
      ? {
          ledger: "erc20",
          endpoint: gateway.config.rpcUrl,
          chainId: gateway.config.chainId,
          account: gateway.config.xcmWrapperAddress,
          contract: bankUsdcAsset.address
        }
      : undefined;
    return new BankLaneFeedService(
      stateStore,
      venueBalanceReader,
      {
        ...config,
        requestTargets: [config.targets?.position, withdrawTarget].filter(Boolean),
        subjectReader: new EvmWrapperPauseReader(gateway.provider)
      }
    );
  });
  const transparencyService = initStep("init-transparency-service", logger, () =>
    new TransparencyService({
      bankLaneFeed,
      gateway,
      platformService,
      stateStore,
      venueBalanceReader,
      selfIdentityRegistry,
      logger
    })
  );
  const depositPoolObservability = initStep("init-deposit-pool-observability", logger, () =>
    new DepositPoolObservabilityService({
      poolAddress: gateway.config.depositPoolAddress,
      provider: gateway.provider,
      catalogueDailyBudget
    })
  );
  const creditPoolObservability = initStep("init-credit-pool-observability", logger, () =>
    new CreditPoolObservabilityService({
      poolAddress: gateway.config.creditPoolAddress,
      provider: gateway.provider
    })
  );
  const depositPoolDoor = initStep("init-deposit-pool-door", logger, () =>
    createDepositPoolDoor({ gateway, authConfig, workerExposurePolicy })
  );
  const earningsDoor = initStep("init-earnings-door", logger, () =>
    createEarningsDoor({ gateway, authConfig, stateStore, eventBus, workerExposurePolicy })
  );
  platformService.setFirstWithdrawalGasGrantStatusProvider(earningsDoor);
  const creditPoolDoor = initStep("init-credit-pool-door", logger, () =>
    createCreditPoolDoor({ gateway, authConfig, workerExposurePolicy, creditBookDoor })
  );
  const xcmBalanceObserver = initStep("init-xcm-balance-observer", logger, () =>
    new XcmBalanceObserverService(
      stateStore,
      venueBalanceReader,
      xcmSettlementWatcher,
      eventBus,
      {
        // Unit 3 owns v2.2 deployment/env activation. A config flag alone can
        // never activate observation against a null wrapper.
        enabled: bankXcmFlowRequested && gateway.hasXcmWrapper(),
        pollIntervalMs: parsePositiveInt(process.env.BANK_XCM_OBSERVER_POLL_MS, 15_000),
        defaultTimeoutMs: parsePositiveInt(process.env.BANK_XCM_OBSERVER_TIMEOUT_MS, 15 * 60_000),
        bankLaneFeed,
        chainEventWatchConfig: bankXcmFlowRequested && gateway.hasXcmWrapper()
          ? {
              expectedWrapper: gateway.config.xcmWrapperAddress,
              depositTarget: bankLaneFeed.targets?.position,
              withdrawTarget: {
                ledger: "erc20",
                endpoint: gateway.config.rpcUrl,
                chainId: gateway.config.chainId,
                account: gateway.config.xcmWrapperAddress,
                contract: bankUsdcAsset?.address
              }
            }
          : undefined,
        logger
      }
    )
  );
  const bankXcmV22Services = initStep("init-bank-xcm-v22-runtime", logger, () =>
    createBankXcmV22RuntimeServices({
      enabled: bankXcmFlowRequested && gateway.hasXcmWrapper(),
      gateway,
      balanceObserver: xcmBalanceObserver,
      balanceReader: venueBalanceReader,
      bankLaneFeed,
      eventBus,
      env: process.env,
      logger
    })
  );
  const xcmObservationRelay = initStep("init-xcm-observation-relay", logger, () =>
    new XcmObservationRelayService(platformService, stateStore, eventBus, {
      enabled: process.env.XCM_OBSERVER_ENABLED === undefined
        ? (gateway.isEnabled() && Boolean(process.env.XCM_OBSERVER_FEED_URL?.trim()))
        : parseBooleanEnv(process.env.XCM_OBSERVER_ENABLED),
      feedUrl: process.env.XCM_OBSERVER_FEED_URL?.trim(),
      authToken: process.env.XCM_OBSERVER_AUTH_TOKEN?.trim(),
      pollIntervalMs: parsePositiveInt(process.env.XCM_OBSERVER_POLL_MS, 30_000),
      batchSize: parsePositiveInt(process.env.XCM_OBSERVER_BATCH_SIZE, 25),
      logger
    })
  );
  const upstreamStatusPoller = initStep("init-upstream-status-poller", logger, () =>
    new UpstreamStatusPollerService(stateStore, eventBus, {
      ...loadUpstreamStatusPollerConfig(process.env),
      logger
    })
  );
  const bootstrapSelfReportScheduler = initStep("init-bootstrap-self-report-scheduler", logger, () =>
    new BootstrapSelfReportSchedulerService(upstreamStatusPoller, eventBus, {
      ...loadBootstrapSelfReportSchedulerConfig(process.env),
      stateStore,
      logger
    })
  );
  const jobStaleSweeper = initStep("init-job-stale-sweeper", logger, () =>
    new JobStaleSweeperService(platformService, stateStore, eventBus, {
      ...loadJobStaleSweeperConfig(process.env),
      logger
    })
  );
  const submittedJobAutoVerifier = initStep("init-submitted-job-auto-verifier", logger, () =>
    new SubmittedJobAutoVerifierService(platformService, verifierService, gateway, eventBus, {
      ...loadSubmittedJobAutoVerifierConfig(process.env),
      logger
    })
  );
  const externalPosterReviewEscalator = initStep("init-external-poster-review-escalator", logger, () =>
    new ExternalPosterReviewEscalatorService(
      platformService,
      stateStore,
      posterReviewService,
      eventBus,
      {
        ...loadExternalPosterReviewEscalatorConfig(process.env, {
          gatewayEnabled: gateway.isEnabled()
        }),
        logger
      }
    )
  );
  const firstExternalAgentAlert = initStep("init-first-external-agent-alert", logger, () =>
    new FirstExternalAgentAlertService(stateStore, eventBus, {
      ...loadFirstExternalAgentAlertConfig(process.env),
      logger
    })
  );
  platformService.recurringScheduler = recurringScheduler;
  platformService.githubIssueIngestionScheduler = githubIssueIngestionScheduler;
  platformService.wikipediaMaintenanceIngestionScheduler = wikipediaMaintenanceIngestionScheduler;
  platformService.osvAdvisoryIngestionScheduler = osvAdvisoryIngestionScheduler;
  platformService.openDataIngestionScheduler = openDataIngestionScheduler;
  platformService.standardsSpecIngestionScheduler = standardsSpecIngestionScheduler;
  platformService.openApiSpecIngestionScheduler = openApiSpecIngestionScheduler;
  platformService.jobSpecHashSweeper = jobSpecHashSweeper;
  platformService.xcmSettlementWatcher = xcmSettlementWatcher;
  platformService.xcmBalanceObserver = xcmBalanceObserver;
  platformService.bankXcmRuntime = bankXcmV22Services.runtime;
  platformService.bankXcmDispatcher = bankXcmV22Services.dispatcher;
  platformService.externalPostingWatcher = externalPostingWatcher;
  platformService.xcmObservationRelay = xcmObservationRelay;
  platformService.upstreamStatusPoller = upstreamStatusPoller;
  platformService.bootstrapSelfReportScheduler = bootstrapSelfReportScheduler;
  platformService.jobStaleSweeper = jobStaleSweeper;
  platformService.submittedJobAutoVerifier = submittedJobAutoVerifier;
  platformService.externalPosterReviewEscalator = externalPosterReviewEscalator;
  platformService.firstExternalAgentAlert = firstExternalAgentAlert;
  // Opt-in (testnet-only operational invariant): escrow auto-ingested job
  // rewards on-chain at ingestion so they are funded before being advertised
  // claimable. Off by default; see deploy/backend.env.template.
  platformService.prefundIngestedJobs = parseBooleanEnv(process.env.INGESTION_PREFUND_ENABLED);
  recurringScheduler.start();
  githubIssueIngestionScheduler.start();
  wikipediaMaintenanceIngestionScheduler.start();
  osvAdvisoryIngestionScheduler.start();
  openDataIngestionScheduler.start();
  standardsSpecIngestionScheduler.start();
  openApiSpecIngestionScheduler.start();
  jobSpecHashSweeper.start();
  xcmSettlementWatcher.start();
  // Watches subscribe before the chain listener starts. A RequestQueued event
  // can therefore never race ahead of its observer baseline during startup.
  xcmBalanceObserver.start();
  // Multisig-origin revive events are absent from eth_getLogs. Start the
  // authoritative Asset Hub system.events bridge only after its observer is
  // subscribed, and keep staging fail-closed until that bridge is live.
  void bankXcmV22Services.runtime?.start?.().catch((error) => {
    logger.error?.({ error: error?.message ?? String(error) }, "bank_xcm_v22_runtime.start_failed");
  });
  void eventListener?.start?.();
  externalPostingWatcher.start();
  xcmObservationRelay.start();
  upstreamStatusPoller.start();
  bootstrapSelfReportScheduler.start();
  jobStaleSweeper.start();
  submittedJobAutoVerifier.start();
  verificationRunFinalizer.start();
  transparencyService.start();
  externalPosterReviewEscalator.start();
  firstExternalAgentAlert.start();

  const authMiddleware = createAuthMiddleware({ authConfig, stateStore, logger });
  const rateLimiter = createRateLimiter({ stateStore, logger });
  const rateLimitConfig = loadRateLimitConfig();
  const httpConfig = loadHttpConfig();
  const strategies = loadStrategiesConfig(process.env, { logger });
  const trustProxy = parseBooleanEnv(process.env.TRUST_PROXY);
  if (authConfig.permissive) {
    logger.warn(
      { mode: "permissive" },
      "AUTH_MODE=permissive — legacy ?wallet= is accepted without signature. Do not use in production."
    );
  }
  return {
    platformService,
    catalogueLaneDiscipline,
    rewardBankHealthProvider,
    policyService,
    verifierService,
    verificationProfileRegistry,
    verificationRunService,
    verificationRunFinalizer,
    mcpEgressGrantVerifier,
    externalPostingService,
    x402PosterRamp,
    externalPostingWatcher,
    posterReviewService,
    externalPosterReviewEscalator,
    gateway,
    mutationBackendConfig,
    pimlicoClient,
    stateStore,
    contentRecoveryLog,
    eventBus,
    eventListener,
    recurringScheduler,
    githubIssueIngestionScheduler,
    wikipediaMaintenanceIngestionScheduler,
    osvAdvisoryIngestionScheduler,
    openDataIngestionScheduler,
    standardsSpecIngestionScheduler,
    openApiSpecIngestionScheduler,
    jobSpecHashSweeper,
    xcmSettlementWatcher,
    xcmBalanceObserver,
    bankXcmRuntime: bankXcmV22Services.runtime,
    bankXcmDispatcher: bankXcmV22Services.dispatcher,
    bankLaneFeed,
    transparencyService,
    depositPoolObservability,
    creditPoolObservability,
    depositPoolDoor,
    earningsDoor,
    creditPoolDoor,
    creditBookDoor,
    creditBookKeeper,
    l3PostingKeeper,
    venueBalanceReader,
    xcmObservationRelay,
    upstreamStatusPoller,
    jobStaleSweeper,
    submittedJobAutoVerifier,
    firstExternalAgentAlert,
    authConfig,
    selfIdentityRegistry,
    authMiddleware,
    authCapabilities: {
      resolveCapabilities,
      capabilityMatrix
    },
    rateLimiter,
    rateLimitConfig,
    httpConfig,
    strategies,
    trustProxy,
    logger,
    metrics,
    observability,
    badgeReceiptSigner
  };
}

function createMetrics() {
  const registry = new MetricRegistry();
  registry.counter("http_requests_total", "Total HTTP requests served.", ["method", "path", "status"]);
  registry.histogram("http_request_duration_ms", "Request duration in milliseconds.", ["method", "path"]);
  registry.counter("auth_failures_total", "Auth or authorization failures by code.", ["code"]);
  registry.counter("rate_limit_rejections_total", "Rate-limit rejections by bucket.", ["bucket"]);
  registry.gauge("sse_active_connections", "Currently open SSE connections.");
  registry.gauge("state_store_backend", "1 when state store backend matches the label.", ["backend"]);
  return registry;
}

function initStep(name, logger, factory) {
  try {
    return factory();
  } catch (error) {
    logger.error(
      { step: name, err: error instanceof Error ? error : new Error(String(error)) },
      "bootstrap.init_failed"
    );
    throw error;
  }
}

async function initStepAsync(name, logger, factory) {
  try {
    return await factory();
  } catch (error) {
    logger.error(
      { step: name, err: error instanceof Error ? error : new Error(String(error)) },
      "bootstrap.init_failed"
    );
    throw error;
  }
}

/**
 * Fail closed when a real on-chain broker is paired with permissive auth
 * (pre-audit #7). In permissive mode, requireAuth accepts an unauthenticated
 * `?wallet=<addr>` and grants that wallet's allowlisted roles with no
 * signature check. That is acceptable for local dev against a disabled
 * gateway, but if `gateway.isEnabled()` is true the same path lets any
 * unauthenticated caller broker on-chain operations (claim/submit/settle) as
 * any AUTH_*_WALLETS member. Refuse to boot that combination unless an
 * operator has explicitly opted in via AUTH_ALLOW_PERMISSIVE_BROKERING — in
 * which case we still log a loud warning so the posture is never silent.
 *
 * @param {object} args
 * @param {{ permissive?: boolean }} args.authConfig
 * @param {{ isEnabled?: () => boolean }} args.gateway
 * @param {Record<string, string | undefined>} [args.env]
 * @param {{ warn?: Function }} [args.logger]
 */
export function assertSafeAuthBrokeringPosture({ authConfig, gateway, env = process.env, logger } = {}) {
  const permissive = authConfig?.permissive === true;
  const gatewayEnabled = typeof gateway?.isEnabled === "function" && gateway.isEnabled() === true;
  if (!permissive || !gatewayEnabled) {
    return;
  }
  if (parseBooleanEnv(env.AUTH_ALLOW_PERMISSIVE_BROKERING)) {
    logger?.warn?.(
      { authMode: "permissive", gatewayEnabled: true },
      "auth.permissive_brokering_explicitly_allowed"
    );
    return;
  }
  throw new ConfigError(
    "AUTH_MODE=permissive with the blockchain gateway enabled lets an unauthenticated " +
      "?wallet= caller broker on-chain operations as any allowlisted wallet. Set AUTH_MODE=strict " +
      "(recommended), or, only if you intentionally want unauthenticated brokering (e.g. local dev " +
      "against a live chain), set AUTH_ALLOW_PERMISSIVE_BROKERING=1."
  );
}

function loadRateLimitConfig(env = process.env) {
  return {
    authNonce: buildLimit(env, "RATE_LIMIT_AUTH_NONCE", { limit: 10, windowSeconds: 60 }),
    authVerify: buildLimit(env, "RATE_LIMIT_AUTH_VERIFY", { limit: 10, windowSeconds: 60 }),
    // Refresh has a stricter per-wallet limit than verify because a refresh
    // call needs a valid token in hand — abusive callers would have to keep
    // spending tokens to retry. 6/min is enough headroom for a tab that
    // wakes up after sleep and a couple of background re-syncs.
    authRefresh: buildLimit(env, "RATE_LIMIT_AUTH_REFRESH", { limit: 6, windowSeconds: 60 }),
    // MCP has independent public and authenticated budgets. Invalid bearer
    // tokens are charged to the anonymous/IP bucket so they cannot bypass it.
    mcpAnonymous: buildLimit(env, "RATE_LIMIT_MCP_ANONYMOUS", { limit: 60, windowSeconds: 60 }),
    mcpAuthenticated: buildLimit(env, "RATE_LIMIT_MCP_AUTHENTICATED", { limit: 300, windowSeconds: 60 }),
    adminJobs: buildLimit(env, "RATE_LIMIT_ADMIN_JOBS", { limit: 60, windowSeconds: 60 }),
    // Draft validation does schema + policy work per request; the open-draft
    // cap and reward floor only bound stored state, so create + status-poll
    // share a per-wallet request budget. 30/min leaves room for a poster
    // iterating on validation errors while polling funding status.
    externalDrafts: buildLimit(env, "RATE_LIMIT_EXTERNAL_DRAFTS", { limit: 30, windowSeconds: 60 }),
    // Submission reads and decisions share a separate per-wallet budget so a
    // noisy review UI cannot exhaust the poster's draft-creation allowance.
    externalReviews: buildLimit(env, "RATE_LIMIT_EXTERNAL_REVIEWS", { limit: 30, windowSeconds: 60 }),
    verifierRun: buildLimit(env, "RATE_LIMIT_VERIFIER_RUN", { limit: 120, windowSeconds: 60 }),
    events: buildLimit(env, "RATE_LIMIT_EVENTS", { limit: 30, windowSeconds: 60 })
  };
}

export function loadHttpConfig(env = process.env) {
  const maxBodyBytes = parsePositiveInt(env.HTTP_MAX_BODY_BYTES, 64 * 1024); // 64 KiB default
  const allowedOrigins = (env.CORS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const allowAllOrigins = allowedOrigins.includes("*");
  return {
    maxBodyBytes,
    allowedOrigins: new Set(allowedOrigins),
    allowAllOrigins,
    allowedMethods: "GET, POST, OPTIONS",
    allowedHeaders: "authorization, content-type, last-event-id, mcp-method, mcp-name, mcp-protocol-version, mcp-session-id, payment-signature, sign-in-with-x, verification-target-authorization, x-payment, x-request-id",
    exposedHeaders: "mcp-protocol-version, mcp-session-id, payment-required, payment-response, retry-after, x-payment-required, x-payment-response, x-request-id",
    maxAgeSeconds: parsePositiveInt(env.CORS_MAX_AGE_SECONDS, 600)
  };
}

function buildLimit(env, prefix, defaults) {
  const limit = parsePositiveInt(env[`${prefix}_LIMIT`], defaults.limit);
  const windowSeconds = parsePositiveInt(env[`${prefix}_WINDOW_SECONDS`], defaults.windowSeconds);
  return { limit, windowSeconds };
}

function parsePositiveInt(raw, fallback) {
  if (raw === undefined || raw === null || raw === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    return fallback;
  }
  return value;
}

function parseBooleanEnv(raw) {
  if (raw === undefined || raw === null || raw === "") {
    return false;
  }
  return ["1", "true", "yes", "on"].includes(String(raw).trim().toLowerCase());
}

/**
 * Load the list of registered strategy adapters the backend should
 * surface at `GET /strategies`. Operators populate `STRATEGIES_JSON`
 * with the `strategies` array copied verbatim from the deployment
 * manifest (deployments/<profile>.json). Invalid JSON logs a warning and
 * falls back to an empty list rather than crashing the boot — strategy
 * discovery is a nice-to-have, not a boot-blocking dependency.
 */
export function loadStrategiesConfig(env = process.env, { logger = console } = {}) {
  const raw = (env.STRATEGIES_JSON ?? "").trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error("STRATEGIES_JSON must decode to an array");
    }
    return parsed.map((entry, idx) => normaliseStrategyEntry(entry, idx));
  } catch (error) {
    logger.warn?.(
      { err: error instanceof Error ? error : new Error(String(error)) },
      "strategies.config_parse_failed"
    );
    return [];
  }
}

function normaliseStrategyEntry(entry, idx) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`strategies[${idx}] must be an object`);
  }
  const { strategyId, adapter, kind, riskLabel, asset, executionMode, xcm } = entry;
  const assetConfig = normaliseStrategyAssetConfig(asset, idx);
  if (typeof strategyId !== "string" || !/^0x[a-fA-F0-9]{64}$/u.test(strategyId)) {
    throw new Error(`strategies[${idx}].strategyId must be 0x + 32-byte hex`);
  }
  if (typeof adapter !== "string" || !/^0x[a-fA-F0-9]{40}$/u.test(adapter)) {
    throw new Error(`strategies[${idx}].adapter must be 0x + 20-byte EVM address`);
  }
  return {
    strategyId,
    adapter: adapter.toLowerCase(),
    kind: typeof kind === "string" ? kind : "unknown",
    executionMode: normaliseStrategyExecutionMode(executionMode, typeof kind === "string" ? kind : "unknown", idx),
    riskLabel: typeof riskLabel === "string" ? riskLabel : "",
    asset: assetConfig?.address,
    assetConfig,
    xcm: normaliseStrategyXcmConfig(xcm, idx)
  };
}

function normaliseStrategyXcmConfig(xcm, idx) {
  if (xcm === undefined || xcm === null) {
    return undefined;
  }
  if (typeof xcm !== "object" || Array.isArray(xcm)) {
    throw new Error(`strategies[${idx}].xcm must be an object`);
  }
  if (
    xcm.messagePrefixes !== undefined ||
    xcm.messages !== undefined ||
    xcm.depositMessagePrefix !== undefined ||
    xcm.withdrawMessagePrefix !== undefined
  ) {
    throw new Error(
      `strategies[${idx}].xcm must not include raw message prefixes; the backend assembles XCM from intent`
    );
  }
  const destinationParachain = xcm.destinationParachain ?? xcm.destinationParaId;
  const normalized = {};
  if (!(destinationParachain === undefined || destinationParachain === null || destinationParachain === "")) {
    const parsed = Number(destinationParachain);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 0xffffffff) {
      throw new Error(`strategies[${idx}].xcm.destinationParachain must be a uint32`);
    }
    normalized.destinationParachain = parsed;
  }
  for (const key of [
    "originChain",
    "destinationChain",
    "feeAmount",
    "executionFeeAmount",
    "depositFeeAmount",
    "withdrawFeeAmount",
    "amount",
    "depositAmount",
    "withdrawAmount",
    "beneficiary",
    "beneficiaryLocation",
    "depositBeneficiary",
    "depositBeneficiaryLocation",
    "withdrawBeneficiary",
    "withdrawBeneficiaryLocation",
    "assetLocation",
    "feeAssetLocation"
  ]) {
    if (xcm[key] !== undefined) {
      normalized[key] = xcm[key];
    }
  }
  return Object.keys(normalized).length ? normalized : undefined;
}

function normaliseStrategyExecutionMode(rawExecutionMode, kind, idx) {
  if (rawExecutionMode === undefined || rawExecutionMode === null || rawExecutionMode === "") {
    if (String(kind).trim().toLowerCase() === "polkadot_vdot") {
      return "async_xcm";
    }
    return "sync";
  }
  if (typeof rawExecutionMode !== "string") {
    throw new Error(`strategies[${idx}].executionMode must be a string`);
  }
  const normalized = rawExecutionMode.trim().toLowerCase().replace(/[\s-]+/gu, "_");
  if (normalized === "sync" || normalized === "async_xcm") {
    return normalized;
  }
  throw new Error(`strategies[${idx}].executionMode must be "sync" or "async_xcm"`);
}
