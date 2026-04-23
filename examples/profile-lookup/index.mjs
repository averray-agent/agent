#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { AgentPlatformClient } from "../../sdk/agent-platform-client.js";

const DEFAULT_API_URL = "https://api.averray.com";
const DEFAULT_WALLET = "0xFd2EAE2043243fDdD2721C0b42aF1b8284Fd6519";

if (isMain()) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    process.exit(0);
  }
  const summary = await runProfileLookup({
    apiUrl: options.apiUrl ?? process.env.API_URL ?? DEFAULT_API_URL,
    wallet: options.wallet ?? process.env.WALLET ?? DEFAULT_WALLET
  });
  console.log(JSON.stringify(summary, null, 2));
}

export async function runProfileLookup({
  apiUrl = DEFAULT_API_URL,
  wallet = DEFAULT_WALLET,
  fetchImpl = fetch
} = {}) {
  if (!/^0x[a-fA-F0-9]{40}$/u.test(wallet)) {
    throw new Error("wallet must be a 0x-prefixed 20-byte hex address.");
  }

  const client = new AgentPlatformClient({
    baseUrl: apiUrl,
    fetchImpl
  });

  const [manifest, schemas, lifecycle, profile] = await Promise.all([
    client.getDiscoveryManifest(),
    client.listJobSchemas(),
    client.getSessionStateMachine(),
    client.getAgentProfile(wallet)
  ]);

  return buildProfileLookupSummary({
    apiUrl: client.baseUrl,
    wallet,
    manifest,
    schemas,
    lifecycle,
    profile
  });
}

export function buildProfileLookupSummary({
  apiUrl,
  wallet,
  manifest,
  schemas,
  lifecycle,
  profile
}) {
  return {
    apiUrl,
    wallet: String(profile?.wallet ?? wallet).toLowerCase(),
    discovery: {
      name: manifest?.name,
      mode: manifest?.discoveryMode,
      protocols: manifest?.protocols ?? []
    },
    schemas: {
      count: Number(schemas?.count ?? schemas?.schemas?.length ?? 0),
      names: Array.isArray(schemas?.schemas)
        ? schemas.schemas.map((entry) => entry.name ?? entry.$id).filter(Boolean)
        : []
    },
    lifecycle: {
      states: Array.isArray(lifecycle?.states) ? lifecycle.states.length : 0,
      transitions: Array.isArray(lifecycle?.transitions) ? lifecycle.transitions.length : 0
    },
    profile: {
      wallet: String(profile?.wallet ?? wallet).toLowerCase(),
      reputation: profile?.reputation ?? null,
      badgeCount: Number(profile?.badges?.length ?? profile?.stats?.badgeCount ?? 0),
      stats: profile?.stats ?? {}
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
  console.log(`Usage: node examples/profile-lookup/index.mjs [options]

Options:
  --api <url>       API base URL. Defaults to https://api.averray.com.
  --wallet <addr>   0x wallet to look up.
  --help            Show this help.

Environment:
  API_URL
  WALLET
`);
}

function isMain() {
  return import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
}
