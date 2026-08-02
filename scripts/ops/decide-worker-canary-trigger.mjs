#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SHA_PATTERN = /^[0-9a-f]{40}$/u;

export function decideWorkerCanaryTrigger({
  eventName,
  workflowConclusion = "",
  deployChanged = false,
  deployedSha,
  greenCanaryExists = false,
}) {
  assertSha(deployedSha);

  if (eventName === "schedule") {
    return decision(true, "daily_heartbeat", deployedSha, "Daily 06:37 UTC heartbeat always runs.");
  }

  if (eventName === "workflow_dispatch") {
    return decision(true, "manual_dispatch", deployedSha, "Manual dispatch explicitly requested a canary run.");
  }

  if (eventName !== "workflow_run") {
    throw new Error(`Unsupported worker-canary trigger event: ${eventName || "missing"}`);
  }

  if (workflowConclusion !== "success") {
    return decision(
      false,
      "deploy_not_successful",
      deployedSha,
      `Deploy Production concluded ${workflowConclusion || "unknown"}; there is no successful deploy to canary.`,
    );
  }

  if (deployChanged !== true) {
    return decision(
      false,
      "no_running_system_change",
      deployedSha,
      "Deploy Production reported no running-system change; skipping the paid lifecycle walk.",
    );
  }

  if (greenCanaryExists === true) {
    return decision(
      false,
      "green_sha_already_proven",
      deployedSha,
      `A green worker canary already proved deployed SHA ${deployedSha}; debounce is active.`,
    );
  }

  return decision(
    true,
    "new_deployed_sha",
    deployedSha,
    `Deploy Production changed the running system and SHA ${deployedSha} has no green canary marker.`,
  );
}

function decision(shouldRun, reason, deployedSha, summary) {
  return { shouldRun, reason, deployedSha, summary };
}

function assertSha(value) {
  if (!SHA_PATTERN.test(value ?? "")) {
    throw new Error(`Worker canary requires a full lowercase deployed SHA, got ${value || "missing"}.`);
  }
}

function parseBoolean(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be exactly true or false, got ${value}.`);
}

function runCli() {
  const result = decideWorkerCanaryTrigger({
    eventName: process.env.WORKER_CANARY_EVENT_NAME,
    workflowConclusion: process.env.WORKER_CANARY_WORKFLOW_CONCLUSION ?? "",
    deployChanged: parseBoolean("WORKER_CANARY_DEPLOY_CHANGED"),
    deployedSha: process.env.WORKER_CANARY_DEPLOYED_SHA,
    greenCanaryExists: parseBoolean("WORKER_CANARY_GREEN_EXISTS"),
  });

  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      [
        `should_run=${result.shouldRun}`,
        `reason=${result.reason}`,
        `deployed_sha=${result.deployedSha}`,
        `summary=${result.summary}`,
        "",
      ].join("\n"),
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli();
}
