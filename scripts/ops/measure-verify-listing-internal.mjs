// Local real-server benchmark. All chain traffic stays on a loopback fixture;
// the generated signer is ephemeral and unfunded. Run from the repository root.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Interface, TypedDataEncoder, Wallet } from "ethers";
import { metricPathLabel } from "../../mcp-server/src/protocols/http/http-helpers.js";

const output = process.argv[2];
assert.ok(output && !output.startsWith("--"), "Usage: node scripts/ops/measure-verify-listing-internal.mjs <output.json> [--assert-guards]");
const checkGuards = process.argv.includes("--assert-guards");
const checkRecovery = process.argv.includes("--assert-recovery");
let rpcDown = checkRecovery;
const root = process.cwd();
const abi = new Interface(["function name() view returns (string)", "function DOMAIN_SEPARATOR() view returns (bytes32)"]);
const domain = { name: "USD Coin", version: "2", chainId: 8453,
  verifyingContract: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" };
let rpcCalls = 0;
const rpc = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const input = JSON.parse(body);
  if (rpcDown && req.url !== "/hub") {
    rpcCalls += Array.isArray(input) ? input.length : 1;
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "temporary RPC outage" }));
    return;
  }
  const answer = (msg) => {
    if (req.url !== "/hub") rpcCalls++;
    const unsupported = { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unimplemented fixture call" } };
    let result;
    if (msg.method === "eth_chainId") result = req.url === "/hub" ? "0x1" : "0x2105";
    else if (msg.method === "eth_call") {
      const fn = abi.parseTransaction({ data: msg.params[0].data })?.name;
      if (!fn) return unsupported;
      result = abi.encodeFunctionResult(fn, [fn === "name" ? domain.name : TypedDataEncoder.hashDomain(domain)]);
    } else return unsupported;
    return { jsonrpc: "2.0", id: msg.id, result };
  };
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(Array.isArray(input) ? input.map(answer) : answer(input)));
});
await new Promise((resolve) => rpc.listen(0, "127.0.0.1", resolve));
const probe = createServer();
await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const base = `http://127.0.0.1:${port}`;
const rpcUrl = `http://127.0.0.1:${rpc.address().port}`;
// Short path fits macOS sockaddr_un; no production socket is accessed.
const socket = `/tmp/listing-grants-${process.pid}.sock`;
const child = spawn(process.execPath, [join(root, "mcp-server/src/protocols/http/server.js")], {
  cwd: root,
  env: {
    PATH: process.env.PATH, NODE_ENV: "test", PORT: String(port), AUTH_MODE: "strict",
    JWT_BACKEND: "hmac", AUTH_JWT_SECRETS: "benchmark-only-secret-".repeat(3), AUTH_DOMAIN: "localhost",
    AUTH_CHAIN_ID: "1", STATE_STORE_ALLOW_MEMORY: "1", LOG_LEVEL: "silent", METRICS_AUTH_REQUIRED: "0",
    RPC_URL: `${rpcUrl}/hub`, TREASURY_POLICY_ADDRESS: "0x1111111111111111111111111111111111111111",
    AGENT_ACCOUNT_ADDRESS: "0x2222222222222222222222222222222222222222",
    ESCROW_CORE_ADDRESS: "0x3333333333333333333333333333333333333333",
    REPUTATION_SBT_ADDRESS: "0x4444444444444444444444444444444444444444",
    SUPPORTED_ASSETS_JSON: JSON.stringify([{ symbol: "USDC", assetClass: "trust_backed", assetId: 1337,
      decimals: 6, address: "0x0000053900000000000000000000000001200000" }]),
    SIGNER_BACKEND: "local", SIGNER_PRIVATE_KEY: Wallet.createRandom().privateKey,
    X402_VERIFY_MODE: "enabled", X402_PAYMENT_NETWORK: "eip155:8453", BASE_RPC_URL: rpcUrl,
    X402_PAYMENT_ASSET_ADDRESS: domain.verifyingContract,
    X402_PAYMENT_PAY_TO: "0x1111111111111111111111111111111111111111",
    X402_PAYMENT_ASSET_EIP712_NAME: domain.name, X402_PAYMENT_ASSET_EIP712_VERSION: domain.version,
    X402_PUBLIC_ORIGIN: base, MCP_PROBER_URL: "http://127.0.0.1:1", MCP_EGRESS_GRANT_SOCKET: socket
  },
  stdio: ["ignore", "ignore", "pipe"]
});
let stderr = "";
child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-3000); });
const request = (path, options) => fetch(base + path, { ...options, signal: AbortSignal.timeout(10_000) });
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`server boot failed: ${stderr}`);
    try { const res = await request("/health"); ready = res.ok; await res.text(); } catch {}
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, `boot timeout: ${stderr}`);
  if (checkRecovery) {
    const post = (body = {}) => request("/verify/runs", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const health = await (await request("/health")).json();
    assert.equal(health.status, "degraded");
    assert.ok(health.warnings.some((warning) => warning.code === "verify_payment_domain_unavailable"));
    for (const response of [await post(), await request("/.well-known/x402")]) {
      assert.equal(response.status, 503);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("payment-required"), null);
      const body = await response.json();
      assert.equal(body.error, "payment_domain_unavailable");
      assert.equal(body.details.status, "unavailable");
      assert.equal(body.accepts, undefined);
      assert.equal(body.resources, undefined, "outage cannot look like a healthy empty catalogue");
      assert.ok(!body.message.includes("not enabled yet"));
    }
    rpcDown = false;
    const recovered = await post();
    assert.equal(recovered.status, 402, await recovered.clone().text());
    assert.equal((await recovered.json()).accepts.length, 3);
    const recoveredHealth = await (await request("/health")).json();
    assert.ok(!recoveredHealth.warnings.some((warning) => warning.code === "verify_payment_domain_unavailable"));
    const before = rpcCalls;
    const discovery = await request("/.well-known/x402");
    assert.equal(discovery.status, 200);
    assert.equal((await discovery.json()).resources[0].accepts.length, 3);
    const profiles = (await (await request("/verify/profiles")).json()).profiles;
    for (const profile of profiles) {
      const response = await post(profile.workedExample.request);
      assert.equal(response.status, 402);
      assert.equal((await response.json()).accepts[0].amount, profile.price.amountRaw);
    }
    assert.equal(rpcCalls, before, "recovered unpaid requests and discovery must stay RPC-free");
  }
  const readMetric = async (path, method, required = false) => {
    const res = await request("/metrics"); assert.equal(res.status, 200);
    const text = await res.text();
    const prefix = `http_request_duration_ms_sum{method="${method}",path="${metricPathLabel(path)}"}`;
    const line = text.split("\n").find((line) => line.startsWith(prefix));
    if (required) assert.ok(line, `missing metric ${prefix}`);
    return line ? Number(line.slice(prefix.length).trim()) : 0;
  };
  const startupRpcCalls = rpcCalls;
  if (checkGuards) assert.equal(startupRpcCalls, 3, "startup must validate Base domain before listening");
  const rows = [];
  for (const [path, method] of [["/", "GET"], ["/verify/runs", "POST"], ["/openapi.json", "GET"], ["/llms.txt", "GET"]]) {
    const samples = [];
    let last = await readMetric(path, method);
    for (let i = 0; i < 20; i++) {
      const beforeRpc = rpcCalls;
      const start = performance.now();
      const res = await request(path, method === "POST" ? { method, headers: { "content-type": "application/json" }, body: "{}" } : {});
      const body = await res.text();
      assert.equal(res.status, method === "POST" ? 402 : 200, `${path}: ${body}`);
      const total_ms = performance.now() - start;
      const next = await readMetric(path, method, true);
      const sample = { status: res.status, internal_ms: next - last, total_ms, rpcCalls: rpcCalls - beforeRpc };
      samples.push(sample); last = next;
      if (checkGuards) assert.equal(sample.rpcCalls, 0, `provider call during ${path}`);
      if (checkGuards && method === "GET" && i === 0) {
        const etag = res.headers.get("etag"); assert.match(etag ?? "", /^"[a-f0-9]{64}"$/u);
        const conditional = await request(path, { headers: { "if-none-match": etag } });
        assert.equal(conditional.status, 304); assert.equal(await conditional.text(), "");
        const head = await request(path, { method: "HEAD" });
        assert.equal(head.status, 200); assert.equal(await head.text(), "");
        assert.equal(head.headers.get("etag"), etag);
        assert.equal(Number(head.headers.get("content-length")), Buffer.byteLength(body));
        // Validation/HEAD requests have their own metrics; don't include them
        // in the next measured sample's sum delta.
        last = await readMetric(path, method, true);
      }
    }
    const values = samples.map((sample) => sample.internal_ms).sort((a, b) => a - b);
    const row = { path, method, metricPath: metricPathLabel(path), n: 20,
      p50_ms: values[9], p95_ms: values[18], max_ms: values.at(-1), samples };
    rows.push(row); console.log(JSON.stringify({ ...row, samples: undefined }));
  }
  await writeFile(output, JSON.stringify({ measured_at: new Date().toISOString(),
    revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    working_tree_dirty: Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()),
    method: "20 sequential real HTTP requests per path; per-request delta of existing http_request_duration_ms_sum; integer ms; local memory store and deterministic loopback Base RPC; no warmup; nearest-rank percentiles",
    startupRpcCalls, rows }, null, 2) + "\n");
} finally {
  if (child.exitCode === null) {
    child.kill("SIGTERM");
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    await new Promise((resolve) => child.once("exit", resolve)); clearTimeout(killTimer);
  }
  rpc.closeAllConnections();
  await new Promise((resolve) => rpc.close(resolve));
  await rm(socket, { force: true });
}
