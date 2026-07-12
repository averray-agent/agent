import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SCRIPT = join(REPO_ROOT, "scripts/ops/preflight-badge-receipt-signer.sh");

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "badge-receipt-preflight-"));
  const declaration = join(root, "profile");
  const config = join(root, "aws-config");
  const certificate = join(root, "badge-cert.pem");
  const privateKey = join(root, "badge-key.pem");
  const block = [
    "# public declaration",
    "[profile averray-badge-receipt-signer]",
    "credential_process = /usr/local/bin/aws_signing_helper credential-process --certificate badge-cert.pem",
    "",
  ].join("\n");
  await writeFile(declaration, block);
  await writeFile(config, `[profile existing]\nvalue = kept\n\n${block}`);
  await writeFile(certificate, "certificate");
  await writeFile(privateKey, "private-key");
  await chmod(certificate, 0o400);
  await chmod(privateKey, 0o400);
  return { declaration, config, certificate, privateKey };
}

function run(paths) {
  return spawnSync(
    "bash",
    [SCRIPT, paths.declaration, paths.config, paths.certificate, paths.privateKey],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PREFLIGHT_NO_SUDO: "1",
        PREFLIGHT_EXPECTED_OWNER_MODE: `${process.getuid()}:${process.getgid()} 400`,
      },
    },
  );
}

test("badge receipt signer preflight accepts the exact declared profile and consumer files", async () => {
  const paths = await fixture();
  const result = run(paths);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /preflight passed/u);
});

test("badge receipt signer preflight names a missing mounted profile before deploy", async () => {
  const paths = await fixture();
  await writeFile(paths.config, "[profile existing]\nvalue = kept\n");
  const result = run(paths);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /required profile averray-badge-receipt-signer missing or divergent/u);
  assert.match(result.stderr, /mounted aws-config/u);
});

test("badge receipt signer preflight names a missing consumer credential path", async () => {
  const paths = await fixture();
  const result = run({ ...paths, privateKey: join(tmpdir(), "definitely-missing-badge-key.pem") });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /required credential file missing or empty at consumer path/u);
});

test("badge receipt signer preflight rejects ownership or mode drift", async () => {
  const paths = await fixture();
  await chmod(paths.privateKey, 0o600);
  const result = run(paths);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must be root:root mode 0400; found/u);
});
