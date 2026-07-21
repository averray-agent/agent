import { spawn } from "node:child_process";

const OUTCOME_TERMINALS = new Set(["completed", "partial", "failed"]);
const STATE_TERMINALS = new Set(["quarantined", "cancelled"]);

export function parseStatusOutput(output) {
  const status = {};
  for (const rawLine of String(output).split(/\r?\n/)) {
    const line = rawLine.trim();
    const separator = line.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    status[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return status;
}

export function isTerminalStatus(status) {
  return OUTCOME_TERMINALS.has(status?.outcome) || STATE_TERMINALS.has(status?.state);
}

export function parseDeliverablesOutput(output) {
  const deliverables = {};
  for (const rawLine of String(output).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const separator = line.search(/\s/);
    if (separator <= 0) {
      continue;
    }
    const type = line.slice(0, separator);
    const uri = line.slice(separator).trim();
    if (uri) {
      deliverables[type] = uri;
    }
  }
  return deliverables;
}

function abortError() {
  const error = new Error("Harness wait was aborted");
  error.name = "AbortError";
  return error;
}

function delay(milliseconds, signal) {
  if (signal?.aborted) {
    return Promise.reject(abortError());
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function execute(bin, args, { cwd, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      const stdoutBuffer = Buffer.concat(stdout);
      const stderrBuffer = Buffer.concat(stderr);
      if (code === 0) {
        resolve({ stdout: stdoutBuffer, stderr: stderrBuffer });
        return;
      }
      const detail = stderrBuffer.toString("utf8").trim() || stdoutBuffer.toString("utf8").trim();
      const error = new Error(
        `harness ${args.join(" ")} failed (${signal ? `signal ${signal}` : `exit ${code}`}): ${detail || "no diagnostic"}`,
      );
      error.exitCode = code;
      error.stdout = stdoutBuffer;
      error.stderr = stderrBuffer;
      reject(error);
    });
  });
}

export class HarnessDriver {
  constructor(config = {}) {
    this.harnessBin = config.harnessBin || process.env.HARNESS_BIN || "harness";
    this.databaseUrl = config.databaseUrl ?? process.env.HARNESS_DATABASE_URL;
    this.extraEnv = { ...(config.env ?? {}) };
    this.cwd = config.cwd;
  }

  environment() {
    const env = { ...process.env, ...this.extraEnv };
    if (this.databaseUrl) {
      env.HARNESS_DATABASE_URL = this.databaseUrl;
    }
    return env;
  }

  async command(args) {
    return execute(this.harnessBin, args, {
      cwd: this.cwd,
      env: this.environment(),
    });
  }

  async submit(path) {
    const { stdout } = await this.command(["run", "submit", String(path)]);
    const lines = stdout
      .toString("utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length !== 1) {
      throw new Error("harness run submit did not return exactly one run id");
    }
    return lines[0];
  }

  async status(id) {
    const { stdout } = await this.command(["run", "status", String(id)]);
    return parseStatusOutput(stdout.toString("utf8"));
  }

  async deliverables(id) {
    const { stdout } = await this.command(["run", "deliverables", String(id)]);
    return parseDeliverablesOutput(stdout.toString("utf8"));
  }

  async artifactGet(uri, outPath) {
    const args = ["artifacts", "get", String(uri)];
    if (outPath != null) {
      args.push("--out", String(outPath));
    }
    const { stdout } = await this.command(args);
    return outPath == null ? stdout : outPath;
  }

  async waitForOutcome(id, options = {}) {
    const timeoutMs = options.timeoutMs ?? 30 * 60 * 1000;
    const pollIntervalMs = options.pollIntervalMs ?? 1_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new TypeError("timeoutMs must be a non-negative finite number");
    }
    if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
      throw new TypeError("pollIntervalMs must be a positive finite number");
    }

    const deadline = Date.now() + timeoutMs;
    while (true) {
      if (options.signal?.aborted) {
        throw abortError();
      }
      const status = await this.status(id);
      if (isTerminalStatus(status)) {
        return status;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`Timed out waiting for harness run ${id}`);
      }
      await delay(Math.min(pollIntervalMs, remaining), options.signal);
    }
  }

  async runToCompletion(path, waitOptions = {}) {
    const runId = await this.submit(path);
    const status = await this.waitForOutcome(runId, waitOptions);
    const deliverables = status.outcome === "completed" ? await this.deliverables(runId) : {};
    return { runId, status, deliverables };
  }
}
