#!/usr/bin/env node

import { createStateStore } from "../core/state-store.js";
import {
  UpstreamStatusPollerService,
  loadUpstreamStatusPollerConfig
} from "../services/upstream-status-poller.js";

export function parseArgs(argv) {
  const parsed = { poll: false, report: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    if (key === "poll") {
      parsed.poll = true;
      continue;
    }
    if (key === "report") {
      parsed.report = true;
      continue;
    }
    const next = argv[index + 1];
    parsed[key] = next && !next.startsWith("--") ? next : true;
    if (next && !next.startsWith("--")) index += 1;
  }
  if (!parsed.poll && !parsed.report) {
    parsed.poll = true;
    parsed.report = true;
  }
  return parsed;
}

export async function runBootstrapUpstreamStatusCli({
  argv = process.argv.slice(2),
  env = process.env,
  fetchImpl = fetch,
  stdout = process.stdout,
  logger = console
} = {}) {
  const args = parseArgs(argv);
  const stateStore = createStateStore(env, { logger });
  const poller = new UpstreamStatusPollerService(stateStore, undefined, {
    ...loadUpstreamStatusPollerConfig(env),
    enabled: true,
    fetchImpl,
    logger
  });
  const result = {};
  if (args.poll) {
    result.poll = await poller.runOnce(new Date(args.now ?? Date.now()));
  }
  if (args.report) {
    result.report = await poller.generateWeeklyReport({
      now: new Date(args.now ?? Date.now()),
      from: args.from,
      to: args.to
    });
  }
  stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  await stateStore.client?.quit?.();
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runBootstrapUpstreamStatusCli().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
