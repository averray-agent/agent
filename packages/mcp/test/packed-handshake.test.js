import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createMcpRoute } from "../../../mcp-server/src/protocols/mcp/handler.js";
import { respond } from "../../../mcp-server/src/protocols/http/http-helpers.js";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const INITIALIZE_REQUEST = {
  jsonrpc: "2.0",
  id: "packed-handshake",
  method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "averray-packed-handshake", version: "1" }
  }
};
const TOOLS_LIST_REQUEST = {
  jsonrpc: "2.0",
  id: "packed-tools-list",
  method: "tools/list",
  params: {}
};
test("packed @averray/mcp bin completes initialize and tools/list through the real bridge", { timeout: 45_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "averray-mcp-packed-handshake-"));
  const packDir = join(root, "pack");
  const installDir = join(root, "install");
  const npmCache = join(root, "npm-cache");
  const fixture = await startMcpFixture();
  mkdirSync(packDir);
  mkdirSync(installDir);
  const npmEnv = {
    ...process.env,
    npm_config_cache: npmCache,
    npm_config_update_notifier: "false"
  };

  try {
    const packOutput = execFileSync(
      "npm",
      ["pack", "--json", "--pack-destination", packDir],
      { cwd: PACKAGE_ROOT, encoding: "utf8", env: npmEnv }
    );
    const [packed] = JSON.parse(packOutput);
    const tarball = join(packDir, packed.filename);
    execFileSync(
      "npm",
      ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", installDir, tarball],
      { encoding: "utf8", env: npmEnv }
    );

    const bin = join(installDir, "node_modules", ".bin", "averray-mcp");
    const result = await runPackedToolLoop(bin, {
      ...npmEnv,
      AVERRAY_MCP_TEST_URL: fixture.url,
      NODE_ENV: "test"
    });

    assert.equal(result.initialize.jsonrpc, "2.0");
    assert.equal(result.initialize.id, INITIALIZE_REQUEST.id);
    assert.equal(result.initialize.error, undefined);
    assert.equal(result.initialize.result?.protocolVersion, INITIALIZE_REQUEST.params.protocolVersion);
    assert.equal(typeof result.initialize.result?.capabilities, "object");
    assert.equal(result.initialize.result?.serverInfo?.name, "averray-agent-platform");
    assert.equal(result.toolsList.error, undefined);
    assert.ok(result.toolsList.result?.tools.some((tool) => tool.name === "listJobs"));
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

async function startMcpFixture() {
  const handler = createMcpRoute({
    authMiddleware: async () => ({ wallet: "0xauthed" }),
    clientIp: () => "127.0.0.1",
    enforceLimit: async () => {},
    executeTool: async () => ({ jobs: [] }),
    rateLimitConfig: {
      mcpAnonymous: { limit: 100, windowSeconds: 60 },
      mcpAuthenticated: { limit: 100, windowSeconds: 60 }
    },
    readJsonBody,
    respond
  });
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const handled = await handler({ request, response, pathname: url.pathname });
      if (!handled) respond(response, 404, { error: "not_found" });
    } catch (error) {
      respond(response, 500, { error: error.message });
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })
  };
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function runPackedToolLoop(bin, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let initialize;
    let settled = false;
    const timer = setTimeout(() => {
      finish(new Error(`Packed MCP tool loop timed out. stderr:\n${stderr}`));
    }, 30_000);

    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      if (error) reject(error);
      else resolve(result);
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      let newline;
      while ((newline = stdout.indexOf("\n")) >= 0) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (!line) continue;
        let response;
        try {
          response = JSON.parse(line);
        } catch (error) {
          finish(new Error(`Packed MCP emitted invalid JSON: ${error.message}\nline:\n${line}\nstderr:\n${stderr}`));
          return;
        }
        if (response.id === INITIALIZE_REQUEST.id) {
          initialize = response;
          child.stdin.write(`${JSON.stringify({
            jsonrpc: "2.0",
            method: "notifications/initialized",
            params: {}
          })}\n`);
          // mcp-remote sends the notification and the following request over
          // separate HTTP calls. Give the notification its ordering point so
          // this tests the post-initialize tool loop, not a client-side race.
          setTimeout(() => {
            child.stdin.write(`${JSON.stringify(TOOLS_LIST_REQUEST)}\n`);
          }, 100);
        } else if (response.id === TOOLS_LIST_REQUEST.id) {
          finish(undefined, { initialize, toolsList: response });
          return;
        }
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      if (!settled) {
        finish(new Error(
          `Packed MCP exited before tools/list: code=${code} signal=${signal}\nstdout:\n${stdout}\nstderr:\n${stderr}`
        ));
      }
    });
    child.stdin.write(`${JSON.stringify(INITIALIZE_REQUEST)}\n`);
  });
}
