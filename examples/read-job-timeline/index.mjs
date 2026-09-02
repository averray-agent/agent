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
  const summary = await runTimelineLookup({
    apiUrl: options.apiUrl ?? process.env.API_URL ?? DEFAULT_API_URL,
    token: options.token ?? process.env.AVERRAY_TOKEN,
    jobId: options.jobId ?? process.env.JOB_ID,
    sessionId: options.sessionId ?? process.env.SESSION_ID,
    limit: options.limit
  });
  console.log(JSON.stringify(summary, null, 2));
}

export async function runTimelineLookup({
  apiUrl = DEFAULT_API_URL,
  token = undefined,
  jobId = undefined,
  sessionId = undefined,
  limit = undefined,
  fetchImpl = fetch
} = {}) {
  if (!jobId && !sessionId) {
    throw new Error("jobId or sessionId is required.");
  }
  const client = new AgentPlatformClient({ baseUrl: apiUrl, token, fetchImpl });
  const timeline = jobId
    ? await client.getJobTimeline(jobId, { limit })
    : await client.getSessionTimeline(sessionId);
  return buildTimelineSummary({ apiUrl: client.baseUrl, jobId, sessionId, timeline });
}

export function buildTimelineSummary({ apiUrl, jobId, sessionId, timeline }) {
  const events = Array.isArray(timeline?.timeline) ? timeline.timeline : [];
  return {
    apiUrl,
    kind: jobId ? "job" : "session",
    jobId: timeline?.job?.id ?? jobId ?? timeline?.session?.jobId ?? null,
    sessionId: timeline?.session?.sessionId ?? sessionId ?? null,
    timelineVersion: timeline?.timelineVersion ?? null,
    summary: timeline?.summary ?? null,
    lineage: timeline?.lineage ?? null,
    eventCount: events.length,
    eventTypes: [...new Set(events.map((event) => event.type).filter(Boolean))],
    latestEvent: events.at(-1) ?? null
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
    if (arg === "--session-id") {
      parsed.sessionId = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--limit") {
      parsed.limit = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function printHelp() {
  console.log(`Usage: node examples/read-job-timeline/index.mjs [options]

Options:
  --api <url>          API base URL. Defaults to https://api.averray.com.
  --token <jwt>        Bearer token. Or set AVERRAY_TOKEN.
  --job-id <id>        Read admin job timeline for a job.
  --session-id <id>    Read wallet-owned session timeline.
  --limit <n>          Max job-session history to include for job timelines.
  --help               Show this help.

Environment:
  API_URL
  AVERRAY_TOKEN
  JOB_ID
  SESSION_ID
`);
}

function isMain() {
  return import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
}
