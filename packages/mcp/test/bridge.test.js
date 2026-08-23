import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync, statSync } from "node:fs";
import test from "node:test";

import {
  AVERRAY_MCP_URL,
  buildBridgeInvocation,
  isDirectExecution,
  runBridge
} from "../bin/averray-mcp.js";

test("0.1.1 package metadata is registry-attachable and keeps one exact transport dependency", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

  assert.equal(manifest.version, "0.1.1");
  assert.equal(manifest.mcpName, "com.averray/mcp");
  assert.deepEqual(manifest.dependencies, { "mcp-remote": "0.1.43" });
});

test("the pinned mcp-remote executable is present in the installed dependency graph", () => {
  const remoteBin = buildBridgeInvocation().args[0];

  assert.match(remoteBin, /mcp-remote\/dist\/proxy\.js$/u);
  assert.equal(statSync(remoteBin).isFile(), true);
});

test("the npm bin symlink resolves to the packaged executable", () => {
  const targets = new Map([
    ["/install/node_modules/.bin/averray-mcp", "/install/node_modules/@averray/mcp/bin/averray-mcp.js"],
    ["/install/node_modules/@averray/mcp/bin/averray-mcp.js", "/install/node_modules/@averray/mcp/bin/averray-mcp.js"]
  ]);

  assert.equal(isDirectExecution({
    argvEntry: "/install/node_modules/.bin/averray-mcp",
    modulePath: "/install/node_modules/@averray/mcp/bin/averray-mcp.js",
    realpath(path) { return targets.get(path); }
  }), true);
});

test("npx @averray/mcp pins the hosted endpoint and mcp-remote HTTP transport", () => {
  const invocation = buildBridgeInvocation({
    args: ["--silent"],
    execPath: "/node",
    resolve: () => "/package/node_modules/mcp-remote/package.json"
  });

  assert.deepEqual(invocation, {
    command: "/node",
    args: [
      "/package/node_modules/mcp-remote/dist/proxy.js",
      AVERRAY_MCP_URL,
      "--transport",
      "http-only",
      "--silent"
    ]
  });
});

test("bridge inherits stdio and reports the delegated process exit", async () => {
  const child = new EventEmitter();
  child.kill = () => true;
  let spawnCall;

  runBridge({
    args: [],
    execPath: "/node",
    resolve: () => "/package/node_modules/mcp-remote/package.json",
    spawnImpl(command, args, options) {
      spawnCall = { command, args, options };
      return child;
    }
  });

  child.emit("exit", 0, null);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(spawnCall.options, { stdio: "inherit" });
  assert.equal(process.exitCode, 0);
  process.exitCode = undefined;
});
