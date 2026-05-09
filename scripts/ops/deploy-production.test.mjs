import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, copyFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DEPLOY_SCRIPT = join(REPO_ROOT, "scripts/ops/deploy-production.sh");

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

  for (const command of ["docker", "curl", "npm", "flock"]) {
    await writeExecutable(join(fakeBin, command), "#!/usr/bin/env bash\nexit 0\n");
  }

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

test("deploy wrapper writes bootstrap instrumentation backend env when secrets are present", async () => {
  const root = await mkdtemp(join(tmpdir(), "deploy-production-bootstrap-"));
  const appRoot = join(root, "app");
  const stackRoot = join(root, "stack");
  const fakeBin = join(root, "bin");
  const stateDir = join(root, "state");
  const deployLog = join(root, "deploy.log");
  const backendEnv = join(stackRoot, "backend.env");

  await mkdir(join(appRoot, "scripts/ops"), { recursive: true });
  await mkdir(stackRoot, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await writeFile(join(stackRoot, "docker-compose.yml"), "services: {}\n");
  await writeFile(backendEnv, "KEEP_ME=1\nBOOTSTRAP_SELF_REPORT_ENABLED=false\nRESEND_API_KEY=\"old\"\n");
  await copyFile(DEPLOY_SCRIPT, join(appRoot, "scripts/ops/deploy-production.sh"));
  await chmod(join(appRoot, "scripts/ops/deploy-production.sh"), 0o755);
  await writeExecutable(join(appRoot, "scripts/ops/redeploy-backend.sh"), [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "echo backend >> \"$DEPLOY_LOG\""
  ].join("\n"));

  for (const command of ["docker", "curl", "npm", "flock"]) {
    await writeExecutable(join(fakeBin, command), "#!/usr/bin/env bash\nexit 0\n");
  }

  git(appRoot, "init");
  git(appRoot, "config", "user.email", "test@example.com");
  git(appRoot, "config", "user.name", "Deploy Test");
  await writeFile(join(appRoot, "README.md"), "base\n");
  git(appRoot, "add", ".");
  git(appRoot, "commit", "-m", "base");
  const baseSha = revParse(appRoot, "HEAD");

  const result = runDeploy(appRoot, {
    PATH: `${fakeBin}:${process.env.PATH}`,
    STACK_ROOT: stackRoot,
    COMPOSE_FILE: join(stackRoot, "docker-compose.yml"),
    BACKEND_ENV_FILE: backendEnv,
    DEPLOY_LOCK_FILE: join(root, "deploy.lock"),
    DEPLOY_STATE_DIR: stateDir,
    DEPLOY_OLD_SHA: baseSha,
    DEPLOY_NEW_SHA: baseSha,
    DEPLOY_LOG: deployLog,
    RESEND_API_KEY: "secret",
    BOOTSTRAP_SELF_REPORT_TO: "ops@example.com",
    BOOTSTRAP_SELF_REPORT_FROM: "ops@averray.com",
    BOOTSTRAP_SELF_REPORT_SEND_ON_START: "1",
    RUN_FRONTEND: "0",
    RUN_INDEXER: "0",
    RUN_SITE: "0",
    RUN_CADDY: "0",
    RUN_SMOKE: "0"
  });

  assert.equal(result.status, 0, result.stderr);
  const contents = await readFile(backendEnv, "utf8");
  assert.match(contents, /^KEEP_ME=1$/m);
  assert.match(contents, /^UPSTREAM_STATUS_POLLER_ENABLED="true"$/m);
  assert.match(contents, /^BOOTSTRAP_SELF_REPORT_ENABLED="true"$/m);
  assert.match(contents, /^BOOTSTRAP_SELF_REPORT_SEND_ON_START="true"$/m);
  assert.match(contents, /^BOOTSTRAP_SELF_REPORT_TO="ops@example\.com"$/m);
  assert.match(contents, /^BOOTSTRAP_SELF_REPORT_FROM="ops@averray\.com"$/m);
  assert.match(contents, /^RESEND_API_KEY="secret"$/m);
  assert.equal((contents.match(/^RESEND_API_KEY=/gm) ?? []).length, 1);
  assert.match(await readFile(deployLog, "utf8"), /^backend$/m);
});

test("deploy wrapper refreshes settlement backend env from testnet deployment manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "deploy-production-settlement-"));
  const appRoot = join(root, "app");
  const stackRoot = join(root, "stack");
  const fakeBin = join(root, "bin");
  const stateDir = join(root, "state");
  const deployLog = join(root, "deploy.log");
  const backendEnv = join(stackRoot, "backend.env");

  await mkdir(join(appRoot, "scripts/ops"), { recursive: true });
  await mkdir(join(appRoot, "deployments"), { recursive: true });
  await mkdir(stackRoot, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await writeFile(join(stackRoot, "docker-compose.yml"), "services: {}\n");
  await writeFile(backendEnv, [
    "KEEP_ME=1",
    "DWELLER_RPC_URL=\"https://old-dweller.example\"",
    "POLKADOT_RPC_URL=\"https://old-polkadot.example\"",
    "RPC_URL=\"https://old.example\"",
    "SUPPORTED_ASSETS=\"DOT:0x5555555555555555555555555555555555555555\"",
    "SUPPORTED_ASSETS_JSON=\"[]\""
  ].join("\n") + "\n");
  await writeFile(join(appRoot, "deployments/testnet.json"), JSON.stringify({
    profile: "testnet",
    rpcUrl: "https://eth-rpc-testnet.polkadot.io/",
    contracts: {
      treasuryPolicy: "0x648Cc5fdE94435992296C4e5ac642d18bB64c12B",
      agentAccountCore: "0x71B111d8c9DF84Be26cb9067D27dAd7A2d5E7e08",
      reputationSbt: "0x68Db90db715Be59E5800Bea08c058E4CFd88e27c",
      discoveryRegistry: "0x0a1b78F8A2A3C28dB47f35Cb3E6b3b83412dad57",
      escrowCore: "0x7BB8fea44bDeE9870cF27c1dB616E7017BC38b0a",
      xcmWrapper: null,
      token: "0x0000053900000000000000000000000001200000"
    }
  }), "utf8");
  await copyFile(DEPLOY_SCRIPT, join(appRoot, "scripts/ops/deploy-production.sh"));
  await chmod(join(appRoot, "scripts/ops/deploy-production.sh"), 0o755);
  await writeExecutable(join(appRoot, "scripts/ops/redeploy-backend.sh"), [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "echo backend >> \"$DEPLOY_LOG\""
  ].join("\n"));

  for (const command of ["docker", "curl", "npm", "flock"]) {
    await writeExecutable(join(fakeBin, command), "#!/usr/bin/env bash\nexit 0\n");
  }

  git(appRoot, "init");
  git(appRoot, "config", "user.email", "test@example.com");
  git(appRoot, "config", "user.name", "Deploy Test");
  await writeFile(join(appRoot, "README.md"), "base\n");
  git(appRoot, "add", ".");
  git(appRoot, "commit", "-m", "base");
  const baseSha = revParse(appRoot, "HEAD");

  const result = runDeploy(appRoot, {
    PATH: `${fakeBin}:${process.env.PATH}`,
    STACK_ROOT: stackRoot,
    COMPOSE_FILE: join(stackRoot, "docker-compose.yml"),
    BACKEND_ENV_FILE: backendEnv,
    DEPLOY_LOCK_FILE: join(root, "deploy.lock"),
    DEPLOY_STATE_DIR: stateDir,
    DEPLOY_OLD_SHA: baseSha,
    DEPLOY_NEW_SHA: baseSha,
    DEPLOY_LOG: deployLog,
    RUN_FRONTEND: "0",
    RUN_INDEXER: "0",
    RUN_SITE: "0",
    RUN_CADDY: "0",
    RUN_SMOKE: "0"
  });

  assert.equal(result.status, 0, result.stderr);
  const contents = await readFile(backendEnv, "utf8");
  assert.match(contents, /^KEEP_ME=1$/m);
  assert.match(contents, /^DWELLER_RPC_URL="https:\/\/eth-rpc-testnet\.polkadot\.io\/"$/m);
  assert.match(contents, /^POLKADOT_RPC_URL="https:\/\/eth-rpc-testnet\.polkadot\.io\/"$/m);
  assert.match(contents, /^RPC_URL="https:\/\/eth-rpc-testnet\.polkadot\.io\/"$/m);
  assert.match(contents, /^TREASURY_POLICY_ADDRESS="0x648Cc5fdE94435992296C4e5ac642d18bB64c12B"$/m);
  assert.match(contents, /^AGENT_ACCOUNT_ADDRESS="0x71B111d8c9DF84Be26cb9067D27dAd7A2d5E7e08"$/m);
  assert.match(contents, /^ESCROW_CORE_ADDRESS="0x7BB8fea44bDeE9870cF27c1dB616E7017BC38b0a"$/m);
  assert.match(contents, /^REPUTATION_SBT_ADDRESS="0x68Db90db715Be59E5800Bea08c058E4CFd88e27c"$/m);
  assert.match(contents, /^DISCOVERY_REGISTRY_ADDRESS="0x0a1b78F8A2A3C28dB47f35Cb3E6b3b83412dad57"$/m);
  assert.match(contents, /^XCM_WRAPPER_ADDRESS=""$/m);
  assert.match(contents, /^SUPPORTED_ASSETS=""$/m);
  assert.match(contents, /^SUPPORTED_ASSETS_JSON="\[{\\"symbol\\":\\"USDC\\",\\"assetClass\\":\\"trust_backed\\",\\"assetId\\":1337,\\"address\\":\\"0x0000053900000000000000000000000001200000\\",\\"decimals\\":6}\]"$/m);
  assert.match(await readFile(deployLog, "utf8"), /^backend$/m);
});

async function writeExecutable(path, content) {
  await writeFile(path, `${content}\n`);
  await chmod(path, 0o755);
}

function git(cwd, ...args) {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function revParse(cwd, revision) {
  return execFileSync("git", ["rev-parse", revision], { cwd, encoding: "utf8" }).trim();
}

function runDeploy(cwd, env) {
  return spawnSync("bash", ["scripts/ops/deploy-production.sh"], {
    cwd,
    env: {
      ...process.env,
      ...env
    },
    encoding: "utf8"
  });
}
