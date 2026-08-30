#!/usr/bin/env node
/**
 * Replace the ratified GitHub report jobs with real PR jobs, then retire the
 * exact keyword-only benchmark listings named in docs/catalog-pr-shape.json.
 *
 * Safety properties:
 * - dry-run unless --commit is present;
 * - no discovery-by-pattern for destructive actions: only manifest-pinned IDs
 *   can be archived;
 * - every replacement must exist and be claimable before the first archive;
 * - the waiver-eligible claimable minimum is checked before every archive;
 * - a partial run can leave duplicates, but cannot remove an unexpected job or
 *   cross the onboarding inventory floor.
 *
 * Usage:
 *   node scripts/ops/reshape-catalog-pr-jobs.mjs
 *   ADMIN_KEY_OP="op://vault/item/private key" \
 *     node scripts/ops/reshape-catalog-pr-jobs.mjs --commit
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { Wallet } from "ethers";

const execFileAsync = promisify(execFile);
const DEFAULT_API_BASE_URL = "https://api.averray.com";
const MANIFEST_URL = new URL("../../docs/catalog-pr-shape.json", import.meta.url);
const REAL_INGESTION_SOURCES = new Set([
  "github_issue",
  "open_data_dataset",
  "openapi_spec",
  "osv_advisory",
  "standards_spec",
  "wikipedia_article"
]);

export async function loadCatalogPrShapeManifest() {
  return JSON.parse(await readFile(MANIFEST_URL, "utf8"));
}

export function catalogInventory(jobs) {
  const listed = Array.isArray(jobs) ? jobs : [];
  const claimableJobs = listed.filter((job) => job?.claimable === true).length;
  const waiverEligibleJobs = listed.filter(isRealWaiverEligibleJob).length;
  const waiverEligibleClaimableJobs = listed.filter((job) => (
    isRealWaiverEligibleJob(job) && job?.claimable === true
  )).length;
  return { claimableJobs, waiverEligibleJobs, waiverEligibleClaimableJobs };
}

export function buildCatalogReshapePlan(jobs, manifest) {
  assertManifestIsBounded(manifest);
  const byId = new Map(jobs.map((job) => [job.id, job]));
  const creates = [];
  for (const replacement of manifest.replacements) {
    const existing = byId.get(replacement.job.id);
    if (existing) {
      assertReplacementMatches(existing, replacement);
    } else {
      creates.push(replacement.job);
    }
  }

  const retires = [];
  for (const retirement of manifest.retirements) {
    const existing = byId.get(retirement.id);
    if (!existing) continue;
    assertRetirementMatches(existing, retirement);
    retires.push(retirement);
  }

  const projected = [
    ...jobs,
    ...creates.map((job) => ({ ...job, claimable: true }))
  ].filter((job) => !manifest.retirements.some((retirement) => retirement.id === job.id));
  assertProjectedCatalog(projected, manifest.minimumClaimableInventory);

  return {
    creates,
    retires,
    before: catalogInventory(jobs),
    after: catalogInventory(projected),
    projectedVerifierMix: verifierMix(projected)
  };
}

export function assertRetirementStepSafe(jobs, manifest, retirementId) {
  const replacements = manifest.replacements.map(({ job }) => (
    jobs.find((candidate) => candidate.id === job.id)
  ));
  if (replacements.some((job) => !job || job.claimable !== true)) {
    throw new Error("Every github_pr replacement must be listed and claimable before retirement.");
  }
  const projected = jobs.filter((job) => job.id !== retirementId);
  const inventory = catalogInventory(projected);
  if (inventory.waiverEligibleClaimableJobs < manifest.minimumClaimableInventory) {
    throw new Error(
      `Archiving ${retirementId} would leave ${inventory.waiverEligibleClaimableJobs} `
      + `waiver-eligible claimable jobs; minimum is ${manifest.minimumClaimableInventory}.`
    );
  }
  return inventory;
}

export async function executeCatalogReshape({
  apiBaseUrl,
  fetchImpl,
  manifest,
  token
}) {
  let jobs = await listPublicJobs(fetchImpl, apiBaseUrl);
  const initialPlan = buildCatalogReshapePlan(jobs, manifest);
  await assertHealthAgreement(fetchImpl, apiBaseUrl, jobs);

  for (const job of initialPlan.creates) {
    await requestJson(fetchImpl, `${apiBaseUrl}/admin/jobs`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        ...job,
        idempotencyKey: `${manifest.bundleId}:create:${job.id}`
      })
    });
  }

  jobs = await listPublicJobs(fetchImpl, apiBaseUrl);
  assertReplacementGate(jobs, manifest);

  for (const retirement of manifest.retirements) {
    jobs = await listPublicJobs(fetchImpl, apiBaseUrl);
    const existing = jobs.find((job) => job.id === retirement.id);
    if (!existing) continue;
    assertRetirementMatches(existing, retirement);
    assertRetirementStepSafe(jobs, manifest, retirement.id);
    await requestJson(fetchImpl, `${apiBaseUrl}/admin/jobs/lifecycle`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        jobId: retirement.id,
        action: "archive",
        reason: `catalog-pr-shape ${manifest.bundleId}: ${retirement.reason}`
      })
    });
    const afterStep = await listPublicJobs(fetchImpl, apiBaseUrl);
    if (afterStep.some((job) => job.id === retirement.id)) {
      throw new Error(`Archive did not remove ${retirement.id} from public discovery.`);
    }
    if (catalogInventory(afterStep).waiverEligibleClaimableJobs < manifest.minimumClaimableInventory) {
      throw new Error(`Inventory floor crossed after archiving ${retirement.id}.`);
    }
  }

  jobs = await listPublicJobs(fetchImpl, apiBaseUrl);
  const finalPlan = buildCatalogReshapePlan(jobs, manifest);
  if (finalPlan.creates.length || finalPlan.retires.length) {
    throw new Error("Catalog reshape stopped before reaching its manifest-pinned final state.");
  }
  await waitForHealthAgreement(fetchImpl, apiBaseUrl, jobs);
  return {
    before: initialPlan.before,
    after: catalogInventory(jobs),
    verifierMix: verifierMix(jobs)
  };
}

function assertManifestIsBounded(manifest) {
  if (manifest?.schemaVersion !== "averray.catalog-pr-shape.v1") {
    throw new Error("Unexpected catalog PR-shape manifest schema.");
  }
  if (manifest?.replacements?.length !== 3 || manifest?.retirements?.length !== 6) {
    throw new Error("The ceremony is pinned to exactly three replacements and six retirements.");
  }
  const ids = [
    ...manifest.replacements.map(({ job }) => job.id),
    ...manifest.retirements.map(({ id }) => id)
  ];
  if (new Set(ids).size !== ids.length) throw new Error("Manifest IDs must be unique.");
  if (!Number.isInteger(manifest.minimumClaimableInventory) || manifest.minimumClaimableInventory < 1) {
    throw new Error("Manifest minimumClaimableInventory must be a positive integer.");
  }
}

function assertReplacementMatches(job, replacement) {
  const expected = replacement.job;
  const fields = [
    [job.verifierMode, "github_pr", "verifierMode"],
    [job.source?.type, "github_issue", "source.type"],
    [job.source?.repo, expected.source.repo, "source.repo"],
    [Number(job.source?.issueNumber), Number(expected.source.issueNumber), "source.issueNumber"],
    [job.rewardAsset, replacement.legacyEconomics.rewardAsset, "rewardAsset"],
    [Number(job.rewardAmount), Number(replacement.legacyEconomics.rewardAmount), "rewardAmount"],
    [job.tier, replacement.legacyEconomics.tier, "tier"],
    [job.estimatedDifficulty, replacement.legacyEconomics.estimatedDifficulty, "estimatedDifficulty"],
    [job.onboardingWaiverEligible, replacement.legacyEconomics.onboardingWaiverEligible, "onboardingWaiverEligible"],
    [job.requiresSponsoredGas, replacement.legacyEconomics.requiresSponsoredGas, "requiresSponsoredGas"]
  ];
  for (const [actual, wanted, field] of fields) {
    if (actual !== wanted) throw new Error(`Replacement ${expected.id} changed ${field}.`);
  }
  assertNoPullRequestProhibition(job);
}

function assertRetirementMatches(job, retirement) {
  const fields = [
    [job.source?.type, retirement.sourceType, "source.type"],
    [job.rewardAsset, retirement.rewardAsset, "rewardAsset"],
    [Number(job.rewardAmount), Number(retirement.rewardAmount), "rewardAmount"],
    [job.verifierMode, "benchmark", "verifierMode"]
  ];
  for (const [actual, wanted, field] of fields) {
    if (actual !== wanted) throw new Error(`Refusing to archive ${retirement.id}: ${field} drifted.`);
  }
  if (!isKeywordOnlyBenchmarkJob(job)) {
    throw new Error(`Refusing to archive ${retirement.id}: verifier is no longer keyword-only.`);
  }
}

function assertReplacementGate(jobs, manifest) {
  for (const replacement of manifest.replacements) {
    const job = jobs.find((candidate) => candidate.id === replacement.job.id);
    if (!job) throw new Error(`Replacement ${replacement.job.id} is not publicly listed.`);
    assertReplacementMatches(job, replacement);
    if (job.claimable !== true) {
      throw new Error(`Replacement ${replacement.job.id} is not claimable; no legacy job will retire.`);
    }
  }
}

function assertProjectedCatalog(jobs, minimum) {
  for (const job of jobs) assertNoPullRequestProhibition(job);
  const unsafe = jobs.filter(isKeywordOnlyBenchmarkJob);
  if (unsafe.length) {
    throw new Error(`Projected catalog still contains non-failable verifiers: ${unsafe.map(({ id }) => id).join(", ")}`);
  }
  const inventory = catalogInventory(jobs);
  if (inventory.waiverEligibleClaimableJobs < minimum) {
    throw new Error(`Projected catalog has ${inventory.waiverEligibleClaimableJobs} waiver jobs; minimum is ${minimum}.`);
  }
}

function assertNoPullRequestProhibition(job) {
  const copy = JSON.stringify({
    title: job?.title,
    description: job?.description,
    acceptanceCriteria: job?.acceptanceCriteria,
    agentInstructions: job?.agentInstructions
  }).toLowerCase();
  if (/do not (?:open|create|submit)[^.!?]{0,40}pull request/u.test(copy)) {
    throw new Error(`Job ${job.id} still forbids its native pull-request artifact.`);
  }
}

function isKeywordOnlyBenchmarkJob(job) {
  if (!REAL_INGESTION_SOURCES.has(job?.source?.type)) return false;
  if (String(job?.verifierMode ?? "").toLowerCase() !== "benchmark") return false;
  if (job?.disposableProof === true) return false;
  return !(job?.verifierAnchorEvidence || job?.verifierConfig?.anchorEvidence);
}

function isRealWaiverEligibleJob(job) {
  return job?.tier === "starter"
    && job?.onboardingWaiverEligible === true
    && REAL_INGESTION_SOURCES.has(job?.source?.type);
}

function verifierMix(jobs) {
  return jobs.reduce((mix, job) => {
    const mode = isKeywordOnlyBenchmarkJob(job)
      ? "benchmark_keyword_only"
      : job.verifierMode === "benchmark"
        ? "benchmark_anchored"
        : String(job.verifierMode ?? "unknown");
    mix[mode] = Number(mix[mode] ?? 0) + 1;
    return mix;
  }, {});
}

async function assertHealthAgreement(fetchImpl, apiBaseUrl, jobs) {
  const health = await requestJson(fetchImpl, `${apiBaseUrl}/health`);
  const healthCount = health?.onboarding?.waiverEligibleClaimableJobs;
  const catalogCount = catalogInventory(jobs).waiverEligibleClaimableJobs;
  if (healthCount !== catalogCount) {
    throw new Error(
      `Health/catalog mismatch: health=${String(healthCount)}, catalog intersection=${catalogCount}. `
      + "No catalog mutation was attempted after this check."
    );
  }
}

async function waitForHealthAgreement(fetchImpl, apiBaseUrl, jobs, {
  timeoutMs = 70_000,
  pollMs = 5_000
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  do {
    try {
      await assertHealthAgreement(fetchImpl, apiBaseUrl, jobs);
      return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, pollMs));
  } while (Date.now() < deadline);
  throw lastError;
}

async function listPublicJobs(fetchImpl, apiBaseUrl) {
  const payload = await requestJson(fetchImpl, `${apiBaseUrl}/jobs`);
  if (!Array.isArray(payload)) throw new Error("GET /jobs did not return the full legacy array shape.");
  return payload;
}

async function requestJson(fetchImpl, url, init = undefined) {
  const response = await fetchImpl(url, init);
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    throw new Error(`${init?.method ?? "GET"} ${url} returned non-JSON HTTP ${response.status}.`);
  }
  if (!response.ok) {
    throw new Error(`${init?.method ?? "GET"} ${url} failed HTTP ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

function authHeaders(token) {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json"
  };
}

async function loadAdminWallet(opRef, execFileImpl = execFileAsync) {
  if (!String(opRef ?? "").startsWith("op://")) {
    throw new Error("ADMIN_KEY_OP must be a 1Password reference; raw private keys are refused.");
  }
  const { stdout } = await execFileImpl("op", ["read", opRef], { encoding: "utf8" });
  const raw = stdout.trim();
  try {
    return new Wallet(raw.startsWith("0x") ? raw : `0x${raw}`);
  } catch {
    throw new Error(`${opRef} did not resolve to a valid private key.`);
  }
}

async function signIn(fetchImpl, apiBaseUrl, wallet) {
  const nonce = await requestJson(fetchImpl, `${apiBaseUrl}/auth/nonce`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wallet: wallet.address })
  });
  const verified = await requestJson(fetchImpl, `${apiBaseUrl}/auth/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message: nonce.message,
      signature: await wallet.signMessage(nonce.message)
    })
  });
  if (!(verified?.roles ?? []).includes("admin")) throw new Error("Wallet is not an admin.");
  const token = verified?.token ?? verified?.accessToken;
  if (!token) throw new Error("Admin sign-in returned no access token.");
  return token;
}

async function main() {
  const commit = process.argv.includes("--commit");
  const apiBaseUrl = String(process.env.API_URL ?? DEFAULT_API_BASE_URL).replace(/\/+$/u, "");
  const manifest = await loadCatalogPrShapeManifest();
  const jobs = await listPublicJobs(fetch, apiBaseUrl);
  const plan = buildCatalogReshapePlan(jobs, manifest);
  await assertHealthAgreement(fetch, apiBaseUrl, jobs);
  console.log(JSON.stringify({
    commit,
    bundleId: manifest.bundleId,
    create: plan.creates.map(({ id }) => id),
    retire: plan.retires.map(({ id }) => id),
    before: plan.before,
    projectedAfter: plan.after,
    projectedVerifierMix: plan.projectedVerifierMix
  }, null, 2));
  if (!commit) {
    console.error("DRY RUN — no jobs created or archived. Re-run with --commit after reviewing this exact plan.");
    return;
  }
  const wallet = await loadAdminWallet(process.env.ADMIN_KEY_OP);
  const token = await signIn(fetch, apiBaseUrl, wallet);
  const result = await executeCatalogReshape({ apiBaseUrl, fetchImpl: fetch, manifest, token });
  console.log(JSON.stringify(result, null, 2));
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error?.message ?? error);
    process.exitCode = 1;
  });
}
