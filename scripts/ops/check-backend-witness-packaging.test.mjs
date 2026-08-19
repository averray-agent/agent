import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("public backend image carries neither Witness tooling nor Docker control", async () => {
  const dockerfile = await readFile(resolve(REPO_ROOT, "mcp-server/Dockerfile"), "utf8");
  const instructions = dockerfile.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
  assert.doesNotMatch(instructions, /COPY witness|apt-get.*\bgit\b|^COPY[^\n]*\bdocker\b|docker\.sock/mu);
});

test("no-listener runner image carries Witness, git, and only the Docker client", async () => {
  const dockerfile = await readFile(resolve(REPO_ROOT, "mcp-server/Dockerfile.witness-runner"), "utf8");
  assert.match(dockerfile, /apt-get install[^\n]*ca-certificates git/u);
  assert.match(dockerfile, /^COPY witness \/witness$/mu);
  assert.match(dockerfile, /COPY --from=docker-cli \/usr\/local\/bin\/docker/u);
  assert.doesNotMatch(dockerfile, /^EXPOSE\s+/mu);
  assert.doesNotMatch(dockerfile, /^COPY[^\n]*dockerd|docker\.sock/mu);
});

test("compose mounts the raw socket only into the allowlisting proxy", async () => {
  const compose = await readFile(resolve(REPO_ROOT, "deploy/docker-compose.mainnet.yml"), "utf8");
  const socketMounts = compose.match(/^\s*- \/var\/run\/docker\.sock:\/var\/run\/docker\.sock:ro$/gmu) ?? [];
  assert.equal(socketMounts.length, 1);
  const runnerSection = compose.split("  mainnet-witness-runner:")[1].split("\n  mainnet-backend:")[0];
  assert.match(runnerSection, /DOCKER_HOST: tcp:\/\/mainnet-witness-docker-proxy:2375/u);
  assert.doesNotMatch(runnerSection, /env_file|ports:|docker\.sock/u);
  assert.doesNotMatch(runnerSection, /AUTH_|KMS_|AWS_|SIGNER_|X402_|PAYMENT/u);
});
