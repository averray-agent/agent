import { spawn } from "node:child_process";

import { OUTPUT_LIMIT_BYTES } from "./constants.mjs";

export async function runProcess(command, args, options = {}) {
  const {
    cwd,
    env = process.env,
    timeoutSeconds = 0,
    outputLimitBytes = OUTPUT_LIMIT_BYTES
  } = options;

  return new Promise((resolve) => {
    const started = performance.now();
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let timedOut = false;
    let outputTruncated = false;
    let settled = false;
    let timer;

    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    const append = (current, chunk) => {
      const remaining = Math.max(0, outputLimitBytes - current.length);
      if (chunk.length > remaining) {
        outputTruncated = true;
      }
      return remaining === 0
        ? current
        : Buffer.concat([current, chunk.subarray(0, remaining)]);
    };

    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });

    if (timeoutSeconds > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
      }, timeoutSeconds * 1_000);
      timer.unref();
    }

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ...result,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        timedOut,
        outputTruncated,
        seconds: Number(((performance.now() - started) / 1_000).toFixed(3))
      });
    };

    child.on("error", (error) => {
      finish({ exitCode: null, signal: null, spawnError: error.message });
    });
    child.on("close", (exitCode, signal) => {
      finish({ exitCode, signal, spawnError: null });
    });
  });
}

export function tail(value, limit = 8_000) {
  if (!value || value.length <= limit) return value || "";
  return `[truncated to final ${limit} characters]\n${value.slice(-limit)}`;
}
