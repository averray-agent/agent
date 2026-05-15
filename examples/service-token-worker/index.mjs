#!/usr/bin/env node
//
// Minimal worker-shaped service-token example.
//
// Shows the *shape* of how an external agent uses a scoped service
// token against the Averray API. Intentionally only reads safe
// endpoints (`/health`, `/agents/:wallet`) so a misconfigured copy
// of this script cannot mutate state. The capability bundles
// referenced in this file are also validated by the colocated
// `index.test.mjs` against the runtime capability registry — so a
// future capability rename surfaces as a test failure instead of as
// silently-broken docs.
//
// This file does NOT issue, rotate, or revoke tokens. Those calls
// require an admin JWT, and live token administration is an
// operator-only action. See `docs/SERVICE_TOKEN_OPERATOR_PACK.md`.

import { pathToFileURL } from "node:url";

import { AgentPlatformClient } from "../../sdk/agent-platform-client.js";

const DEFAULT_API_URL = "https://api.averray.com";

/**
 * Recommended low-privilege bundles by worker shape. Every bundle is
 * validated against the runtime capability registry (no admin:*
 * capabilities; every name is a real capability). If you need a
 * shape not listed here, derive it from the route rules in
 * `mcp-server/src/auth/capabilities.js` — list the routes you hit,
 * union their required capabilities, never widen.
 */
export const WORKER_CAPABILITY_BUNDLES = Object.freeze({
  discoveryReader: Object.freeze([
    "agents:list",
    "badges:list",
    "reputation:read"
  ]),
  jobClaimerSubmitter: Object.freeze([
    "jobs:list",
    "jobs:claim",
    "jobs:preflight",
    "jobs:submit"
  ]),
  schemaAwareClaimer: Object.freeze([
    "jobs:list",
    "jobs:claim",
    "jobs:preflight",
    "jobs:submit",
    "session:read",
    "session:timeline"
  ]),
  accountAllocator: Object.freeze([
    "account:read",
    "account:allocate",
    "account:deallocate",
    "strategies:list"
  ]),
  readOnlyObserver: Object.freeze([
    "agents:list",
    "badges:list",
    "events:read",
    "reputation:read",
    "session:read",
    "session:timeline"
  ])
});

if (isMain()) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    process.exit(0);
  }
  const summary = await runServiceTokenWorker({
    apiUrl: options.apiUrl ?? process.env.API_URL ?? DEFAULT_API_URL,
    token: options.token ?? process.env.AVERRAY_WORKER_TOKEN,
    wallet: options.wallet ?? process.env.WORKER_WALLET
  });
  console.log(JSON.stringify(summary, null, 2));
}

/**
 * Demonstrates a worker token making read-only calls. Does NOT
 * mutate state. Throws if `token` is missing rather than falling
 * through to anonymous reads — the point of this example is to show
 * the auth-header path.
 */
export async function runServiceTokenWorker({
  apiUrl = DEFAULT_API_URL,
  token,
  wallet,
  fetchImpl = fetch
} = {}) {
  if (typeof token !== "string" || !token.trim()) {
    throw new Error(
      "A worker service token is required. Set AVERRAY_WORKER_TOKEN or pass --token. See docs/SERVICE_TOKEN_OPERATOR_PACK.md."
    );
  }
  if (typeof wallet !== "string" || !/^0x[a-fA-F0-9]{40}$/u.test(wallet)) {
    throw new Error("wallet must be a 0x-prefixed 20-byte hex address.");
  }

  const client = new AgentPlatformClient({
    baseUrl: apiUrl,
    token,
    fetchImpl
  });

  // Hit a public endpoint first to confirm the client wiring; then
  // hit one authenticated read so the token's auth-header path is
  // exercised. No mutations.
  const [health, profile] = await Promise.all([
    client.getHealth(),
    client.getAgentProfile(wallet)
  ]);

  return buildWorkerSummary({
    apiUrl: client.baseUrl,
    wallet,
    health,
    profile
  });
}

export function buildWorkerSummary({ apiUrl, wallet, health, profile }) {
  return {
    apiUrl,
    wallet: String(profile?.wallet ?? wallet).toLowerCase(),
    health: {
      ok: Boolean(health?.ok ?? health?.status === "ok"),
      status: health?.status
    },
    profile: {
      wallet: String(profile?.wallet ?? wallet).toLowerCase(),
      reputation: profile?.reputation ?? null,
      badgeCount: Number(profile?.badges?.length ?? profile?.stats?.badgeCount ?? 0)
    }
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
    if (arg === "--wallet") {
      parsed.wallet = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function printHelp() {
  console.log(`Usage: node examples/service-token-worker/index.mjs [options]

Demonstrates a scoped service token making safe read-only calls
against the Averray API. Does NOT issue, rotate, or revoke tokens —
those are admin actions covered in docs/SERVICE_TOKEN_OPERATOR_PACK.md.

Options:
  --api <url>       API base URL. Defaults to https://api.averray.com.
  --token <jwt>     Worker service token (or AVERRAY_WORKER_TOKEN env).
  --wallet <addr>   The worker wallet's 0x address to look up.
  --help            Show this help.

Environment:
  API_URL
  AVERRAY_WORKER_TOKEN
  WORKER_WALLET

Recommended capability bundles for issuing the token are exported as
WORKER_CAPABILITY_BUNDLES from this module. See
docs/SERVICE_TOKEN_OPERATOR_PACK.md for the full operator runbook.
`);
}

function isMain() {
  return import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
}
