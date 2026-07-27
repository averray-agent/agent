import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, copyFile, chmod, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

import {
  buildSelection,
  writeSelectionAtomic,
} from "./caddy-network-selection.mjs";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DEPLOY_SCRIPT = join(REPO_ROOT, "scripts/ops/deploy-production.sh");
// DERIVE_SETTLEMENT_ENV_SCRIPT was removed in PR 2.6: deploy-production.sh
// no longer calls derive-settlement-env.mjs at runtime (the template carries
// the settlement values directly, and CI enforces drift via
// scripts/ops/check-template-matches-manifest.mjs).

test("deploy wrapper retries frontend after an earlier failed indexer deploy", async () => {
  const root = await mkdtemp(join(tmpdir(), "deploy-production-"));
  const appRoot = join(root, "app");
  const stackRoot = join(root, "stack");
  const fakeBin = join(root, "bin");
  const stateDir = join(root, "state");
  const deployLog = join(root, "deploy.log");

  await mkdir(join(appRoot, "scripts/ops"), { recursive: true });
  await mkdir(join(appRoot, "app"), { recursive: true });
  await mkdir(join(appRoot, "indexer"), { recursive: true });
  await mkdir(stackRoot, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await writeFile(join(stackRoot, "docker-compose.yml"), "services: {}\n");
  await copyFile(DEPLOY_SCRIPT, join(appRoot, "scripts/ops/deploy-production.sh"));
  await chmod(join(appRoot, "scripts/ops/deploy-production.sh"), 0o755);

  await writeExecutable(join(appRoot, "scripts/ops/redeploy-indexer.sh"), [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "echo indexer >> \"$DEPLOY_LOG\"",
    "if [[ \"${FAIL_INDEXER:-0}\" == \"1\" ]]; then exit 1; fi"
  ].join("\n"));
  await writeExecutable(join(appRoot, "scripts/ops/redeploy-frontend.sh"), [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "echo frontend >> \"$DEPLOY_LOG\""
  ].join("\n"));
  await writeExecutable(join(appRoot, "scripts/ops/redeploy-backend.sh"), [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "echo backend >> \"$DEPLOY_LOG\""
  ].join("\n"));
  await writeExecutable(join(appRoot, "scripts/ops/check-hosted-stack.sh"), [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "echo smoke >> \"$DEPLOY_LOG\""
  ].join("\n"));
  await writeExecutable(join(appRoot, "scripts/ops/render-caddyfile.sh"), [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "echo caddy-render >> \"$DEPLOY_LOG\""
  ].join("\n"));

  for (const command of ["docker", "npm", "flock"]) {
    await writeExecutable(join(fakeBin, command), "#!/usr/bin/env bash\nexit 0\n");
  }
  await writeFakeHealthCurl(join(fakeBin, "curl"));

  git(appRoot, "init");
  git(appRoot, "config", "user.email", "test@example.com");
  git(appRoot, "config", "user.name", "Deploy Test");
  await writeFile(join(appRoot, "README.md"), "base\n");
  await writeFile(join(appRoot, "app/README.md"), "base app\n");
  await writeFile(join(appRoot, "indexer/README.md"), "base indexer\n");
  git(appRoot, "add", ".");
  git(appRoot, "commit", "-m", "base");
  const baseSha = revParse(appRoot, "HEAD");

  await writeFile(join(appRoot, "app/page.tsx"), "export default function Page() { return null; }\n");
  git(appRoot, "add", ".");
  git(appRoot, "commit", "-m", "frontend change");
  const frontendSha = revParse(appRoot, "HEAD");

  const firstRun = runDeploy(appRoot, {
    PATH: `${fakeBin}:${process.env.PATH}`,
    STACK_ROOT: stackRoot,
    COMPOSE_FILE: join(stackRoot, "docker-compose.yml"),
    DEPLOY_LOCK_FILE: join(root, "deploy.lock"),
    DEPLOY_STATE_DIR: stateDir,
    DEPLOY_OLD_SHA: baseSha,
    DEPLOY_NEW_SHA: frontendSha,
    DEPLOY_LOG: deployLog,
    FAIL_INDEXER: "1",
    RUN_INDEXER: "1",
    RUN_SITE: "0",
    RUN_CADDY: "0",
    RUN_SMOKE: "0"
  });
  assert.equal(firstRun.status, 1);
  assert.match(await readFile(deployLog, "utf8"), /^indexer$/m);
  assert.doesNotMatch(await readFile(deployLog, "utf8"), /^frontend$/m);
  assert.equal((await readFile(join(stateDir, "frontend.last-good"), "utf8")).trim(), baseSha);

  await writeFile(join(appRoot, "indexer/fix.ts"), "export const fixed = true;\n");
  git(appRoot, "add", ".");
  git(appRoot, "commit", "-m", "indexer fix");
  const indexerFixSha = revParse(appRoot, "HEAD");
  await writeFile(deployLog, "");

  const secondRun = runDeploy(appRoot, {
    PATH: `${fakeBin}:${process.env.PATH}`,
    STACK_ROOT: stackRoot,
    COMPOSE_FILE: join(stackRoot, "docker-compose.yml"),
    DEPLOY_LOCK_FILE: join(root, "deploy.lock"),
    DEPLOY_STATE_DIR: stateDir,
    DEPLOY_OLD_SHA: frontendSha,
    DEPLOY_NEW_SHA: indexerFixSha,
    DEPLOY_LOG: deployLog,
    RUN_BACKEND: "0",
    RUN_INDEXER: "0",
    RUN_SITE: "0",
    RUN_CADDY: "0",
    RUN_SMOKE: "0"
  });
  assert.equal(secondRun.status, 0, secondRun.stderr);
  assert.match(await readFile(deployLog, "utf8"), /^frontend$/m);
  assert.equal((await readFile(join(stateDir, "frontend.last-good"), "utf8")).trim(), indexerFixSha);
});

test("root workspace lock changes do not restart the independently packaged indexer", async () => {
  const root = await mkdtemp(join(tmpdir(), "deploy-indexer-gate-"));
  const appRoot = join(root, "app");
  const stackRoot = join(root, "stack");
  const fakeBin = join(root, "bin");
  const stateDir = join(root, "state");
  const deployLog = join(root, "deploy.log");

  await mkdir(join(appRoot, "scripts/ops"), { recursive: true });
  await mkdir(join(appRoot, "indexer"), { recursive: true });
  await mkdir(stackRoot, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await writeFile(join(stackRoot, "docker-compose.yml"), "services: {}\n");
  await copyFile(DEPLOY_SCRIPT, join(appRoot, "scripts/ops/deploy-production.sh"));
  await chmod(join(appRoot, "scripts/ops/deploy-production.sh"), 0o755);
  await writeExecutable(join(appRoot, "scripts/ops/redeploy-indexer.sh"), [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "echo indexer >> \"$DEPLOY_LOG\""
  ].join("\n"));
  for (const command of ["docker", "npm", "flock"]) {
    await writeExecutable(join(fakeBin, command), "#!/usr/bin/env bash\nexit 0\n");
  }
  await writeFakeHealthCurl(join(fakeBin, "curl"));

  git(appRoot, "init");
  git(appRoot, "config", "user.email", "test@example.com");
  git(appRoot, "config", "user.name", "Deploy Test");
  await writeFile(join(appRoot, "package-lock.json"), '{"lockfileVersion":3,"packages":{}}\n');
  await writeFile(join(appRoot, "indexer/package.json"), '{"name":"indexer","dependencies":{}}\n');
  git(appRoot, "add", ".");
  git(appRoot, "commit", "-m", "base");
  const baseSha = revParse(appRoot, "HEAD");

  await writeFile(
    join(appRoot, "package-lock.json"),
    '{"lockfileVersion":3,"packages":{"app/node_modules/canonicalize":{"version":"3.0.0"}}}\n'
  );
  git(appRoot, "add", ".");
  git(appRoot, "commit", "-m", "app dependency");
  const appDependencySha = revParse(appRoot, "HEAD");

  const env = (oldSha, newSha) => ({
    PATH: `${fakeBin}:${process.env.PATH}`,
    STACK_ROOT: stackRoot,
    COMPOSE_FILE: join(stackRoot, "docker-compose.yml"),
    DEPLOY_LOCK_FILE: join(root, "deploy.lock"),
    DEPLOY_STATE_DIR: stateDir,
    DEPLOY_OLD_SHA: oldSha,
    DEPLOY_NEW_SHA: newSha,
    DEPLOY_LOG: deployLog,
    RUN_BACKEND: "0",
    RUN_INDEXER: "auto",
    RUN_FRONTEND: "0",
    RUN_SITE: "0",
    RUN_CADDY: "0",
    RUN_SMOKE: "0"
  });

  const appOnlyRun = runDeploy(appRoot, env(baseSha, appDependencySha));
  assert.equal(appOnlyRun.status, 0, appOnlyRun.stderr);
  assert.match(appOnlyRun.stdout, /Skipping indexer deploy/u);
  assert.equal(await readFile(deployLog, "utf8").catch(() => ""), "");

  await writeFile(
    join(appRoot, "indexer/package.json"),
    '{"name":"indexer","dependencies":{"ponder":"0.16.6"}}\n'
  );
  git(appRoot, "add", ".");
  git(appRoot, "commit", "-m", "indexer dependency");
  const indexerDependencySha = revParse(appRoot, "HEAD");

  const indexerRun = runDeploy(appRoot, env(appDependencySha, indexerDependencySha));
  assert.equal(indexerRun.status, 0, indexerRun.stderr);
  assert.match(await readFile(deployLog, "utf8"), /^indexer$/m);
});

test("unchanged Caddy content does not imply an indexer smoke check", async () => {
  const root = await mkdtemp(join(tmpdir(), "deploy-caddy-outcome-"));
  const appRoot = join(root, "app");
  const stackRoot = join(root, "stack");
  const fakeBin = join(root, "bin");
  const stateDir = join(root, "state");
  const deployLog = join(root, "deploy.log");
  const renderSource = join(root, "rendered-caddyfile");

  await mkdir(join(appRoot, "scripts/ops"), { recursive: true });
  await mkdir(stackRoot, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await writeFile(join(stackRoot, "docker-compose.yml"), "services: {}\n");
  await writeFile(join(stackRoot, "Caddyfile"), "same config\n");
  await writeFile(renderSource, "same config\n");
  await copyFile(DEPLOY_SCRIPT, join(appRoot, "scripts/ops/deploy-production.sh"));
  await chmod(join(appRoot, "scripts/ops/deploy-production.sh"), 0o755);
  await writeExecutable(join(appRoot, "scripts/ops/render-caddyfile.sh"), [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "cp \"$FAKE_RENDER_SOURCE\" \"$1\""
  ].join("\n"));
  await writeFile(
    join(appRoot, "scripts/ops/caddy-network-selection.mjs"),
    [
      'import { mkdirSync, writeFileSync } from "node:fs";',
      'import { dirname, join } from "node:path";',
      'const command = process.argv[2];',
      'const option = (name) => process.argv[process.argv.indexOf(name) + 1];',
      'if (command === "bootstrap") {',
      '  const state = option("--state");',
      '  mkdirSync(dirname(state), { recursive: true });',
      '  writeFileSync(state, JSON.stringify({ network: "testnet", expectedChainId: "420420417" }));',
      '  console.log(JSON.stringify({ bootstrapped: true }));',
      '} else if (command === "status") {',
      '  console.log(JSON.stringify({ consistent: true }));',
      '} else if (command === "deploy-target") {',
      '  const stackRoot = option("--stack-root");',
      '  const appRoot = option("--app-root");',
      '  console.log(JSON.stringify({',
      '    network: "testnet",',
      '    composeFile: join(stackRoot, "docker-compose.yml"),',
      '    projectDirectory: stackRoot,',
      '    backendService: "backend",',
      '    backendContainer: "agent-backend",',
      '    indexerService: "indexer",',
      '    runtimeRoot: "/run/agent-stack",',
      '    credentialsRoot: "/etc/agent-stack",',
      '    backendTemplate: join(appRoot, "deploy/backend.env.template"),',
      '    indexerTemplate: join(appRoot, "deploy/indexer.env.template"),',
      '  }));',
      '}',
      '',
    ].join("\n"),
  );
  await copyFile(
    join(REPO_ROOT, "scripts/ops/run-caddy-network-selection.sh"),
    join(appRoot, "scripts/ops/run-caddy-network-selection.sh"),
  );
  await chmod(join(appRoot, "scripts/ops/run-caddy-network-selection.sh"), 0o755);
  await writeExecutable(join(appRoot, "scripts/ops/check-hosted-stack.sh"), [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "echo check-indexer=$CHECK_INDEXER >> \"$DEPLOY_LOG\"",
    "echo check-product-proof=$CHECK_PRODUCT_PROOF_GATE >> \"$DEPLOY_LOG\"",
  ].join("\n"));
  await writeExecutable(join(fakeBin, "docker"), [
    "#!/usr/bin/env bash",
    "echo docker \"$*\" >> \"$DEPLOY_LOG\"",
    "if [[ \"${FAKE_DOCKER_FAIL_RELOAD:-0}\" == \"1\" && \"$*\" == *\"exec -T caddy caddy reload\"* ]]; then exit 1; fi",
    "exit 0"
  ].join("\n"));
  for (const command of ["npm", "flock"]) {
    await writeExecutable(join(fakeBin, command), "#!/usr/bin/env bash\nexit 0\n");
  }
  await writeFakeHealthCurl(join(fakeBin, "curl"));

  git(appRoot, "init");
  git(appRoot, "config", "user.email", "test@example.com");
  git(appRoot, "config", "user.name", "Deploy Test");
  await writeFile(join(appRoot, "README.md"), "base\n");
  git(appRoot, "add", ".");
  git(appRoot, "commit", "-m", "base");
  const baseSha = revParse(appRoot, "HEAD");
  await writeFile(join(appRoot, "README.md"), "next\n");
  git(appRoot, "add", ".");
  git(appRoot, "commit", "-m", "next");
  const nextSha = revParse(appRoot, "HEAD");

  const env = (oldSha, newSha) => ({
    PATH: `${fakeBin}:${process.env.PATH}`,
    STACK_ROOT: stackRoot,
    COMPOSE_FILE: join(stackRoot, "docker-compose.yml"),
    DEPLOY_LOCK_FILE: join(root, "deploy.lock"),
    DEPLOY_STATE_DIR: stateDir,
    DEPLOY_OLD_SHA: oldSha,
    DEPLOY_NEW_SHA: newSha,
    DEPLOY_LOG: deployLog,
    FAKE_RENDER_SOURCE: renderSource,
    APP_BASIC_AUTH_USER: "operator",
    APP_BASIC_AUTH_PASSWORD_HASH: "bcrypt-hash",
    RUN_BACKEND: "0",
    RUN_INDEXER: "0",
    RUN_FRONTEND: "0",
    RUN_SITE: "0",
    RUN_CADDY: "auto",
    RUN_SMOKE: "1"
  });

  const unchangedRun = runDeploy(appRoot, env(baseSha, nextSha));
  assert.equal(unchangedRun.status, 0, unchangedRun.stderr);
  assert.match(unchangedRun.stdout, /Caddyfile content unchanged/u);
  assert.match(await readFile(deployLog, "utf8"), /^check-indexer=0$/m);
  assert.match(await readFile(deployLog, "utf8"), /^check-product-proof=1$/m);
  assert.doesNotMatch(await readFile(deployLog, "utf8"), /restart caddy/u);

  await writeFile(join(appRoot, "README.md"), "third\n");
  git(appRoot, "add", ".");
  git(appRoot, "commit", "-m", "third");
  const thirdSha = revParse(appRoot, "HEAD");
  await writeFile(renderSource, "changed config\n");
  await writeFile(deployLog, "");
  const caddyInodeBefore = (await stat(join(stackRoot, "Caddyfile"))).ino;

  const changedRun = runDeploy(appRoot, env(nextSha, thirdSha));
  assert.equal(changedRun.status, 0, changedRun.stderr);
  assert.match(changedRun.stdout, /Caddyfile content changed/u);
  assert.match(await readFile(deployLog, "utf8"), /exec -T caddy caddy reload/u);
  assert.match(await readFile(deployLog, "utf8"), /^check-indexer=1$/m);
  assert.equal(
    (await stat(join(stackRoot, "Caddyfile"))).ino,
    caddyInodeBefore,
    "normal production deploy must preserve the single-file bind mount inode",
  );
  assert.equal(await readFile(join(stackRoot, "Caddyfile"), "utf8"), "changed config\n");

  await writeFile(join(appRoot, "README.md"), "fourth\n");
  git(appRoot, "add", ".");
  git(appRoot, "commit", "-m", "fourth");
  const fourthSha = revParse(appRoot, "HEAD");
  await writeFile(renderSource, "rejected config\n");
  await writeFile(deployLog, "");
  const rollbackInodeBefore = (await stat(join(stackRoot, "Caddyfile"))).ino;

  const rejectedRun = runDeploy(appRoot, {
    ...env(thirdSha, fourthSha),
    FAKE_DOCKER_FAIL_RELOAD: "1",
  });
  assert.equal(rejectedRun.status, 1);
  assert.match(rejectedRun.stderr, /original bytes restored in place/u);
  assert.equal((await stat(join(stackRoot, "Caddyfile"))).ino, rollbackInodeBefore);
  assert.equal(await readFile(join(stackRoot, "Caddyfile"), "utf8"), "changed config\n");
});

test("deploy rebuilds and verifies the public site even when no site paths changed", async () => {
  const { appRoot, stackRoot, fakeBin, stateDir, deployLog, baseSha, nextSha } =
    await makeSiteFixture();

  const run = runDeploy(appRoot, {
    PATH: `${fakeBin}:${process.env.PATH}`,
    STACK_ROOT: stackRoot,
    COMPOSE_FILE: join(stackRoot, "docker-compose.yml"),
    DEPLOY_LOCK_FILE: join(appRoot, "deploy.lock"),
    DEPLOY_STATE_DIR: stateDir,
    DEPLOY_OLD_SHA: baseSha,
    DEPLOY_NEW_SHA: nextSha,
    DEPLOY_LOG: deployLog,
    FAKE_SERVED_DIR: join(appRoot, "site"),
    RUN_BACKEND: "0",
    RUN_INDEXER: "0",
    RUN_FRONTEND: "0",
    RUN_CADDY: "0",
    RUN_SMOKE: "0"
  });

  assert.equal(run.status, 0, run.stderr);
  // The deploy range only touches README.md — the retired path gate would
  // have skipped the build here, which is exactly how the 2026-06-28 stash
  // regression stayed live for 10 days.
  assert.match(await readFile(deployLog, "utf8"), /run build:site/u);
  assert.match(run.stdout, /Served .*\/ matches built site\/index\.html/u);
  assert.match(run.stdout, /Served .*\/console-stream\.js matches built site\/console-stream\.js/u);
  assert.equal((await readFile(join(stateDir, "site.last-good"), "utf8")).trim(), nextSha);
});

test("post-deploy site serve check fails closed when served bytes differ from the built site", async () => {
  const { appRoot, stackRoot, fakeBin, stateDir, deployLog, baseSha, nextSha, root } =
    await makeSiteFixture();

  const staleDir = join(root, "stale-served");
  await mkdir(staleDir, { recursive: true });
  await writeFile(join(staleDir, "index.html"), "<title>Averray</title> stale pre-#409 copy\n");
  await writeFile(join(staleDir, "console-stream.js"), "// stale console stream\n");

  const run = runDeploy(appRoot, {
    PATH: `${fakeBin}:${process.env.PATH}`,
    STACK_ROOT: stackRoot,
    COMPOSE_FILE: join(stackRoot, "docker-compose.yml"),
    DEPLOY_LOCK_FILE: join(appRoot, "deploy.lock"),
    DEPLOY_STATE_DIR: stateDir,
    DEPLOY_OLD_SHA: baseSha,
    DEPLOY_NEW_SHA: nextSha,
    DEPLOY_LOG: deployLog,
    FAKE_SERVED_DIR: staleDir,
    SITE_SERVE_CHECK_ATTEMPTS: "1",
    RUN_BACKEND: "0",
    RUN_INDEXER: "0",
    RUN_FRONTEND: "0",
    RUN_CADDY: "0",
    RUN_SMOKE: "0"
  });

  assert.equal(run.status, 1);
  assert.match(run.stderr, /does not match the freshly built site\/index\.html/u);
});

test("frontend staleness detector seeds on first deploy and skips while frontend/ matches it", async () => {
  const { appRoot, stackRoot, fakeBin, stateDir, deployLog, baseSha, nextSha, root } =
    await makeFrontendFixture();
  const env = (overrides) => ({
    PATH: `${fakeBin}:${process.env.PATH}`,
    STACK_ROOT: stackRoot,
    COMPOSE_FILE: join(stackRoot, "docker-compose.yml"),
    DEPLOY_LOCK_FILE: join(root, "deploy.lock"),
    DEPLOY_STATE_DIR: stateDir,
    DEPLOY_LOG: deployLog,
    RUN_BACKEND: "0",
    RUN_INDEXER: "0",
    RUN_SITE: "0",
    RUN_CADDY: "0",
    RUN_SMOKE: "0",
    ...overrides
  });

  // Docs-only range: the path gate would skip, but no build tree hash has
  // ever been recorded — the detector forces one build to seed it.
  const first = runDeploy(appRoot, env({ DEPLOY_OLD_SHA: baseSha, DEPLOY_NEW_SHA: nextSha }));
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /no recorded frontend build tree hash/u);
  assert.match(await readFile(deployLog, "utf8"), /^frontend$/m);
  const seeded = (await readFile(join(stateDir, "frontend.built-tree-hash"), "utf8")).trim();
  assert.match(seeded, /^[0-9a-f]{64}$/u);

  // No-op redeploy with the build output still on disk: skip the rebuild.
  await writeFile(deployLog, "");
  const second = runDeploy(appRoot, env({ DEPLOY_OLD_SHA: nextSha, DEPLOY_NEW_SHA: nextSha }));
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /matches the last recorded build tree hash/u);
  assert.doesNotMatch(await readFile(deployLog, "utf8"), /^frontend$/m);
  assert.equal(
    (await readFile(join(stateDir, "frontend.built-tree-hash"), "utf8")).trim(),
    seeded
  );
});

test("frontend staleness detector force-rebuilds after an un-popped stash reverts the build output", async () => {
  const { appRoot, stackRoot, fakeBin, stateDir, deployLog, baseSha, nextSha, root } =
    await makeFrontendFixture();
  const env = (overrides) => ({
    PATH: `${fakeBin}:${process.env.PATH}`,
    STACK_ROOT: stackRoot,
    COMPOSE_FILE: join(stackRoot, "docker-compose.yml"),
    DEPLOY_LOCK_FILE: join(root, "deploy.lock"),
    DEPLOY_STATE_DIR: stateDir,
    DEPLOY_LOG: deployLog,
    RUN_BACKEND: "0",
    RUN_INDEXER: "0",
    RUN_SITE: "0",
    RUN_CADDY: "0",
    RUN_SMOKE: "0",
    ...overrides
  });

  const first = runDeploy(appRoot, env({ DEPLOY_OLD_SHA: baseSha, DEPLOY_NEW_SHA: nextSha }));
  assert.equal(first.status, 0, first.stderr);
  assert.match(await readFile(deployLog, "utf8"), /^frontend$/m);

  // The 2026-06-28 incident, replayed: an ops rollback stashes the checkout
  // (untracked build output included) and never pops — frontend/ silently
  // reverts to the stale committed copies while the path gate sees nothing.
  git(appRoot, "stash", "push", "-u", "-m", "ops path-b backend rollback pre-state");
  assert.equal(
    (await readFile(join(appRoot, "frontend/index.html"), "utf8")).trim(),
    "stale committed operator shell"
  );

  await writeFile(deployLog, "");
  const second = runDeploy(appRoot, env({ DEPLOY_OLD_SHA: nextSha, DEPLOY_NEW_SHA: nextSha }));
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /no longer matches the recorded last-build tree hash/u);
  assert.match(await readFile(deployLog, "utf8"), /^frontend$/m);
  assert.equal(
    (await readFile(join(appRoot, "frontend/index.html"), "utf8")).trim(),
    "fresh operator build 1"
  );
});

test("frontend staleness detector fails closed when the hash tooling breaks", async () => {
  const { appRoot, stackRoot, fakeBin, stateDir, deployLog, baseSha, nextSha, root } =
    await makeFrontendFixture();
  const brokenBin = join(root, "broken-bin");
  await mkdir(brokenBin, { recursive: true });
  await writeExecutable(join(brokenBin, "sha256sum"), "#!/usr/bin/env bash\nexit 1\n");
  const env = (overrides) => ({
    PATH: `${fakeBin}:${process.env.PATH}`,
    STACK_ROOT: stackRoot,
    COMPOSE_FILE: join(stackRoot, "docker-compose.yml"),
    DEPLOY_LOCK_FILE: join(root, "deploy.lock"),
    DEPLOY_STATE_DIR: stateDir,
    DEPLOY_LOG: deployLog,
    RUN_BACKEND: "0",
    RUN_INDEXER: "0",
    RUN_SITE: "0",
    RUN_CADDY: "0",
    RUN_SMOKE: "0",
    ...overrides
  });

  // Healthy first deploy seeds the recorded hash.
  const first = runDeploy(appRoot, env({ DEPLOY_OLD_SHA: baseSha, DEPLOY_NEW_SHA: nextSha }));
  assert.equal(first.status, 0, first.stderr);
  const seeded = (await readFile(join(stateDir, "frontend.built-tree-hash"), "utf8")).trim();

  // With sha256sum broken, the unhashable tree must force a rebuild
  // (fail-safe), and the deploy must then abort rather than record an
  // empty hash — recording it would make every later deploy claim a match
  // by comparing empty to empty.
  await writeFile(deployLog, "");
  const second = runDeploy(appRoot, env({
    PATH: `${brokenBin}:${fakeBin}:${process.env.PATH}`,
    DEPLOY_OLD_SHA: nextSha,
    DEPLOY_NEW_SHA: nextSha
  }));
  assert.equal(second.status, 1);
  assert.match(second.stdout, /could not compute the frontend tree hash/u);
  assert.match(await readFile(deployLog, "utf8"), /^frontend$/m);
  assert.match(second.stderr, /refusing to record it/u);
  assert.equal(
    (await readFile(join(stateDir, "frontend.built-tree-hash"), "utf8")).trim(),
    seeded
  );
});

test("RUN_FRONTEND=0 skips the frontend staleness detector loudly", async () => {
  const { appRoot, stackRoot, fakeBin, stateDir, deployLog, baseSha, nextSha, root } =
    await makeFrontendFixture();
  await writeFile(deployLog, "");

  const run = runDeploy(appRoot, {
    PATH: `${fakeBin}:${process.env.PATH}`,
    STACK_ROOT: stackRoot,
    COMPOSE_FILE: join(stackRoot, "docker-compose.yml"),
    DEPLOY_LOCK_FILE: join(root, "deploy.lock"),
    DEPLOY_STATE_DIR: stateDir,
    DEPLOY_OLD_SHA: baseSha,
    DEPLOY_NEW_SHA: nextSha,
    DEPLOY_LOG: deployLog,
    RUN_BACKEND: "0",
    RUN_INDEXER: "0",
    RUN_FRONTEND: "0",
    RUN_SITE: "0",
    RUN_CADDY: "0",
    RUN_SMOKE: "0"
  });

  assert.equal(run.status, 0, run.stderr);
  assert.doesNotMatch(await readFile(deployLog, "utf8"), /^frontend$/m);
  // Truth boundary: the escape hatch must say the disk check is off, not
  // just that the deploy step was skipped.
  assert.match(run.stdout, /frontend\/ disk staleness is also NOT checked/u);
});

test("docker node fallback persists product-proof evidence on the host", async () => {
  const script = await readFile(DEPLOY_SCRIPT, "utf8");

  assert.match(
    script,
    /PRODUCT_PROOF_EVIDENCE_FILE="\$APP_ROOT\/\$PRODUCT_PROOF_EVIDENCE_FILE"/u,
    "relative evidence paths should be normalized before docker env propagation"
  );
  assert.match(
    script,
    /product_proof_evidence_dir="\$\(dirname "\$PRODUCT_PROOF_EVIDENCE_FILE"\)"/u,
    "docker fallback should derive the host evidence directory"
  );
  assert.match(
    script,
    /mkdir -p "\$product_proof_evidence_dir"/u,
    "docker fallback should create the host evidence directory"
  );
  assert.match(
    script,
    /-v "\$product_proof_evidence_dir:\$product_proof_evidence_dir"/u,
    "docker fallback should mount the evidence directory at the same path"
  );
});

test("deploy wrapper can trigger a one-shot bootstrap self-report before smoke", async () => {
  const script = await readFile(DEPLOY_SCRIPT, "utf8");

  assert.match(
    script,
    /BOOTSTRAP_SELF_REPORT_SEND_NOW=\$\{BOOTSTRAP_SELF_REPORT_SEND_NOW:-0\}/u,
    "deploy wrapper should expose a fail-closed one-shot self-report toggle"
  );
  assert.match(
    script,
    /POST "\$api_base\/admin\/bootstrap-self-report\/send"/u,
    "one-shot trigger should use the admin self-report endpoint"
  );
  assert.match(
    script,
    /\.ok == true and\s+\.result\.status == "sent"/u,
    "one-shot trigger should require sent evidence before continuing"
  );
  const smokeIndex = script.indexOf('echo "Running hosted stack smoke check"');
  const triggerIndex = script.lastIndexOf("run_bootstrap_self_report_once", smokeIndex);
  assert.ok(
    triggerIndex > -1 && triggerIndex < smokeIndex,
    "one-shot trigger must run before the hosted smoke sent-evidence gate"
  );
});

test("indexer schema recovery persists across normal runtime-env renders", async () => {
  const script = await readFile(DEPLOY_SCRIPT, "utf8");
  const indexerTemplate = await readFile(join(REPO_ROOT, "deploy/indexer.env.template"), "utf8");

  assert.match(
    script,
    /INDEXER_ENV_FILE=\$\{INDEXER_ENV_FILE_OVERRIDE:-"\$RUNTIME_ROOT\/indexer\.env"\}/u,
    "schema recovery should target the selected network's rendered indexer env"
  );
  assert.match(
    script,
    /indexer\.database-schema\.\$LIVE_NETWORK/u,
    "the persisted schema override must be scoped per network — a testnet-era pin must never be reapplied to the mainnet indexer"
  );
  assert.match(
    script,
    /LEGACY_INDEXER_SCHEMA_STATE_FILE="\$DEPLOY_STATE_DIR\/indexer\.database-schema"/u,
    "the pre-cutover unscoped state file should remain readable as testnet fallback"
  );
  assert.match(
    script,
    /Ignoring legacy unscoped indexer schema override/u,
    "non-testnet networks must loudly skip the legacy unscoped override instead of inheriting it"
  );
  assert.match(
    script,
    /\/run\/agent-stack\/\*\|\/run\/agent-stack-mainnet\/\*\)/u,
    "schema writes must use sudo for both network runtime roots (mainnet mv regression, 2026-07-27 deploy failures)"
  );
  assert.match(
    script,
    /write_persisted_indexer_schema "\$target_schema"/u,
    "explicit or fresh schema overrides should persist for the next normal deploy"
  );
  assert.match(
    script,
    /Reapplying persisted indexer DATABASE_SCHEMA override/u,
    "normal deploys should reapply a persisted schema override after rendering the template"
  );
  assert.match(
    script,
    /render_runtime_envs\s+apply_indexer_database_schema/u,
    "schema override must run after op inject renders /run env files"
  );
  assert.match(
    indexerTemplate,
    /^DATABASE_SCHEMA=agent_indexer_20260516080108$/m,
    "the template should match the known-good production Ponder schema"
  );
});

test("badge-receipt preflight declaration is per network and byte-matches aws-config.mainnet", async () => {
  const script = await readFile(DEPLOY_SCRIPT, "utf8");
  assert.match(
    script,
    /badge_profile_declaration="\$APP_ROOT\/deploy\/aws-config\.badge-receipt-profile\.mainnet"/u,
    "mainnet deploys must preflight against the mainnet badge declaration — the testnet one can never match the mainnet mounted aws-config (2026-07-27 failure)"
  );
  assert.match(
    script,
    /BADGE_RECEIPT_PROFILE_DECLARATION="\$badge_profile_declaration"/u,
    "the selected declaration must be passed through to redeploy-backend.sh"
  );

  const redeploy = await readFile(join(REPO_ROOT, "scripts/ops/redeploy-backend.sh"), "utf8");
  assert.match(
    redeploy,
    /\$\{BADGE_RECEIPT_PROFILE_DECLARATION:-\$APP_ROOT\/deploy\/aws-config\.badge-receipt-profile\}/u,
    "redeploy-backend must keep the testnet declaration as its standalone default"
  );

  const mainnetDeclaration = await readFile(
    join(REPO_ROOT, "deploy/aws-config.badge-receipt-profile.mainnet"),
    "utf8"
  );
  const mainnetAwsConfigLines = (await readFile(join(REPO_ROOT, "deploy/aws-config.mainnet"), "utf8")).split("\n");
  const declarationLines = mainnetDeclaration
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.startsWith("#"));
  assert.ok(
    declarationLines.includes("[profile averray-badge-receipt-signer]"),
    "mainnet declaration must pin the dedicated badge profile"
  );
  assert.ok(
    declarationLines.some((line) => line.includes("averray-badge-receipt-signer-prod-role")),
    "mainnet declaration must use the mainnet Roles Anywhere role, not the testnet one"
  );
  for (const line of declarationLines) {
    assert.ok(
      mainnetAwsConfigLines.includes(line),
      `mainnet badge declaration line must byte-match deploy/aws-config.mainnet (the file the VPS aws-config is installed from): ${line}`
    );
  }
});

test("normal Caddy deploys consume the durable external network selector", async () => {
  const script = await readFile(DEPLOY_SCRIPT, "utf8");
  assert.match(
    script,
    /CADDY_NETWORK_STATE_FILE=\$\{CADDY_NETWORK_STATE_FILE:-"\$DEPLOY_STATE_DIR\/caddy-network-selection\.json"\}/u,
  );
  assert.match(script, /run-caddy-network-selection\.sh" bootstrap/u);
  assert.match(script, /run-caddy-network-selection\.sh" status/u);
  assert.match(script, /"\$selector" deploy-target/u);
  assert.match(script, /BACKEND_SERVICE/u);
  assert.match(script, /INDEXER_SERVICE/u);
  assert.match(script, /jq -e '\.consistent == true'/u);
  assert.match(script, /refusing an unguarded route repair/u);
  assert.match(
    script,
    /CADDY_NETWORK_STATE_FILE="\$CADDY_NETWORK_STATE_FILE"\s+\\\s+"\$APP_ROOT\/scripts\/ops\/render-caddyfile\.sh"/u,
  );
  assert.match(
    script,
    /apply_caddy\s+verify_public_caddy_network_selection/u,
    "every normal Caddy deploy should verify that the public API still serves the selected chain",
  );
  assert.match(script, /Durable Caddy selection verified publicly: chainId \$expected_chain_id/u);
  assert.doesNotMatch(script, /mv "\$rendered_tmp" "\$STACK_ROOT\/Caddyfile"/u);
  assert.match(script, /cp "\$rendered_tmp" "\$STACK_ROOT\/Caddyfile"/u);
  assert.match(script, /cp -p "\$live_backup" "\$STACK_ROOT\/Caddyfile"/u);
});

test("manual deploys run the product-proof gate unless explicitly opted out", async () => {
  const script = await readFile(DEPLOY_SCRIPT, "utf8");
  assert.match(
    script,
    /SMOKE_CHECK_PRODUCT_PROOF_GATE=\$\{SMOKE_CHECK_PRODUCT_PROOF_GATE:-1\}/u,
  );
});

test("durable mainnet selection drives the live backend compose target", async () => {
  const fixture = await makeDurableMainnetTargetFixture();
  const run = runDeploy(fixture.appRoot, fixture.env);

  assert.equal(run.status, 0, run.stderr);
  const [
    composeFile,
    projectDirectory,
    backendService,
    backendContainer,
    backendTemplate,
    backendEnvTarget,
  ] = (await readFile(fixture.deployLog, "utf8")).trim().split("|");
  assert.ok(composeFile.endsWith("/app/deploy/docker-compose.mainnet.yml"));
  assert.ok(projectDirectory.endsWith("/app"));
  assert.equal(backendService, "mainnet-backend");
  assert.equal(backendContainer, "agent-mainnet-backend");
  assert.ok(backendTemplate.endsWith("/app/deploy/backend.mainnet.env.template"));
  assert.equal(backendEnvTarget, "/run/agent-stack-mainnet/backend.env");
  assert.match(run.stdout, /Live deploy target: network=mainnet/u);
});

test("a skipped backend keeps its pointer so the next automatic run deploys it", async () => {
  const fixture = await makeBackendPointerFixture();

  const skipped = runDeploy(fixture.appRoot, {
    ...fixture.env,
    FAKE_HEALTH_SHA: fixture.baseSha,
    RUN_BACKEND: "auto",
  });
  assert.equal(skipped.status, 0, skipped.stderr);
  assert.equal(
    (await readFile(join(fixture.stateDir, "backend.last-good"), "utf8")).trim(),
    fixture.baseSha,
  );
  assert.doesNotMatch(await readFile(fixture.deployLog, "utf8").catch(() => ""), /^backend$/mu);

  git(fixture.appRoot, "checkout", fixture.backendSha);
  const deployed = runDeploy(fixture.appRoot, {
    ...fixture.env,
    DEPLOY_OLD_SHA: fixture.docsSha,
    DEPLOY_NEW_SHA: fixture.backendSha,
    FAKE_HEALTH_SHA: fixture.backendSha,
    RUN_BACKEND: "auto",
  });
  assert.equal(deployed.status, 0, deployed.stderr);
  assert.match(await readFile(fixture.deployLog, "utf8"), /^backend$/mu);
  assert.equal(
    (await readFile(join(fixture.stateDir, "backend.last-good"), "utf8")).trim(),
    fixture.backendSha,
  );
});

test("deploy exits non-zero when public health serves a different deployedSha", async () => {
  const fixture = await makeBackendPointerFixture();
  git(fixture.appRoot, "checkout", fixture.backendSha);
  const run = runDeploy(fixture.appRoot, {
    ...fixture.env,
    FAKE_HEALTH_SHA: fixture.baseSha,
    DEPLOY_NEW_SHA: fixture.backendSha,
    RUN_BACKEND: "auto",
  });

  assert.equal(run.status, 1);
  assert.match(run.stderr, /deployedSha/u);
  assert.doesNotMatch(run.stdout, /Production deploy completed/u);
  assert.equal(
    (await readFile(join(fixture.stateDir, "backend.last-good"), "utf8")).trim(),
    fixture.baseSha,
    "a serving-SHA mismatch must not advance the backend deploy pointer",
  );
});

test("deploy wrapper freezes contract surface changes without a manifest update", async () => {
  const { appRoot, stackRoot, fakeBin, stateDir, baseSha, nextSha } = await makeDeployFreezeFixture(
    async (appRoot) => {
      await mkdir(join(appRoot, "contracts"), { recursive: true });
      await writeFile(join(appRoot, "contracts/AgentAccountCore.sol"), "contract AgentAccountCore {}\n");
    },
    "contract surface change"
  );

  const run = runDeploy(appRoot, {
    PATH: `${fakeBin}:${process.env.PATH}`,
    STACK_ROOT: stackRoot,
    COMPOSE_FILE: join(stackRoot, "docker-compose.yml"),
    DEPLOY_LOCK_FILE: join(appRoot, "deploy.lock"),
    DEPLOY_STATE_DIR: stateDir,
    DEPLOY_OLD_SHA: baseSha,
    DEPLOY_NEW_SHA: nextSha,
    RUN_BACKEND: "0",
    RUN_INDEXER: "0",
    RUN_FRONTEND: "0",
    RUN_SITE: "0",
    RUN_CADDY: "0",
    RUN_SMOKE: "0"
  });

  assert.equal(run.status, 1);
  assert.match(run.stderr, /D-03 contract compatibility freeze: refusing production deploy/u);
  assert.match(run.stderr, /contracts\/AgentAccountCore\.sol/u);
  assert.match(run.stderr, /deployments\/testnet\.json did not change/u);
});

test("deploy wrapper allows contract surface changes when the deployment manifest moves with them", async () => {
  const { appRoot, stackRoot, fakeBin, stateDir, baseSha, nextSha } = await makeDeployFreezeFixture(
    async (appRoot) => {
      await mkdir(join(appRoot, "contracts"), { recursive: true });
      await mkdir(join(appRoot, "deployments"), { recursive: true });
      await writeFile(join(appRoot, "contracts/AgentAccountCore.sol"), "contract AgentAccountCore {}\n");
      await writeFile(join(appRoot, "deployments/testnet.json"), '{"contracts":{"agentAccountCore":"0x0000000000000000000000000000000000000001"}}\n');
    },
    "contract surface plus manifest"
  );

  const run = runDeploy(appRoot, {
    PATH: `${fakeBin}:${process.env.PATH}`,
    STACK_ROOT: stackRoot,
    COMPOSE_FILE: join(stackRoot, "docker-compose.yml"),
    DEPLOY_LOCK_FILE: join(appRoot, "deploy.lock"),
    DEPLOY_STATE_DIR: stateDir,
    DEPLOY_OLD_SHA: baseSha,
    DEPLOY_NEW_SHA: nextSha,
    RUN_BACKEND: "0",
    RUN_INDEXER: "0",
    RUN_FRONTEND: "0",
    RUN_SITE: "0",
    RUN_CADDY: "0",
    RUN_SMOKE: "0"
  });

  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /contract-surface changes are paired with deployments\/testnet\.json; allowing deploy/u);
});

test("deploy wrapper exposes an explicit contract surface drift override", async () => {
  const { appRoot, stackRoot, fakeBin, stateDir, baseSha, nextSha } = await makeDeployFreezeFixture(
    async (appRoot) => {
      await mkdir(join(appRoot, "mcp-server/src/blockchain"), { recursive: true });
      await writeFile(join(appRoot, "mcp-server/src/blockchain/abis.js"), "export const ABI = [];\n");
    },
    "backend contract abi change"
  );

  const run = runDeploy(appRoot, {
    PATH: `${fakeBin}:${process.env.PATH}`,
    STACK_ROOT: stackRoot,
    COMPOSE_FILE: join(stackRoot, "docker-compose.yml"),
    DEPLOY_LOCK_FILE: join(appRoot, "deploy.lock"),
    DEPLOY_STATE_DIR: stateDir,
    DEPLOY_OLD_SHA: baseSha,
    DEPLOY_NEW_SHA: nextSha,
    DEPLOY_ALLOW_CONTRACT_SURFACE_DRIFT: "1",
    RUN_BACKEND: "0",
    RUN_INDEXER: "0",
    RUN_FRONTEND: "0",
    RUN_SITE: "0",
    RUN_CADDY: "0",
    RUN_SMOKE: "0"
  });

  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /D-03 contract compatibility freeze override set/u);
  assert.match(run.stdout, /mcp-server\/src\/blockchain\/abis\.js/u);
});

test("deploy workflow wires the D-03 contract surface override as manual-only", async () => {
  const workflow = await readFile(join(REPO_ROOT, ".github/workflows/deploy-production.yml"), "utf8");

  assert.match(
    workflow,
    /allow_contract_surface_drift:/u,
    "workflow_dispatch should expose a named D-03 override"
  );
  assert.match(
    workflow,
    /DEPLOY_ALLOW_CONTRACT_SURFACE_DRIFT:\s*\$\{\{\s*github\.event_name\s*==\s*'workflow_dispatch'\s*&&\s*inputs\.allow_contract_surface_drift\s*\|\|\s*'0'\s*\}\}/u,
    "automatic workflow_run deploys must leave the contract-surface drift override disabled"
  );
  assert.match(
    workflow,
    /printf 'APP_BASIC_AUTH_USER=.*DEPLOY_ALLOW_CONTRACT_SURFACE_DRIFT=%q /u,
    "the manual override must be forwarded through the SSH remote_env wrapper"
  );
  assert.match(
    workflow,
    /"\$DEPLOY_ALLOW_CONTRACT_SURFACE_DRIFT"/u,
    "remote_env must include the evaluated override value"
  );
});

test("deploy workflow forwards an auditable GitHub actor for one-time selector migration", async () => {
  const workflow = await readFile(join(REPO_ROOT, ".github/workflows/deploy-production.yml"), "utf8");
  assert.match(workflow, /DEPLOY_ACTOR=%q/u);
  assert.match(workflow, /github-actions:\$\{\{ github\.actor \}\}/u);
});

async function writeExecutable(path, content) {
  await writeFile(path, `${content}\n`);
  await chmod(path, 0o755);
}

async function writeFakeHealthCurl(path) {
  await writeExecutable(path, [
    "#!/usr/bin/env bash",
    "printf '{\"status\":\"ok\",\"chainId\":\"%s\",\"deployedSha\":\"%s\"}\\n' \"${FAKE_HEALTH_CHAIN_ID:-420420417}\" \"$FAKE_HEALTH_SHA\"",
  ].join("\n"));
}

// Sandbox for the always-build site path: committed site/ files stand in
// for the build output (the fake npm only logs), and the fake curl serves
// bytes from $FAKE_SERVED_DIR so tests control what "Caddy" returns.
async function makeSiteFixture() {
  const root = await mkdtemp(join(tmpdir(), "deploy-site-"));
  const appRoot = join(root, "app");
  const stackRoot = join(root, "stack");
  const fakeBin = join(root, "bin");
  const stateDir = join(root, "state");
  const deployLog = join(root, "deploy.log");

  await mkdir(join(appRoot, "scripts/ops"), { recursive: true });
  await mkdir(join(appRoot, "site"), { recursive: true });
  await mkdir(stackRoot, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await writeFile(join(stackRoot, "docker-compose.yml"), "services: {}\n");
  await copyFile(DEPLOY_SCRIPT, join(appRoot, "scripts/ops/deploy-production.sh"));
  await chmod(join(appRoot, "scripts/ops/deploy-production.sh"), 0o755);

  for (const command of ["docker", "flock"]) {
    await writeExecutable(join(fakeBin, command), "#!/usr/bin/env bash\nexit 0\n");
  }
  await writeExecutable(join(fakeBin, "npm"), [
    "#!/usr/bin/env bash",
    "echo \"npm $*\" >> \"$DEPLOY_LOG\"",
    "exit 0"
  ].join("\n"));
  await writeExecutable(join(fakeBin, "curl"), [
    "#!/usr/bin/env bash",
    "# fake file_server: honours `-o <file> <url>`, serving from $FAKE_SERVED_DIR",
    "out=\"\"",
    "url=\"\"",
    "args=(\"$@\")",
    "for ((i=0; i<${#args[@]}; i++)); do",
    "  case \"${args[i]}\" in",
    "    -o|-H|--max-time) ((i+=1)); [[ \"${args[i-1]}\" == \"-o\" ]] && out=\"${args[i]}\" ;;",
    "    -*) ;;",
    "    *) url=\"${args[i]}\" ;;",
    "  esac",
    "done",
    "name=index.html",
    "case \"$url\" in */console-stream.js) name=console-stream.js ;; esac",
    "if [[ -n \"$out\" && -n \"${FAKE_SERVED_DIR:-}\" ]]; then",
    "  cp \"$FAKE_SERVED_DIR/$name\" \"$out\"",
    "else",
    "  printf '{\"status\":\"ok\",\"chainId\":\"%s\",\"deployedSha\":\"%s\"}\\n' \"${FAKE_HEALTH_CHAIN_ID:-420420417}\" \"$FAKE_HEALTH_SHA\"",
    "fi",
    "exit 0"
  ].join("\n"));

  git(appRoot, "init");
  git(appRoot, "config", "user.email", "test@example.com");
  git(appRoot, "config", "user.name", "Deploy Test");
  await writeFile(join(appRoot, "README.md"), "base\n");
  await writeFile(join(appRoot, "site/index.html"), "<title>Averray</title> fresh build\n");
  await writeFile(join(appRoot, "site/console-stream.js"), "// fresh console stream\n");
  git(appRoot, "add", ".");
  git(appRoot, "commit", "-m", "base");
  const baseSha = revParse(appRoot, "HEAD");

  await writeFile(join(appRoot, "README.md"), "docs-only change\n");
  git(appRoot, "add", ".");
  git(appRoot, "commit", "-m", "docs-only change");
  const nextSha = revParse(appRoot, "HEAD");

  return { root, appRoot, stackRoot, fakeBin, stateDir, deployLog, baseSha, nextSha };
}

// Sandbox for the frontend staleness detector: the fake redeploy-frontend.sh
// stands in for the real Next build by leaving the same disk shape the real
// `npm run build:frontend` does — a tracked modification (index.html) plus an
// untracked build file (_next/chunk.js) layered over the stale committed
// frontend/ copies. `git stash push -u` in a test then reverts both, exactly
// like the 2026-06-28 VPS stash.
async function makeFrontendFixture() {
  const root = await mkdtemp(join(tmpdir(), "deploy-frontend-"));
  const appRoot = join(root, "app");
  const stackRoot = join(root, "stack");
  const fakeBin = join(root, "bin");
  const stateDir = join(root, "state");
  const deployLog = join(root, "deploy.log");

  await mkdir(join(appRoot, "scripts/ops"), { recursive: true });
  await mkdir(join(appRoot, "frontend"), { recursive: true });
  await mkdir(stackRoot, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await writeFile(join(stackRoot, "docker-compose.yml"), "services: {}\n");
  await copyFile(DEPLOY_SCRIPT, join(appRoot, "scripts/ops/deploy-production.sh"));
  await chmod(join(appRoot, "scripts/ops/deploy-production.sh"), 0o755);

  await writeExecutable(join(appRoot, "scripts/ops/redeploy-frontend.sh"), [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "APP_ROOT=$(cd \"$(dirname \"${BASH_SOURCE[0]}\")/../..\" && pwd)",
    "echo frontend >> \"$DEPLOY_LOG\"",
    "printf 'fresh operator build %s\\n' \"${FAKE_FRONTEND_BUILD_STAMP:-1}\" > \"$APP_ROOT/frontend/index.html\"",
    "mkdir -p \"$APP_ROOT/frontend/_next\"",
    "printf '// chunk %s\\n' \"${FAKE_FRONTEND_BUILD_STAMP:-1}\" > \"$APP_ROOT/frontend/_next/chunk.js\""
  ].join("\n"));

  for (const command of ["docker", "npm", "flock"]) {
    await writeExecutable(join(fakeBin, command), "#!/usr/bin/env bash\nexit 0\n");
  }
  await writeFakeHealthCurl(join(fakeBin, "curl"));

  git(appRoot, "init");
  git(appRoot, "config", "user.email", "test@example.com");
  git(appRoot, "config", "user.name", "Deploy Test");
  await writeFile(join(appRoot, "README.md"), "base\n");
  await writeFile(join(appRoot, "frontend/index.html"), "stale committed operator shell\n");
  git(appRoot, "add", ".");
  git(appRoot, "commit", "-m", "base");
  const baseSha = revParse(appRoot, "HEAD");

  await writeFile(join(appRoot, "README.md"), "docs-only change\n");
  git(appRoot, "add", ".");
  git(appRoot, "commit", "-m", "docs-only change");
  const nextSha = revParse(appRoot, "HEAD");

  return { root, appRoot, stackRoot, fakeBin, stateDir, deployLog, baseSha, nextSha };
}

async function makeDeployFreezeFixture(applyChange, message) {
  const root = await mkdtemp(join(tmpdir(), "deploy-contract-freeze-"));
  const appRoot = join(root, "app");
  const stackRoot = join(root, "stack");
  const fakeBin = join(root, "bin");
  const stateDir = join(root, "state");

  await mkdir(join(appRoot, "scripts/ops"), { recursive: true });
  await mkdir(stackRoot, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await writeFile(join(stackRoot, "docker-compose.yml"), "services: {}\n");
  await copyFile(DEPLOY_SCRIPT, join(appRoot, "scripts/ops/deploy-production.sh"));
  await chmod(join(appRoot, "scripts/ops/deploy-production.sh"), 0o755);

  for (const command of ["docker", "npm", "flock"]) {
    await writeExecutable(join(fakeBin, command), "#!/usr/bin/env bash\nexit 0\n");
  }
  await writeFakeHealthCurl(join(fakeBin, "curl"));

  git(appRoot, "init");
  git(appRoot, "config", "user.email", "test@example.com");
  git(appRoot, "config", "user.name", "Deploy Test");
  await writeFile(join(appRoot, "README.md"), "base\n");
  git(appRoot, "add", ".");
  git(appRoot, "commit", "-m", "base");
  const baseSha = revParse(appRoot, "HEAD");

  await applyChange(appRoot);
  git(appRoot, "add", ".");
  git(appRoot, "commit", "-m", message);
  const nextSha = revParse(appRoot, "HEAD");

  return { appRoot, stackRoot, fakeBin, stateDir, baseSha, nextSha };
}

async function makeBackendPointerFixture() {
  const root = await mkdtemp(join(tmpdir(), "deploy-backend-pointer-"));
  const appRoot = join(root, "app");
  const stackRoot = join(root, "stack");
  const fakeBin = join(root, "bin");
  const stateDir = join(root, "state");
  const deployLog = join(root, "deploy.log");

  await mkdir(join(appRoot, "scripts/ops"), { recursive: true });
  await mkdir(join(appRoot, "mcp-server/src"), { recursive: true });
  await mkdir(stackRoot, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await writeFile(join(stackRoot, "docker-compose.yml"), "services: {}\n");
  await copyFile(DEPLOY_SCRIPT, join(appRoot, "scripts/ops/deploy-production.sh"));
  await chmod(join(appRoot, "scripts/ops/deploy-production.sh"), 0o755);
  await writeExecutable(join(appRoot, "scripts/ops/redeploy-backend.sh"), [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "echo backend >> \"$DEPLOY_LOG\"",
  ].join("\n"));
  await writeExecutable(join(fakeBin, "curl"), [
    "#!/usr/bin/env bash",
    "printf '{\"status\":\"ok\",\"deployedSha\":\"%s\"}\\n' \"$FAKE_HEALTH_SHA\"",
  ].join("\n"));
  for (const command of ["docker", "flock", "npm"]) {
    await writeExecutable(join(fakeBin, command), "#!/usr/bin/env bash\nexit 0\n");
  }

  git(appRoot, "init");
  git(appRoot, "config", "user.email", "test@example.com");
  git(appRoot, "config", "user.name", "Deploy Test");
  await writeFile(join(appRoot, "README.md"), "base\n");
  await writeFile(join(appRoot, "mcp-server/src/server.js"), "export const version = 1;\n");
  git(appRoot, "add", ".");
  git(appRoot, "commit", "-m", "base");
  const baseSha = revParse(appRoot, "HEAD");

  await writeFile(join(appRoot, "README.md"), "docs-only change\n");
  git(appRoot, "add", ".");
  git(appRoot, "commit", "-m", "docs change");
  const docsSha = revParse(appRoot, "HEAD");

  await writeFile(join(appRoot, "mcp-server/src/server.js"), "export const version = 2;\n");
  git(appRoot, "add", ".");
  git(appRoot, "commit", "-m", "backend change");
  const backendSha = revParse(appRoot, "HEAD");
  git(appRoot, "checkout", docsSha);

  return {
    appRoot,
    stackRoot,
    fakeBin,
    stateDir,
    deployLog,
    baseSha,
    docsSha,
    backendSha,
    env: {
      PATH: `${fakeBin}:${process.env.PATH}`,
      STACK_ROOT: stackRoot,
      COMPOSE_FILE: join(stackRoot, "docker-compose.yml"),
      DEPLOY_LOCK_FILE: join(root, "deploy.lock"),
      DEPLOY_STATE_DIR: stateDir,
      DEPLOY_OLD_SHA: baseSha,
      DEPLOY_NEW_SHA: docsSha,
      DEPLOY_LOG: deployLog,
      RUN_INDEXER: "0",
      RUN_FRONTEND: "0",
      RUN_SITE: "0",
      RUN_CADDY: "0",
      RUN_SMOKE: "0",
    },
  };
}

async function makeDurableMainnetTargetFixture() {
  const root = await mkdtemp(join(tmpdir(), "deploy-mainnet-target-"));
  const appRoot = join(root, "app");
  const stackRoot = join(root, "stack");
  const fakeBin = join(root, "bin");
  const stateDir = join(root, "state");
  const selectionFile = join(stateDir, "caddy-network-selection.json");
  const deployLog = join(root, "deploy.log");
  const mainnetCompose = join(appRoot, "deploy/docker-compose.mainnet.yml");

  await mkdir(join(appRoot, "scripts/ops"), { recursive: true });
  await mkdir(join(appRoot, "mcp-server/src"), { recursive: true });
  await mkdir(join(appRoot, "deploy"), { recursive: true });
  await mkdir(stackRoot, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await writeFile(mainnetCompose, "services: {}\n");
  await writeFile(
    join(stackRoot, "Caddyfile"),
    [
      "api.averray.com {",
      "  reverse_proxy mainnet-backend:8787",
      "}",
      "index.averray.com {",
      "  reverse_proxy mainnet-indexer:42069",
      "}",
      "",
    ].join("\n"),
  );
  for (const name of [
    "deploy-production.sh",
    "run-caddy-network-selection.sh",
  ]) {
    await copyFile(
      join(REPO_ROOT, "scripts/ops", name),
      join(appRoot, "scripts/ops", name),
    );
    await chmod(join(appRoot, "scripts/ops", name), 0o755);
  }
  for (const name of [
    "caddy-network-selection.mjs",
    "render-caddy-cutover.mjs",
  ]) {
    await copyFile(
      join(REPO_ROOT, "scripts/ops", name),
      join(appRoot, "scripts/ops", name),
    );
  }
  await writeExecutable(join(appRoot, "scripts/ops/redeploy-backend.sh"), [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "printf '%s|%s|%s|%s|%s|%s\\n' \\",
    "  \"$COMPOSE_FILE\" \"$COMPOSE_PROJECT_DIRECTORY\" \"$BACKEND_SERVICE\" \"$BACKEND_CONTAINER\" \\",
    "  \"$BACKEND_ENV_TEMPLATE\" \"$BACKEND_ENV_TARGET\" > \"$DEPLOY_LOG\"",
  ].join("\n"));
  for (const command of ["docker", "flock", "npm"]) {
    await writeExecutable(join(fakeBin, command), "#!/usr/bin/env bash\nexit 0\n");
  }
  await writeFakeHealthCurl(join(fakeBin, "curl"));

  git(appRoot, "init");
  git(appRoot, "config", "user.email", "test@example.com");
  git(appRoot, "config", "user.name", "Deploy Test");
  await writeFile(join(appRoot, "mcp-server/src/server.js"), "export const version = 1;\n");
  git(appRoot, "add", ".");
  git(appRoot, "commit", "-m", "base");
  const baseSha = revParse(appRoot, "HEAD");

  await writeFile(join(appRoot, "mcp-server/src/server.js"), "export const version = 2;\n");
  git(appRoot, "add", ".");
  git(appRoot, "commit", "-m", "backend change");
  const newSha = revParse(appRoot, "HEAD");

  writeSelectionAtomic(selectionFile, buildSelection({
    network: "mainnet",
    previousNetwork: "testnet",
    selectedAt: "2026-07-27T10:00:00.000Z",
    selectedBy: "deploy-test",
    executionUser: "runner",
    host: "prod.invalid",
    source: "flip-caddy-network.sh",
    sourceRevision: newSha,
    operationId: "mainnet-target-test",
    reason: "test the selected deploy target",
  }));

  return {
    appRoot,
    deployLog,
    env: {
      PATH: `${fakeBin}:${process.env.PATH}`,
      STACK_ROOT: stackRoot,
      CADDY_NETWORK_STATE_FILE: selectionFile,
      DEPLOY_LOCK_FILE: join(root, "deploy.lock"),
      DEPLOY_STATE_DIR: stateDir,
      DEPLOY_OLD_SHA: baseSha,
      DEPLOY_NEW_SHA: newSha,
      DEPLOY_LOG: deployLog,
      FAKE_HEALTH_SHA: newSha,
      RUN_BACKEND: "auto",
      RUN_INDEXER: "0",
      RUN_FRONTEND: "0",
      RUN_SITE: "0",
      RUN_CADDY: "0",
      RUN_SMOKE: "0",
    },
  };
}

function git(cwd, ...args) {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function revParse(cwd, revision) {
  return execFileSync("git", ["rev-parse", revision], { cwd, encoding: "utf8" }).trim();
}

function runDeploy(cwd, env) {
  let fakeHealthSha = env.FAKE_HEALTH_SHA;
  const backendState = env.DEPLOY_STATE_DIR
    ? join(env.DEPLOY_STATE_DIR, "backend.last-good")
    : undefined;
  if (!fakeHealthSha && backendState && existsSync(backendState)) {
    fakeHealthSha = readFileSync(backendState, "utf8").trim();
  }
  fakeHealthSha ||= env.DEPLOY_OLD_SHA;
  return spawnSync("bash", ["scripts/ops/deploy-production.sh"], {
    cwd,
    env: {
      ...process.env,
      ...env,
      FAKE_HEALTH_SHA: fakeHealthSha
    },
    encoding: "utf8"
  });
}
