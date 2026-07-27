import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const flipScript = resolve(here, "flip-caddy-network.sh");

function callLibraryFunction(name, ...args) {
  execFileSync(
    "bash",
    [
      "-c",
      `set -euo pipefail
       export FLIP_CADDY_NETWORK_LIBRARY_ONLY=1
       source "$1"
       shift
       ${name} "$@"`,
      "bash",
      flipScript,
      ...args
    ],
    { stdio: "pipe" }
  );
}

test("candidate validation precedes the in-place install and reload", async () => {
  const source = await readFile(flipScript, "utf8");
  const validateAt = source.indexOf(
    'caddy validate --config "$container_candidate" --adapter caddyfile'
  );
  const installAt = source.indexOf(
    'install_caddy_candidate_in_place "$candidate" "$CADDYFILE"'
  );
  const reloadAt = source.indexOf(
    'caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile'
  );

  assert.ok(validateAt >= 0, "candidate validation must remain present");
  assert.ok(installAt > validateAt, "candidate must be validated before install");
  assert.ok(reloadAt > installAt, "Caddy must reload after the in-place install");
});

test("in-place install preserves the mounted inode and changes content", async () => {
  const dir = await mkdtemp(join(tmpdir(), "caddy-cutover-install-"));
  const live = join(dir, "Caddyfile");
  const candidate = join(dir, "candidate");
  await writeFile(live, "reverse_proxy backend:8787\n", "utf8");
  await writeFile(candidate, "reverse_proxy mainnet-backend:8787\n", "utf8");

  const inodeBefore = (await stat(live)).ino;
  callLibraryFunction("install_caddy_candidate_in_place", candidate, live);

  assert.equal((await stat(live)).ino, inodeBefore);
  assert.equal(await readFile(live, "utf8"), "reverse_proxy mainnet-backend:8787\n");
});

test("rollback restores the original bytes without replacing the mounted inode", async () => {
  const dir = await mkdtemp(join(tmpdir(), "caddy-cutover-rollback-"));
  const live = join(dir, "Caddyfile");
  const candidate = join(dir, "candidate");
  const backup = join(dir, "backup");
  const original = "reverse_proxy backend:8787\n";
  await writeFile(live, original, "utf8");
  await copyFile(live, backup);
  await writeFile(candidate, "reverse_proxy mainnet-backend:8787\n", "utf8");

  const inodeBefore = (await stat(live)).ino;
  callLibraryFunction("install_caddy_candidate_in_place", candidate, live);
  assert.notEqual(await readFile(live, "utf8"), original);

  callLibraryFunction("restore_caddy_backup_in_place", backup, live);
  assert.equal((await stat(live)).ino, inodeBefore);
  assert.equal(await readFile(live, "utf8"), original);
});
