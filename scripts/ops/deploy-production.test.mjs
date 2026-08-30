import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, copyFile, chmod, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

import {
  buildSelection,
  writeSelectionAtomic,
} from "./caddy-network-selection.mjs";
import { buildBackendRebuildPattern } from "./backend-image-rebuild-pattern.mjs";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DEPLOY_SCRIPT = join(REPO_ROOT, "scripts/ops/deploy-production.sh");
const BACKEND_REBUILD_PATTERN_SCRIPT = join(REPO_ROOT, "scripts/ops/backend-image-rebuild-pattern.mjs");
const BACKEND_DOCKERFILE = join(REPO_ROOT, "mcp-server/Dockerfile");
const FRONTEND_DEPLOY_SCRIPT = join(REPO_ROOT, "scripts/ops/redeploy-frontend.sh");
const APP_PACKAGE = join(REPO_ROOT, "app/package.json");
const INDEXER_DOCKERFILE = join(REPO_ROOT, "indexer/Dockerfile");
const INDEXER_PACKAGE = join(REPO_ROOT, "indexer/package.json");
const INDEXER_LOCKFILE = join(REPO_ROOT, "indexer/package-lock.json");
// DERIVE_SETTLEMENT_ENV_SCRIPT was removed in PR 2.6: deploy-production.sh
// no longer calls derive-settlement-env.mjs at runtime (the template carries
// the settlement values directly, and CI enforces drift via
// scripts/ops/check-template-matches-manifest.mjs).

test("production static builders omit dev dependencies and classify their build toolchain as runtime", async () => {
  const [deployScript, frontendScript, appPackageText] = await Promise.all([
    readFile(DEPLOY_SCRIPT, "utf8"),
    readFile(FRONTEND_DEPLOY_SCRIPT, "utf8"),
    readFile(APP_PACKAGE, "utf8"),
  ]);
  const appPackage = JSON.parse(appPackageText);

  assert.match(deployScript, /npm ci --omit=dev && npm run build:site/u);
  assert.match(frontendScript, /npm ci --omit=dev && npm run build:frontend/u);
  for (const dependency of [
    "@tailwindcss/postcss",
    "@types/node",
    "@types/react",
    "@types/react-dom",
    "postcss",
    "tailwindcss",
    "typescript",
  ]) {
    assert.ok(
      appPackage.dependencies?.[dependency],
      `${dependency} is required by the production frontend build and must not be a devDependency`,
    );
    assert.equal(appPackage.devDependencies?.[dependency], undefined);
  }
});

test("indexer image installs deterministically from its committed lockfile", async () => {
  const [dockerfile, packageText, lockText] = await Promise.all([
    readFile(INDEXER_DOCKERFILE, "utf8"),
    readFile(INDEXER_PACKAGE, "utf8"),
    readFile(INDEXER_LOCKFILE, "utf8"),
  ]);
  const packageJson = JSON.parse(packageText);
  const lockfile = JSON.parse(lockText);

  assert.match(dockerfile, /COPY indexer\/package\*\.json \.\//u);
  assert.match(dockerfile, /RUN npm ci --omit=dev/u);
  assert.doesNotMatch(dockerfile, /RUN npm install/u);
  assert.equal(lockfile.lockfileVersion, 3);
  assert.equal(lockfile.packages?.[""]?.dependencies?.ponder, packageJson.dependencies.ponder);
  assert.equal(
    lockfile.packages?.["node_modules/ponder"]?.version,
    "0.16.6",
    "the hotfix must pin the existing Ponder release, not upgrade it",
  );
});

test("deploy wrapper retries frontend after an earlier failed indexer deploy", async () => {
  const root = await mkdtemp(join(tmpdir(), "deploy-production-"));
  const appRoot = join(root, "app");
  const stackRoot = join(root, "stack");
  const fakeBin = join(root, "bin");
  const stateDir = join(root, "state");
  const deployLog = join(root, "deploy.log");
  const indexerEnv = join(root, "indexer.env");

  await mkdir(join(appRoot, "scripts/ops"), { recursive: true });
  await mkdir(join(appRoot, "app"), { recursive: true });
  await mkdir(join(appRoot, "indexer"), { recursive: true });
  await mkdir(join(appRoot, "deploy"), { recursive: true });
  await mkdir(stackRoot, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await writeFile(join(stackRoot, "docker-compose.yml"), "services: {}\n");
  await writeFile(indexerEnv, "DATABASE_SCHEMA=agent_indexer_existing\n");
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
  await writeFile(
    join(appRoot, "deploy/indexer.env.template"),
    [
      "POLKADOT_CHAIN_ID=420420417",
      "POLKADOT_CHAIN_NAME=polkadotHubTestnet",
      "PONDER_ESCROW_CORE_ADDRESS=0x1111111111111111111111111111111111111111",
      "",
    ].join("\n")
  );
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
    INDEXER_ENV_FILE: indexerEnv,
    DEPLOY_OLD_SHA: baseSha,
    DEPLOY_NEW_SHA: frontendSha,
    DEPLOY_LOG: deployLog,
    FAIL_INDEXER: "1",
    RUN_BACKEND: "0",
    RUN_INDEXER: "1",
    RUN_SITE: "0",
    RUN_CADDY: "0",
    RUN_SMOKE: "0"
  });
  assert.equal(firstRun.status, 1);
  assert.match(await readFile(deployLog, "utf8"), /^indexer$/m);
  assert.doesNotMatch(await readFile(deployLog, "utf8"), /^frontend$/m);
  assert.equal((await readFile(join(stateDir, "frontend.last-good"), "utf8")).trim(), baseSha);
  assert.equal(
    existsSync(join(stateDir, "indexer.database-schema.testnet")),
    false,
    "a failed indexer deploy must not persist the candidate schema as last-good"
  );
  assert.equal(
    existsSync(join(stateDir, "indexer.app-identity.testnet")),
    false,
    "a failed indexer deploy must not persist the candidate identity as last-good"
  );

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

test("indexer source, resolved Ponder version, or contract-config changes rotate while unchanged identity does not", async () => {
  const root = await mkdtemp(join(tmpdir(), "deploy-indexer-gate-"));
  const appRoot = join(root, "app");
  const stackRoot = join(root, "stack");
  const fakeBin = join(root, "bin");
  const stateDir = join(root, "state");
  const deployLog = join(root, "deploy.log");
  const indexerEnv = join(root, "indexer.env");

  await mkdir(join(appRoot, "scripts/ops"), { recursive: true });
  await mkdir(join(appRoot, "indexer"), { recursive: true });
  await mkdir(join(appRoot, "deploy"), { recursive: true });
  await mkdir(stackRoot, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stackRoot, "docker-compose.yml"), "services: {}\n");
  await writeFile(indexerEnv, "DATABASE_SCHEMA=agent_indexer_existing\n");
  await writeFile(
    join(stateDir, "indexer.database-schema.testnet"),
    "agent_indexer_existing\n",
  );
  await copyFile(DEPLOY_SCRIPT, join(appRoot, "scripts/ops/deploy-production.sh"));
  await chmod(join(appRoot, "scripts/ops/deploy-production.sh"), 0o755);
  await writeExecutable(join(appRoot, "scripts/ops/redeploy-indexer.sh"), [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "printf 'indexer wait=%s stability=%s build=%s rollback=%s\\n' \"$WAIT_FOR_READY\" \"$HEALTH_STABILITY_SEC\" \"$INDEXER_BUILD_IMAGE\" \"$ROLLBACK_INDEXER_SCHEMA\" >> \"$DEPLOY_LOG\""
  ].join("\n"));
  for (const command of ["docker", "npm", "flock"]) {
    await writeExecutable(join(fakeBin, command), "#!/usr/bin/env bash\nexit 0\n");
  }
  await writeFakeHealthCurl(join(fakeBin, "curl"));

  git(appRoot, "init");
  git(appRoot, "config", "user.email", "test@example.com");
  git(appRoot, "config", "user.name", "Deploy Test");
  await writeFile(join(appRoot, "package-lock.json"), '{"lockfileVersion":3,"packages":{}}\n');
  await writeFile(
    join(appRoot, "indexer/package.json"),
    '{"name":"indexer","dependencies":{"ponder":"^0.16.6"}}\n',
  );
  await writeFile(
    join(appRoot, "indexer/package-lock.json"),
    '{"lockfileVersion":3,"packages":{"":{"dependencies":{"ponder":"^0.16.6"}},"node_modules/ponder":{"version":"0.16.6"}}}\n',
  );
  await writeFile(
    join(appRoot, "deploy/indexer.env.template"),
    [
      "POLKADOT_CHAIN_ID=420420417",
      "POLKADOT_CHAIN_NAME=polkadotHubTestnet",
      "PONDER_ESCROW_CORE_ADDRESS=0x1111111111111111111111111111111111111111",
      "PONDER_START_BLOCK_ESCROW=100",
      "",
    ].join("\n")
  );
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
    INDEXER_ENV_FILE: indexerEnv,
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

  await writeFile(join(appRoot, "indexer/fix.ts"), "export const fixed = true;\n");
  git(appRoot, "add", ".");
  git(appRoot, "commit", "-m", "indexer source change");
  const indexerSourceSha = revParse(appRoot, "HEAD");

  const indexerRun = runDeploy(appRoot, env(appDependencySha, indexerSourceSha));
  assert.equal(indexerRun.status, 0, indexerRun.stderr);
  assert.match(
    indexerRun.stderr,
    /INDEXER HISTORICAL RE-SYNC STARTING/u,
    "an app-identity change must make its historical replay window conspicuous"
  );
  assert.match(
    await readFile(deployLog, "utf8"),
    /^indexer wait=0 stability=15 build=1 rollback=agent_indexer_existing$/m,
    "a fresh schema gates on a stability window, rebuilds the changed image, and carries the exact rollback schema"
  );
  const selectedSchema = (await readFile(indexerEnv, "utf8"))
    .match(/^DATABASE_SCHEMA=(.+)$/mu)?.[1];
  assert.match(
    selectedSchema,
    /^agent_indexer_testnet_\d{14}_[0-9a-f]{8}$/u,
    "the normal flow should mint a unique network-scoped schema before recreating the changed app"
  );
  assert.notEqual(selectedSchema, "agent_indexer_existing");
  assert.equal(
    (await readFile(join(stateDir, "indexer.database-schema.testnet"), "utf8")).trim(),
    selectedSchema,
    "the healthy replacement should become the persisted schema"
  );
  const sourceTreeIdentity = revParse(appRoot, `${indexerSourceSha}:indexer`);
  const persistedAppIdentity = (
    await readFile(join(stateDir, "indexer.app-identity.testnet"), "utf8")
  ).trim();
  assert.match(persistedAppIdentity, /^[0-9a-f]{40}$/u);
  assert.notEqual(
    persistedAppIdentity,
    sourceTreeIdentity,
    "the schema owner must bind both the source tree and committed Ponder config"
  );
  const template = await readFile(join(appRoot, "deploy/indexer.env.template"), "utf8");
  const configInput = template
    .trimEnd()
    .split("\n")
    .filter((line) => {
      const key = line.split("=", 1)[0];
      return key === "POLKADOT_CHAIN_ID"
        || key === "POLKADOT_CHAIN_NAME"
        || /^PONDER_[A-Z0-9_]+$/u.test(key);
    })
    .sort()
    .join("\n") + "\n";
  const configIdentity = gitHashObject(appRoot, configInput);
  assert.equal(
    persistedAppIdentity,
    gitHashObject(
      appRoot,
      `indexer_tree=${sourceTreeIdentity}\nponder_config=${configIdentity}\nponder_version=0.16.6\n`,
    ),
    "the persisted owner identity must explicitly include the resolved Ponder version",
  );
  const resync = await readFile(join(stateDir, "indexer.resync.testnet"), "utf8");
  assert.match(resync, /^initial_status=staged$/mu);
  assert.match(resync, /^reason=app_identity_changed$/mu);
  assert.match(resync, /^honest_degradation_signal=externalPostingWatcherLagSeconds$/mu);

  await writeFile(
    join(appRoot, "deploy/indexer.env.template"),
    [
      "POLKADOT_CHAIN_ID=420420417",
      "POLKADOT_CHAIN_NAME=polkadotHubTestnet",
      "PONDER_ESCROW_CORE_ADDRESS=0x2222222222222222222222222222222222222222",
      "PONDER_START_BLOCK_ESCROW=200",
      "",
    ].join("\n")
  );
  git(appRoot, "add", ".");
  git(appRoot, "commit", "-m", "change indexed contract");
  const configChangeSha = revParse(appRoot, "HEAD");
  await writeFile(deployLog, "");

  // Reproduce the production failure shape: the checkout already
  // fast-forwarded to the config change before Ponder rejected its old schema,
  // so the retry's current Git range contains no template diff.
  const configRun = runDeploy(appRoot, env(configChangeSha, configChangeSha));
  assert.equal(configRun.status, 0, configRun.stderr);
  assert.match(
    configRun.stderr,
    /INDEXER HISTORICAL RE-SYNC STARTING/u,
    "an indexed-contract address change must select a fresh schema before Ponder starts"
  );
  assert.match(
    configRun.stdout,
    /indexer\.env content changed; image unchanged/u,
    "a range-empty retry must still rotate and recreate without rebuilding the unchanged indexer image"
  );
  assert.match(
    await readFile(deployLog, "utf8"),
    new RegExp(`^indexer wait=0 stability=15 build=0 rollback=${selectedSchema}$`, "mu")
  );
  const configSchema = (await readFile(indexerEnv, "utf8"))
    .match(/^DATABASE_SCHEMA=(.+)$/mu)?.[1];
  assert.match(configSchema, /^agent_indexer_testnet_\d{14}_[0-9a-f]{8}$/u);
  assert.notEqual(configSchema, selectedSchema);
  const configResync = await readFile(join(stateDir, "indexer.resync.testnet"), "utf8");
  assert.match(configResync, /^reason=ponder_config_changed$/mu);

  // #833 persisted only the indexer tree. A host that completed the explicit
  // fresh-schema recovery before this fix lands will still carry that legacy
  // value. Upgrade it from the last-good SHA without rotating the healthy
  // just-recovered schema a second time.
  const configTreeIdentity = revParse(appRoot, `${configChangeSha}:indexer`);
  await writeFile(join(stateDir, "indexer.app-identity.testnet"), `${configTreeIdentity}\n`);
  await writeFile(deployLog, "");
  const legacyStateRun = runDeploy(appRoot, {
    ...env(configChangeSha, configChangeSha),
    RUN_INDEXER: "1",
  });
  assert.equal(legacyStateRun.status, 0, legacyStateRun.stderr);
  assert.match(legacyStateRun.stdout, /Upgrading legacy tree-only indexer owner identity/u);
  assert.doesNotMatch(legacyStateRun.stderr, /INDEXER HISTORICAL RE-SYNC STARTING/u);
  assert.equal(
    (await readFile(indexerEnv, "utf8")).match(/^DATABASE_SCHEMA=(.+)$/mu)?.[1],
    configSchema,
    "legacy state migration must retain the already-recovered schema"
  );
  assert.notEqual(
    (await readFile(join(stateDir, "indexer.app-identity.testnet"), "utf8")).trim(),
    configTreeIdentity,
    "the successful deploy should persist the composite identity"
  );

  const configIdentityV2 = gitHashObject(
    appRoot,
    [
      "POLKADOT_CHAIN_ID=420420417",
      "POLKADOT_CHAIN_NAME=polkadotHubTestnet",
      "PONDER_ESCROW_CORE_ADDRESS=0x2222222222222222222222222222222222222222",
      "PONDER_START_BLOCK_ESCROW=200",
      "",
    ].join("\n"),
  );
  const preVersionIdentity = gitHashObject(
    appRoot,
    `indexer_tree=${configTreeIdentity}\nponder_config=${configIdentityV2}\n`,
  );
  await writeFile(join(stateDir, "indexer.app-identity.testnet"), `${preVersionIdentity}\n`);
  await writeFile(deployLog, "");
  const preVersionStateRun = runDeploy(appRoot, {
    ...env(configChangeSha, configChangeSha),
    RUN_INDEXER: "1",
  });
  assert.equal(preVersionStateRun.status, 0, preVersionStateRun.stderr);
  assert.match(preVersionStateRun.stdout, /Upgrading pre-version indexer owner identity/u);
  assert.doesNotMatch(preVersionStateRun.stderr, /INDEXER HISTORICAL RE-SYNC STARTING/u);
  assert.equal(
    (await readFile(indexerEnv, "utf8")).match(/^DATABASE_SCHEMA=(.+)$/mu)?.[1],
    configSchema,
    "adding the version field to the identity format alone must not rotate a healthy schema",
  );

  await writeFile(deployLog, "");
  const unchangedRun = runDeploy(appRoot, {
    ...env(configChangeSha, configChangeSha),
    RUN_INDEXER: "1",
  });
  assert.equal(unchangedRun.status, 0, unchangedRun.stderr);
  assert.doesNotMatch(unchangedRun.stderr, /INDEXER HISTORICAL RE-SYNC STARTING/u);
  assert.equal(
    (await readFile(indexerEnv, "utf8")).match(/^DATABASE_SCHEMA=(.+)$/mu)?.[1],
    configSchema,
    "unchanged tree, config, and resolved Ponder version must retain the schema",
  );

  await writeFile(
    join(appRoot, "indexer/package-lock.json"),
    '{"lockfileVersion":3,"packages":{"":{"dependencies":{"ponder":"^0.16.6"}},"node_modules/ponder":{"version":"0.16.7"}}}\n',
  );
  git(appRoot, "add", ".");
  git(appRoot, "commit", "-m", "deliberate Ponder upgrade");
  const ponderUpgradeSha = revParse(appRoot, "HEAD");
  await writeFile(deployLog, "");

  const versionRun = runDeploy(appRoot, env(configChangeSha, ponderUpgradeSha));
  assert.equal(versionRun.status, 0, versionRun.stderr);
  assert.match(versionRun.stderr, /INDEXER HISTORICAL RE-SYNC STARTING/u);
  const versionSchema = (await readFile(indexerEnv, "utf8"))
    .match(/^DATABASE_SCHEMA=(.+)$/mu)?.[1];
  assert.notEqual(versionSchema, configSchema);
  const versionResync = await readFile(join(stateDir, "indexer.resync.testnet"), "utf8");
  assert.match(versionResync, /^reason=ponder_version_changed$/mu);
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
    "if [[ \"${FAKE_DOCKER_FAIL_RELOAD:-0}\" == \"1\" && \"$*\" == *\"exec agent-caddy caddy reload\"* ]]; then exit 1; fi",
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
  const changedLog = await readFile(deployLog, "utf8");
  // Regression lock (2026-08-18): Caddy must be reached by container name, never
  // through `docker compose -f <host-side legacy compose>`. That compose file
  // still declares the pre-cutover backend with an env_file under
  // /run/agent-stack/, which mainnet no longer renders, so any compose call
  // against it dies while parsing — before Caddy runs. It stayed hidden until
  // #1158 became the first Caddyfile content change since the cutover.
  assert.match(changedLog, /exec agent-caddy caddy reload/u);
  assert.doesNotMatch(
    changedLog,
    /compose[^\n]*caddy (reload|validate)/u,
    "Caddy reload/validate must not go through docker compose"
  );
  assert.match(changedLog, /exec agent-caddy caddy validate/u);
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
  assert.match(run.stdout, /Served .*\/transparency\/ matches built site\/transparency\/index\.html/u);
  assert.match(run.stdout, /Served .*\/transparency-reader\.js matches built site\/transparency-reader\.js/u);
  assert.match(run.stdout, /Served .*\/verify\/ matches built site\/verify\/index\.html/u);
  assert.match(run.stdout, /Served .*\/proof-to-pay\/ matches built site\/proof-to-pay\/index\.html/u);
  assert.deepEqual(parseDeployResult(run.stdout), {
    schemaVersion: 1,
    changed: false,
    oldSha: baseSha,
    newSha: nextSha,
    components: [],
  });
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

test("a forced site dispatch rebuilds even when OLD_SHA equals NEW_SHA", async () => {
  const { appRoot, stackRoot, fakeBin, stateDir, deployLog, nextSha } =
    await makeSiteFixture();

  const run = runDeploy(appRoot, {
    PATH: `${fakeBin}:${process.env.PATH}`,
    STACK_ROOT: stackRoot,
    COMPOSE_FILE: join(stackRoot, "docker-compose.yml"),
    DEPLOY_LOCK_FILE: join(appRoot, "deploy.lock"),
    DEPLOY_STATE_DIR: stateDir,
    DEPLOY_OLD_SHA: nextSha,
    DEPLOY_NEW_SHA: nextSha,
    DEPLOY_LOG: deployLog,
    FAKE_SERVED_DIR: join(appRoot, "site"),
    RUN_BACKEND: "0",
    RUN_INDEXER: "0",
    RUN_FRONTEND: "0",
    RUN_SITE: "1",
    RUN_CADDY: "0",
    RUN_SMOKE: "0"
  });

  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /No new commits/u);
  assert.match(run.stdout, /reason: forced by RUN_SITE=1/u);
  assert.match(await readFile(deployLog, "utf8"), /run build:site/u);
});

test("site source detection includes the discovery manifest generator", async () => {
  const deployScript = await readFile(DEPLOY_SCRIPT, "utf8");
  assert.match(
    deployScript,
    /SITE_SOURCE_PATTERN=.*mcp-server\/src\/core\/discovery-manifest\\\.js/u
  );
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

test("rendered and persisted indexer schema disagreement fails before container start", async () => {
  const fixture = await makeIndexerSchemaSourceFixture({
    runtimeSchema: "agent_indexer_rendered_stale",
  });
  await writeFile(
    join(fixture.stateDir, "indexer.database-schema.testnet"),
    "agent_indexer_persisted\n",
  );

  const refused = runDeploy(fixture.appRoot, fixture.env);

  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Indexer schema source-of-truth disagreement/u);
  assert.match(refused.stderr, /Refusing before DATABASE_SCHEMA or the running container can change/u);
  assert.equal(await readFile(fixture.deployLog, "utf8").catch(() => ""), "");
  assert.equal(
    (await readFile(fixture.indexerEnv, "utf8")).trim(),
    "DATABASE_SCHEMA=agent_indexer_rendered_stale",
    "a refused deploy must not silently repair the rendered value",
  );

  const resolved = runDeploy(fixture.appRoot, {
    ...fixture.env,
    INDEXER_DATABASE_SCHEMA: "agent_indexer_persisted",
  });
  assert.equal(resolved.status, 0, resolved.stderr);
  assert.match(resolved.stderr, /Explicit operator schema selection is resolving/u);
  assert.match(await readFile(fixture.deployLog, "utf8"), /^indexer rollback=agent_indexer_persisted$/mu);
});

test("fresh host mints a schema instead of inheriting an unowned runtime literal", async () => {
  const fixture = await makeIndexerSchemaSourceFixture({
    runtimeSchema: "agent_indexer_unowned_literal",
  });

  const deployed = runDeploy(fixture.appRoot, fixture.env);

  assert.equal(deployed.status, 0, deployed.stderr);
  assert.match(deployed.stderr, /ignoring unowned rendered DATABASE_SCHEMA=agent_indexer_unowned_literal/u);
  const selected = (await readFile(fixture.indexerEnv, "utf8"))
    .match(/^DATABASE_SCHEMA=(.+)$/mu)?.[1];
  assert.match(selected, /^agent_indexer_testnet_\d{14}_[0-9a-f]{8}$/u);
  assert.notEqual(selected, "agent_indexer_unowned_literal");
  assert.equal(
    (await readFile(join(fixture.stateDir, "indexer.database-schema.testnet"), "utf8")).trim(),
    selected,
  );
  assert.match(
    await readFile(join(fixture.stateDir, "indexer.resync.testnet"), "utf8"),
    /^reason=fresh_host_bootstrap$/mu,
  );
  assert.match(await readFile(fixture.deployLog, "utf8"), /^indexer rollback=$/mu);
});

test("indexer schema host state survives normal runtime-env renders", async () => {
  const script = await readFile(DEPLOY_SCRIPT, "utf8");
  const indexerTemplate = await readFile(join(REPO_ROOT, "deploy/indexer.env.template"), "utf8");
  const mainnetTemplate = await readFile(
    join(REPO_ROOT, "deploy/indexer.mainnet.env.template"),
    "utf8",
  );
  const mainnetManifest = JSON.parse(
    await readFile(join(REPO_ROOT, "deployments/mainnet.json"), "utf8"),
  );

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
    /commit_indexer_schema_ownership[\s\S]*?write_persisted_indexer_schema "\$INDEXER_TARGET_SCHEMA"/u,
    "schema ownership should persist only through the post-health commit step"
  );
  assert.match(
    script,
    /Indexer deploy was selected without a completed host-state schema preflight; refusing before container recreation/u,
    "every wrapper-selected container recreation must carry a completed host-state schema decision",
  );
  assert.match(
    script,
    /Applying persisted host-owned indexer DATABASE_SCHEMA/u,
    "normal deploys should inject persisted host state after rendering the template"
  );
  const renderIndex = script.indexOf("  render_runtime_envs");
  const applyIndex = script.indexOf("    apply_indexer_database_schema 1", renderIndex);
  assert.ok(
    renderIndex > -1 && applyIndex > renderIndex,
    "schema override must run after op inject renders /run env files"
  );
  assert.doesNotMatch(
    indexerTemplate,
    /^DATABASE_SCHEMA=/mu,
    "the base template must not compete with host state",
  );
  assert.doesNotMatch(mainnetTemplate, /^DATABASE_SCHEMA=/mu);
  assert.equal(mainnetManifest.runtime.indexer.schema, undefined);
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
  // Compose-file directory, not the app root: the mainnet compose has
  // relative build contexts (context: ..) that must resolve to the repo root
  // exactly as start-mainnet-sidecar.sh's default-project-directory bring-up
  // resolved them.
  assert.ok(projectDirectory.endsWith("/app/deploy"));
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
  assert.deepEqual(parseDeployResult(skipped.stdout), {
    schemaVersion: 1,
    changed: false,
    oldSha: fixture.baseSha,
    newSha: fixture.docsSha,
    components: [],
  });
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
  assert.deepEqual(parseDeployResult(deployed.stdout), {
    schemaVersion: 1,
    changed: true,
    oldSha: fixture.docsSha,
    newSha: fixture.backendSha,
    components: ["backend"],
  });
  assert.match(await readFile(fixture.deployLog, "utf8"), /^backend$/mu);
  assert.equal(
    (await readFile(join(fixture.stateDir, "backend.last-good"), "utf8")).trim(),
    fixture.backendSha,
  );
});

test("a change confined to a Dockerfile-copied ops script rebuilds the backend", async () => {
  const fixture = await makeBackendPointerFixture();
  await mkdir(fixture.stateDir, { recursive: true });
  await writeFile(join(fixture.stateDir, "backend.last-good"), `${fixture.backendSha}\n`);
  git(fixture.appRoot, "checkout", fixture.copiedScriptSha);

  const deployed = runDeploy(fixture.appRoot, {
    ...fixture.env,
    DEPLOY_OLD_SHA: fixture.backendSha,
    DEPLOY_NEW_SHA: fixture.copiedScriptSha,
    FAKE_HEALTH_SHA: fixture.copiedScriptSha,
    RUN_BACKEND: "auto",
  });

  assert.equal(deployed.status, 0, deployed.stderr);
  assert.deepEqual(parseDeployResult(deployed.stdout), {
    schemaVersion: 1,
    changed: true,
    oldSha: fixture.backendSha,
    newSha: fixture.copiedScriptSha,
    components: ["backend"],
  });
  assert.match(await readFile(fixture.deployLog, "utf8"), /^backend$/mu);
});

test("backend matcher derives without node on PATH and byte-matches the CI reference", async () => {
  const fixture = await makeBackendPointerFixture();
  const hostOnlyPath = `${fixture.fakeBin}:/usr/bin:/bin`;
  assert.equal(
    spawnSync("node", ["--version"], { env: { PATH: hostOnlyPath } }).error?.code,
    "ENOENT",
    "the deploy proof must run with no Node executable available",
  );
  await mkdir(fixture.stateDir, { recursive: true });
  await writeFile(join(fixture.stateDir, "backend.last-good"), `${fixture.backendSha}\n`);
  git(fixture.appRoot, "checkout", fixture.copiedScriptSha);
  const dockerfileText = await readFile(join(fixture.appRoot, "mcp-server/Dockerfile"), "utf8");
  const expectedPattern = buildBackendRebuildPattern({
    dockerfileText,
    repoRoot: fixture.appRoot,
  });

  const deployed = runDeploy(fixture.appRoot, {
    ...fixture.env,
    PATH: hostOnlyPath,
    DEPLOY_OLD_SHA: fixture.backendSha,
    DEPLOY_NEW_SHA: fixture.copiedScriptSha,
    FAKE_HEALTH_SHA: fixture.copiedScriptSha,
    RUN_BACKEND: "auto",
  });

  assert.equal(deployed.status, 0, deployed.stderr);
  assert.equal(
    deployed.stdout.split("\n").find((line) => line.startsWith("Backend rebuild pattern: ")),
    `Backend rebuild pattern: ${expectedPattern}`,
  );
  assert.match(await readFile(fixture.deployLog, "utf8"), /^backend$/mu);
});

test("empty Dockerfile COPY derivation fails the deploy closed", async () => {
  const fixture = await makeBackendPointerFixture();
  await writeFile(join(fixture.appRoot, "mcp-server/Dockerfile"), "FROM node:22-alpine\n");

  const refused = runDeploy(fixture.appRoot, {
    ...fixture.env,
    PATH: `${fixture.fakeBin}:/usr/bin:/bin`,
    FAKE_HEALTH_SHA: fixture.docsSha,
    RUN_BACKEND: "auto",
  });

  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /exposes no parseable build-context COPY sources/u);
  assert.match(refused.stderr, /refusing a potentially stale deploy/u);
  assert.doesNotMatch(await readFile(fixture.deployLog, "utf8").catch(() => ""), /^backend$/mu);
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

test("deploy wrapper freezes a real compiled contract-runtime change without a manifest update", async () => {
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
    DEPLOY_CONTRACT_COMPAT_FREEZE: "1",
    FAKE_CONTRACT_SOURCE_STATUS: "1",
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
  assert.match(run.stderr, /immutable-masked compiled runtime differs from deployed provenance/u);
  assert.match(run.stderr, /deployments\/testnet\.json did not change/u);
});

test("deploy wrapper does not freeze a contract source edit whose compiled runtime still matches", async () => {
  const fixture = await makeDeployFreezeFixture(
    async (appRoot) => {
      await mkdir(join(appRoot, "contracts"), { recursive: true });
      await writeFile(
        join(appRoot, "contracts/AgentAccountCore.sol"),
        "// comment-only source edit; fake semantic checker reports identical runtime\n"
      );
    },
    "contract comment change"
  );

  const run = runDeploy(fixture.appRoot, {
    ...deployFreezeEnv(fixture),
    DEPLOY_OLD_SHA: fixture.baseSha,
    DEPLOY_NEW_SHA: fixture.nextSha,
  });

  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /compiled runtimes match deployed provenance/u);
  assert.equal(
    existsSync(join(fixture.stateDir, "contract-surface.frozen-at.testnet")),
    false
  );
});

test("deploy wrapper does not freeze contract source changes when the deployment manifest moves with them", async () => {
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
    DEPLOY_CONTRACT_COMPAT_FREEZE: "1",
    RUN_BACKEND: "0",
    RUN_INDEXER: "0",
    RUN_FRONTEND: "0",
    RUN_SITE: "0",
    RUN_CADDY: "0",
    RUN_SMOKE: "0"
  });

  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /contract source changes are paired with deployments\/testnet\.json; no sticky freeze/u);
});

const HISTORICAL_D03_FALSE_POSITIVES = [
  {
    pr: "#859",
    files: [
      "deployments/mainnet-multisig-owner.json",
      "deployments/testnet-multisig-owner.json",
      "scripts/ops/redeploy-escrowcore-wire-multisig.mjs",
      "scripts/ops/redeploy-escrowcore-wire-multisig.test.mjs",
    ],
  },
  {
    pr: "#842",
    files: [
      "deploy/backend.env.template",
      "deploy/backend.mainnet.env.template",
      "docs/SECRETS.md",
      "mcp-server/src/blockchain/config.js",
      "mcp-server/src/blockchain/config.test.js",
      "mcp-server/src/blockchain/gateway.js",
      "mcp-server/src/blockchain/rpc-provider.js",
      "mcp-server/src/blockchain/rpc-provider.test.js",
      "scripts/ops/render-mainnet-backend-env.mjs",
      "scripts/ops/render-mainnet-backend-env.test.mjs",
      "scripts/write_server_env.sh",
    ],
  },
  {
    pr: "#837",
    files: [
      "docs/PREFLIGHT_WAIVER_PARITY_HANDBACK.md",
      "mcp-server/src/blockchain/gateway.js",
      "mcp-server/src/blockchain/gateway.test.js",
      "mcp-server/src/core/claim-economics.js",
      "mcp-server/src/core/job-execution-service.js",
      "mcp-server/src/core/job-execution-service.test.js",
      "mcp-server/src/core/platform-service.js",
      "mcp-server/src/core/platform-service.test.js",
    ],
  },
];

for (const historical of HISTORICAL_D03_FALSE_POSITIVES) {
  test(`deploy wrapper verifies but does not freeze historical false positive ${historical.pr}`, async () => {
    const fixture = await makeDeployFreezeFixture(
      async (appRoot) => {
        for (const file of historical.files) {
          const path = join(appRoot, file);
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, `fixture for ${historical.pr}: ${file}\n`);
        }
      },
      `${historical.pr} historical file set`
    );

    const run = runDeploy(fixture.appRoot, {
      ...deployFreezeEnv(fixture),
      DEPLOY_OLD_SHA: fixture.baseSha,
      DEPLOY_NEW_SHA: fixture.nextSha,
    });

    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /D-03 Tier 2: live chain runtime matches/u);
    assert.match(run.stdout, /D-03 Tier 1: no contract source changes; no sticky freeze/u);
    assert.equal(
      existsSync(join(fixture.stateDir, "contract-surface.frozen-at.testnet")),
      false,
      `${historical.pr} must not create a sticky marker`
    );
  });
}

test("deploy wrapper exposes an explicit contract surface drift override", async () => {
  const { appRoot, stackRoot, fakeBin, stateDir, baseSha, nextSha } = await makeDeployFreezeFixture(
    async (appRoot) => {
      await mkdir(join(appRoot, "contracts"), { recursive: true });
      await writeFile(join(appRoot, "contracts/AgentAccountCore.sol"), "contract AgentAccountCore { uint256 changed; }\n");
    },
    "contract runtime change"
  );

  const run = runDeploy(appRoot, {
    PATH: `${fakeBin}:${process.env.PATH}`,
    STACK_ROOT: stackRoot,
    COMPOSE_FILE: join(stackRoot, "docker-compose.yml"),
    DEPLOY_LOCK_FILE: join(appRoot, "deploy.lock"),
    DEPLOY_STATE_DIR: stateDir,
    DEPLOY_OLD_SHA: baseSha,
    DEPLOY_NEW_SHA: nextSha,
    DEPLOY_CONTRACT_COMPAT_FREEZE: "1",
    DEPLOY_ALLOW_CONTRACT_SURFACE_DRIFT: "1",
    FAKE_CONTRACT_SOURCE_STATUS: "1",
    RUN_BACKEND: "0",
    RUN_INDEXER: "0",
    RUN_FRONTEND: "0",
    RUN_SITE: "0",
    RUN_CADDY: "0",
    RUN_SMOKE: "0"
  });

  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /D-03 contract compatibility freeze override set/u);
  assert.match(run.stdout, /contracts\/AgentAccountCore\.sol/u);
});

test("deploy wrapper fails Tier 2 on chain-manifest drift even with zero changed files", async () => {
  const fixture = await makeDeployFreezeFixture(
    async (appRoot) => {
      await writeFile(join(appRoot, "README.md"), "unchanged runtime fixture\n");
    },
    "non-contract change"
  );

  const run = runDeploy(fixture.appRoot, {
    ...deployFreezeEnv(fixture),
    DEPLOY_OLD_SHA: fixture.nextSha,
    DEPLOY_NEW_SHA: fixture.nextSha,
    FAKE_CONTRACT_LIVE_STATUS: "1",
  });

  assert.equal(run.status, 1);
  assert.match(run.stderr, /D-03 Tier 2: live chain runtime does not match/u);
  assert.equal(
    existsSync(join(fixture.stateDir, "contract-surface.frozen-at.testnet")),
    false,
    "Tier 2 mismatch must fail without creating a sticky marker"
  );
});

test("deploy wrapper runs Tier 2 in the containerized Node toolchain when host node is absent", async () => {
  const fixture = await makeDeployFreezeFixture(
    async (appRoot) => {
      await writeFile(join(appRoot, "README.md"), "container runtime fixture\n");
    },
    "non-contract change"
  );
  const dockerLog = join(fixture.appRoot, "docker.log");

  const run = runDeploy(fixture.appRoot, {
    ...deployFreezeEnv(fixture),
    PATH: `${fixture.fakeBin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    DEPLOY_OLD_SHA: fixture.baseSha,
    DEPLOY_NEW_SHA: fixture.nextSha,
    FAKE_DOCKER_LOG: dockerLog,
  });

  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /using containerized Node v22\.0\.0/u);
  assert.match(run.stdout, /host node is not required/u);
  const invocations = await readFile(dockerLog, "utf8");
  assert.match(invocations, /node --version/u);
  assert.match(invocations, /node scripts\/ops\/check-contract-provenance\.mjs --profile testnet/u);
});

test("deploy wrapper runs Tier 3 in the digest-pinned Foundry container when host forge is absent", async () => {
  const fixture = await makeDeployFreezeFixture(
    async (appRoot) => {
      await mkdir(join(appRoot, "contracts"), { recursive: true });
      await writeFile(
        join(appRoot, "contracts/AgentAccountCore.sol"),
        "// contract edit whose fake compiled runtime matches deployed provenance\n"
      );
    },
    "contract source change"
  );
  const dockerLog = join(fixture.appRoot, "docker.log");

  const run = runDeploy(fixture.appRoot, {
    ...deployFreezeEnv(fixture),
    PATH: `${fixture.fakeBin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    DEPLOY_OLD_SHA: fixture.baseSha,
    DEPLOY_NEW_SHA: fixture.nextSha,
    FAKE_DOCKER_LOG: dockerLog,
    CONTRACT_PROVENANCE_FOUNDRY_IMAGE: "ghcr.io/foundry-rs/foundry:stable",
  });

  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /D-03 Tier 3 runtime: using containerized forge Version: 1\.5\.1-stable/u);
  assert.match(run.stdout, /host forge is not required/u);
  assert.match(run.stdout, /D-03 Tier 3: candidate build and immutable-masked provenance comparison passed/u);

  const invocations = await readFile(dockerLog, "utf8");
  assert.match(
    invocations,
    /--entrypoint forge ghcr\.io\/foundry-rs\/foundry@sha256:043752653d5be351c71709091b3db97c4421c907eb40ea294195e7f532aadf46 --version/u
  );
  assert.doesNotMatch(invocations, /foundry:stable/u);
  assert.match(invocations, /--entrypoint forge -v .*\/app:\/workspace:ro -v .*:\/build -w \/workspace/u);
  assert.match(invocations, /--entrypoint forge .* build --root \/workspace --out \/build\/out --cache-path \/build\/cache --skip test/u);
  assert.match(invocations, /node scripts\/ops\/check-contract-source-drift\.mjs --profile testnet --artifacts/u);
});

test("deploy wrapper can force the fail-closed Tier 3 comparison without contract path changes", async () => {
  const fixture = await makeDeployFreezeFixture(
    async (appRoot) => {
      await writeFile(join(appRoot, "README.md"), "manual Tier 3 proof fixture\n");
    },
    "non-contract change"
  );
  const dockerLog = join(fixture.appRoot, "docker.log");

  const run = runDeploy(fixture.appRoot, {
    ...deployFreezeEnv(fixture),
    DEPLOY_OLD_SHA: fixture.baseSha,
    DEPLOY_NEW_SHA: fixture.nextSha,
    DEPLOY_VERIFY_CONTRACT_SOURCE: "1",
    FAKE_DOCKER_LOG: dockerLog,
  });

  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /D-03 Tier 3: manual verification requested/u);
  assert.match(run.stdout, /D-03 Tier 3: candidate build and immutable-masked provenance comparison passed/u);
  assert.match(run.stdout, /D-03 Tier 1: no contract source changes/u);
  const invocations = await readFile(dockerLog, "utf8");
  assert.match(invocations, /--entrypoint forge .* build --root \/workspace/u);
  assert.match(invocations, /check-contract-source-drift\.mjs/u);
});

test("deploy wrapper rejects an invalid manual Tier 3 verification value", async () => {
  const fixture = await makeDeployFreezeFixture(
    async (appRoot) => {
      await writeFile(join(appRoot, "README.md"), "invalid manual Tier 3 fixture\n");
    },
    "non-contract change"
  );

  const run = runDeploy(fixture.appRoot, {
    ...deployFreezeEnv(fixture),
    DEPLOY_OLD_SHA: fixture.baseSha,
    DEPLOY_NEW_SHA: fixture.nextSha,
    DEPLOY_VERIFY_CONTRACT_SOURCE: "sometimes",
  });

  assert.equal(run.status, 1);
  assert.match(run.stderr, /Invalid DEPLOY_VERIFY_CONTRACT_SOURCE: sometimes/u);
  assert.doesNotMatch(run.stdout, /immutable-masked provenance comparison passed/u);
});

test("deploy wrapper fails a forced Tier 3 proof on a real compiled-runtime mismatch", async () => {
  const fixture = await makeDeployFreezeFixture(
    async (appRoot) => {
      await writeFile(join(appRoot, "README.md"), "forced Tier 3 mismatch fixture\n");
    },
    "non-contract change"
  );

  const run = runDeploy(fixture.appRoot, {
    ...deployFreezeEnv(fixture),
    DEPLOY_OLD_SHA: fixture.baseSha,
    DEPLOY_NEW_SHA: fixture.nextSha,
    DEPLOY_VERIFY_CONTRACT_SOURCE: "1",
    FAKE_CONTRACT_SOURCE_STATUS: "1",
  });

  assert.equal(run.status, 1);
  assert.match(run.stderr, /D-03 Tier 3: manual verification failed; refusing production deploy/u);
  assert.doesNotMatch(run.stdout, /immutable-masked provenance comparison passed/u);
  assert.equal(
    existsSync(join(fixture.stateDir, "contract-surface.frozen-at.testnet")),
    false,
    "a proof-only mismatch must fail closed without claiming a contracts-path sticky freeze"
  );
});

test("deploy wrapper fails closed when the digest-pinned Tier 3 Foundry runtime is unavailable", async () => {
  const fixture = await makeDeployFreezeFixture(
    async (appRoot) => {
      await mkdir(join(appRoot, "contracts"), { recursive: true });
      await writeFile(join(appRoot, "contracts/AgentAccountCore.sol"), "contract AgentAccountCore {}\n");
    },
    "contract source change"
  );

  const run = runDeploy(fixture.appRoot, {
    ...deployFreezeEnv(fixture),
    PATH: `${fixture.fakeBin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    DEPLOY_OLD_SHA: fixture.baseSha,
    DEPLOY_NEW_SHA: fixture.nextSha,
    FAKE_FOUNDRY_PREFLIGHT_STATUS: "127",
  });

  assert.equal(run.status, 1);
  assert.match(run.stderr, /D-03 Tier 3 environment error/u);
  assert.match(run.stderr, /not runnable \(exit 127\)/u);
  assert.match(run.stderr, /candidate build and comparison did not run/u);
  assert.doesNotMatch(run.stdout, /immutable-masked provenance comparison passed/u);
  assert.equal(
    existsSync(join(fixture.stateDir, "contract-surface.frozen-at.testnet")),
    false,
    "a missing Tier 3 runtime must fail closed without misclassifying an environment error as sticky drift"
  );
});

test("deploy wrapper fails closed when the containerized Tier 3 candidate build fails", async () => {
  const fixture = await makeDeployFreezeFixture(
    async (appRoot) => {
      await mkdir(join(appRoot, "contracts"), { recursive: true });
      await writeFile(join(appRoot, "contracts/AgentAccountCore.sol"), "contract AgentAccountCore {}\n");
    },
    "contract source change"
  );

  const run = runDeploy(fixture.appRoot, {
    ...deployFreezeEnv(fixture),
    DEPLOY_OLD_SHA: fixture.baseSha,
    DEPLOY_NEW_SHA: fixture.nextSha,
    FAKE_FOUNDRY_BUILD_STATUS: "1",
  });

  assert.equal(run.status, 1);
  assert.match(run.stderr, /D-03 Tier 3: containerized candidate contract build failed/u);
  assert.doesNotMatch(run.stdout, /immutable-masked provenance comparison passed/u);
  assert.equal(
    existsSync(join(fixture.stateDir, "contract-surface.frozen-at.testnet")),
    false,
    "a candidate build failure must fail closed without writing a sticky drift marker"
  );
});

test("deploy wrapper reports a missing containerized Node runtime as an environment error", async () => {
  const fixture = await makeDeployFreezeFixture(
    async (appRoot) => {
      await writeFile(join(appRoot, "README.md"), "missing node runtime fixture\n");
    },
    "non-contract change"
  );

  const run = runDeploy(fixture.appRoot, {
    ...deployFreezeEnv(fixture),
    PATH: `${fixture.fakeBin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    DEPLOY_OLD_SHA: fixture.baseSha,
    DEPLOY_NEW_SHA: fixture.nextSha,
    FAKE_PROVENANCE_NODE_PREFLIGHT_STATUS: "127",
  });

  assert.equal(run.status, 1);
  assert.match(run.stderr, /D-03 Tier 2 environment error/u);
  assert.match(run.stderr, /not runnable \(exit 127\)/u);
  assert.match(run.stderr, /provenance checker did not run/u);
  assert.doesNotMatch(run.stderr, /live chain runtime does not match/u);
});

test("deploy wrapper fails closed on an unreachable provenance RPC even when drift override is set", async () => {
  const fixture = await makeDeployFreezeFixture(
    async (appRoot) => {
      await writeFile(join(appRoot, "README.md"), "rpc failure fixture\n");
    },
    "non-contract change"
  );

  const run = runDeploy(fixture.appRoot, {
    ...deployFreezeEnv(fixture),
    DEPLOY_OLD_SHA: fixture.baseSha,
    DEPLOY_NEW_SHA: fixture.nextSha,
    DEPLOY_ALLOW_CONTRACT_SURFACE_DRIFT: "1",
    FAKE_CONTRACT_LIVE_STATUS: "2",
  });

  assert.equal(run.status, 1);
  assert.match(run.stderr, /could not verify live contract provenance/u);
  assert.match(run.stderr, /unreachable RPC/u);
  assert.doesNotMatch(run.stderr, /Tier 2 override set/u);
});

test("deploy wrapper fails closed on an unreadable deployment manifest", async () => {
  const fixture = await makeDeployFreezeFixture(
    async (appRoot) => {
      await writeFile(join(appRoot, "README.md"), "manifest failure fixture\n");
    },
    "non-contract change"
  );

  const run = runDeploy(fixture.appRoot, {
    ...deployFreezeEnv(fixture),
    DEPLOY_OLD_SHA: fixture.baseSha,
    DEPLOY_NEW_SHA: fixture.nextSha,
    FAKE_CONTRACT_LIVE_STATUS: "2",
    FAKE_CONTRACT_LIVE_ERROR: "fake live provenance: unreadable deployment manifest",
  });

  assert.equal(run.status, 1);
  assert.match(run.stderr, /could not verify live contract provenance/u);
  assert.match(run.stderr, /unreadable deployment manifest/u);
});

// 2026-07-27 (deploy run 30312416198): the VPS checkout fast-forwards even when
// a deploy fails AT the freeze, so the next merge's own OLD..NEW range no
// longer contains the flagged files and a range-only gate silently passes.
// These fixtures drive two consecutive runs to prove the refusal persists.
function deployFreezeEnv({ stackRoot, fakeBin, appRoot, stateDir }) {
  return {
    PATH: `${fakeBin}:${process.env.PATH}`,
    STACK_ROOT: stackRoot,
    COMPOSE_FILE: join(stackRoot, "docker-compose.yml"),
    DEPLOY_LOCK_FILE: join(appRoot, "deploy.lock"),
    DEPLOY_STATE_DIR: stateDir,
    DEPLOY_CONTRACT_COMPAT_FREEZE: "1",
    RUN_BACKEND: "0",
    RUN_INDEXER: "0",
    RUN_FRONTEND: "0",
    RUN_SITE: "0",
    RUN_CADDY: "0",
    RUN_SMOKE: "0"
  };
}

async function makeStickyFreezeFixture() {
  const fixture = await makeDeployFreezeFixture(
    async (appRoot) => {
      await mkdir(join(appRoot, "contracts"), { recursive: true });
      await writeFile(join(appRoot, "contracts/AgentAccountCore.sol"), "contract AgentAccountCore { uint256 changed; }\n");
    },
    "contract runtime change"
  );
  const env = {
    ...deployFreezeEnv(fixture),
    FAKE_CONTRACT_SOURCE_STATUS: "1",
  };
  const markerPath = join(fixture.stateDir, "contract-surface.frozen-at.testnet");

  const firstRun = runDeploy(fixture.appRoot, {
    ...env,
    DEPLOY_OLD_SHA: fixture.baseSha,
    DEPLOY_NEW_SHA: fixture.nextSha
  });
  assert.equal(firstRun.status, 1);
  assert.match(firstRun.stderr, /D-03 contract compatibility freeze: refusing production deploy/u);
  assert.match(firstRun.stderr, /This refusal is persisted at/u);

  const marker = await readFile(markerPath, "utf8");
  assert.match(marker, new RegExp(`^baseline_sha=${fixture.baseSha}$`, "mu"));
  assert.match(marker, new RegExp(`^flagged_sha=${fixture.nextSha}$`, "mu"));
  assert.match(marker, /^manifest=deployments\/testnet\.json$/mu);
  assert.match(marker, /^contracts\/AgentAccountCore\.sol$/mu);

  return { ...fixture, env, markerPath };
}

test("deploy wrapper keeps the freeze armed after a refused deploy fast-forwards the checkout", async () => {
  const { appRoot, env, markerPath, baseSha, nextSha } = await makeStickyFreezeFixture();

  await writeFile(join(appRoot, "README.md"), "unrelated docs change\n");
  git(appRoot, "add", ".");
  git(appRoot, "commit", "-m", "docs change");
  const docsSha = revParse(appRoot, "HEAD");

  const secondRun = runDeploy(appRoot, {
    ...env,
    DEPLOY_OLD_SHA: nextSha,
    DEPLOY_NEW_SHA: docsSha
  });
  assert.equal(
    secondRun.status,
    1,
    `the second deploy must stay frozen even though its own range has no contract-surface files\n${secondRun.stdout}\n${secondRun.stderr}`
  );
  assert.match(secondRun.stdout, /enforcing persisted freeze from/u);
  assert.match(secondRun.stderr, /D-03 contract compatibility freeze: refusing production deploy/u);
  assert.match(secondRun.stderr, new RegExp(`Evaluated range: ${baseSha} -> ${docsSha}`, "u"));
  assert.match(secondRun.stderr, /contracts\/AgentAccountCore\.sol/u);
  assert.ok(existsSync(markerPath), "the freeze marker must survive the second refusal");
});

test("deploy wrapper refuses a frozen no-new-commits rerun instead of taking the OLD==NEW fast path", async () => {
  const { appRoot, env, markerPath, nextSha } = await makeStickyFreezeFixture();

  // Same-sha re-dispatch of the refused deploy: the pre-marker gate returned
  // early on OLD==NEW, but component pointers still trail the flagged files,
  // so an auto-routed rerun would deploy them with the gate skipped.
  const rerun = runDeploy(appRoot, {
    ...env,
    DEPLOY_OLD_SHA: nextSha,
    DEPLOY_NEW_SHA: nextSha
  });
  assert.equal(rerun.status, 1, `a no-new-commits rerun must stay frozen\n${rerun.stdout}\n${rerun.stderr}`);
  assert.match(rerun.stdout, /enforcing persisted freeze from/u);
  assert.match(rerun.stderr, /D-03 contract compatibility freeze: refusing production deploy/u);
  assert.ok(existsSync(markerPath), "the freeze marker must survive the rerun refusal");
});

test("deploy wrapper clears the persisted freeze once the deployment manifest pairs with the drift", async () => {
  const { appRoot, env, markerPath, nextSha } = await makeStickyFreezeFixture();

  await mkdir(join(appRoot, "deployments"), { recursive: true });
  await writeFile(join(appRoot, "deployments/testnet.json"), '{"contracts":{"agentAccountCore":"0x0000000000000000000000000000000000000002"}}\n');
  git(appRoot, "add", ".");
  git(appRoot, "commit", "-m", "repin contracts manifest");
  const manifestSha = revParse(appRoot, "HEAD");

  const run = runDeploy(appRoot, {
    ...env,
    DEPLOY_OLD_SHA: nextSha,
    DEPLOY_NEW_SHA: manifestSha
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /clearing persisted freeze marker/u);
  assert.match(run.stdout, /now paired with deployments\/testnet\.json/u);
  assert.match(run.stdout, /contract source changes are paired with deployments\/testnet\.json; no sticky freeze/u);
  assert.ok(!existsSync(markerPath), "a manifest-paired deploy must clear the freeze marker");
});

test("deploy wrapper clears the persisted freeze on an explicit drift override dispatch", async () => {
  const { appRoot, env, markerPath, nextSha } = await makeStickyFreezeFixture();

  await writeFile(join(appRoot, "README.md"), "unrelated docs change\n");
  git(appRoot, "add", ".");
  git(appRoot, "commit", "-m", "docs change");
  const docsSha = revParse(appRoot, "HEAD");

  const run = runDeploy(appRoot, {
    ...env,
    DEPLOY_OLD_SHA: nextSha,
    DEPLOY_NEW_SHA: docsSha,
    DEPLOY_ALLOW_CONTRACT_SURFACE_DRIFT: "1"
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /D-03 contract compatibility freeze override set/u);
  assert.match(run.stdout, /clearing persisted freeze marker/u);
  // The override run's log is the audit record: it must name the drift it accepted.
  assert.match(run.stdout, /contracts\/AgentAccountCore\.sol/u);
  assert.ok(!existsSync(markerPath), "an explicit override dispatch must clear the freeze marker");
});

test("deploy wrapper clears the persisted freeze when the flagged drift is reverted", async () => {
  const { appRoot, env, markerPath, nextSha } = await makeStickyFreezeFixture();

  git(appRoot, "rm", "contracts/AgentAccountCore.sol");
  git(appRoot, "commit", "-m", "revert contract surface change");
  const revertSha = revParse(appRoot, "HEAD");

  const run = runDeploy(appRoot, {
    ...env,
    DEPLOY_OLD_SHA: nextSha,
    DEPLOY_NEW_SHA: revertSha
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /clearing persisted freeze marker/u);
  assert.match(run.stdout, /old marker was heuristic-only or the source drift was reverted/u);
  assert.ok(!existsSync(markerPath), "a reverted drift must clear the freeze marker instead of over-blocking");
});

test("deploy workflow wires the D-03 contract controls as manual-only", async () => {
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
  assert.match(
    workflow,
    /verify_contract_source:/u,
    "workflow_dispatch should expose a named fail-closed Tier 3 proof input"
  );
  assert.match(
    workflow,
    /DEPLOY_VERIFY_CONTRACT_SOURCE:\s*\$\{\{\s*github\.event_name\s*==\s*'workflow_dispatch'\s*&&\s*inputs\.verify_contract_source\s*\|\|\s*'0'\s*\}\}/u,
    "automatic workflow_run deploys must not force the extra Tier 3 proof build"
  );
  assert.match(
    workflow,
    /DEPLOY_VERIFY_CONTRACT_SOURCE=%q DEPLOY_ACTOR=%q/u,
    "the manual Tier 3 proof input must be forwarded through the SSH remote_env wrapper"
  );
  assert.match(
    workflow,
    /"\$DEPLOY_VERIFY_CONTRACT_SOURCE"/u,
    "remote_env must include the evaluated Tier 3 proof value"
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
  await mkdir(join(appRoot, "site/transparency"), { recursive: true });
  await mkdir(join(appRoot, "site/verify"), { recursive: true });
  await mkdir(join(appRoot, "site/proof-to-pay"), { recursive: true });
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
    "case \"$url\" in",
    "  */console-stream.js) name=console-stream.js ;;",
    "  */transparency/) name=transparency/index.html ;;",
    "  */transparency-reader.js) name=transparency-reader.js ;;",
    "  */verify/) name=verify/index.html ;;",
    "  */verify-reader.js) name=verify-reader.js ;;",
    "  */proof-to-pay/) name=proof-to-pay/index.html ;;",
    "esac",
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
  await writeFile(join(appRoot, "site/transparency/index.html"), "<title>Transparency</title> fresh build\n");
  await writeFile(join(appRoot, "site/transparency-reader.js"), "// fresh transparency reader\n");
  await writeFile(join(appRoot, "site/verify/index.html"), "<title>Averray Verify</title> fresh build\n");
  await writeFile(join(appRoot, "site/verify-reader.js"), "// fresh verify reader\n");
  await writeFile(join(appRoot, "site/proof-to-pay/index.html"), "<title>Proof-to-Pay</title> fresh build\n");
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
  await mkdir(join(appRoot, "deployments"), { recursive: true });
  await mkdir(stackRoot, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await writeFile(join(stackRoot, "docker-compose.yml"), "services: {}\n");
  await copyFile(DEPLOY_SCRIPT, join(appRoot, "scripts/ops/deploy-production.sh"));
  await chmod(join(appRoot, "scripts/ops/deploy-production.sh"), 0o755);
  await writeFile(
    join(appRoot, "scripts/ops/check-contract-provenance.mjs"),
    [
      "const status = Number(process.env.FAKE_CONTRACT_LIVE_STATUS ?? '0');",
      "if (status === 0) console.log('fake live provenance: match');",
      "else if (status === 1) console.error('fake live provenance: runtime hash mismatch');",
      "else console.error(process.env.FAKE_CONTRACT_LIVE_ERROR ?? 'fake live provenance: unreachable RPC');",
      "process.exitCode = status;",
    ].join("\n")
  );
  await writeFile(
    join(appRoot, "scripts/ops/check-contract-source-drift.mjs"),
    [
      "const status = Number(process.env.FAKE_CONTRACT_SOURCE_STATUS ?? '0');",
      "if (status === 0) console.log('fake compiled provenance: match or allowlisted');",
      "else if (status === 1) console.error('fake compiled provenance: unallowlisted runtime drift');",
      "else console.error('fake compiled provenance: unreadable manifest or artifacts');",
      "process.exitCode = status;",
    ].join("\n")
  );
  await writeFile(
    join(appRoot, "deployments/testnet.json"),
    '{"profile":"testnet","contracts":{},"contractProvenance":{},"knownUnshippedContractChanges":{}}\n'
  );

  for (const command of ["npm", "flock"]) {
    await writeExecutable(join(fakeBin, command), "#!/usr/bin/env bash\nexit 0\n");
  }
  await writeExecutable(join(fakeBin, "docker"), [
    "#!/usr/bin/env bash",
    "if [[ -n \"${FAKE_DOCKER_LOG:-}\" ]]; then printf '%s\\n' \"$*\" >> \"$FAKE_DOCKER_LOG\"; fi",
    "if [[ \"$*\" == *\"node --version\"* ]]; then",
    "  status=\"${FAKE_PROVENANCE_NODE_PREFLIGHT_STATUS:-0}\"",
    "  if [[ \"$status\" != \"0\" ]]; then echo 'node: command not found' >&2; exit \"$status\"; fi",
    "  echo 'v22.0.0'",
    "  exit 0",
    "fi",
    "if [[ \"$*\" == *\"--entrypoint forge\"* && \"$*\" == *\"--version\"* ]]; then",
    "  status=\"${FAKE_FOUNDRY_PREFLIGHT_STATUS:-0}\"",
    "  if [[ \"$status\" != \"0\" ]]; then echo 'forge: command not found' >&2; exit \"$status\"; fi",
    "  echo 'forge Version: 1.5.1-stable'",
    "  exit 0",
    "fi",
    "if [[ \"$*\" == *\"--entrypoint forge\"* && \"$*\" == *\" build \"* ]]; then",
    "  status=\"${FAKE_FOUNDRY_BUILD_STATUS:-0}\"",
    "  if [[ \"$status\" != \"0\" ]]; then echo 'fake forge build failed' >&2; fi",
    "  exit \"$status\"",
    "fi",
    "if [[ \"$*\" == *\"check-contract-provenance.mjs\"* ]]; then",
    "  status=\"${FAKE_CONTRACT_LIVE_STATUS:-0}\"",
    "  if [[ \"$status\" == \"0\" ]]; then echo 'fake live provenance: match';",
    "  elif [[ \"$status\" == \"1\" ]]; then echo 'fake live provenance: runtime hash mismatch' >&2;",
    "  else echo \"${FAKE_CONTRACT_LIVE_ERROR:-fake live provenance: unreachable RPC}\" >&2; fi",
    "  exit \"$status\"",
    "fi",
    "if [[ \"$*\" == *\"check-contract-source-drift.mjs\"* ]]; then",
    "  status=\"${FAKE_CONTRACT_SOURCE_STATUS:-0}\"",
    "  if [[ \"$status\" == \"0\" ]]; then echo 'fake compiled provenance: match or allowlisted';",
    "  elif [[ \"$status\" == \"1\" ]]; then echo 'fake compiled provenance: unallowlisted runtime drift' >&2;",
    "  else echo 'fake compiled provenance: unreadable manifest or artifacts' >&2; fi",
    "  exit \"$status\"",
    "fi",
    "exit 0",
  ].join("\n"));
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
  await copyFile(BACKEND_REBUILD_PATTERN_SCRIPT, join(appRoot, "scripts/ops/backend-image-rebuild-pattern.mjs"));
  await copyFile(BACKEND_DOCKERFILE, join(appRoot, "mcp-server/Dockerfile"));
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
  await writeFile(join(appRoot, "scripts/ops/pool-venue-dispatch.mjs"), "export const version = 1;\n");
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

  await writeFile(join(appRoot, "scripts/ops/pool-venue-dispatch.mjs"), "export const version = 2;\n");
  git(appRoot, "add", ".");
  git(appRoot, "commit", "-m", "copied ops change");
  const copiedScriptSha = revParse(appRoot, "HEAD");
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
    copiedScriptSha,
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
  await copyFile(BACKEND_REBUILD_PATTERN_SCRIPT, join(appRoot, "scripts/ops/backend-image-rebuild-pattern.mjs"));
  await copyFile(BACKEND_DOCKERFILE, join(appRoot, "mcp-server/Dockerfile"));
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

async function makeIndexerSchemaSourceFixture({ runtimeSchema = "" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "deploy-indexer-schema-source-"));
  const appRoot = join(root, "app");
  const stackRoot = join(root, "stack");
  const fakeBin = join(root, "bin");
  const stateDir = join(root, "state");
  const deployLog = join(root, "deploy.log");
  const indexerEnv = join(root, "indexer.env");

  await mkdir(join(appRoot, "scripts/ops"), { recursive: true });
  await mkdir(join(appRoot, "indexer"), { recursive: true });
  await mkdir(join(appRoot, "deploy"), { recursive: true });
  await mkdir(stackRoot, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stackRoot, "docker-compose.yml"), "services: {}\n");
  await writeFile(
    indexerEnv,
    runtimeSchema ? `DATABASE_SCHEMA=${runtimeSchema}\n` : "",
  );
  await copyFile(DEPLOY_SCRIPT, join(appRoot, "scripts/ops/deploy-production.sh"));
  await chmod(join(appRoot, "scripts/ops/deploy-production.sh"), 0o755);
  await writeExecutable(join(appRoot, "scripts/ops/redeploy-indexer.sh"), [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "printf 'indexer rollback=%s\\n' \"${ROLLBACK_INDEXER_SCHEMA:-}\" >> \"$DEPLOY_LOG\"",
  ].join("\n"));
  for (const command of ["docker", "npm", "flock"]) {
    await writeExecutable(join(fakeBin, command), "#!/usr/bin/env bash\nexit 0\n");
  }
  await writeFakeHealthCurl(join(fakeBin, "curl"));

  await writeFile(
    join(appRoot, "indexer/package-lock.json"),
    '{"lockfileVersion":3,"packages":{"":{"dependencies":{"ponder":"^0.16.6"}},"node_modules/ponder":{"version":"0.16.6"}}}\n',
  );
  await writeFile(
    join(appRoot, "deploy/indexer.env.template"),
    [
      "POLKADOT_CHAIN_ID=420420417",
      "POLKADOT_CHAIN_NAME=polkadotHubTestnet",
      "PONDER_ESCROW_CORE_ADDRESS=0x1111111111111111111111111111111111111111",
      "PONDER_START_BLOCK_ESCROW=100",
      "",
    ].join("\n"),
  );

  git(appRoot, "init");
  git(appRoot, "config", "user.email", "test@example.com");
  git(appRoot, "config", "user.name", "Deploy Test");
  await writeFile(join(appRoot, "README.md"), "schema source fixture\n");
  git(appRoot, "add", ".");
  git(appRoot, "commit", "-m", "base");
  const sha = revParse(appRoot, "HEAD");

  return {
    appRoot,
    stateDir,
    deployLog,
    indexerEnv,
    env: {
      PATH: `${fakeBin}:${process.env.PATH}`,
      STACK_ROOT: stackRoot,
      COMPOSE_FILE: join(stackRoot, "docker-compose.yml"),
      DEPLOY_LOCK_FILE: join(root, "deploy.lock"),
      DEPLOY_STATE_DIR: stateDir,
      INDEXER_ENV_FILE: indexerEnv,
      DEPLOY_OLD_SHA: sha,
      DEPLOY_NEW_SHA: sha,
      DEPLOY_LOG: deployLog,
      RUN_BACKEND: "0",
      RUN_INDEXER: "1",
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

function gitHashObject(cwd, input) {
  return execFileSync("git", ["hash-object", "--stdin"], {
    cwd,
    encoding: "utf8",
    input,
  }).trim();
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
      // Generic deploy fixtures isolate unrelated routing behavior and do not
      // carry a chain manifest/checker. D-03 fixtures explicitly re-enable it.
      DEPLOY_CONTRACT_COMPAT_FREEZE: "0",
      ...env,
      FAKE_HEALTH_SHA: fakeHealthSha
    },
    encoding: "utf8"
  });
}

function parseDeployResult(stdout) {
  const line = stdout
    .split("\n")
    .find((candidate) => candidate.startsWith("AVERRAY_DEPLOY_RESULT="));
  assert.ok(line, "successful deploy must emit an AVERRAY_DEPLOY_RESULT record");
  return JSON.parse(line.slice("AVERRAY_DEPLOY_RESULT=".length));
}
