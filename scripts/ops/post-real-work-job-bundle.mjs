#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_BUNDLE_FILE = "docs/real-work-jobs.json";
export const DEFAULT_API_URL = "https://api.averray.com";

export function parseArgs(argv) {
  const args = {
    apiUrl: process.env.API_URL ?? DEFAULT_API_URL,
    token: process.env.ADMIN_JWT ?? process.env.TOKEN ?? "",
    filePath: DEFAULT_BUNDLE_FILE,
    execute: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
      index += 1;
      return value;
    };
    if (flag === "--api") args.apiUrl = next();
    else if (flag === "--token") args.token = next();
    else if (flag === "--file") args.filePath = next();
    else if (flag === "--execute") args.execute = true;
    else if (flag === "--dry-run") args.execute = false;
    else if (flag === "--help" || flag === "-h") args.help = true;
    else throw new Error(`Unknown flag: ${flag}`);
  }
  return args;
}

export function validateBundle(bundle) {
  if (bundle?.schemaVersion !== "averray.real-work-job-bundle.v1") {
    throw new Error("The real-work bundle schemaVersion is missing or unsupported.");
  }
  if (bundle?.network?.chainId !== 420420419
      || bundle?.network?.asset !== "USDC"
      || bundle?.network?.assetId !== 1337) {
    throw new Error("The bundle must target USDC asset 1337 on Polkadot Hub chain 420420419.");
  }
  if (!Array.isArray(bundle.jobs) || bundle.jobs.length !== 3) {
    throw new Error("The ratified ceremony requires exactly three jobs; partial bundles are prohibited.");
  }
  const ids = new Set();
  for (const job of bundle.jobs) {
    if (!job?.id || ids.has(job.id)) throw new Error("Every real-work job must have a unique id.");
    ids.add(job.id);
    if (job.rewardAsset !== "USDC" || job.rewardAmount !== 2) {
      throw new Error(`${job.id} must carry the ratified 2 USDC reward.`);
    }
    if (job.onboardingWaiverEligible !== false) {
      throw new Error(`${job.id} must stay outside the onboarding-waiver subsidy.`);
    }
    if (job.requiresSponsoredGas !== true) {
      throw new Error(`${job.id} must use the ratified brokered-gas posture.`);
    }
    if (job.disposableProof === true) {
      throw new Error(`${job.id} is marked disposable and therefore is not real work.`);
    }
    if (job.source === "external" || job.source?.type === "external") {
      throw new Error(`${job.id} would be represented as external demand; stop without posting.`);
    }
  }
  const rewardTotal = bundle.jobs.reduce((total, job) => total + job.rewardAmount, 0);
  if (rewardTotal !== 6
      || bundle.funding?.rewardPerJob !== 2
      || bundle.funding?.rewardTotal !== 6
      || bundle.funding?.brokeredGasBudget !== 0.18
      || bundle.funding?.requiredBankBalance !== 6.18) {
    throw new Error("The bundle no longer matches the ratified 6.18 USDC funding plan.");
  }
  if (bundle.poster?.classification !== "operator-run"
      || bundle.poster?.postingRoute !== "curated"
      || bundle.poster?.contentTrust !== "operator-curated") {
    throw new Error("The bundle must remain honestly classified as operator-run curated work.");
  }
  return bundle;
}

export function assertLivePreflight({ bundle, onboarding, health, existingJobs }) {
  const chainIds = collectNamedValues(onboarding, "chainId").map(Number).filter(Number.isFinite);
  if (!chainIds.length || chainIds.some((chainId) => chainId !== bundle.network.chainId)) {
    throw new Error(`The public board is not consistently reporting Hub chain ${bundle.network.chainId}.`);
  }
  const bank = health?.rewardBank;
  if (bank?.readable !== true || bank?.asset !== bundle.network.asset) {
    throw new Error("The reward-bank reading is unavailable or reports the wrong asset.");
  }
  if (Number(bank.liquid) < bundle.funding.requiredBankBalance) {
    throw new Error(
      `Reward bank ${bank.liquid ?? "unknown"} ${bank.asset ?? "USDC"} cannot cover the ratified ${bundle.funding.requiredBankBalance}.`
    );
  }
  const selected = new Set(bundle.jobs.map(({ id }) => id));
  const present = existingJobs.filter((job) => selected.has(job.id));
  if (present.length !== 0 && present.length !== bundle.jobs.length) {
    throw new Error("Only part of the ratified bundle already exists; stop and reconcile before writing anything.");
  }
  return {
    bankLiquid: Number(bank.liquid),
    alreadyPresent: present.length === bundle.jobs.length
  };
}

export function assertServedBundle(bundle, servedJobs) {
  const byId = new Map(servedJobs.map((job) => [job.id, job]));
  for (const definition of bundle.jobs) {
    const job = byId.get(definition.id);
    if (!job) throw new Error(`${definition.id} is absent after the bundle ceremony.`);
    if (job.claimable !== true || job.effectiveState !== "claimable") {
      throw new Error(`${definition.id} is not claimable after posting.`);
    }
    if (job.reward?.asset !== "USDC" || Number(job.reward?.amount) !== 2) {
      throw new Error(`${definition.id} is serving the wrong reward.`);
    }
    if (job.onboardingWaiverEligible !== false) {
      throw new Error(`${definition.id} unexpectedly consumes the onboarding waiver.`);
    }
    if (job.contentTrust !== "operator-curated"
        || job.provenance?.posterTier !== "operator-curated"
        || job.provenance?.postingRoute !== "curated"
        || job.source === "external"
        || job.sourceType === "external") {
      throw new Error(`${definition.id} is misclassified as external demand; stop and report.`);
    }
  }
  return true;
}

export async function postRealWorkBundle({
  bundle,
  apiUrl = DEFAULT_API_URL,
  token = "",
  execute = false,
  fetchImpl = fetch,
  logger = console
}) {
  validateBundle(bundle);
  const baseUrl = trimTrailingSlash(apiUrl);
  const [onboarding, health, existing] = await Promise.all([
    readJson(fetchImpl, `${baseUrl}/onboarding`),
    readJson(fetchImpl, `${baseUrl}/health`),
    readJson(fetchImpl, `${baseUrl}/jobs`)
  ]);
  const existingJobs = Array.isArray(existing) ? existing : existing?.jobs ?? [];
  const preflight = assertLivePreflight({ bundle, onboarding, health, existingJobs });
  logger.log(
    `${bundle.bundleId}: 3 jobs, 2 USDC each, ${bundle.funding.requiredBankBalance} USDC plan, ${preflight.bankLiquid} USDC bank.`
  );

  if (!execute) {
    logger.log(preflight.alreadyPresent
      ? "Dry run: the complete bundle is already present; no write attempted."
      : `Dry run: would post ${bundle.jobs.map(({ id }) => id).join(", ")}.`);
    return { dryRun: true, ...preflight };
  }
  if (!token) throw new Error("--execute requires an admin token via --token or ADMIN_JWT.");

  if (!preflight.alreadyPresent) {
    for (const job of bundle.jobs) {
      await postJson(fetchImpl, `${baseUrl}/admin/jobs`, {
        ...job,
        idempotencyKey: `${bundle.bundleId}:${job.id}`
      }, token);
      logger.log(`Posted ${job.id}.`);
    }
  }

  const served = await readJson(fetchImpl, `${baseUrl}/jobs?limit=100&state=claimable`);
  assertServedBundle(bundle, Array.isArray(served) ? served : served?.jobs ?? []);
  logger.log("Verified: all three are claimable, operator-curated, non-waived, and serve 2 USDC rewards.");
  return { dryRun: false, alreadyPresent: preflight.alreadyPresent, verified: true };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Post the ratified three-job real-work bundle as one guarded ceremony.

Usage:
  node scripts/ops/post-real-work-job-bundle.mjs --dry-run
  ADMIN_JWT='<admin-jwt>' node scripts/ops/post-real-work-job-bundle.mjs --execute

Options:
  --api <url>    API base URL (default: https://api.averray.com)
  --file <path>  Bundle manifest (default: docs/real-work-jobs.json)
  --token <jwt>  Admin token; required only with --execute
  --execute      Post all three jobs; there is deliberately no partial selector
  --dry-run      Read and verify only (default)
`);
    return;
  }
  const absolutePath = resolve(process.cwd(), args.filePath);
  const bundle = JSON.parse(await readFile(absolutePath, "utf8"));
  await postRealWorkBundle({
    bundle,
    apiUrl: args.apiUrl,
    token: args.token,
    execute: args.execute
  });
}

function collectNamedValues(value, name, collected = []) {
  if (!value || typeof value !== "object") return collected;
  if (Object.hasOwn(value, name)) collected.push(value[name]);
  for (const child of Object.values(value)) collectNamedValues(child, name, collected);
  return collected;
}

async function readJson(fetchImpl, url) {
  const response = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!response?.ok) throw new Error(`GET ${url} failed: HTTP ${response?.status ?? "unknown"}.`);
  return response.json();
}

async function postJson(fetchImpl, url, body, token) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!response?.ok) {
    const detail = typeof response?.text === "function" ? await response.text() : "";
    throw new Error(`POST ${url} failed: HTTP ${response?.status ?? "unknown"} ${detail}`.trim());
  }
  return response.json();
}

function trimTrailingSlash(value) {
  return String(value).replace(/\/+$/u, "");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  });
}
