import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Interface } from "ethers";
import { resolvePoolVenuePair } from "./pool-venue-ceremony.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const mainnet = JSON.parse(await readFile(resolve(root, "deployments/mainnet.json"), "utf8"));
const V21 = mainnet.contracts.depositPoolV21;
const LEGACY = mainnet.contracts.legacyDepositPoolV2;
const UNKNOWN = "0x0000000000000000000000000000000000000001";
const run = promisify(execFile);
const timestamp = 1_800_000_000;
const values = {
  totalAssets: 10_000_000n, totalSupply: 10_000_000n, bufferAssets: 10_000_000n,
  bufferFloor: 0n, venuePrincipalCostBasis: 0n, TOTAL_ASSET_CAP: 1_000_000_000n,
  PER_AGENT_ASSET_CAP: 1_000_000_000n, NOTICE_7_DAYS: 604800n,
  nextRedeemRequestId: 1n, nextVenueDeploymentId: 1n, nextVenueRecallId: 1n,
  activeVenueDeploymentId: 0n, activeVenueRecallId: 0n,
};
const abi = new Interface([
  ...Object.keys(values).map((name) => `function ${name}() view returns (uint256)`),
  "function asset() view returns (address)", "function operator() view returns (address)",
  "function venueAdapter() view returns (address)",
  "function deployToVenue(uint256,uint64) returns (uint256)",
]);

// Run the unmodified CLI against a deterministic, read-only RPC fixture. Only
// the manifest's RPC URLs differ; both generations share the same binary and
// address entries. Never contact mainnet or construct a signing fixture here.
async function fixture(t, { liveAdapters = {} } = {}) {
  const requests = [];
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/observability") {
      res.end(JSON.stringify({ available: true, pool: url.searchParams.get("pool"), reconciled: true,
        block: { number: 100, timestamp }, flows: { status: "ok" } }));
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    const handle = (request) => {
      requests.push(request);
      const reply = { jsonrpc: "2.0", id: request.id };
      try {
        if (request.method === "eth_chainId") reply.result = "0x190f1b43";
        else if (request.method === "eth_blockNumber") reply.result = "0x64";
        else if (request.method === "eth_getBlockByNumber") reply.result = {
          number: "0x64", hash: `0x${"11".repeat(32)}`, parentHash: `0x${"22".repeat(32)}`,
          timestamp: `0x${timestamp.toString(16)}`, nonce: "0x0000000000000000", difficulty: "0x0",
          gasLimit: "0x1c9c380", gasUsed: "0x0", miner: UNKNOWN, extraData: "0x", transactions: [],
        };
        else if (request.method === "eth_call") {
          const [call] = request.params;
          const parsed = abi.parseTransaction(call);
          const pool = [V21, LEGACY].find((address) => address.toLowerCase() === call.to.toLowerCase());
          assert.ok(pool, `unexpected RPC target ${call.to}`);
          let value = values[parsed.name];
          if (parsed.name === "asset") value = mainnet.contracts.token;
          if (parsed.name === "operator") value = mainnet.verifier;
          if (parsed.name === "venueAdapter") value = liveAdapters[pool] ?? resolvePoolVenuePair(mainnet, pool).adapterAddress;
          if (parsed.name === "deployToVenue") {
            assert.equal(call.from.toLowerCase(), mainnet.verifier.toLowerCase());
            value = 1n;
          }
          reply.result = abi.encodeFunctionResult(parsed.name, [value]);
        } else throw new Error(`forbidden RPC method ${request.method}`);
      } catch (error) { reply.error = { code: -32000, message: error.message }; }
      return reply;
    };
    res.end(JSON.stringify(Array.isArray(payload) ? payload.map(handle) : handle(payload)));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => server.close(done)));
  const directory = await realpath(await mkdtemp(resolve(tmpdir(), "venue-pair-cli-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(resolve(directory, "scripts/ops"), { recursive: true });
  await mkdir(resolve(directory, "deployments"));
  for (const file of ["pool-venue-ceremony.mjs", "ceremony-rpc.mjs", "ceremony-module-loader.mjs"]) {
    await copyFile(resolve(root, "scripts/ops", file), resolve(directory, "scripts/ops", file));
  }
  for (const path of ["node_modules", "mcp-server"]) await symlink(resolve(root, path), resolve(directory, path), "dir");
  const rpcUrl = `http://127.0.0.1:${server.address().port}`;
  const manifest = { ...structuredClone(mainnet), rpcUrl, rpcBackupUrls: [] };
  const saveManifest = () => writeFile(resolve(directory, "deployments/mainnet.json"), JSON.stringify(manifest));
  await saveManifest();
  async function deploy(pool, extra = []) {
    try {
      const output = await run(process.execPath, [resolve(directory, "scripts/ops/pool-venue-ceremony.mjs"),
        "deploy", "--profile", "mainnet", "--pool", pool, "--assets", "2000000",
        "--return-by", String(timestamp + 3600), "--expected-signer", mainnet.verifier,
        "--observability-url", `${rpcUrl}/observability`, ...extra,
      ], { timeout: 15000, env: { PATH: process.env.PATH } });
      return { ...output, code: 0 };
    } catch (error) { return error; }
  }
  return { deploy, requests, manifest, saveManifest };
}

test("same ceremony CLI and manifest select the targeted v2.1 or legacy venue pair", async (t) => {
  const { deploy } = await fixture(t);
  for (const [pool, adapter] of [[V21, mainnet.contracts.hydrationDepositPoolAdapterV21], [LEGACY, mainnet.contracts.hydrationDepositPoolAdapterV2]]) {
    const result = await deploy(pool.toLowerCase());
    assert.equal(result.code, 0, result.stderr);
    assert.ok(result.stdout.includes(`"venueAdapter": "${adapter}"`), result.stdout);
    assert.match(result.stdout, /"staticCall": "success"/u);
  }
});

test("unknown or incomplete pool manifest entries refuse by pool name before RPC without fallback", async (t) => {
  const context = await fixture(t);
  // Even the canonical alias cannot lend an unknown pool another pool's pair.
  context.manifest.contracts.depositPool = UNKNOWN;
  await context.saveManifest();
  let result = await context.deploy(UNKNOWN);
  assert.equal(result.code, 1);
  assert.ok(result.stderr.includes(`Pool ${UNKNOWN} has no manifest venue pair`));
  for (const key of ["hydrationDepositPoolAdapterV21", "depositPoolLaneV21"]) {
    const original = context.manifest.contracts[key];
    delete context.manifest.contracts[key];
    await context.saveManifest();
    result = await context.deploy(V21);
    assert.equal(result.code, 1);
    assert.ok(result.stderr.includes(`Pool ${V21} has no valid manifest contracts.${key}`));
    context.manifest.contracts[key] = original;
  }
  delete context.manifest.deploymentBlocks.hydrationDepositPoolAdapterV21;
  await context.saveManifest();
  result = await context.deploy(V21);
  assert.equal(result.code, 1);
  assert.ok(result.stderr.includes(`Pool ${V21} has no valid manifest deploymentBlocks.hydrationDepositPoolAdapterV21`));
  context.manifest.contracts.legacyDepositPoolV2 = V21;
  await context.saveManifest();
  result = await context.deploy(V21);
  assert.equal(result.code, 1);
  assert.ok(result.stderr.includes(`Pool ${V21} has ambiguous manifest venue pair`));
  assert.deepEqual(context.requests, []);
});

test("live venueAdapter disagreement still refuses each pool before staticCall", async (t) => {
  const { deploy, requests } = await fixture(t, { liveAdapters: {
    [V21]: mainnet.contracts.hydrationDepositPoolAdapterV2,
    [LEGACY]: mainnet.contracts.hydrationDepositPoolAdapterV21,
  } });
  for (const pool of [V21, LEGACY]) {
    const result = await deploy(pool);
    assert.equal(result.code, 1);
    assert.ok(result.stderr.includes(`Pool ${pool} venueAdapter`));
    assert.match(result.stderr, /!= manifest/u);
  }
  assert.ok(requests.filter((r) => r.method === "eth_call").every((r) => abi.parseTransaction(r.params[0]).name !== "deployToVenue"));
});

test("legacy deploy dry run preserves its existing adapter, calldata and admission guards", async (t) => {
  const { deploy, requests } = await fixture(t);
  const result = await deploy(LEGACY);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /"poolAdapterMatchesManifest": true/u);
  const call = requests.find((r) => r.method === "eth_call" && abi.parseTransaction(r.params[0]).name === "deployToVenue").params[0];
  assert.equal(call.to, LEGACY.toLowerCase());
  assert.equal(call.data, abi.encodeFunctionData("deployToVenue", [2_000_000n, timestamp + 3600]));
  const refused = await deploy(LEGACY, ["--assets", "5000001"]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /50% deployment policy/u);
});

test("pool-specific dry runs request no signature or broadcast and retain the KMS-only write gate", async (t) => {
  const { deploy, requests } = await fixture(t);
  for (const pool of [V21, LEGACY]) {
    const result = await deploy(pool, ["--dry-run"]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /DRY RUN ONLY — no signature requested and no transaction broadcast/u);
    assert.match(result.stdout, /"signerBackend": "expected-signer \(dry-run only\)"/u);
  }
  assert.ok(requests.every((r) => ["eth_chainId", "eth_blockNumber", "eth_getBlockByNumber", "eth_call"].includes(r.method)));
  const count = requests.length;
  const refused = await deploy(V21, ["--commit"]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /--commit requires --use-kms/u);
  assert.equal(requests.length, count);
});
