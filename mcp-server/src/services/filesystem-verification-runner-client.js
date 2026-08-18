import { createHash } from "node:crypto";
import { chmod, chown, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { hashCanonicalContent } from "../core/canonical-content.js";
import { ConfigError } from "../core/errors.js";

const HEARTBEAT_MAX_AGE_MS = 30_000;
const POLL_INTERVAL_MS = 250;

/**
 * Filesystem capability boundary between the public backend and the offline
 * Witness host worker. The backend receives no Docker socket or process runner.
 */
export class FilesystemVerificationRunnerClient {
  constructor({
    queueRoot = process.env.WITNESS_VERIFY_QUEUE_ROOT,
    queueGid = process.env.WITNESS_VERIFY_QUEUE_GID,
    fetchImpl = globalThis.fetch,
    now = () => new Date()
  } = {}) {
    this.queueRoot = queueRoot ? resolve(queueRoot) : undefined;
    this.queueGid = parseQueueGid(queueGid);
    this.fetch = fetchImpl;
    this.now = now;
  }

  async initialize() {
    if (!this.queueRoot) {
      throw new ConfigError("WITNESS_VERIFY_QUEUE_ROOT is required when Averray Verify is enabled.");
    }
    if (!this.queueGid) {
      throw new ConfigError("WITNESS_VERIFY_QUEUE_GID must be the offline worker's numeric group id.");
    }
    let heartbeat;
    try {
      heartbeat = JSON.parse(await readFile(resolve(this.queueRoot, "worker-heartbeat.json"), "utf8"));
    } catch {
      throw new ConfigError("The offline Witness verification worker has not published a heartbeat.");
    }
    const ageMs = this.currentTime().getTime() - Date.parse(heartbeat.at ?? "");
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > HEARTBEAT_MAX_AGE_MS) {
      throw new ConfigError("The offline Witness verification worker heartbeat is stale.");
    }
    return { worker: heartbeat.worker, at: heartbeat.at };
  }

  async run({ runId, profile, target, inputs }) {
    await ensureQueueDirectories(this.queueRoot);
    const requestDirectory = resolve(this.queueRoot, "requests", runId);
    await mkdir(requestDirectory, { recursive: false, mode: 0o700 });
    await shareWithWorker(requestDirectory, this.queueGid, 0o750);
    try {
      const [bundle, patch] = await Promise.all([
        fetchVerifiedArtifact(inputs.bundle, this.fetch, profile.limits.timeout),
        fetchVerifiedArtifact(inputs.patch, this.fetch, profile.limits.timeout)
      ]);
      await Promise.all([
        writeFile(resolve(requestDirectory, "source.bundle"), bundle, { mode: 0o600 }),
        writeFile(resolve(requestDirectory, "candidate.patch"), patch, { mode: 0o600 })
      ]);
      await Promise.all([
        shareWithWorker(resolve(requestDirectory, "source.bundle"), this.queueGid, 0o640),
        shareWithWorker(resolve(requestDirectory, "candidate.patch"), this.queueGid, 0o640)
      ]);
      const task = {
        runId,
        profile,
        target,
        inputs: {
          ...inputs,
          bundle: {
            ...inputs.bundle,
            locator: { kind: "path", path: "source.bundle" }
          },
          patch: {
            ...inputs.patch,
            locator: { kind: "path", path: "candidate.patch" }
          }
        },
        requestDirectory,
        queuedAt: this.currentTime().toISOString()
      };
      const staged = resolve(this.queueRoot, "inbox", `.${runId}.json.tmp`);
      const queued = resolve(this.queueRoot, "inbox", `${runId}.json`);
      await writeFile(staged, JSON.stringify(task), { mode: 0o600, flag: "wx" });
      await shareWithWorker(staged, this.queueGid, 0o640);
      await rename(staged, queued);
      return await pollForResult({
        path: resolve(this.queueRoot, "results", `${runId}.json`),
        timeoutMs: (profile.limits.timeout * 1_000) + HEARTBEAT_MAX_AGE_MS
      });
    } catch (error) {
      if (error?.code === "TARGET_UNREACHABLE") {
        return inconclusive("target_unreachable", "TARGET_UNREACHABLE", error.message);
      }
      throw error;
    } finally {
      await rm(requestDirectory, { recursive: true, force: true });
    }
  }

  currentTime() {
    const value = this.now();
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) throw new ConfigError("Verification queue clock is invalid.");
    return date;
  }
}

async function ensureQueueDirectories(root) {
  if (!root) throw new ConfigError("WITNESS_VERIFY_QUEUE_ROOT is required.");
  await Promise.all(["inbox", "processing", "requests", "results"].map((name) =>
    mkdir(resolve(root, name), { recursive: true, mode: 0o700 })
  ));
}

async function fetchVerifiedArtifact(artifact, fetchImpl, timeoutSeconds) {
  if (artifact?.locator?.kind !== "https" || typeof fetchImpl !== "function") {
    throw targetError("Public verification artifacts must use a reachable HTTPS locator.");
  }
  let response;
  try {
    response = await fetchImpl(artifact.locator.url, {
      redirect: "follow",
      signal: AbortSignal.timeout(Math.min(timeoutSeconds * 1_000, 60_000))
    });
  } catch (error) {
    throw targetError(`Artifact fetch failed: ${error?.message ?? "unreachable"}`);
  }
  if (!response.ok || new URL(response.url).protocol !== "https:") {
    throw targetError(`Artifact fetch returned HTTP ${response.status} or left HTTPS.`);
  }
  const bytes = await readBoundedResponse(response, Number(artifact.bytes));
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (bytes.length !== Number(artifact.bytes) || digest !== artifact.sha256) {
    throw targetError("Artifact bytes do not match the declared size and SHA-256.");
  }
  return bytes;
}

async function readBoundedResponse(response, expectedBytes) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > expectedBytes) {
    throw targetError("Artifact response exceeds the declared byte length.");
  }
  if (!response.body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > expectedBytes) {
      throw targetError("Artifact response exceeds the declared byte length.");
    }
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > expectedBytes) {
      await reader.cancel().catch(() => {});
      throw targetError("Artifact response exceeds the declared byte length.");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

async function pollForResult({ path, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const result = JSON.parse(await readFile(path, "utf8"));
      await rm(path, { force: true });
      return result;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolvePoll) => setTimeout(resolvePoll, POLL_INTERVAL_MS));
  }
  return inconclusive(
    "runner_fault",
    "RUNNER_FAULT",
    "The offline Witness worker did not return within the profile timeout."
  );
}

function targetError(message) {
  const error = new Error(message);
  error.code = "TARGET_UNREACHABLE";
  return error;
}

function parseQueueGid(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return undefined;
  }
  return parsed;
}

async function shareWithWorker(path, gid, mode) {
  if (!gid) {
    throw new ConfigError("WITNESS_VERIFY_QUEUE_GID must name the offline worker's numeric group id.");
  }
  await chown(path, 0, gid);
  await chmod(path, mode);
}

function inconclusive(reason, reasonCode, detail) {
  return {
    status: "inconclusive",
    reason,
    reasonCode,
    detail,
    evidenceHash: hashCanonicalContent({ reason, reasonCode, detail })
  };
}
