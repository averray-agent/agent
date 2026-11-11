import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createHostedCanaryClaimantAttribution } from "./claimant-attribution.js";
import { MemoryStateStore } from "./state-store.js";
import { WorkerProgressionService } from "./worker-progression.js";
import { buildArrivalOperatorView } from "../services/arrival-operator-view.js";
import { readGithubAuthors } from "../services/github-author-visibility.js";
import { TransparencyService } from "../services/transparency-service.js";
import { SelfIdentityRegistry } from "./self-identity-registry.js";

const NOW = Date.parse("2026-10-18T12:00:00.000Z");
const OUTSIDER = "0x6666666666666666666666666666666666666666";
const TAGGED = "0x7777777777777777777777777777777777777777";
const PREFIXED = "0x8888888888888888888888888888888888888888";
const MARKED = "0x9999999999999999999999999999999999999999";
const OPERATOR = "0x1111111111111111111111111111111111111111";

function loadMainRegistryHref() {
  const source = execFileSync(
    "git",
    ["show", "origin/main:mcp-server/src/core/self-identity-registry.js"],
    { cwd: fileURLToPath(new URL("../../..", import.meta.url)), encoding: "utf8" }
  );
  const claimant = new URL("./claimant-attribution.js", import.meta.url).href;
  const errors = new URL("./errors.js", import.meta.url).href;
  const rewritten = source
    .replaceAll(`from "./claimant-attribution.js"`, `from ${JSON.stringify(claimant)}`)
    .replaceAll(`from "./errors.js"`, `from ${JSON.stringify(errors)}`);
  return `data:text/javascript;charset=utf-8,${encodeURIComponent(rewritten)}`;
}

function session(id, wallet, definition, extra = {}) {
  return {
    sessionId: id,
    wallet,
    status: "resolved",
    claimedAt: new Date(NOW).toISOString(),
    submittedAt: new Date(NOW).toISOString(),
    resolvedAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    jobId: definition.id,
    verificationSummary: { outcome: "approved" },
    payoutTx: { status: 1, txHash: `0x${"ab".repeat(32)}`, settlement: { assetSymbol: "USDC", workerAmountRaw: "1000000" } },
    jobSnapshot: { definition },
    ...extra
  };
}

const github = (id, extra = {}) => ({
  id,
  verifierMode: "github_pr",
  source: { type: "github_issue", repo: "example/project", githubRepoId: 11, issueNumber: 1 },
  ...extra
});

function fixtures() {
  return [
    session("plain", OUTSIDER, github("ordinary-job")),
    session("tagged", TAGGED, github("ordinary-proof", { disposableProof: true })),
    session("prefixed", PREFIXED, github("worker-canary-1786453506586", {
      disposableProof: true,
      lineage: { createdBy: "operator-canary-service" }
    })),
    session("marked", MARKED, github("worker-canary-marked", { disposableProof: true }), {
      claimantAttribution: createHostedCanaryClaimantAttribution()
    })
  ];
}

async function project(registry, sessions) {
  const store = new MemoryStateStore();
  for (const row of sessions) await store.upsertSession(row);
  if (registry.hydrateAdminOurs) await registry.hydrateAdminOurs(store);
  const authors = await readGithubAuthors(store, {
    now: new Date(NOW),
    sessions,
    selfIdentityRegistry: registry
  });
  const arrivals = await buildArrivalOperatorView({
    nowMs: NOW,
    identityRegistry: registry,
    clients: [],
    httpClients: [],
    totals: {},
    actorTotals: {},
    httpTotals: {},
    httpActorTotals: {},
    stateStore: store
  });
  const transparency = new TransparencyService({
    stateStore: store,
    selfIdentityRegistry: registry,
    now: () => NOW,
    platformService: { getJobDefinition() { return undefined; } },
    gateway: {
      async getJobs(jobIds) {
        return jobIds.map((jobId) => {
          const row = sessions.find((candidate) => candidate.jobId === jobId);
          return {
            status: "fulfilled",
            value: {
              state: 5,
              poster: row?.wallet,
              rewardRaw: "1000000",
              releasedRaw: "1000000",
              protocolFeeRaw: "1000",
              protocolFeeReleasedRaw: "1000"
            }
          };
        });
      }
    }
  });
  const flow = transparency.buildFlow(await transparency.readFlow(), NOW);
  const progression = new WorkerProgressionService({
    stateStore: store,
    selfIdentityRegistry: registry,
    getReputation: async () => ({ skill: 0, tier: "starter" }),
    workerExposurePolicy: {
      async capacityForWallet() {
        return {
          vestedAssetsRaw: "0",
          externalRewardCeilingRaw: "1000000",
          externalRewardCeilingUsdc: 1,
          externalRewardCeilingBaseRaw: "1000000",
          externalRewardCeilingBaseUsdc: 1,
          externalRewardCeilingRaiseRaw: "0",
          externalRewardCeilingRaiseUsdc: 0,
          openExposureCapRaw: "2500000",
          openExposureCapUsdc: 2.5,
          baseOpenExposureCapRaw: "2500000",
          baseOpenExposureCapUsdc: 2.5,
          openExposureRaiseRaw: "0",
          openExposureRaiseUsdc: 0,
          nextConcurrentRaiseAmountRaw: "0",
          vestingHours: 48,
          vestingAvailable: true
        };
      }
    },
    workerDailyExposurePolicy: {
      progressionConfig: () => ({
        rolling24hRaw: "1500000",
        rolling24hUsdc: 1.5,
        graduationSettledJobs: 10
      })
    }
  });
  return {
    healthWarnings: authors.warnings,
    adminStatusGithubAuthors: authors,
    arrivals,
    transparency: flow,
    progression: {
      tagged: await progression.getProgression(TAGGED),
      marked: await progression.getProgression(MARKED)
    },
    classify: {
      outsider: registry.classify({ wallet: OUTSIDER, session: sessions[0] }),
      tagged: registry.classify({ wallet: TAGGED, session: sessions[1] }),
      prefixed: registry.classify({ wallet: PREFIXED, session: sessions[2] }),
      marked: registry.classify({ wallet: MARKED, session: sessions[3] }),
      invalidMarker: registry.classify({
        wallet: OPERATOR,
        canaryMarkerValid: false,
        session: sessions[2]
      }),
      sessions: registry.classifySessions({ wallet: TAGGED, sessions: [sessions[1]] })
    }
  };
}

test("an empty ours list matches main across health, admin status, arrivals, transparency, and progression", async () => {
  const mainModule = await import(loadMainRegistryHref());
  const sessions = fixtures();
  const mainRegistry = new mainModule.SelfIdentityRegistry();
  const current = new SelfIdentityRegistry();
  await current.hydrateAdminOurs({ getServiceState: async () => ({ wallets: [] }) });
  const before = await project(mainRegistry, sessions);
  const after = await project(current, sessions);
  assert.equal(after.classify.tagged.evidence, "unlisted_wallet");
  assert.equal(after.classify.prefixed.evidence, "unlisted_wallet");
  assert.deepEqual(after, before);
  assert.equal(after.progression.tagged == null, false);
  assert.equal(after.progression.marked, undefined);
  assert.equal(after.healthWarnings.some((warning) => warning.code === "github_lane_claim_burst"), true);
});
