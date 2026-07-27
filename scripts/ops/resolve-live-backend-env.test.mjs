import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const resolver = new URL("./resolve-live-backend-env.sh", import.meta.url).pathname;

async function fixture({ network = "mainnet", chainId = 420420419, consistent = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "resolve-live-backend-env-"));
  const statusFile = join(root, "status.jsons");
  const flip = join(root, "flip.sh");
  const testnetEnv = join(root, "testnet.env");
  const mainnetEnv = join(root, "mainnet.env");

  await writeFile(testnetEnv, "PROFILE=testnet\n");
  await writeFile(mainnetEnv, "PROFILE=mainnet\n");
  await writeFile(
    statusFile,
    `${JSON.stringify({
      selectedNetwork: network,
      expectedChainId: chainId,
      liveRoute: network,
      consistent,
    })}\n${JSON.stringify({ publicStatus: "ok", publicChainId: chainId })}\n`,
  );
  await writeFile(flip, "#!/usr/bin/env bash\ncat \"$STATUS_FIXTURE\"\n");
  await chmod(flip, 0o755);

  return {
    root,
    statusFile,
    flip,
    testnetEnv,
    mainnetEnv,
    env: {
      ...process.env,
      STATUS_FIXTURE: statusFile,
      FLIP_CADDY_NETWORK_SCRIPT: flip,
      TESTNET_BACKEND_ENV_FILE: testnetEnv,
      MAINNET_BACKEND_ENV_FILE: mainnetEnv,
    },
  };
}

test("selects the mainnet render only when the durable route and public chain agree", async () => {
  const f = await fixture();
  try {
    const { stdout } = await execFileAsync(resolver, [], { env: f.env });
    assert.equal(stdout.trim(), f.mainnetEnv);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("keeps the one-operation testnet rollback path", async () => {
  const f = await fixture({ network: "testnet", chainId: 420420417 });
  try {
    const { stdout } = await execFileAsync(resolver, [], { env: f.env });
    assert.equal(stdout.trim(), f.testnetEnv);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("fails closed when the selector is inconsistent", async () => {
  const f = await fixture({ consistent: false });
  try {
    await assert.rejects(execFileAsync(resolver, [], { env: f.env }));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("fails closed when the public chain differs from the selected chain", async () => {
  const f = await fixture();
  try {
    await writeFile(
      f.statusFile,
      `${JSON.stringify({
        selectedNetwork: "mainnet",
        expectedChainId: 420420419,
        liveRoute: "mainnet",
        consistent: true,
      })}\n${JSON.stringify({ publicStatus: "ok", publicChainId: 420420417 })}\n`,
    );
    await assert.rejects(execFileAsync(resolver, [], { env: f.env }));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
