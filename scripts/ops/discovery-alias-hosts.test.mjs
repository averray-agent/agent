import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { createServer, get as httpGet } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { buildDiscoveryManifest } from "../../mcp-server/src/core/discovery-manifest.js";
import { DISCOVERY_ALIAS_PATHS } from "../../mcp-server/src/core/discovery-aliases.js";
import { createPublicMetadataRoutes } from "../../mcp-server/src/protocols/http/public-metadata-routes.js";
import { respond } from "../../mcp-server/src/protocols/http/http-helpers.js";
import { renderCutover } from "./render-caddy-cutover.mjs";

const exec = promisify(execFile);
const caddyBin = process.env.CADDY_BIN;

// CI provisions the pinned Caddy binary before running test:ops. This is an
// actual edge-proxy proof, not a mock implementation of Caddy's match order.
test("Caddy serves byte-identical discovery aliases on apex and API from the live route family", {
  skip: !caddyBin && !process.env.CI,
  timeout: 30_000
}, async (t) => {
  assert.ok(caddyBin, "CI must provision CADDY_BIN; the edge proof must not silently skip");
  const dir = await mkdtemp(join(tmpdir(), "discovery-alias-hosts-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let amount = "7123456";
  let manifestCalls = 0;
  let pricingCalls = 0;
  const route = createPublicMetadataRoutes({
    authConfig: { chainId: 420420419 },
    publicBaseUrl: "https://api.averray.com",
    buildDiscoveryManifest: (options) => { manifestCalls++; return buildDiscoveryManifest(options); },
    getX402Discovery: async () => {
      pricingCalls++;
      return { x402Version: 2, resources: [{ resource: "https://api.averray.com/verify/runs", maxAmountRequired: amount }] };
    },
    respond
  });
  const backend = createServer(async (request, response) => {
    try {
      if (!await route({ request, response, pathname: new URL(request.url, "http://fixture").pathname })) {
        response.writeHead(404).end();
      }
    } catch (error) { response.writeHead(500).end(error.message); }
  });
  await new Promise((resolve) => backend.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => backend.close(resolve)));
  const backendAddress = `127.0.0.1:${backend.address().port}`;
  const template = await readFile(new URL("../../deploy/Caddyfile.averray", import.meta.url), "utf8");

  for (const network of ["testnet", "mainnet"]) {
    const sourcePath = join(dir, `Caddyfile-${network}`);
    await writeFile(sourcePath, renderCutover(template, network));
    const { stdout } = await exec(caddyBin, ["adapt", "--config", sourcePath, "--adapter", "caddyfile"]);
    const config = JSON.parse(stdout);
    const server = Object.values(config.apps.http.servers)[0];
    server.routes = server.routes.filter((r) => r.match?.some((m) => m.host?.some((h) => ["averray.com", "api.averray.com"].includes(h))));
    assert.equal(server.routes.length, 2);
    // Keep the production routing tree (including the static wildcard), only
    // replacing the network destination and TLS/listen settings for this host.
    const expectedUpstream = network === "mainnet" ? "mainnet-backend:8787" : "backend:8787";
    const walk = (value) => {
      if (!value || typeof value !== "object") return;
      if (value.handler === "reverse_proxy") {
        assert.deepEqual(value.upstreams, [{ dial: expectedUpstream }]);
        value.upstreams = [{ dial: backendAddress }];
      }
      Object.values(value).forEach(walk);
    };
    walk(server.routes);
    const reservation = createServer();
    await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    server.listen = [`127.0.0.1:${port}`];
    server.automatic_https = { disable: true };
    config.admin = { disabled: true };
    config.storage = { module: "file_system", root: join(dir, "storage") };
    const configPath = join(dir, `caddy-${network}.json`);
    await writeFile(configPath, JSON.stringify(config));
    const child = spawn(caddyBin, ["run", "--config", configPath], { stdio: ["ignore", "ignore", "pipe"] });
    let logs = "";
    child.stderr.on("data", (chunk) => { logs += chunk; });
    const stopped = once(child, "exit");
    const stop = async () => { if (child.exitCode === null) child.kill("SIGTERM"); await stopped; };
    t.after(stop);
    const get = (host, path) => new Promise((resolve, reject) => {
      const request = httpGet(`http://127.0.0.1:${port}${path}`, {
        headers: { host, "accept-encoding": "identity" }
      }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, bytes: Buffer.concat(chunks) }));
        response.on("error", reject);
      });
      request.setTimeout(2_000, () => request.destroy(new Error("edge request timed out")));
      request.on("error", reject);
    });
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await get("api.averray.com", "/not-a-route"); ready = true; break; }
      catch { if (child.exitCode !== null) break; await delay(25); }
    }
    assert.ok(ready, logs);
    for (const price of ["7123456", "9234567"]) {
      amount = price;
      for (const path of DISCOVERY_ALIAS_PATHS) {
        const before = { manifestCalls, pricingCalls };
        const apex = await get("averray.com", path);
        const api = await get("api.averray.com", path);
        assert.equal(apex.status, 200, `${network} apex ${path}`);
        assert.equal(api.status, 200, `${network} API ${path}`);
        assert.equal(apex.headers["content-type"], "application/json");
        assert.equal(api.headers["content-type"], "application/json");
        assert.deepEqual(apex.bytes, api.bytes, `${network}: ${path}`);
        assert.equal(JSON.parse(apex.bytes).pricing.resources[0].maxAmountRequired, price);
        assert.equal(manifestCalls - before.manifestCalls, 2);
        assert.equal(pricingCalls - before.pricingCalls, 2);
      }
    }
    await stop();
  }
});
