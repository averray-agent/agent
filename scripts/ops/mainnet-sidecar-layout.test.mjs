import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const COMPOSE = join(ROOT, "deploy", "docker-compose.mainnet.yml");

test("parallel compose isolates mainnet identities, ports, Redis, and AWS mounts", (t) => {
  const result = spawnSync("docker", ["compose", "-f", COMPOSE, "config", "--no-interpolate", "--format", "json"], {
    encoding: "utf8",
  });
  if (result.error?.code === "ENOENT") {
    t.skip("docker compose is unavailable");
    return;
  }
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(config.services).sort(), [
    "mainnet-backend",
    "mainnet-indexer",
    "mainnet-mcp-egress-proxy",
    "mainnet-mcp-prober",
    "mainnet-redis",
    "mainnet-witness-docker-proxy",
    "mainnet-witness-runner",
  ]);

  const backend = config.services["mainnet-backend"];
  const indexer = config.services["mainnet-indexer"];
  const redis = config.services["mainnet-redis"];
  const proxy = config.services["mainnet-witness-docker-proxy"];
  const runner = config.services["mainnet-witness-runner"];
  const mcpProxy = config.services["mainnet-mcp-egress-proxy"];
  const mcpProber = config.services["mainnet-mcp-prober"];
  assert.equal(backend.container_name, "agent-mainnet-backend");
  assert.equal(indexer.container_name, "agent-mainnet-indexer");
  assert.equal(redis.container_name, "agent-mainnet-redis");
  assert.equal(proxy.container_name, "agent-mainnet-witness-docker-proxy");
  assert.equal(runner.container_name, "agent-mainnet-witness-runner");
  assert.equal(mcpProxy.container_name, "agent-mainnet-mcp-egress-proxy");
  assert.equal(mcpProber.container_name, "agent-mainnet-mcp-prober");
  assert.equal(backend.ports[0].host_ip, "127.0.0.1");
  assert.equal(backend.ports[0].published, "18787");
  assert.equal(indexer.ports[0].host_ip, "127.0.0.1");
  assert.equal(indexer.ports[0].published, "52069");
  assert.deepEqual(Object.keys(redis.networks), ["mainnet-internal"]);
  assert.equal(config.networks["mainnet-internal"].internal, true);
  assert.equal(config.networks["witness-docker-control"].internal, true);
  assert.equal(config.networks["mcp-probe-egress"].internal, true);
  assert.equal(config.networks["mcp-probe-submit-control"].internal, true);
  assert.equal(config.networks["caddy-testnet"].external, true);
  assert.equal(config.networks["caddy-testnet"].name, "agent-stack_default");

  const backendMountSources = backend.volumes.map((volume) => volume.source);
  assert.ok(backendMountSources.includes("/etc/agent-stack-mainnet/aws-config"));
  assert.ok(backendMountSources.includes("/etc/agent-stack-mainnet/roles-anywhere"));
  assert.ok(!backendMountSources.includes("/etc/agent-stack/aws-config"));
  assert.ok(!backendMountSources.includes("/var/run/docker.sock"));
  assert.equal(backend.environment.AWS_USE_ROLES_ANYWHERE, "true");

  const proxyMountSources = proxy.volumes.map((volume) => volume.source);
  const runnerMountSources = runner.volumes.map((volume) => volume.source);
  assert.deepEqual(proxyMountSources, ["/var/run/docker.sock"]);
  assert.ok(!runnerMountSources.includes("/var/run/docker.sock"));
  assert.equal(runner.ports, undefined);
  assert.equal(runner.env_file, undefined);
  assert.deepEqual(Object.keys(runner.environment).sort(), [
    "DOCKER_HOST",
    "NODE_ENV",
    "REDIS_NAMESPACE",
    "REDIS_URL",
    "WITNESS_IMAGE",
    "WITNESS_IMAGE_BUILD",
    "WITNESS_RUNNER_CLAIM_LEASE_SECONDS",
    "WITNESS_RUNNER_INTERVAL_MS",
    "WITNESS_TEMP_ROOT",
  ]);
  assert.match(runner.environment.DOCKER_HOST, /^tcp:\/\/mainnet-witness-docker-proxy:/u);
  assert.deepEqual(Object.keys(proxy.networks), ["witness-docker-control"]);
  assert.ok(!Object.hasOwn(backend.networks, "witness-docker-control"));
  assert.deepEqual(Object.keys(mcpProber.networks), ["mcp-probe-egress"]);
  assert.equal(mcpProber.ports, undefined);
  assert.equal(mcpProber.env_file, undefined);
  assert.deepEqual(Object.keys(mcpProber.environment).sort(), ["MCP_EGRESS_PROXY_URL", "NODE_ENV", "PORT"]);
  assert.ok(!Object.hasOwn(mcpProxy.networks, "mainnet-internal"));
  assert.ok(Object.hasOwn(mcpProxy.networks, "mcp-target-egress"));
  assert.ok(Object.hasOwn(backend.networks, "mcp-probe-submit-control"));
  assert.ok(!Object.hasOwn(backend.networks, "mcp-probe-egress"));
});

test("mainnet AWS config has three isolated profiles and no testnet references", async () => {
  const source = await readFile(join(ROOT, "deploy", "aws-config.mainnet"), "utf8");
  for (const profile of ["averray-signer", "averray-jwt-signer", "averray-badge-receipt-signer"]) {
    assert.equal(source.split(`[profile ${profile}]`).length - 1, 1);
  }
  assert.doesNotMatch(source, /testnet/iu);
  assert.match(source, /averray-signer-prod-role/u);
  assert.match(source, /averray-jwt-signer-prod-role/u);
  assert.match(source, /averray-badge-receipt-signer-prod-role/u);
});

test("cutover scripts fail closed on cap, preserve testnet identity, and auto-rollback Caddy", async () => {
  const preflight = await readFile(join(ROOT, "scripts", "ops", "preflight-mainnet-sidecar.sh"), "utf8");
  const start = await readFile(join(ROOT, "scripts", "ops", "start-mainnet-sidecar.sh"), "utf8");
  const flip = await readFile(join(ROOT, "scripts", "ops", "flip-caddy-network.sh"), "utf8");
  assert.match(preflight, /\.parameters\.dailyOutflowCap == \$cap/u);
  assert.match(preflight, /115792089237316195423570985008687907853269984665640564039457584007913129639935/u);
  assert.match(preflight, /\.mapAccount\.status == "auto_mapped"/u);
  assert.match(preflight, /POLKADOT_CHAIN_ID 420420419/u);
  assert.match(preflight, /owner_go_gate=pending \(internal sidecar only; ownership\/admin rehearsal still required\)/u);
  assert.match(preflight, /BADGE_RECEIPT_SIGNING=disabled/u);
  assert.match(start, /testnet_containers=unchanged/u);
  assert.match(start, /cmp -s "\$testnet_before" "\$testnet_after"/u);
  assert.match(start, /build --build-arg "DEPLOYED_SHA=\$DEPLOYED_SHA" mainnet-backend/u);
  assert.match(start, /\.deployedSha == \$sha/u);
  assert.match(flip, /rollback\(\)/u);
  assert.match(flip, /Public health did not report chainId/u);
});

test("mainnet env renderer and tmpfiles allow only the isolated mainnet runtime path", async () => {
  const render = await readFile(join(ROOT, "scripts", "ops", "render-vps-env.sh"), "utf8");
  const tmpfiles = await readFile(join(ROOT, "deploy", "agent-stack.tmpfiles.conf"), "utf8");
  assert.match(render, /\/run\/agent-stack\/\*\|\/run\/agent-stack-mainnet\/\*/u);
  assert.match(render, /not inside an allowed agent-stack runtime directory/u);
  assert.match(tmpfiles, /^d \/run\/agent-stack-mainnet 0750 root ubuntu - -$/mu);
});
