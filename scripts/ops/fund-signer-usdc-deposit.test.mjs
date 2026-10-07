// Tests for scripts/ops/fund-signer-usdc-deposit.mjs.
//
// Two layers:
//   1. Pure parseArgs unit tests — argument parsing matrix.
//   2. CLI-level error-path tests — spawn the script and assert the
//      KMS-mode validation errors surface before any network/AWS call.
//
// Neither layer hits AWS or the chain. The full happy path is exercised
// indirectly by run-hosted-worker-loop integration smoke tests; locally
// the dry-run is the regression contract.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { parseArgs, selectRpcUrl } from "./fund-signer-usdc-deposit.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = resolve(here, "fund-signer-usdc-deposit.mjs");

test("parseArgs: dry-run is the default and useKms is off", () => {
  const args = parseArgs([]);
  assert.equal(args.dryRun, true);
  assert.equal(args.useKms, false);
  assert.equal(args.amount, undefined);
});

// The profile default was "testnet", correct until the 2026-07-27 mainnet cutover
// and silently wrong afterwards — on 2026-08-11 it aimed a live deposit at the
// testnet AgentAccountCore, and only a zero balance stopped it. A script that moves
// money must refuse rather than guess a network.
test("parseArgs: there is NO default profile — a money script must not guess a network", () => {
  assert.equal(parseArgs([]).profile, undefined);
  assert.equal(parseArgs(["--amount", "10000000", "--commit"]).profile, undefined);
});

test("parseArgs: --commit flips dryRun off", () => {
  const args = parseArgs(["--commit", "--amount", "10000000"]);
  assert.equal(args.dryRun, false);
  assert.equal(args.useKms, false);
  assert.equal(args.amount, "10000000");
});

test("parseArgs: --use-kms is independent of --commit", () => {
  // KMS-aware dry-run: --use-kms without --commit.
  const dryRun = parseArgs(["--use-kms", "--amount", "100000"]);
  assert.equal(dryRun.useKms, true);
  assert.equal(dryRun.dryRun, true);

  // KMS-signed commit: both flags set.
  const commit = parseArgs(["--use-kms", "--commit", "--amount", "100000"]);
  assert.equal(commit.useKms, true);
  assert.equal(commit.dryRun, false);
});

test("parseArgs: --profile picks a non-default deployments file", () => {
  const args = parseArgs(["--profile", "mainnet", "--amount", "1"]);
  assert.equal(args.profile, "mainnet");
});

test("parseArgs: --expected-signer is explicit and has no default", () => {
  assert.equal(parseArgs([]).expectedSigner, undefined);
  assert.equal(
    parseArgs(["--expected-signer", "0x5a6836c6D4d293F6E5377E6c28054F4171915813"]).expectedSigner,
    "0x5a6836c6D4d293F6E5377E6c28054F4171915813"
  );
});

test("parseArgs: --help is captured even when other flags are present", () => {
  const args = parseArgs(["--commit", "--help", "--amount", "1"]);
  assert.equal(args.help, true);
});

// --- CLI-level error paths (no AWS, no chain) -----------------------------

test("CLI: --use-kms without KMS_KEY_ID exits 1 before any AWS call", () => {
  const result = spawnSync("node", [scriptPath, "--profile", "mainnet", "--amount", "1", "--use-kms"], {
    env: {
      ...process.env,
      KMS_KEY_ID: "",
      AWS_REGION: "eu-central-2",
      AWS_ACCESS_KEY_ID: "",
      AWS_SECRET_ACCESS_KEY: "",
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /--use-kms requires KMS_KEY_ID/u);
});

test("CLI: --use-kms without AWS_REGION exits 1 before any AWS call", () => {
  const result = spawnSync("node", [scriptPath, "--profile", "mainnet", "--amount", "1", "--use-kms"], {
    env: {
      ...process.env,
      KMS_KEY_ID: "alias/dummy",
      AWS_REGION: "",
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /--use-kms requires AWS_REGION/u);
});

test("CLI: --commit (no --use-kms) without PRIVATE_KEY exits 1 and hints at KMS path", () => {
  const result = spawnSync("node", [scriptPath, "--profile", "mainnet", "--amount", "1", "--commit"], {
    env: {
      ...process.env,
      PRIVATE_KEY: "",
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /PRIVATE_KEY env .* is required with --commit/u);
  assert.match(result.stderr, /Use --use-kms for KMS-backed signers/u);
});

test("CLI: --expected-signer refuses a mismatched resolved identity before chain access", () => {
  const result = spawnSync(
    "node",
    [
      scriptPath,
      "--profile", "mainnet",
      "--amount", "1",
      "--expected-signer", "0x5a6836c6D4d293F6E5377E6c28054F4171915813"
    ],
    {
      env: {
        ...process.env,
        SIGNER_ADDRESS_OVERRIDE: "0x31ad432dFe08000000000000000000000000ab7F"
      },
      encoding: "utf8"
    }
  );
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Resolved signer 0x31ad432d/u);
  assert.match(result.stderr, /Refusing before any chain read or transaction/u);
});

test("CLI: --help prints both signer backends and SIGNER_ADDRESS_OVERRIDE", () => {
  const result = spawnSync("node", [scriptPath, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--use-kms/u);
  assert.match(result.stdout, /PRIVATE_KEY/u);
  assert.match(result.stdout, /KMS_KEY_ID/u);
  assert.match(result.stdout, /AWS_REGION/u);
  assert.match(result.stdout, /SIGNER_ADDRESS_OVERRIDE/u);
  assert.match(result.stdout, /--expected-signer/u);
});

// ── RPC selection ──────────────────────────────────────────────────────
// The manifest primary can be unreachable (DNS gone, provider down). The
// script must then use a backup instead of retrying the dead endpoint until
// the workflow timeout cancels it.

const MANIFEST = { rpcUrl: "https://primary.test/", rpcBackupUrls: ["https://backup.test/"] };
const chainReply = (hex) => ({ ok: true, json: async () => ({ jsonrpc: "2.0", id: 1, result: hex }) });
const fetchBy = (table) => async (url, init) => {
  const handler = table[url];
  if (!handler) throw new Error(`unexpected url ${url}`);
  return handler(init);
};

test("selectRpcUrl: the primary wins when it answers with the right chain id", async () => {
  const calls = [];
  const chosen = await selectRpcUrl(MANIFEST, { profile: "mainnet", fetchImpl: fetchBy({
    "https://primary.test/": async () => { calls.push("primary"); return chainReply("0x190f1b43"); },
    "https://backup.test/": async () => { calls.push("backup"); return chainReply("0x190f1b43"); }
  }) });
  assert.equal(chosen.host, "primary.test");
  assert.equal(chosen.role, "primary");
  assert.equal(chosen.chainId, 420420419);
  assert.deepEqual(calls, ["primary"]);
});

test("selectRpcUrl: a primary that cannot be reached falls through to the backup", async () => {
  const chosen = await selectRpcUrl(MANIFEST, { profile: "mainnet", fetchImpl: fetchBy({
    "https://primary.test/": async () => { throw new TypeError("fetch failed"); },
    "https://backup.test/": async () => chainReply("0x190f1b43")
  }) });
  assert.equal(chosen.host, "backup.test");
  assert.equal(chosen.role, "backup");
});

test("selectRpcUrl: a primary on the wrong chain is skipped, not trusted", async () => {
  const chosen = await selectRpcUrl(MANIFEST, { profile: "mainnet", fetchImpl: fetchBy({
    "https://primary.test/": async () => chainReply("0x190f1b41"),
    "https://backup.test/": async () => chainReply("0x190f1b43")
  }) });
  assert.equal(chosen.host, "backup.test");
});

test("selectRpcUrl: a primary that never answers is abandoned at the deadline", async () => {
  // AbortSignal.timeout() uses an unref'd timer. A real fetch keeps the loop
  // alive while it waits; this stub does not, so hold the loop open ourselves.
  const keepAlive = setInterval(() => {}, 10);
  let deadlineSeen = false;
  try {
    const chosen = await selectRpcUrl(MANIFEST, { profile: "mainnet", timeoutMs: 50, fetchImpl: fetchBy({
      "https://primary.test/": (init) => new Promise((_, reject) => {
        deadlineSeen = init.signal instanceof AbortSignal;
        init.signal?.addEventListener("abort", () => reject(init.signal.reason));
        setTimeout(() => reject(new Error("stub gave up: no deadline was passed")), 500).unref();
      }),
      "https://backup.test/": async () => chainReply("0x190f1b43")
    }) });
    assert.equal(chosen.host, "backup.test");
    assert.equal(deadlineSeen, true, "the request must carry an abort deadline");
  } finally {
    clearInterval(keepAlive);
  }
});

test("selectRpcUrl: when every endpoint fails it throws and names each host", async () => {
  await assert.rejects(
    selectRpcUrl(MANIFEST, { profile: "mainnet", fetchImpl: fetchBy({
      "https://primary.test/": async () => { throw new TypeError("fetch failed"); },
      "https://backup.test/": async () => ({ ok: false, status: 503, json: async () => ({}) })
    }) }),
    /No RPC endpoint answered for mainnet: primary\.test: fetch failed; backup\.test: HTTP 503/u
  );
});

test("selectRpcUrl: an unknown profile is refused before any request", async () => {
  let called = false;
  await assert.rejects(
    selectRpcUrl(MANIFEST, { profile: "devnet", fetchImpl: async () => { called = true; return chainReply("0x1"); } }),
    /unknown deployment profile: devnet/u
  );
  assert.equal(called, false);
});

test("script: the provider is built with a fixed chain id, never a bare JsonRpcProvider(url)", async () => {
  const source = await import("node:fs/promises").then((fs) => fs.readFile(scriptPath, "utf8"));
  assert.match(source, /new JsonRpcProvider\(rpc\.url, rpc\.chainId, \{ staticNetwork: true \}\)/u);
  assert.doesNotMatch(source, /new JsonRpcProvider\(rpcUrl\)/u);
});

