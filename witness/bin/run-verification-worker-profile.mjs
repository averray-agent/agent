#!/usr/bin/env node

const profile = process.argv[2];
const roots = {
  testnet: "/srv/agent-stack",
  mainnet: "/srv/agent-stack-mainnet"
};
const root = roots[profile];
if (!root) throw new Error("Usage: run-verification-worker-profile.mjs testnet|mainnet");

process.env.WITNESS_VERIFY_QUEUE_ROOT = `${root}/verify-queue`;
process.env.WITNESS_TEMP_ROOT = `${root}/witness-work`;
await import("./run-verification-queue-worker.mjs");
