import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

import { buildSelection, writeSelectionAtomic } from "./caddy-network-selection.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const script = join(repoRoot, "scripts/ops/render-caddyfile.sh");

const USER = "operator";
// Shape-valid bcrypt hash; the renderer only checks the $2a$/$2b$/$2y$ prefix.
const HASH = "$2a$14$C6UzMDM.H6dfI/f/IKcEe.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

async function render(env, network = "testnet") {
  const dir = await mkdtemp(join(tmpdir(), "render-caddyfile-"));
  const out = join(dir, "Caddyfile");
  const state = join(dir, "caddy-network-selection.json");
  writeSelectionAtomic(state, buildSelection({
    network,
    previousNetwork: network,
    selectedAt: "2026-07-27T10:00:00.000Z",
    selectedBy: "render-test",
    executionUser: "test",
    host: "test.invalid",
    source: "render-caddyfile.test.mjs",
    sourceRevision: "a".repeat(40),
    operationId: `render-${network}`,
    reason: "renderer regression test",
  }));
  try {
    const result = await execFileAsync(script, [out], {
      env: { ...process.env, CADDY_NETWORK_STATE_FILE: state, ...env },
    });
    return { out, dir, contents: await readFile(out, "utf8"), stderr: result.stderr };
  } finally {
    // Caller reads `contents`, so the file itself is no longer needed.
    await rm(dir, { recursive: true, force: true });
  }
}

test("omits the basic-auth block when no credentials are supplied", async () => {
  const { contents } = await render({
    APP_BASIC_AUTH_USER: "",
    APP_BASIC_AUTH_PASSWORD_HASH: "",
  });
  assert.ok(!contents.includes("basic_auth"), "expected no basic_auth directive");
  assert.match(contents, /^app\.averray\.com \{$/m, "operator app block should still render");
});

test("renders mainnet upstreams from the durable selector even though the template is testnet", async () => {
  const { contents } = await render({
    APP_BASIC_AUTH_USER: "",
    APP_BASIC_AUTH_PASSWORD_HASH: "",
  }, "mainnet");
  assert.match(contents, /reverse_proxy mainnet-backend:8787/u);
  assert.match(contents, /reverse_proxy mainnet-indexer:42069/u);
  assert.doesNotMatch(contents, /reverse_proxy backend:8787/u);
  assert.doesNotMatch(contents, /reverse_proxy indexer:42069/u);
});

test("node-less host fallback keeps every selector file inside the mounted stack", async () => {
  const dir = await mkdtemp(join(tmpdir(), "render-fallback-"));
  const stackRoot = dir;
  const fakeBin = join(dir, "bin");
  const out = join(dir, "Caddyfile");
  const state = join(dir, "caddy-network-selection.json");
  const dockerLog = join(dir, "docker-args.txt");
  await mkdir(fakeBin);
  writeSelectionAtomic(state, buildSelection({
    network: "mainnet",
    previousNetwork: "testnet",
    selectedAt: "2026-07-27T11:00:00.000Z",
    selectedBy: "fallback-test",
    executionUser: "test",
    host: "test.invalid",
    source: "render-caddyfile.test.mjs",
    sourceRevision: "b".repeat(40),
    operationId: "render-fallback-mainnet",
    reason: "prove the node-less production path",
  }));
  await writeFile(join(fakeBin, "docker"), `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$@" > "$FAKE_DOCKER_LOG"
while [[ "$#" -gt 0 && "$1" != "node" ]]; do shift; done
[[ "$#" -gt 0 ]] || exit 9
shift
exec "$FAKE_NODE" "$@"
`);
  await chmod(join(fakeBin, "docker"), 0o755);

  try {
    await execFileAsync("/bin/bash", [script, out], {
      env: {
        ...process.env,
        PATH: `${fakeBin}:/usr/bin:/bin:/usr/sbin:/sbin`,
        STACK_ROOT: stackRoot,
        FAKE_DOCKER_LOG: dockerLog,
        FAKE_NODE: process.execPath,
        CADDY_NETWORK_STATE_FILE: state,
        APP_BASIC_AUTH_USER: "",
        APP_BASIC_AUTH_PASSWORD_HASH: "",
      },
    });
    assert.match(await readFile(out, "utf8"), /reverse_proxy mainnet-backend:8787/u);
    const args = await readFile(dockerLog, "utf8");
    assert.match(args, new RegExp(stackRoot.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
    assert.match(args, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("injects the basic-auth block when both credentials are supplied", async () => {
  const { contents } = await render({
    APP_BASIC_AUTH_USER: USER,
    APP_BASIC_AUTH_PASSWORD_HASH: HASH,
  });
  assert.match(contents, /basic_auth @protectedOperatorShell bcrypt "Averray Operator"/);
  assert.ok(contents.includes(`${USER} ${HASH}`), "expected the user + hash pair inline");
  // The gate has always excluded the proxy paths — it only ever covered the
  // static shell, never the API the browser talks to.
  assert.match(contents, /not path \/api\/\* \/index\/\*/);
});

test("APP_PUBLIC_SHELL renders public even when credentials are present", async () => {
  const { contents, stderr } = await render({
    APP_PUBLIC_SHELL: "1",
    APP_BASIC_AUTH_USER: USER,
    APP_BASIC_AUTH_PASSWORD_HASH: HASH,
  });
  assert.ok(!contents.includes("basic_auth"), "public shell must not carry a basic_auth directive");
  assert.ok(!contents.includes(HASH), "the hash must not leak into a public render");
  assert.match(stderr, /ignoring the supplied basic-auth credentials/);
});

test("APP_PUBLIC_SHELL=0 keeps the gate on", async () => {
  const { contents } = await render({
    APP_PUBLIC_SHELL: "0",
    APP_BASIC_AUTH_USER: USER,
    APP_BASIC_AUTH_PASSWORD_HASH: HASH,
  });
  assert.match(contents, /basic_auth @protectedOperatorShell/);
});

test("rejects an unrecognised APP_PUBLIC_SHELL rather than guessing", async () => {
  await assert.rejects(
    render({ APP_PUBLIC_SHELL: "maybe" }),
    (error) => /Invalid APP_PUBLIC_SHELL/.test(error.stderr ?? ""),
  );
});

test("still refuses a raw password in every mode", async () => {
  for (const extra of [{}, { APP_PUBLIC_SHELL: "1" }]) {
    await assert.rejects(
      render({ ...extra, APP_BASIC_AUTH_PASSWORD: "hunter2" }),
      (error) => /APP_BASIC_AUTH_PASSWORD \(raw\) is set/.test(error.stderr ?? ""),
      `raw password should be rejected with ${JSON.stringify(extra)}`,
    );
  }
});

test("half-set credentials remain an error when the gate is on", async () => {
  await assert.rejects(
    render({ APP_BASIC_AUTH_USER: USER, APP_BASIC_AUTH_PASSWORD_HASH: "" }),
    (error) => /APP_BASIC_AUTH_PASSWORD_HASH is required/.test(error.stderr ?? ""),
  );
  await assert.rejects(
    render({ APP_BASIC_AUTH_USER: "", APP_BASIC_AUTH_PASSWORD_HASH: HASH }),
    (error) => /APP_BASIC_AUTH_USER is required/.test(error.stderr ?? ""),
  );
});
