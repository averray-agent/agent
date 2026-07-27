import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const flipScript = resolve(here, "flip-caddy-network.sh");

async function writeExecutable(path, contents) {
  await writeFile(path, contents);
  await chmod(path, 0o755);
}

async function makeFlipFixture(publicChainId) {
  const dir = await mkdtemp(join(tmpdir(), "caddy-cutover-live-"));
  const bin = join(dir, "bin");
  const live = join(dir, "Caddyfile");
  const state = join(dir, "caddy-network-selection.json");
  const lock = join(dir, "cutover.lock");
  await mkdir(bin);
  await writeFile(
    live,
    "api.averray.com {\n  reverse_proxy backend:8787\n}\nindex.averray.com {\n  reverse_proxy indexer:42069\n}\n",
  );
  await writeExecutable(join(bin, "docker"), "#!/usr/bin/env bash\nexit 0\n");
  await writeExecutable(join(bin, "flock"), "#!/usr/bin/env bash\nexit 0\n");
  await writeExecutable(join(bin, "chmod"), "#!/usr/bin/env bash\nexit 0\n");
  await writeExecutable(join(bin, "chown"), "#!/usr/bin/env bash\nexit 0\n");
  await writeExecutable(
    join(bin, "curl"),
    `#!/usr/bin/env bash
case "\${*: -1}" in
  http://127.0.0.1:18787/health) printf '%s\\n' '{"status":"ok","auth":{"chainId":420420419}}' ;;
  http://127.0.0.1:8787/health) printf '%s\\n' '{"status":"ok","auth":{"chainId":420420417}}' ;;
  *) printf '%s\\n' '{"status":"ok","auth":{"chainId":${publicChainId}}}' ;;
esac
`,
  );
  return { dir, bin, live, state, lock };
}

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

test("chain assertion still precedes the durable selector write and write failure rolls back", async () => {
  const source = await readFile(flipScript, "utf8");
  const publicGuardAt = source.indexOf("Public health did not report chainId");
  const stateWriteAt = source.indexOf('run-caddy-network-selection.sh" set');
  const writeFailureAt = source.indexOf("Durable Caddy network selection write failed");

  assert.ok(publicGuardAt >= 0, "public chain-ID assertion must remain present");
  assert.ok(stateWriteAt > publicGuardAt, "selection becomes durable only after the public chain assertion");
  assert.ok(writeFailureAt > stateWriteAt, "selection write failure path must remain explicit");
  assert.match(
    source.slice(stateWriteAt, writeFailureAt),
    /rollback/u,
    "a failed durable write must restore the original live route",
  );
});

test("status reports the durable selection alongside the live Caddy route", async () => {
  const source = await readFile(flipScript, "utf8");
  assert.match(source, /TARGET" == "status"/u);
  assert.match(source, /run-caddy-network-selection\.sh" status/u);
  assert.match(source, /publicChainId/u);
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

test("guarded live flip persists an auditable mainnet selection only after success", async () => {
  const fixture = await makeFlipFixture(420420419);
  const inodeBefore = (await stat(fixture.live)).ino;
  const run = spawnSync("bash", [flipScript, "mainnet"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fixture.bin}:${process.env.PATH}`,
      CADDYFILE: fixture.live,
      CADDY_CONTAINER: "fake-caddy",
      CADDY_NETWORK_STATE_FILE: fixture.state,
      LOCK_FILE: fixture.lock,
      PUBLIC_HEALTH_URL: "https://public.invalid/health",
      CUTOVER_ACTOR: "codex:authorized-by-pascal",
      CUTOVER_OPERATION_ID: "live-proof-mainnet-1",
      CUTOVER_REASON: "test guarded mainnet durability",
    },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal((await stat(fixture.live)).ino, inodeBefore);
  assert.match(await readFile(fixture.live, "utf8"), /mainnet-backend:8787/u);
  const record = JSON.parse(await readFile(fixture.state, "utf8"));
  assert.equal(record.network, "mainnet");
  assert.equal(record.expectedChainId, 420420419);
  assert.equal(record.selectedBy, "codex:authorized-by-pascal");
  assert.equal(record.operationId, "live-proof-mainnet-1");
  assert.match(run.stdout, /public_chain_id=420420419/u);
});

test("public chain mismatch restores testnet and leaves no false durable selection", async () => {
  const fixture = await makeFlipFixture(420420417);
  const original = await readFile(fixture.live, "utf8");
  const run = spawnSync("bash", [flipScript, "mainnet"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fixture.bin}:${process.env.PATH}`,
      CADDYFILE: fixture.live,
      CADDY_CONTAINER: "fake-caddy",
      CADDY_NETWORK_STATE_FILE: fixture.state,
      LOCK_FILE: fixture.lock,
      PUBLIC_HEALTH_URL: "https://public.invalid/health",
      CUTOVER_ACTOR: "codex:authorized-by-pascal",
    },
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Public health did not report chainId 420420419; original route restored/u);
  assert.equal(await readFile(fixture.live, "utf8"), original);
  await assert.rejects(readFile(fixture.state, "utf8"), /ENOENT/u);
});
