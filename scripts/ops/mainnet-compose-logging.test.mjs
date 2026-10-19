import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const COMPOSE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "deploy", "docker-compose.mainnet.yml");

const EXPECTED_LOGGING = {
  driver: "json-file",
  options: {
    "max-size": "10m",
    "max-file": "5",
  },
};

const EXPECTED_SERVICES = [
  "mainnet-backend",
  "mainnet-indexer",
  "mainnet-mcp-egress-proxy",
  "mainnet-mcp-prober",
  "mainnet-redis",
  "mainnet-witness-docker-proxy",
  "mainnet-witness-runner",
];

test("every mainnet compose service uses the shared size-capped logging anchor", async () => {
  const source = await readFile(COMPOSE, "utf8");
  const document = yaml.load(source);
  assert.equal(document["x-logging"] === undefined, false, "x-logging anchor is missing");
  assert.deepEqual(document["x-logging"], EXPECTED_LOGGING);
  assert.equal((source.match(/&default-logging\b/gu) ?? []).length, 1, "logging anchor must be defined once");
  assert.match(source, /^x-logging:\s*&default-logging\s*$/mu);

  const services = document.services ?? {};
  const names = Object.keys(services).sort();
  assert.deepEqual(names, EXPECTED_SERVICES);
  assert.equal(
    (source.match(/^ {4}logging:\s*\*default-logging\s*$/gmu) ?? []).length,
    names.length,
    "every service must reference *default-logging",
  );

  for (const name of names) {
    assert.deepEqual(
      services[name].logging,
      EXPECTED_LOGGING,
      `${name} is missing the size-capped json-file logging config`,
    );
  }
});
