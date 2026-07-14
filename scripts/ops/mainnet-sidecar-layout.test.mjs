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
  assert.deepEqual(Object.keys(config.services).sort(), ["mainnet-backend", "mainnet-indexer", "mainnet-redis"]);

  const backend = config.services["mainnet-backend"];
  const indexer = config.services["mainnet-indexer"];
  const redis = config.services["mainnet-redis"];
  assert.equal(backend.container_name, "agent-mainnet-backend");
  assert.equal(indexer.container_name, "agent-mainnet-indexer");
  assert.equal(redis.container_name, "agent-mainnet-redis");
  assert.equal(backend.ports[0].host_ip, "127.0.0.1");
  assert.equal(backend.ports[0].published, "18787");
  assert.equal(indexer.ports[0].host_ip, "127.0.0.1");
  assert.equal(indexer.ports[0].published, "52069");
  assert.deepEqual(Object.keys(redis.networks), ["mainnet-internal"]);
  assert.equal(config.networks["mainnet-internal"].internal, true);
  assert.equal(config.networks["caddy-testnet"].external, true);
  assert.equal(config.networks["caddy-testnet"].name, "agent-stack_default");

  const backendMountSources = backend.volumes.map((volume) => volume.source);
  assert.ok(backendMountSources.includes("/etc/agent-stack-mainnet/aws-config"));
  assert.ok(backendMountSources.includes("/etc/agent-stack-mainnet/roles-anywhere"));
  assert.ok(!backendMountSources.includes("/etc/agent-stack/aws-config"));
  assert.equal(backend.environment.AWS_USE_ROLES_ANYWHERE, "true");
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
  assert.match(preflight, /\.parameters\.dailyOutflowCap == "0"/u);
  assert.match(preflight, /BADGE_RECEIPT_SIGNING=disabled/u);
  assert.match(start, /testnet_containers=unchanged/u);
  assert.match(start, /cmp -s "\$testnet_before" "\$testnet_after"/u);
  assert.match(flip, /rollback\(\)/u);
  assert.match(flip, /Public health did not report chainId/u);
});
