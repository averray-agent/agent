#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AgentPlatformClient } from "../../sdk/agent-platform-client.js";
import {
  HarnessDriver,
  assembleGithubPrSubmission,
  fetchJobDefinition,
  mapJobToTaskIntent,
  serializeIntent,
  slugifyJobId,
} from "../../worker/src/index.js";
import { resolveHostedWorkerLoopAuth } from "./run-hosted-worker-loop.mjs";

const DEFAULT_API_BASE_URL = "https://api.averray.com";
const DEFAULT_GITHUB_API_URL = "https://api.github.com";
const TESTNET_CHAIN_ID = 420420417;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const SAFE_REF = /^(?![-/])(?!.*(?:\.\.|\/\/))[A-Za-z0-9._/-]+(?<![/.])$/u;

export const BOUNTY_WORKER_EXIT = Object.freeze({
  ok: 0,
  usage: 64,
  credentialBoundary: 65,
  databaseUnavailable: 66,
  jobInvalid: 67,
  mappingWarnings: 68,
  cloneRefused: 69,
  claimRefused: 70,
  networkRefused: 71,
  verificationFailed: 72,
  handoffInvalid: 73,
  approvalRequired: 74,
  githubTokenUnavailable: 75,
  githubScopeRefused: 76,
  baseDrift: 77,
  prOpenRefused: 78,
  submitRefused: 79,
  evidenceRefused: 80,
  testnetRefused: 81,
});

class BountyWorkerError extends Error {
  constructor(codeName, exitCode, message) {
    super(message);
    this.name = "BountyWorkerError";
    this.codeName = codeName;
    this.exitCode = exitCode;
  }
}

export async function runBountyWorker({
  argv,
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  dependencies = {},
} = {}) {
  try {
    const options = parseArguments(argv ?? []);
    if (options.verb === "prepare") {
      await prepareBounty(options, env, stdout, dependencies);
    } else {
      await sendBounty(options, env, stdout, dependencies);
    }
    return BOUNTY_WORKER_EXIT.ok;
  } catch (error) {
    if (error instanceof BountyWorkerError) {
      stderr.write(`${error.codeName}: ${error.message}\n`);
      return error.exitCode;
    }
    stderr.write("BOUNTY_OPERATION_REFUSED: operation failed without exposing credential-bearing diagnostics\n");
    return optionsExitCode(argv?.[0]);
  }
}

async function prepareBounty(options, env, stdout, dependencies) {
  if (Object.prototype.hasOwnProperty.call(env, "GITHUB_INSTALLATION_TOKEN")) {
    fail(
      "BOUNTY_PREPARE_TOKEN_REFUSED",
      BOUNTY_WORKER_EXIT.credentialBoundary,
      "GITHUB_INSTALLATION_TOKEN must be absent from the database-bearing prepare shell",
    );
  }
  if (!text(env.HARNESS_DATABASE_URL)) {
    fail(
      "BOUNTY_DATABASE_UNAVAILABLE",
      BOUNTY_WORKER_EXIT.databaseUnavailable,
      "HARNESS_DATABASE_URL is required for prepare",
    );
  }
  const image = text(env.HARNESS_ENV_IMAGE);
  if (!image) {
    fail(
      "BOUNTY_NETWORK_REFUSED",
      BOUNTY_WORKER_EXIT.networkRefused,
      "HARNESS_ENV_IMAGE is required for the network-denied Docker run",
    );
  }

  const apiBaseUrl = resolveApiBaseUrl(env);
  const readJob = dependencies.fetchJobDefinition
    ?? ((jobId) => fetchJobDefinition(jobId, {
      baseUrl: apiBaseUrl,
      fetchImpl: dependencies.fetchImpl ?? globalThis.fetch,
    }));
  const job = await readJob(options.jobId);
  assertJob(job, options.jobId);

  const clone = dependencies.cloneRepository ?? cloneRepository;
  let checkout;
  try {
    checkout = await clone(job, options.workspacePath, dependencies);
  } catch (error) {
    if (error instanceof BountyWorkerError) throw error;
    fail(
      "BOUNTY_CLONE_REFUSED",
      BOUNTY_WORKER_EXIT.cloneRefused,
      "job source could not be cloned into a clean host-side workspace",
    );
  }
  assertCheckout(checkout, job, options.workspacePath);

  const mapped = (dependencies.mapJobToTaskIntent ?? mapJobToTaskIntent)(job, {
    workspacePath: checkout.workspacePath,
    revision: checkout.baseRevision,
  });
  const warnings = Array.isArray(mapped?.warnings) ? mapped.warnings.map(text).filter(Boolean) : [];
  if (warnings.length > 0) {
    fail(
      "BOUNTY_MAPPING_WARNINGS",
      BOUNTY_WORKER_EXIT.mappingWarnings,
      `submission is prohibited because mapping warnings are present: ${warnings.join(" | ")}`,
    );
  }
  const intentText = (dependencies.serializeIntent ?? serializeIntent)(mapped.intent);
  await writeNewFile(options.intentPath, intentText, "BOUNTY_INTENT_EXISTS");

  const platform = dependencies.platform ?? await createPlatformClient(env, dependencies);
  await assertTestnetPlatform(platform);
  let claim;
  try {
    const preflight = await platform.preflightJob(job.id);
    if (preflight?.eligible !== true || preflight?.claimable !== true) {
      fail(
        "BOUNTY_CLAIM_REFUSED",
        BOUNTY_WORKER_EXIT.claimRefused,
        `job preflight refused claim: eligible=${String(preflight?.eligible)} claimable=${String(preflight?.claimable)}`,
      );
    }
    claim = await platform.claimJob(
      job.id,
      `bounty:${slugifyJobId(job.id)}:${checkout.baseRevision}`,
    );
  } catch (error) {
    if (error instanceof BountyWorkerError) throw error;
    fail(
      "BOUNTY_CLAIM_REFUSED",
      BOUNTY_WORKER_EXIT.claimRefused,
      "the existing platform claim path refused the bounty",
    );
  }
  const sessionId = text(claim?.sessionId);
  if (!sessionId) {
    fail(
      "BOUNTY_CLAIM_REFUSED",
      BOUNTY_WORKER_EXIT.claimRefused,
      "claim response did not include a session id",
    );
  }

  const driver = dependencies.driver ?? new HarnessDriver({
    databaseUrl: env.HARNESS_DATABASE_URL,
    env: {
      HARNESS_ENV_PROVIDER: "docker",
      HARNESS_ENV_IMAGE: image,
    },
  });
  const runId = await driver.submit(options.intentPath);
  const inspectNetwork = dependencies.inspectNetworkMode ?? inspectRunNetworkMode;
  const networkMode = await inspectNetwork(runId, dependencies);
  if (networkMode !== "none") {
    fail(
      "BOUNTY_NETWORK_REFUSED",
      BOUNTY_WORKER_EXIT.networkRefused,
      `Harness run container NetworkMode must be none; observed ${networkMode || "unavailable"}`,
    );
  }

  const status = await driver.waitForOutcome(runId, {
    timeoutMs: numericEnv(env.BOUNTY_WORKER_TIMEOUT_MS, 30 * 60 * 1000),
    pollIntervalMs: numericEnv(env.BOUNTY_WORKER_POLL_INTERVAL_MS, 1_000),
  });
  if (status?.outcome !== "completed") {
    fail(
      "BOUNTY_VERIFICATION_FAILED",
      BOUNTY_WORKER_EXIT.verificationFailed,
      `Harness run ${runId} ended with outcome=${text(status?.outcome) || "missing"}`,
    );
  }
  const deliverables = await driver.deliverables(runId);
  const patchText = await readArtifactText(driver, deliverables.workspace_patch, "workspace_patch");
  const verificationText = await readArtifactText(
    driver,
    deliverables.verification_report,
    "verification_report",
  );
  const changeSummary = await readArtifactText(
    driver,
    deliverables.change_summary,
    "change_summary",
  );
  let verificationReport;
  try {
    verificationReport = JSON.parse(verificationText);
  } catch {
    fail(
      "BOUNTY_VERIFICATION_FAILED",
      BOUNTY_WORKER_EXIT.verificationFailed,
      "verification_report is not valid JSON",
    );
  }
  if (verificationReport?.passed !== true) {
    fail(
      "BOUNTY_VERIFICATION_FAILED",
      BOUNTY_WORKER_EXIT.verificationFailed,
      "verification_report.passed is not true",
    );
  }
  if (!patchText.trim()) {
    fail(
      "BOUNTY_VERIFICATION_FAILED",
      BOUNTY_WORKER_EXIT.verificationFailed,
      "completed run produced an empty workspace patch",
    );
  }

  const completedAt = new Date().toISOString();
  const packet = {
    schemaVersion: 1,
    kind: "averray_bounty_worker_handoff",
    job,
    sessionId,
    runId,
    status,
    mappingWarnings: warnings,
    repository: {
      nameWithOwner: job.source.repo,
      workspacePath: checkout.workspacePath,
      baseRef: checkout.baseRef,
      baseRevision: checkout.baseRevision,
    },
    deliverables: {
      patchText,
      patchSha256: digest(patchText),
      verificationReport,
      verificationSha256: digest(JSON.stringify(verificationReport)),
      changeSummary,
      changeSummarySha256: digest(changeSummary),
    },
    intent: {
      path: options.intentPath,
      sha256: digest(intentText),
    },
    network: {
      provider: "docker",
      mode: networkMode,
      containerName: `harness-run-${runId}`,
    },
    completedAt,
  };
  packet.contentSha256 = packetDigest(packet);
  await writeNewFile(
    options.handoffPath,
    `${JSON.stringify(packet, null, 2)}\n`,
    "BOUNTY_HANDOFF_EXISTS",
  );
  stdout.write(
    `BOUNTY_PREPARED run_id=${runId} session_id=${sessionId} network_mode=${networkMode} handoff=${options.handoffPath}\n`,
  );
}

async function sendBounty(options, env, stdout, dependencies) {
  if (Object.prototype.hasOwnProperty.call(env, "HARNESS_DATABASE_URL")) {
    fail(
      "BOUNTY_SEND_DATABASE_REFUSED",
      BOUNTY_WORKER_EXIT.credentialBoundary,
      "HARNESS_DATABASE_URL must be absent from the GitHub credential-bearing send shell",
    );
  }
  const packet = await loadHandoff(options.handoffPath);
  assertPacket(packet);
  if (packet.mappingWarnings.length > 0) {
    fail(
      "BOUNTY_MAPPING_WARNINGS",
      BOUNTY_WORKER_EXIT.mappingWarnings,
      "submission is prohibited because the prepared mapping contains warnings",
    );
  }
  if (packet.deliverables.verificationReport?.passed !== true) {
    fail(
      "BOUNTY_VERIFICATION_FAILED",
      BOUNTY_WORKER_EXIT.verificationFailed,
      "submission is prohibited because verification_report.passed is not true",
    );
  }
  if (options.confirm !== packet.repository.nameWithOwner) {
    fail(
      "BOUNTY_APPROVAL_REQUIRED",
      BOUNTY_WORKER_EXIT.approvalRequired,
      `--confirm must exactly repeat ${packet.repository.nameWithOwner} before any GitHub call`,
    );
  }
  const installationToken = text(env.GITHUB_INSTALLATION_TOKEN);
  if (!installationToken) {
    fail(
      "BOUNTY_GITHUB_TOKEN_UNAVAILABLE",
      BOUNTY_WORKER_EXIT.githubTokenUnavailable,
      "GITHUB_INSTALLATION_TOKEN is absent or empty",
    );
  }

  const platform = dependencies.platform ?? await createPlatformClient(env, dependencies);
  await assertTestnetPlatform(platform);

  const publisher = dependencies.githubPublisher ?? createGitHubPublisher({
    installationToken,
    fetchImpl: dependencies.fetchImpl ?? globalThis.fetch,
    githubApiUrl: text(env.GITHUB_API_URL) || DEFAULT_GITHUB_API_URL,
    runCommandImpl: dependencies.runCommand,
    materializeCommitImpl: dependencies.materializeCommit,
    pushBranchImpl: dependencies.pushBranch,
  });
  const pullRequest = await publisher.publish(packet);
  if (!text(pullRequest?.url)) {
    fail(
      "BOUNTY_PR_OPEN_REFUSED",
      BOUNTY_WORKER_EXIT.prOpenRefused,
      "GitHub did not return a pull-request URL",
    );
  }

  let submission;
  try {
    submission = (dependencies.assembleGithubPrSubmission ?? assembleGithubPrSubmission)({
      job: packet.job,
      prUrl: pullRequest.url,
      verificationReport: packet.deliverables.verificationReport,
      changeSummary: packet.deliverables.changeSummary,
      patchText: packet.deliverables.patchText,
      ciStatus: "unknown",
    });
  } catch {
    fail(
      "BOUNTY_VERIFICATION_FAILED",
      BOUNTY_WORKER_EXIT.verificationFailed,
      "verified submission assembly refused the handoff",
    );
  }

  let submit;
  try {
    submit = await platform.submitValidatedWork(
      packet.job.id,
      packet.sessionId,
      submission,
    );
  } catch {
    fail(
      "BOUNTY_SUBMIT_REFUSED",
      BOUNTY_WORKER_EXIT.submitRefused,
      "the existing validated submit path refused the assembled submission",
    );
  }
  if (submit?.status !== "submitted") {
    fail(
      "BOUNTY_SUBMIT_REFUSED",
      BOUNTY_WORKER_EXIT.submitRefused,
      `expected submitted status; observed ${text(submit?.status) || "missing"}`,
    );
  }

  const evidence = {
    schemaVersion: 1,
    kind: "averray_bounty_worker_result",
    jobId: packet.job.id,
    sessionId: packet.sessionId,
    runId: packet.runId,
    repository: packet.repository.nameWithOwner,
    baseRevision: packet.repository.baseRevision,
    headBranch: pullRequest.headBranch,
    headRevision: pullRequest.headRevision,
    prUrl: pullRequest.url,
    prNumber: pullRequest.number,
    adopted: pullRequest.adopted === true,
    submission,
    submitStatus: submit.status,
    completedAt: new Date().toISOString(),
  };
  await writeNewFile(
    options.evidencePath,
    `${JSON.stringify(evidence, null, 2)}\n`,
    "BOUNTY_EVIDENCE_EXISTS",
  );
  stdout.write(
    `BOUNTY_SUBMITTED run_id=${packet.runId} pr_url=${pullRequest.url} evidence=${options.evidencePath}\n`,
  );
}

function parseArguments(argv) {
  const [verb, ...tokens] = argv;
  if (verb !== "prepare" && verb !== "send") {
    fail(
      "BOUNTY_USAGE",
      BOUNTY_WORKER_EXIT.usage,
      "first argument must be prepare or send",
    );
  }
  const allowed = verb === "prepare"
    ? new Set(["--job", "--workspace", "--intent", "--handoff"])
    : new Set(["--handoff", "--evidence", "--confirm"]);
  const values = new Map();
  for (let index = 0; index < tokens.length; index += 2) {
    const name = tokens[index];
    const value = tokens[index + 1];
    if (
      !allowed.has(name)
      || values.has(name)
      || typeof value !== "string"
      || !value.trim()
      || value.startsWith("--")
    ) {
      fail(
        "BOUNTY_USAGE",
        BOUNTY_WORKER_EXIT.usage,
        "arguments must be unique supported --name value pairs",
      );
    }
    values.set(name, value.trim());
  }
  if (verb === "prepare") {
    for (const name of ["--job", "--workspace", "--intent", "--handoff"]) {
      if (!values.has(name)) {
        fail(
          "BOUNTY_USAGE",
          BOUNTY_WORKER_EXIT.usage,
          "prepare requires --job, --workspace, --intent, and --handoff",
        );
      }
    }
    return {
      verb,
      jobId: values.get("--job"),
      workspacePath: path.resolve(values.get("--workspace")),
      intentPath: path.resolve(values.get("--intent")),
      handoffPath: path.resolve(values.get("--handoff")),
    };
  }
  if (!values.has("--handoff") || !values.has("--evidence")) {
    fail(
      "BOUNTY_USAGE",
      BOUNTY_WORKER_EXIT.usage,
      "send requires --handoff and --evidence; --confirm is the separate approval",
    );
  }
  return {
    verb,
    handoffPath: path.resolve(values.get("--handoff")),
    evidencePath: path.resolve(values.get("--evidence")),
    confirm: values.get("--confirm"),
  };
}

async function createPlatformClient(env, dependencies) {
  const apiBaseUrl = resolveApiBaseUrl(env);
  const auth = await (dependencies.resolveAuth ?? resolveHostedWorkerLoopAuth)({
    env,
    apiBaseUrl,
    fetchImpl: dependencies.fetchImpl ?? globalThis.fetch,
    ...(dependencies.readSecretImpl ? { readSecretImpl: dependencies.readSecretImpl } : {}),
  });
  return new AgentPlatformClient({
    baseUrl: apiBaseUrl,
    token: auth.token,
    fetchImpl: dependencies.fetchImpl ?? globalThis.fetch,
  });
}

function resolveApiBaseUrl(env) {
  return text(env.AVERRAY_API_BASE_URL ?? env.API_BASE_URL) || DEFAULT_API_BASE_URL;
}

function assertJob(job, expectedId) {
  if (
    !isRecord(job)
    || text(job.id) !== expectedId
    || !isRecord(job.source)
    || !REPOSITORY.test(text(job.source.repo))
  ) {
    fail(
      "BOUNTY_JOB_INVALID",
      BOUNTY_WORKER_EXIT.jobInvalid,
      "job definition identity or source repository is invalid",
    );
  }
}

async function cloneRepository(job, workspacePath, dependencies = {}) {
  try {
    await access(workspacePath);
    fail(
      "BOUNTY_CLONE_REFUSED",
      BOUNTY_WORKER_EXIT.cloneRefused,
      "workspace path already exists and will not be overwritten",
    );
  } catch (error) {
    if (error instanceof BountyWorkerError) throw error;
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(path.dirname(workspacePath), { recursive: true });
  const execute = dependencies.runCommand ?? runCommand;
  const repository = job.source.repo;
  await execute(
    "git",
    ["clone", "--origin", "origin", "--no-tags", `https://github.com/${repository}.git`, workspacePath],
  );
  const baseRef = text((await execute("git", ["symbolic-ref", "--short", "HEAD"], {
    cwd: workspacePath,
  })).stdout);
  const baseRevision = text((await execute("git", ["rev-parse", "HEAD"], {
    cwd: workspacePath,
  })).stdout);
  const dirty = text((await execute("git", ["status", "--porcelain"], {
    cwd: workspacePath,
  })).stdout);
  if (!SAFE_REF.test(baseRef) || !/^[a-f0-9]{40}$/u.test(baseRevision) || dirty) {
    fail(
      "BOUNTY_CLONE_REFUSED",
      BOUNTY_WORKER_EXIT.cloneRefused,
      "cloned workspace did not produce a clean branch and immutable base revision",
    );
  }
  return { repository, workspacePath, baseRef, baseRevision };
}

function assertCheckout(checkout, job, workspacePath) {
  if (
    !isRecord(checkout)
    || checkout.repository !== job.source.repo
    || path.resolve(checkout.workspacePath ?? "") !== workspacePath
    || !SAFE_REF.test(text(checkout.baseRef))
    || !/^[a-f0-9]{40}$/u.test(text(checkout.baseRevision))
  ) {
    fail(
      "BOUNTY_CLONE_REFUSED",
      BOUNTY_WORKER_EXIT.cloneRefused,
      "host-side clone result is not pinned to the requested repository and revision",
    );
  }
}

async function inspectRunNetworkMode(runId, dependencies = {}) {
  const execute = dependencies.runCommand ?? runCommand;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const result = await execute(
      "docker",
      ["inspect", "--format", "{{.HostConfig.NetworkMode}}", `harness-run-${runId}`],
      { allowFailure: true },
    );
    if (result.code === 0) return text(result.stdout);
    await delay(100);
  }
  return "unavailable";
}

async function readArtifactText(driver, uri, type) {
  if (!text(uri)) {
    fail(
      "BOUNTY_VERIFICATION_FAILED",
      BOUNTY_WORKER_EXIT.verificationFailed,
      `${type} deliverable is missing`,
    );
  }
  const value = await driver.artifactGet(uri);
  return Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
}

async function loadHandoff(target) {
  try {
    return JSON.parse(await readFile(target, "utf8"));
  } catch {
    fail(
      "BOUNTY_HANDOFF_INVALID",
      BOUNTY_WORKER_EXIT.handoffInvalid,
      "handoff is unavailable or is not JSON",
    );
  }
}

function assertPacket(packet) {
  const repository = packet?.repository;
  const deliverables = packet?.deliverables;
  if (
    packet?.schemaVersion !== 1
    || packet?.kind !== "averray_bounty_worker_handoff"
    || !isRecord(packet.job)
    || !isRecord(repository)
    || !REPOSITORY.test(text(repository.nameWithOwner))
    || packet.job?.source?.repo !== repository.nameWithOwner
    || !SAFE_REF.test(text(repository.baseRef))
    || !/^[a-f0-9]{40}$/u.test(text(repository.baseRevision))
    || !text(packet.sessionId)
    || !text(packet.runId)
    || !Array.isArray(packet.mappingWarnings)
    || !isRecord(deliverables)
    || typeof deliverables.patchText !== "string"
    || !isRecord(deliverables.verificationReport)
    || typeof deliverables.changeSummary !== "string"
    || digest(deliverables.patchText) !== deliverables.patchSha256
    || digest(JSON.stringify(deliverables.verificationReport)) !== deliverables.verificationSha256
    || digest(deliverables.changeSummary) !== deliverables.changeSummarySha256
    || packet.network?.provider !== "docker"
    || packet.network?.mode !== "none"
    || !Number.isFinite(Date.parse(packet.completedAt))
    || packetDigest(packet) !== packet.contentSha256
  ) {
    fail(
      "BOUNTY_HANDOFF_INVALID",
      BOUNTY_WORKER_EXIT.handoffInvalid,
      "handoff identity, content hashes, or network proof is invalid",
    );
  }
}

async function assertTestnetPlatform(platform) {
  let health;
  try {
    health = await platform.getHealth();
  } catch {
    fail(
      "BOUNTY_TESTNET_REFUSED",
      BOUNTY_WORKER_EXIT.testnetRefused,
      "platform health could not prove the testnet chain before a money-rail action",
    );
  }
  const chainId = Number(health?.auth?.chainId);
  if (chainId !== TESTNET_CHAIN_ID) {
    fail(
      "BOUNTY_TESTNET_REFUSED",
      BOUNTY_WORKER_EXIT.testnetRefused,
      `first bounty proof is testnet-only; expected chainId=${TESTNET_CHAIN_ID} observed=${Number.isFinite(chainId) ? chainId : "missing"}`,
    );
  }
}

export function createGitHubPublisher({
  installationToken,
  fetchImpl,
  githubApiUrl = DEFAULT_GITHUB_API_URL,
  runCommandImpl = runCommand,
  materializeCommitImpl = materializeCommit,
  pushBranchImpl = pushBranch,
}) {
  const apiBaseUrl = githubApiUrl.replace(/\/+$/u, "");
  const request = async (apiPath, options = {}) => {
    const response = await fetchImpl(`${apiBaseUrl}${apiPath}`, {
      method: options.method ?? "GET",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${installationToken}`,
        "x-github-api-version": "2022-11-28",
        ...(options.body ? { "content-type": "application/json" } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
    if (options.allow404 && response.status === 404) return undefined;
    if (!response.ok) {
      fail(
        options.errorCode ?? "BOUNTY_PR_OPEN_REFUSED",
        options.exitCode ?? BOUNTY_WORKER_EXIT.prOpenRefused,
        `GitHub request ${options.method ?? "GET"} ${apiPath} returned HTTP ${response.status}`,
      );
    }
    return response.json();
  };

  return {
    async publish(packet) {
      const repository = packet.repository.nameWithOwner;
      const installation = await request("/installation/repositories?per_page=100", {
        errorCode: "BOUNTY_GITHUB_SCOPE_REFUSED",
        exitCode: BOUNTY_WORKER_EXIT.githubScopeRefused,
      });
      const allowed = Array.isArray(installation?.repositories)
        ? installation.repositories.map((entry) => text(entry.full_name))
        : [];
      if (installation?.total_count !== 1 || allowed.length !== 1 || allowed[0] !== repository) {
        fail(
          "BOUNTY_GITHUB_SCOPE_REFUSED",
          BOUNTY_WORKER_EXIT.githubScopeRefused,
          `installation token must select exactly ${repository}`,
        );
      }

      const materialized = await materializeCommitImpl(packet, { runCommandImpl });
      try {
        const base = await request(
          `/repos/${repository}/git/ref/heads/${encodeURIComponent(packet.repository.baseRef)}`,
          {
            errorCode: "BOUNTY_BASE_DRIFT",
            exitCode: BOUNTY_WORKER_EXIT.baseDrift,
          },
        );
        const liveBaseRevision = text(base?.object?.sha);
        if (liveBaseRevision !== packet.repository.baseRevision) {
          fail(
            "BOUNTY_BASE_DRIFT",
            BOUNTY_WORKER_EXIT.baseDrift,
            `live base ${liveBaseRevision || "missing"} does not equal prepared base ${packet.repository.baseRevision}`,
          );
        }

        const headBranch = deriveHeadBranch(packet);
        const existingHead = await request(
          `/repos/${repository}/git/ref/heads/${encodeURIComponent(headBranch)}`,
          { allow404: true },
        );
        if (existingHead && text(existingHead.object?.sha) !== materialized.headRevision) {
          fail(
            "BOUNTY_PR_OPEN_REFUSED",
            BOUNTY_WORKER_EXIT.prOpenRefused,
            "derived head branch already exists at different content; refusing force-push",
          );
        }
        if (!existingHead) {
          await pushBranchImpl({
            repository,
            headBranch,
            materialized,
            installationToken,
            runCommandImpl,
          });
        }

        const owner = repository.split("/")[0];
        const pullRequests = await request(
          `/repos/${repository}/pulls?state=all&head=${encodeURIComponent(`${owner}:${headBranch}`)}`,
        );
        if (Array.isArray(pullRequests) && pullRequests.length > 0) {
          const exact = pullRequests.find((pullRequest) =>
            pullRequest?.head?.sha === materialized.headRevision
            && pullRequest?.base?.ref === packet.repository.baseRef);
          if (!exact) {
            fail(
              "BOUNTY_PR_OPEN_REFUSED",
              BOUNTY_WORKER_EXIT.prOpenRefused,
              "derived head has a pull request whose content or base disagrees",
            );
          }
          return {
            url: exact.html_url,
            number: exact.number,
            headBranch,
            headRevision: materialized.headRevision,
            adopted: true,
          };
        }

        const created = await request(`/repos/${repository}/pulls`, {
          method: "POST",
          body: pullRequestPayload(packet, headBranch),
        });
        return {
          url: created?.html_url,
          number: created?.number,
          headBranch,
          headRevision: materialized.headRevision,
          adopted: false,
        };
      } finally {
        await materialized.cleanup?.();
      }
    },
  };
}

async function materializeCommit(packet, { runCommandImpl = runCommand } = {}) {
  const repositoryPath = await mkdtemp(path.join(tmpdir(), "averray-bounty-pr-"));
  try {
    await runCommandImpl("git", [
      "clone",
      "--local",
      "--no-hardlinks",
      "--no-checkout",
      packet.repository.workspacePath,
      repositoryPath,
    ]);
    await runCommandImpl("git", ["checkout", "--detach", packet.repository.baseRevision], {
      cwd: repositoryPath,
    });
    await runCommandImpl("git", ["apply", "--index", "--whitespace=nowarn", "-"], {
      cwd: repositoryPath,
      input: packet.deliverables.patchText,
    });
    const changed = await runCommandImpl("git", ["diff", "--cached", "--quiet"], {
      cwd: repositoryPath,
      allowFailure: true,
    });
    if (changed.code === 0) {
      fail(
        "BOUNTY_PR_OPEN_REFUSED",
        BOUNTY_WORKER_EXIT.prOpenRefused,
        "workspace patch produced no staged change",
      );
    }
    await runCommandImpl("git", ["diff", "--cached", "--check"], { cwd: repositoryPath });
    const commitEnv = {
      GIT_AUTHOR_NAME: "Averray Worker",
      GIT_AUTHOR_EMAIL: "worker@averray.com",
      GIT_COMMITTER_NAME: "Averray Worker",
      GIT_COMMITTER_EMAIL: "worker@averray.com",
      GIT_AUTHOR_DATE: packet.completedAt,
      GIT_COMMITTER_DATE: packet.completedAt,
    };
    await runCommandImpl("git", ["commit", "-m", `Resolve ${packet.job.id}`], {
      cwd: repositoryPath,
      env: commitEnv,
    });
    const headRevision = text((await runCommandImpl("git", ["rev-parse", "HEAD"], {
      cwd: repositoryPath,
    })).stdout);
    return {
      repositoryPath,
      headRevision,
      async cleanup() {
        await rm(repositoryPath, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(repositoryPath, { recursive: true, force: true });
    throw error;
  }
}

async function pushBranch({
  repository,
  headBranch,
  materialized,
  installationToken,
  runCommandImpl = runCommand,
}) {
  const askPassRoot = await mkdtemp(path.join(tmpdir(), "averray-git-askpass-"));
  const askPassPath = path.join(askPassRoot, "askpass.sh");
  try {
    await writeFile(
      askPassPath,
      "#!/bin/sh\ncase \"$1\" in\n  *Username*) printf '%s\\n' x-access-token ;;\n  *Password*) printf '%s\\n' \"$GITHUB_INSTALLATION_TOKEN\" ;;\n  *) exit 1 ;;\nesac\n",
      { encoding: "utf8", flag: "wx", mode: 0o700 },
    );
    await chmod(askPassPath, 0o700);
    await runCommandImpl(
      "git",
      ["remote", "set-url", "origin", `https://github.com/${repository}.git`],
      { cwd: materialized.repositoryPath },
    );
    await runCommandImpl(
      "git",
      ["push", "--porcelain", "origin", `HEAD:refs/heads/${headBranch}`],
      {
        cwd: materialized.repositoryPath,
        env: {
          GIT_ASKPASS: askPassPath,
          GIT_TERMINAL_PROMPT: "0",
          GITHUB_INSTALLATION_TOKEN: installationToken,
        },
      },
    );
  } finally {
    await rm(askPassRoot, { recursive: true, force: true });
  }
}

function deriveHeadBranch(packet) {
  const run = text(packet.runId).toLowerCase().replace(/[^a-z0-9]+/gu, "").slice(0, 12);
  return `averray/${slugifyJobId(packet.job.id).slice(0, 80)}-${run || "run"}`;
}

function pullRequestPayload(packet, headBranch) {
  const issueNumber = Number.isInteger(packet.job?.source?.issueNumber)
    ? packet.job.source.issueNumber
    : undefined;
  const title = text(packet.job.title) || `Resolve ${packet.job.id}`;
  const summary = text(packet.deliverables.changeSummary);
  return {
    base: packet.repository.baseRef,
    head: headBranch,
    title: issueNumber ? `Resolve #${issueNumber}: ${title}` : title,
    body: [
      summary || `Resolve ${packet.job.id}.`,
      "",
      `Harness run: ${packet.runId}`,
      `Verification: passed`,
      ...(issueNumber ? ["", `Closes #${issueNumber}`] : []),
    ].join("\n"),
  };
}

async function writeNewFile(target, contents, codeName) {
  try {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error?.code === "EEXIST") {
      fail(codeName, BOUNTY_WORKER_EXIT.evidenceRefused, `${target} already exists and will not be overwritten`);
    }
    throw error;
  }
}

function runCommand(bin, args, options = {}) {
  return new Promise((resolve, reject) => {
    const childEnv = { ...process.env };
    delete childEnv.GITHUB_INSTALLATION_TOKEN;
    delete childEnv.HARNESS_DATABASE_URL;
    Object.assign(childEnv, options.env ?? {});
    const child = spawn(bin, args, {
      cwd: options.cwd,
      env: childEnv,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const result = {
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (result.code === 0 || options.allowFailure) {
        resolve(result);
      } else {
        reject(new Error(`${bin} exited non-zero`));
      }
    });
    if (options.input !== undefined) child.stdin.end(options.input);
  });
}

function numericEnv(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function digest(value) {
  const input = typeof value === "string" ? value : JSON.stringify(value);
  return `sha256:${createHash("sha256").update(input, "utf8").digest("hex")}`;
}

function packetDigest(packet) {
  if (!isRecord(packet)) return "";
  const content = { ...packet };
  delete content.contentSha256;
  return digest(JSON.stringify(content));
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function text(value) {
  return value == null ? "" : String(value).trim();
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(codeName, exitCode, message) {
  throw new BountyWorkerError(codeName, exitCode, message);
}

function optionsExitCode(verb) {
  return verb === "send" ? BOUNTY_WORKER_EXIT.submitRefused : BOUNTY_WORKER_EXIT.claimRefused;
}

async function main() {
  process.exitCode = await runBountyWorker({ argv: process.argv.slice(2) });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
