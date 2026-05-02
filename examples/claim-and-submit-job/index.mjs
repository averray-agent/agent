#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { AgentPlatformClient } from "../../sdk/agent-platform-client.js";

const DEFAULT_API_URL = "https://api.averray.com";

if (isMain()) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    process.exit(0);
  }
  const summary = await runClaimAndSubmit({
    apiUrl: options.apiUrl ?? process.env.API_URL ?? DEFAULT_API_URL,
    token: options.token ?? process.env.AVERRAY_TOKEN,
    jobId: options.jobId ?? process.env.JOB_ID,
    idempotencyKey: options.idempotencyKey ?? process.env.IDEMPOTENCY_KEY,
    evidence: options.evidence,
    submission: options.submission,
    execute: Boolean(options.execute)
  });
  console.log(JSON.stringify(summary, null, 2));
}

export async function runClaimAndSubmit({
  apiUrl = DEFAULT_API_URL,
  token = undefined,
  jobId,
  idempotencyKey = undefined,
  evidence = undefined,
  submission = undefined,
  execute = false,
  fetchImpl = fetch
} = {}) {
  if (!jobId) {
    throw new Error("jobId is required.");
  }
  if (execute && !token) {
    throw new Error("AVERRAY_TOKEN or --token is required when --execute is set.");
  }
  if (execute && evidence === undefined && submission === undefined) {
    throw new Error("--evidence or --submission-json is required when --execute is set.");
  }

  const client = new AgentPlatformClient({ baseUrl: apiUrl, token, fetchImpl });
  const [onboarding, definition, preflight] = await Promise.all([
    client.getOnboarding(),
    client.getJobDefinition(jobId),
    token ? client.preflightJob(jobId) : Promise.resolve(undefined)
  ]);
  const readiness = buildReadinessSummary({ onboarding, definition, preflight, tokenPresent: Boolean(token) });

  if (!execute) {
    return {
      apiUrl: client.baseUrl,
      jobId,
      mode: "dry_run",
      readiness,
      nextStep: token
        ? "Review readiness, then rerun with --execute plus --evidence or --submission-json."
        : "Sign in with SIWE, set AVERRAY_TOKEN, then rerun with --execute."
    };
  }

  if (!readiness.canAttemptClaim) {
    return {
      apiUrl: client.baseUrl,
      jobId,
      mode: "blocked",
      readiness,
      validation: null,
      claim: null,
      submit: null
    };
  }

  const draftSubmission = submission ?? evidence;
  const validation = await client.validateJobSubmission(jobId, draftSubmission);
  if (!validation?.valid) {
    return {
      apiUrl: client.baseUrl,
      jobId,
      mode: "blocked",
      readiness,
      validation,
      claim: null,
      submit: null
    };
  }

  const claim = await client.claimJob(jobId, idempotencyKey);
  const sessionId = claim?.sessionId;
  if (!sessionId) {
    throw new Error("claim response did not include sessionId.");
  }

  const submit = await client.submitWork(sessionId, draftSubmission);
  const timeline = await client.getSessionTimeline(sessionId);

  return {
    apiUrl: client.baseUrl,
    jobId,
    mode: "executed",
    readiness,
    claim: {
      sessionId,
      status: claim.status,
      claimExpiresAt: claim.claimExpiresAt ?? claim.deadline ?? null
    },
    validation,
    submit: {
      sessionId: submit?.sessionId ?? sessionId,
      status: submit?.status ?? null,
      updatedAt: submit?.updatedAt ?? null
    },
    timeline: summarizeTimeline(timeline)
  };
}

export function buildReadinessSummary({ onboarding, definition, preflight, tokenPresent }) {
  const claimStatus = definition?.claimStatus ?? {};
  const preflightClaimable = preflight?.claimable ?? preflight?.eligible ?? preflight?.allowed;
  const definitionClaimable = claimStatus.claimable ?? definition?.claimable;
  const claimable = preflightClaimable ?? definitionClaimable ?? false;
  const reason = preflight?.reason ?? claimStatus.reason ?? definition?.reason ?? null;
  return {
    tokenPresent,
    onboardingEntrypoint: onboarding?.onboarding?.entrypoint ?? onboarding?.entrypoint ?? "/onboarding",
    jobId: definition?.id ?? definition?.jobId ?? null,
    title: definition?.title ?? null,
    claimState: claimStatus.claimState ?? definition?.claimState ?? null,
    claimable: Boolean(claimable),
    reason,
    retryLimit: claimStatus.retryLimit ?? definition?.retryLimit ?? null,
    remainingClaimAttempts: claimStatus.remainingClaimAttempts ?? definition?.remainingClaimAttempts ?? null,
    canAttemptClaim: Boolean(tokenPresent && claimable)
  };
}

export function summarizeTimeline(timeline) {
  const entries = Array.isArray(timeline?.timeline) ? timeline.timeline : [];
  return {
    timelineVersion: timeline?.timelineVersion ?? null,
    sessionStatus: timeline?.session?.status ?? null,
    eventCount: entries.length,
    eventTypes: [...new Set(entries.map((entry) => entry.type).filter(Boolean))]
  };
}

export function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--execute") {
      parsed.execute = true;
      continue;
    }
    if (arg === "--api") {
      parsed.apiUrl = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--token") {
      parsed.token = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--job-id") {
      parsed.jobId = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--idempotency-key") {
      parsed.idempotencyKey = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--evidence") {
      parsed.evidence = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--submission-json") {
      parsed.submission = JSON.parse(argv[index + 1]);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function printHelp() {
  console.log(`Usage: node examples/claim-and-submit-job/index.mjs --job-id <id> [options]

Dry-run mode reads onboarding, definition, and preflight without mutating.
Add --execute to claim once and submit once.

Options:
  --api <url>                API base URL. Defaults to https://api.averray.com.
  --token <jwt>              Bearer token. Or set AVERRAY_TOKEN.
  --job-id <id>              Job id to inspect or execute.
  --idempotency-key <key>    Claim idempotency key.
  --evidence <text>          Plain-text evidence for /jobs/submit.
  --submission-json <json>   Structured submission object for /jobs/submit.
  --execute                  Perform claim and submit mutations.
  --help                     Show this help.

Environment:
  API_URL
  AVERRAY_TOKEN
  JOB_ID
  IDEMPOTENCY_KEY
`);
}

function isMain() {
  return import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
}
