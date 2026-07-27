import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const script = new URL("./fingerprint-op-secret.sh", import.meta.url).pathname;

test("fingerprints the consumed value without a display newline", async () => {
  const root = await mkdtemp(join(tmpdir(), "fingerprint-op-secret-"));
  const fakeOp = join(root, "op");
  const secret = "opaque-refresh-token";
  try {
    await writeFile(fakeOp, "#!/usr/bin/env bash\nprintf '%s\\n' \"$FAKE_OP_VALUE\"\n");
    await chmod(fakeOp, 0o755);
    const { stdout } = await execFileAsync(
      script,
      ["op://mainnet-smoke/admin-refresh-token-production-deploy/password"],
      {
        env: {
          ...process.env,
          PATH: `${root}:${process.env.PATH}`,
          FAKE_OP_VALUE: secret,
        },
      },
    );
    const expected = createHash("sha256").update(secret).digest("hex").slice(0, 8);
    assert.equal(stdout.trim(), expected);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("helper uses printf rather than echo for hash input", async () => {
  const source = await readFile(script, "utf8");
  assert.match(source, /printf '%s' "\$value" \| shasum -a 256/u);
  assert.doesNotMatch(source, /echo .*shasum/u);
});
