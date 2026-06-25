import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DEPLOY_SCRIPT = join(REPO_ROOT, "scripts/deploy_contracts.sh");

function runDeployScript(extraEnv) {
  return spawnSync("bash", [DEPLOY_SCRIPT], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...extraEnv
    },
    encoding: "utf8"
  });
}

function assertPreflightFailure(result, expectedMessage) {
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, expectedMessage);
  assert.doesNotMatch(result.stderr, /Missing required command/u);
  assert.doesNotMatch(result.stderr, /PRIVATE_KEY is required/u);
  assert.doesNotMatch(result.stderr, /MAINNET_CONFIRM/u);
}

test("deploy_contracts blocks mainnet XCM vDOT adapter before any deploy preconditions", () => {
  const result = runDeployScript({
    PROFILE: "mainnet",
    WITH_XCM_WRAPPER: "1",
    WITH_XCM_VDOT_ADAPTER: "1"
  });

  assertPreflightFailure(result, /WITH_XCM_VDOT_ADAPTER=1 is not allowed on PROFILE=mainnet/u);
});

test("deploy_contracts blocks mainnet mock vDOT adapter before any deploy preconditions", () => {
  const result = runDeployScript({
    PROFILE: "mainnet",
    WITH_VDOT_MOCK: "1"
  });

  assertPreflightFailure(result, /WITH_VDOT_MOCK=1 is not allowed on PROFILE=mainnet/u);
});

test("deploy_contracts requires the XCM wrapper before enabling the async vDOT adapter", () => {
  const result = runDeployScript({
    PROFILE: "testnet",
    WITH_XCM_VDOT_ADAPTER: "1"
  });

  assertPreflightFailure(result, /WITH_XCM_VDOT_ADAPTER=1 requires WITH_XCM_WRAPPER=1/u);
});

