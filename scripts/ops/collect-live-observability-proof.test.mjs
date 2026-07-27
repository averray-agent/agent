import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const sourceScript = new URL("./collect-live-observability-proof.sh", import.meta.url).pathname;

async function fixture(selectedEnv) {
  const root = await mkdtemp(join(tmpdir(), "collect-live-observability-proof-"));
  const wrapper = join(root, "collect-live-observability-proof.sh");
  const resolver = join(root, "resolve-live-backend-env.sh");
  const collector = join(root, "collect-observability-proof.sh");
  await copyFile(sourceScript, wrapper);
  await writeFile(resolver, `#!/usr/bin/env bash\nprintf '%s\\n' "$SELECTED_ENV"\n`);
  await writeFile(
    collector,
    "#!/usr/bin/env bash\nprintf '%s|%s\\n' \"$BACKEND_ENV_FILE\" \"$BACKEND_CONTAINER\"\n",
  );
  await Promise.all([wrapper, resolver, collector].map((path) => chmod(path, 0o755)));
  return {
    root,
    wrapper,
    env: {
      ...process.env,
      SELECTED_ENV: selectedEnv,
      MAINNET_BACKEND_ENV_FILE: "/runtime/mainnet/backend.env",
    },
  };
}

test("mainnet selection carries the mainnet render and container together", async () => {
  const f = await fixture("/runtime/mainnet/backend.env");
  try {
    const { stdout } = await execFileAsync(f.wrapper, [], { env: f.env });
    assert.equal(stdout.trim(), "/runtime/mainnet/backend.env|agent-mainnet-backend");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("testnet rollback carries the testnet render and container together", async () => {
  const f = await fixture("/runtime/testnet/backend.env");
  try {
    const { stdout } = await execFileAsync(f.wrapper, [], { env: f.env });
    assert.equal(stdout.trim(), "/runtime/testnet/backend.env|agent-backend");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
