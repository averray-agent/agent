#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SHA_PATTERN = /^[0-9a-f]{40}$/u;

export function decideWorkerCanaryTrigger({
  changedFiles = [],
  eventName,
  workflowConclusion = "",
  deployChanged = false,
  deployedSha,
  greenCanaryExists = false,
  profile = "testnet",
  recentGreenMainnetCanaryExists = false,
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

  if (isDocsOnlyDeploy(changedFiles)) {
    return decision(
      false,
      "docs_only_deploy",
      deployedSha,
      "Deploy diff contains only docs/ or Markdown files; skipping the paid lifecycle walk.",
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

  if (profile === "mainnet" && recentGreenMainnetCanaryExists === true) {
    return decision(
      false,
      "recent_green_mainnet_canary",
      deployedSha,
      "A green mainnet canary completed within the last 6 hours; deploy-triggered proof spend is debounced.",
    );
  }

  return decision(
    true,
    "new_deployed_sha",
    deployedSha,
    `Deploy Production changed the running system and SHA ${deployedSha} has no green canary marker.`,
  );
}

export function isDocsOnlyDeploy(changedFiles = []) {
  return Array.isArray(changedFiles)
    && changedFiles.length > 0
    && changedFiles.every((candidate) => {
      const path = String(candidate ?? "").trim();
      return path.startsWith("docs/") || path.toLowerCase().endsWith(".md");
    });
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

function parseChangedFiles(raw) {
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("WORKER_CANARY_CHANGED_FILES_JSON must be valid JSON.");
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new Error("WORKER_CANARY_CHANGED_FILES_JSON must be an array of non-empty path strings.");
  }
  return parsed;
}

function runCli() {
  const result = decideWorkerCanaryTrigger({
    changedFiles: parseChangedFiles(process.env.WORKER_CANARY_CHANGED_FILES_JSON),
    eventName: process.env.WORKER_CANARY_EVENT_NAME,
    workflowConclusion: process.env.WORKER_CANARY_WORKFLOW_CONCLUSION ?? "",
    deployChanged: parseBoolean("WORKER_CANARY_DEPLOY_CHANGED"),
    deployedSha: process.env.WORKER_CANARY_DEPLOYED_SHA,
    greenCanaryExists: parseBoolean("WORKER_CANARY_GREEN_EXISTS"),
    profile: process.env.WORKER_CANARY_PROFILE || "testnet",
    recentGreenMainnetCanaryExists: parseBoolean("WORKER_CANARY_RECENT_GREEN_MAINNET_EXISTS"),
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
