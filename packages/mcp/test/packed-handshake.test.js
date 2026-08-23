import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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

test("packed @averray/mcp bin returns a real hosted InitializeResult", { timeout: 45_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "averray-mcp-packed-handshake-"));
  const packDir = join(root, "pack");
  const installDir = join(root, "install");
  const npmCache = join(root, "npm-cache");
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
    const response = await initializePackedBin(bin);

    assert.equal(response.jsonrpc, "2.0");
    assert.equal(response.id, INITIALIZE_REQUEST.id);
    assert.equal(response.error, undefined);
    assert.equal(response.result?.protocolVersion, INITIALIZE_REQUEST.params.protocolVersion);
    assert.equal(typeof response.result?.capabilities, "object");
    assert.equal(response.result?.serverInfo?.name, "averray-agent-platform");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function initializePackedBin(bin) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      finish(new Error(`Packed MCP initialize timed out. stderr:\n${stderr}`));
    }, 30_000);

    function finish(error, response) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      if (error) reject(error);
      else resolve(response);
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      try {
        finish(undefined, JSON.parse(stdout.slice(0, newline)));
      } catch (error) {
        finish(new Error(`Packed MCP emitted invalid JSON: ${error.message}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      if (!settled) {
        finish(new Error(
          `Packed MCP exited before initialize: code=${code} signal=${signal}\nstdout:\n${stdout}\nstderr:\n${stderr}`
        ));
      }
    });
    child.stdin.write(`${JSON.stringify(INITIALIZE_REQUEST)}\n`);
  });
}
