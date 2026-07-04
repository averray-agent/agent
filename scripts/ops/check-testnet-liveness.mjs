#!/usr/bin/env node
//
// check-testnet-liveness.mjs — is the testnet chain ALIVE + did our state survive?
//
// Built for the Paseo V1→V2 relay cutover (Mon 6 Jul 2026 15:00 UTC): after V2
// comes up, run this to decide GO (fire the #724 redeploy / worker-loop rehearsal
// on Paseo) vs NO-GO (fall back to Westend). Also the general "is the chain frozen"
// check — right now, against the halted V1, it correctly reports NOT ADVANCING.
//
// Uses only raw JSON-RPC over global fetch (no ethers / node_modules) so it runs in
// a bare cloud-scheduled environment as well as locally.
//
// Checks (top-line GO/NO-GO = the chain is alive + usable):
//   1. RPC reachable + eth_chainId matches the expected id
//   2. Block ADVANCING (two reads with a gap; not just height>0 — the halt lesson)
//   3. USDC precompile answers (totalSupply) — the settlement asset infra is up
// Plus a STATE-SURVIVAL report (shapes what we do, doesn't block GO):
//   - eth_getCode present at each deployments/<profile>.json contract address
//   - deployer/verifier native (gas) + USDC balances (did funds carry over)
//
// Usage:
//   node scripts/ops/check-testnet-liveness.mjs                     # testnet (Paseo)
//   node scripts/ops/check-testnet-liveness.mjs --rpc <v2-eth-rpc>  # new V2 endpoint
//   node scripts/ops/check-testnet-liveness.mjs --profile mainnet
//   node scripts/ops/check-testnet-liveness.mjs --json             # machine-readable
//
// Exit: 0 = GO (chain alive), 1 = NO-GO, 2 = usage/config error.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// chainId is not stored in deployments/*.json; pin it here (the SIWE-critical value).
export const EXPECTED_CHAIN_ID = { testnet: 420420417, mainnet: 420420419 };
export const USDC_DECIMALS = 6;
const DEFAULT_MAX_BLOCK_AGE_S = 300; // latest-block timestamp older than this ⇒ suspicious
const DEFAULT_ADVANCE_WAIT_MS = 9000; // gap between the two block reads

// ── pure helpers (unit-tested) ───────────────────────────────────────────

export function hexToBigInt(hex) {
  if (typeof hex !== "string" || !hex.startsWith("0x")) throw new Error(`not a hex quantity: ${hex}`);
  return BigInt(hex);
}

/** eth_getCode result → is there actually deployed bytecode? ("0x"/"0x0"/empty = none). */
export function isCodePresent(code) {
  return typeof code === "string" && code.startsWith("0x") && code.replace(/^0x/, "").replace(/0+$/, "").length > 0;
}

/** balanceOf(address) calldata: selector 0x70a08231 + 32-byte left-padded address. */
export function balanceOfCalldata(address) {
  const a = String(address).toLowerCase().replace(/^0x/, "");
  if (a.length !== 40) throw new Error(`bad address: ${address}`);
  return "0x70a08231" + a.padStart(64, "0");
}
export const TOTAL_SUPPLY_CALLDATA = "0x18160ddd"; // totalSupply()

export function formatUnits(raw, decimals) {
  const neg = raw < 0n;
  const s = (neg ? -raw : raw).toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return (neg ? "-" : "") + (frac ? `${whole}.${frac}` : whole);
}

/** Decide advancement from two block reads + the latest timestamp age. */
export function classifyAdvance(block1, block2, ageSeconds, maxAgeSeconds = DEFAULT_MAX_BLOCK_AGE_S) {
  if (block2 > block1) return { advancing: true, detail: `advancing (${block1} → ${block2})` };
  return {
    advancing: false,
    detail: `NOT advancing: block frozen at ${block2}${ageSeconds != null ? ` (latest ~${Math.floor(ageSeconds / 60)}m old)` : ""} — halt or stalled node`,
  };
}

/** GO iff no critical check failed. Returns the blockers for the report. */
export function decideGoNoGo(checks) {
  const blockers = checks.filter((c) => c.critical && c.status === "fail").map((c) => c.name);
  return { go: blockers.length === 0, blockers };
}

// ── live probes ──────────────────────────────────────────────────────────

async function rpc(fetchImpl, url, method, params) {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`${method} → HTTP ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${j.error.message ?? "rpc error"}`);
  return j.result;
}

export function loadDeployment(profile, readFile = (p) => readFileSync(join(REPO_ROOT, p), "utf8")) {
  return JSON.parse(readFile(`deployments/${profile}.json`));
}

/**
 * Run every check against `rpcUrl`. fetchImpl + sleep are injected for tests.
 * Returns { profile, rpcUrl, checks[], survival[], go, blockers }.
 */
export async function runLivenessChecks({
  profile = "testnet",
  rpcUrl,
  deployment,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
  advanceWaitMs = DEFAULT_ADVANCE_WAIT_MS,
  maxAgeSeconds = DEFAULT_MAX_BLOCK_AGE_S,
}) {
  const url = rpcUrl || deployment.rpcUrl;
  const expected = EXPECTED_CHAIN_ID[profile];
  const checks = [];
  const survival = [];

  // 1 — chainId
  let chainOk = false;
  try {
    const id = Number(hexToBigInt(await rpc(fetchImpl, url, "eth_chainId", [])));
    chainOk = id === expected;
    checks.push({
      name: "chainId",
      critical: true,
      status: chainOk ? "pass" : "fail",
      detail: chainOk ? `${id} ✓` : `${id} — expected ${expected} (wrong chain / endpoint not repointed)`,
    });
  } catch (err) {
    checks.push({ name: "chainId", critical: true, status: "fail", detail: `RPC unreachable: ${err.message}` });
    // Can't reach the RPC at all → everything downstream is a fail; short-circuit.
    return finalize({ profile, url, checks, survival });
  }

  // 2 — advancing (two reads with a gap) + freshness
  try {
    const b1 = await getLatest(fetchImpl, url);
    await sleep(advanceWaitMs);
    const b2 = await getLatest(fetchImpl, url);
    const ageS = b2.timestamp != null ? Math.floor(now() / 1000) - b2.timestamp : null;
    const adv = classifyAdvance(b1.number, b2.number, ageS, maxAgeSeconds);
    checks.push({ name: "advancing", critical: true, status: adv.advancing ? "pass" : "fail", detail: adv.detail });
  } catch (err) {
    checks.push({ name: "advancing", critical: true, status: "fail", detail: `block read failed: ${err.message}` });
  }

  // 3 — USDC precompile answers
  const token = deployment.contracts?.token;
  try {
    const raw = hexToBigInt(await rpc(fetchImpl, url, "eth_call", [{ to: token, data: TOTAL_SUPPLY_CALLDATA }, "latest"]));
    checks.push({
      name: "usdc_precompile",
      critical: true,
      status: raw > 0n ? "pass" : "fail",
      detail: `totalSupply = ${formatUnits(raw, USDC_DECIMALS)} USDC${raw > 0n ? "" : " (zero — asset infra not restored?)"}`,
    });
  } catch (err) {
    checks.push({ name: "usdc_precompile", critical: true, status: "fail", detail: `USDC precompile unreachable: ${err.message}` });
  }

  // survival diagnostics (non-blocking): contract code + key balances
  for (const [name, addr] of Object.entries(deployment.contracts || {})) {
    if (!addr) continue; // e.g. xcmWrapper: null
    try {
      const code = await rpc(fetchImpl, url, "eth_getCode", [addr, "latest"]);
      survival.push({ name: `code:${name}`, status: isCodePresent(code) ? "pass" : "warn", detail: isCodePresent(code) ? `${addr} has code` : `${addr} EMPTY — state did not survive; full redeploy needed` });
    } catch (err) {
      survival.push({ name: `code:${name}`, status: "warn", detail: `getCode failed: ${err.message}` });
    }
  }
  for (const who of [["verifier", deployment.verifier], ["deployer", deployment.deployer]]) {
    const [label, addr] = who;
    if (!addr) continue;
    try {
      const gas = hexToBigInt(await rpc(fetchImpl, url, "eth_getBalance", [addr, "latest"]));
      const usdc = hexToBigInt(await rpc(fetchImpl, url, "eth_call", [{ to: token, data: balanceOfCalldata(addr) }, "latest"]));
      survival.push({ name: `balance:${label}`, status: gas > 0n ? "pass" : "warn", detail: `${label} ${addr}: gas ${formatUnits(gas, 18)}, USDC ${formatUnits(usdc, USDC_DECIMALS)}${gas > 0n ? "" : " (no gas — fund before deploy)"}` });
    } catch (err) {
      survival.push({ name: `balance:${label}`, status: "warn", detail: `balance read failed: ${err.message}` });
    }
  }

  return finalize({ profile, url, checks, survival });
}

function finalize({ profile, url, checks, survival }) {
  const { go, blockers } = decideGoNoGo(checks);
  return { profile, rpcUrl: url, checks, survival, go, blockers };
}

async function getLatest(fetchImpl, url) {
  const b = await rpc(fetchImpl, url, "eth_getBlockByNumber", ["latest", false]);
  if (!b || typeof b.number !== "string") throw new Error("no latest block");
  return { number: Number(hexToBigInt(b.number)), timestamp: typeof b.timestamp === "string" ? Number(hexToBigInt(b.timestamp)) : null };
}

// ── CLI ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { profile: "testnet", json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--profile") args.profile = argv[++i];
    else if (a === "--rpc") args.rpc = argv[++i];
    else if (a === "--json") args.json = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else throw new Error(`unknown flag: ${a}`);
  }
  return args;
}

const HELP = `check-testnet-liveness.mjs — GO/NO-GO: is the testnet chain alive + did our state survive?

  --profile <p>   deployments/<p>.json (default testnet)
  --rpc <url>     override the eth-rpc (e.g. the new Paseo V2 Asset Hub endpoint)
  --json          machine-readable output
Exit: 0 = GO (chain alive), 1 = NO-GO, 2 = config error.`;

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  if (args.help) return void console.log(HELP);
  if (!(args.profile in EXPECTED_CHAIN_ID)) {
    console.error(`unknown profile "${args.profile}" (known: ${Object.keys(EXPECTED_CHAIN_ID).join(", ")})`);
    process.exit(2);
  }

  let deployment;
  try {
    deployment = loadDeployment(args.profile);
  } catch (e) {
    console.error(`could not load deployments/${args.profile}.json: ${e.message}`);
    process.exit(2);
  }

  const result = await runLivenessChecks({ profile: args.profile, rpcUrl: args.rpc, deployment });

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`\n# Testnet liveness — profile ${result.profile}`);
    console.log(`  rpc: ${result.rpcUrl}\n`);
    console.log(`## Chain alive (GO gate)`);
    for (const c of result.checks) console.log(`  ${c.status === "pass" ? "✅" : "❌"}  ${c.name.padEnd(16)} ${c.detail}`);
    console.log(`\n## State survival (informs redeploy vs rehearse)`);
    for (const s of result.survival) console.log(`  ${s.status === "pass" ? "✅" : "⚠️ "}  ${s.name.padEnd(24)} ${s.detail}`);
    console.log(
      result.go
        ? `\n▶ GO — chain is alive. If contract code survived → rehearse on existing; if EMPTY → run the #724 redeploy.`
        : `\n■ NO-GO — blockers: ${result.blockers.join(", ")}. Chain not usable; hold or fall back to Westend (chainId 420420421).`
    );
  }
  process.exit(result.go ? 0 : 1);
}

const isCli = process.argv[1] && process.argv[1].endsWith("check-testnet-liveness.mjs");
if (isCli) main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
