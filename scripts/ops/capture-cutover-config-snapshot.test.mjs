import assert from "node:assert/strict";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import test from "node:test";

const SCRIPT = new URL("./capture-cutover-config-snapshot.sh", import.meta.url).pathname;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cutover-config-snapshot-"));
  const stack = join(root, "srv", "agent-stack");
  const runtime = join(root, "run", "agent-stack");
  const config = join(root, "etc", "agent-stack");
  const roles = join(config, "roles-anywhere");
  const backups = join(root, "backups");
  const work = join(root, "work");
  await Promise.all([stack, runtime, config, roles, backups, work].map((path) => mkdir(path, { recursive: true })));

  const files = new Map([
    [join(stack, "docker-compose.yml"), "services: {}\n"],
    [join(stack, "Caddyfile"), "api.example.test { respond 200 }\n"],
    [join(stack, ".env"), "POSTGRES_PASSWORD=stack-secret\n"],
    [join(runtime, "backend.env"), "AUTH_SECRET=backend-secret\n"],
    [join(runtime, "indexer.env"), "DATABASE_URL=postgres://indexer-secret\n"],
    [join(config, "op-backend.env"), "OP_SERVICE_ACCOUNT_TOKEN=backend-token\n"],
    [join(config, "op-indexer.env"), "OP_SERVICE_ACCOUNT_TOKEN=indexer-token\n"],
    [join(config, "aws-config"), "[profile signer]\nregion=test\n"],
    [join(roles, "signer-key.pem"), "private-key-material\n"],
  ]);
  await Promise.all([...files].map(([path, content]) => writeFile(path, content, { mode: 0o600 })));
  return { root, stack, runtime, config, backups, work };
}

test("captures required config encrypted at rest and verifies the archive", async () => {
  const paths = await fixture();
  const passphrase = "test-only-passphrase-with-at-least-thirty-two-characters";
  const result = spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    input: `${passphrase}\n`,
    env: {
      ...process.env,
      STACK_ROOT: paths.stack,
      RUNTIME_ROOT: paths.runtime,
      CONFIG_ROOT: paths.config,
      BACKUP_DIR: paths.backups,
      WORK_ROOT: paths.work,
      TIMESTAMP: "20260714-180000",
      KDF_ITERATIONS: "100000",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /integrity=verified/u);
  assert.match(result.stdout, /restore_check=verified/u);
  const archive = join(paths.backups, "testnet-config-20260714-180000.tar.gz.aes256");
  const bytes = await readFile(archive);
  assert.equal(bytes.subarray(0, 8).toString("ascii"), "Salted__");
  assert.equal(bytes.includes(Buffer.from("backend-secret")), false);
  assert.equal((await stat(archive)).mode & 0o777, 0o600);

  const decrypted = spawnSync(
    "bash",
    ["-c", `openssl enc -d -aes-256-cbc -pbkdf2 -md sha256 -iter 100000 -pass stdin -in "$1" | tar -tzf -`, "bash", archive],
    { encoding: "utf8", input: `${passphrase}\n` },
  );
  assert.equal(decrypted.status, 0, decrypted.stderr);
  assert.match(decrypted.stdout, /cutover-snapshot-manifest\.txt/u);
  assert.match(decrypted.stdout, /backend\.env/u);
  assert.match(decrypted.stdout, /roles-anywhere\/signer-key\.pem/u);
});

test("fails before writing when a required runtime env is absent", async () => {
  const paths = await fixture();
  await chmod(join(paths.runtime, "indexer.env"), 0o600);
  const result = spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    input: "test-only-passphrase-with-at-least-thirty-two-characters\n",
    env: {
      ...process.env,
      STACK_ROOT: join(paths.root, "missing-stack"),
      RUNTIME_ROOT: paths.runtime,
      CONFIG_ROOT: paths.config,
      BACKUP_DIR: paths.backups,
      WORK_ROOT: paths.work,
      KDF_ITERATIONS: "100000",
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Required cutover snapshot path is missing/u);
});
