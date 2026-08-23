#!/usr/bin/env node

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const AVERRAY_MCP_URL = "https://api.averray.com/mcp";

export function resolveMcpRemoteBin(resolve = createRequire(import.meta.url).resolve) {
  return join(dirname(resolve("mcp-remote/package.json")), "dist", "proxy.js");
}

export function buildBridgeInvocation({
  args = process.argv.slice(2),
  execPath = process.execPath,
  resolve
} = {}) {
  return {
    command: execPath,
    args: [
      resolveMcpRemoteBin(resolve),
      AVERRAY_MCP_URL,
      "--transport",
      "http-only",
      ...args
    ]
  };
}

export function runBridge({ args, execPath, resolve, spawnImpl = spawn } = {}) {
  const invocation = buildBridgeInvocation({ args, execPath, resolve });
  const child = spawnImpl(invocation.command, invocation.args, { stdio: "inherit" });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => child.kill(signal));
  }

  child.once("error", (error) => {
    console.error(`Averray MCP bridge could not start: ${error.message}`);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code ?? 1;
  });

  return child;
}

export function isDirectExecution({
  argvEntry = process.argv[1],
  modulePath = fileURLToPath(import.meta.url),
  realpath = realpathSync
} = {}) {
  if (!argvEntry) return false;
  try {
    // npm/npx invokes package bins through node_modules/.bin symlinks. Compare
    // their real targets so the packaged executable cannot silently import and
    // exit before starting the bridge.
    return realpath(argvEntry) === realpath(modulePath);
  } catch {
    return argvEntry === modulePath;
  }
}

if (isDirectExecution()) {
  runBridge();
}
