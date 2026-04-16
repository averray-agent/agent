import { PlatformService } from "../core/platform-service.js";
import { createStateStore } from "../core/state-store.js";
import { BlockchainGateway } from "../blockchain/gateway.js";
import { VerifierService } from "./verifier-service.js";
import { loadLocalEnv } from "./env-loader.js";
import { PimlicoClient } from "./pimlico-client.js";
import { EventBus } from "../core/event-bus.js";
import { EventListener } from "../blockchain/event-listener.js";
import { loadAuthConfig } from "../auth/config.js";
import { createAuthMiddleware } from "../auth/middleware.js";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = dirname(fileURLToPath(import.meta.url));
loadLocalEnv(process.cwd(), resolve(moduleDir, "../../"));

const jobs = [
  {
    id: "starter-coding-001",
    category: "coding",
    tier: "starter",
    rewardAsset: "DOT",
    rewardAmount: 5,
    verifierMode: "benchmark",
    verifierConfig: {
      handler: "benchmark",
      requiredKeywords: ["complete", "verified", "output"],
      minimumMatches: 2
    },
    inputSchemaRef: "schema://jobs/coding-input",
    outputSchemaRef: "schema://jobs/coding-output",
    claimTtlSeconds: 3600,
    retryLimit: 1,
    requiresSponsoredGas: true
  },
  {
    id: "governance-pro-001",
    category: "governance",
    tier: "pro",
    rewardAsset: "DOT",
    rewardAmount: 25,
    verifierMode: "deterministic",
    verifierConfig: {
      handler: "deterministic",
      expectedOutputs: ["governance-approved-summary", "vote-yes rationale"],
      matchMode: "contains_all"
    },
    inputSchemaRef: "schema://jobs/governance-input",
    outputSchemaRef: "schema://jobs/governance-output",
    claimTtlSeconds: 7200,
    retryLimit: 2,
    requiresSponsoredGas: false
  }
];

const profiles = new Map([
  ["0xagent", {
    wallet: "0xagent",
    capabilities: ["claim_job", "submit_work", "allocate_idle_funds"],
    supportedProtocols: ["mcp", "a2a", "http"],
    preferredCategories: ["coding", "governance"],
    preferredRiskLevel: "low",
    verifierCompatibility: ["benchmark", "deterministic", "human_fallback"],
    minLiquidReserve: 10,
    autoUnwindStrategies: false
  }]
]);

const accounts = new Map([
  ["0xagent", {
    wallet: "0xagent",
    liquid: { DOT: 25 },
    reserved: { DOT: 0 },
    strategyAllocated: { DOT: 5 },
    collateralLocked: { DOT: 10 },
    jobStakeLocked: { DOT: 0 },
    debtOutstanding: { DOT: 0 }
  }]
]);

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
  const eventBus = new EventBus();
  return new PlatformService(jobs, profiles, accounts, reputations, gateway, stateStore, eventBus);
}

export function createPlatformRuntime() {
  const gateway = new BlockchainGateway();
  const pimlicoClient = new PimlicoClient();
  const stateStore = createStateStore();
  const eventBus = new EventBus();
  const platformService = new PlatformService(jobs, profiles, accounts, reputations, gateway, stateStore, eventBus);
  const verifierService = new VerifierService(platformService, stateStore, gateway);
  const eventListener = gateway.isEnabled() ? new EventListener(gateway, eventBus, stateStore) : undefined;
  void eventListener?.start?.();
  const authConfig = loadAuthConfig();
  const authMiddleware = createAuthMiddleware({ authConfig });
  if (authConfig.permissive) {
    console.warn(
      `[auth] AUTH_MODE=permissive — legacy ?wallet= is accepted without signature. Do not use in production.`
    );
  }
  return {
    platformService,
    verifierService,
    gateway,
    pimlicoClient,
    stateStore,
    eventBus,
    eventListener,
    authConfig,
    authMiddleware
  };
}
