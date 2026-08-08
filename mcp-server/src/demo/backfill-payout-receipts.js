import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createRpcProvider } from "../blockchain/rpc-provider.js";
import { createStateStore } from "../core/state-store.js";
import { backfillPayoutReceipts } from "../services/payout-receipt-backfill.js";

const CHAIN_IDS = Object.freeze({
  testnet: 420420417,
  mainnet: 420420419
});
const repoRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const { commit, sessionIds } = parseArguments(process.argv.slice(2));
const profile = String(process.env.BLOCKCHAIN_PROFILE ?? "mainnet").trim();
const expectedChainId = CHAIN_IDS[profile];
if (!expectedChainId) {
  throw new Error(`Unsupported BLOCKCHAIN_PROFILE ${JSON.stringify(profile)}.`);
}
if (!String(process.env.REDIS_URL ?? "").trim()) {
  throw new Error("REDIS_URL is required; payout receipt backfill refuses an ephemeral state store.");
}

const manifestPath = resolve(repoRoot, "deployments", `${profile}.json`);
const deployment = JSON.parse(readFileSync(manifestPath, "utf8"));
if (deployment.profile !== profile) {
  throw new Error(`${manifestPath} declares profile ${deployment.profile}, expected ${profile}.`);
}
const rpcUrls = [
  String(process.env.RPC_URL ?? deployment.rpcUrl ?? "").trim(),
  ...splitUrls(process.env.RPC_BACKUP_URLS),
  ...(Array.isArray(deployment.rpcBackupUrls) ? deployment.rpcBackupUrls : [])
].filter(Boolean);
const provider = createRpcProvider({
  rpcUrls: [...new Set(rpcUrls)],
  rpcRequestTimeoutMs: 15_000,
  rpcFailoverStallMs: 1_000
});
const stateStore = createStateStore(process.env, { logger: { warn() {} } });

try {
  const result = await backfillPayoutReceipts({
    stateStore,
    provider,
    deployment,
    expectedChainId,
    commit,
    sessionIds
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await Promise.allSettled([
    provider.destroy?.(),
    stateStore.client?.quit?.()
  ]);
}

function parseArguments(args) {
  let commit = false;
  const sessionIds = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--commit") {
      commit = true;
      continue;
    }
    if (argument === "--session-id") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--session-id requires a value.");
      sessionIds.push(value);
      index += 1;
      continue;
    }
    if (argument.startsWith("--session-id=")) {
      const value = argument.slice("--session-id=".length);
      if (!value) throw new Error("--session-id requires a value.");
      sessionIds.push(value);
      continue;
    }
    throw new Error(
      "Usage: node src/demo/backfill-payout-receipts.js [--session-id <id>]... [--commit]"
    );
  }
  return { commit, sessionIds: [...new Set(sessionIds)] };
}

function splitUrls(value) {
  return String(value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}
