#!/usr/bin/env node
//
// check-mainnet-deploy-readiness.mjs — PRE-deploy dry-run for the mainnet launch sprint.
//
// audit-launch-readiness.mjs is the POST-deploy on-chain gate (reads roles/selectors
// off deployed contracts — it can't run before the ceremony exists). This is its
// pre-deploy sibling: it checks everything that IS knowable before the deploy sprint
// so the sprint is rehearsable on paper before the audit clears, and flags what's
// still pending. Purely read-only; deploys nothing.
//
// Sections:
//   A. Chain target      — mainnet eth-rpc reachable + chainId 420420419 + ADVANCING
//                          + USDC precompile answering (is the target chain up?)
//   B. Config readiness  — mainnet env example + the [Claude] GAP scripts + closing-proof
//                          scripts present; mainnet.env.example identity literals correct;
//                          ⛔ SAFETY: warn if DAILY_OUTFLOW_CAP is armed finite (audit-2 H-1)
//   C. Deploy sprint     — the LAUNCH_CRITICAL_PATH deploy-sprint steps as READY / PENDING
//
// Raw JSON-RPC over global fetch (no ethers). Exit 0 = report produced; 1 = the mainnet
// chain target is unreachable or wrong-chain (a real blocker); 2 = usage error.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const MAINNET = {
  chainId: 420420419,
  rpc: "https://eth-rpc.polkadot.io/",
  usdc: "0x0000053900000000000000000000000001200000", // USDC precompile, 6dp (same as testnet)
  usdcDecimals: 6,
};
const MAX_BLOCK_AGE_S = 300;

// [Claude]/ceremony config artifacts the sprint depends on.
export const REQUIRED_ARTIFACTS = [
  { path: "deployments/mainnet.env.example", label: "mainnet env example (identity + launch econ params)" },
  { path: "deploy/backend.mainnet.env.template", label: "backend mainnet op:// template (render-mainnet-backend-env.mjs)" },
  { path: "deploy/indexer.mainnet.env.template", label: "indexer mainnet op:// template" },
  { path: "scripts/ops/render-mainnet-backend-env.mjs", label: "GAP: env-template generator" },
  { path: "scripts/ops/bootstrap-mainnet-vault.mjs", label: "GAP: 1Password vault/token bootstrap planner" },
  { path: "scripts/ops/check-mainnet-env-secrets-proof.mjs", label: "closing proof: env-secrets" },
  { path: "scripts/ops/check-mainnet-usdc-config.mjs", label: "closing proof: usdc-config" },
  { path: "scripts/ops/audit-launch-readiness.mjs", label: "post-deploy on-chain gate (step D-4)" },
];
// Produced only by the deploy ceremony — absence is EXPECTED pre-deploy (Codex/ceremony).
export const CEREMONY_ARTIFACTS = [
  { path: "deployments/mainnet.json", label: "deployed contract addresses (deploy ceremony output)" },
  { path: "deployments/mainnet-multisig-owner.json", label: "mapped multisig owner record (ceremony output)" },
];

// ── pure helpers (unit-tested) ────────────────────────────────────────────

export function parseEnvText(text) {
  const out = {};
  for (const line of String(text).split("\n")) {
    if (/^\s*#/.test(line)) continue;
    const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

/** A finite, non-zero DAILY_OUTFLOW_CAP is the audit-2 H-1 footgun (self-DoS pre-H-1). */
export function classifyOutflowCap(value) {
  if (value === undefined || value === "" || value === "0") return { armed: false, note: "unset/0 — safe (no finite cap)" };
  if (!/^\d+$/.test(value)) return { armed: false, note: `non-numeric (${value})` };
  return { armed: true, note: `${value} base units — ⛔ DO NOT ARM until audit-2 H-1 (outflow-breaker rewire) is DEPLOYED; a finite cap self-DoSes settlement` };
}

export function hexToBigInt(hex) {
  if (typeof hex !== "string" || !hex.startsWith("0x")) throw new Error(`not a hex quantity: ${hex}`);
  return BigInt(hex);
}
export const TOTAL_SUPPLY_CALLDATA = "0x18160ddd";

export function classifyAdvance(b1, b2) {
  return b2 > b1
    ? { advancing: true, detail: `advancing (${b1} → ${b2})` }
    : { advancing: false, detail: `NOT advancing: frozen at ${b2}` };
}

// ── live chain-target probe ───────────────────────────────────────────────

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

export async function runChainTarget({ rpc: url = MAINNET.rpc, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const checks = [];
  let reachable = false;
  try {
    const id = Number(hexToBigInt(await rpc(fetchImpl, url, "eth_chainId", [])));
    reachable = id === MAINNET.chainId;
    checks.push({ name: "chainId", status: reachable ? "pass" : "fail", detail: reachable ? `${id} ✓` : `${id} — expected ${MAINNET.chainId} (wrong endpoint/chain)` });
  } catch (err) {
    checks.push({ name: "chainId", status: "fail", detail: `mainnet rpc unreachable: ${err.message}` });
    return { checks, chainReady: false };
  }
  try {
    const b1 = Number(hexToBigInt((await rpc(fetchImpl, url, "eth_getBlockByNumber", ["latest", false])).number));
    await sleep(9000);
    const b2 = Number(hexToBigInt((await rpc(fetchImpl, url, "eth_getBlockByNumber", ["latest", false])).number));
    const adv = classifyAdvance(b1, b2);
    checks.push({ name: "advancing", status: adv.advancing ? "pass" : "fail", detail: adv.detail });
  } catch (err) {
    checks.push({ name: "advancing", status: "fail", detail: `block read failed: ${err.message}` });
  }
  try {
    const raw = hexToBigInt(await rpc(fetchImpl, url, "eth_call", [{ to: MAINNET.usdc, data: TOTAL_SUPPLY_CALLDATA }, "latest"]));
    checks.push({ name: "usdc_precompile", status: raw >= 0n ? "pass" : "fail", detail: `answers (totalSupply readable)` });
  } catch (err) {
    checks.push({ name: "usdc_precompile", status: "fail", detail: `USDC precompile unreachable: ${err.message}` });
  }
  const chainReady = checks.every((c) => c.status === "pass");
  return { checks, chainReady };
}

// ── config readiness (static) ─────────────────────────────────────────────

export function runConfigReadiness({ readFile = (p) => readFileSync(join(REPO_ROOT, p), "utf8"), exists = (p) => existsSync(join(REPO_ROOT, p)) } = {}) {
  const checks = [];
  for (const a of REQUIRED_ARTIFACTS) {
    checks.push({ name: a.path, status: exists(a.path) ? "pass" : "fail", detail: exists(a.path) ? a.label : `MISSING — ${a.label}` });
  }
  // mainnet.env.example identity literals + the outflow-cap safety check
  if (exists("deployments/mainnet.env.example")) {
    const env = parseEnvText(readFile("deployments/mainnet.env.example"));
    const idOk = env.AUTH_CHAIN_ID === String(MAINNET.chainId);
    checks.push({ name: "env:AUTH_CHAIN_ID", status: idOk ? "pass" : "fail", detail: idOk ? `${env.AUTH_CHAIN_ID} ✓` : `${env.AUTH_CHAIN_ID} — expected ${MAINNET.chainId}` });
    const rpcOk = (env.RPC_URL || "").includes("eth-rpc.polkadot.io") && !(env.RPC_URL || "").includes("testnet");
    checks.push({ name: "env:RPC_URL", status: rpcOk ? "pass" : "fail", detail: env.RPC_URL || "(unset)" });
    const cap = classifyOutflowCap(env.DAILY_OUTFLOW_CAP);
    checks.push({ name: "env:DAILY_OUTFLOW_CAP", status: cap.armed ? "warn" : "pass", detail: cap.note });
  }
  return checks;
}

// ── deploy-sprint checklist (READY / PENDING) ─────────────────────────────

export function deploySprintChecklist({ chainReady, configReady, mainnetJsonExists }) {
  const R = (ready, step, note) => ({ step, ready, note });
  return [
    R(chainReady, "chain target live (mainnet eth-rpc advancing, chainId 420420419, USDC up)", chainReady ? "" : "mainnet rpc unreachable/frozen"),
    R(configReady, "mainnet env template + [Claude] GAP scripts present", configReady ? "" : "some config artifact missing (see section B)"),
    R(false, "audited build (MAIN-006 + audit-2 H-1/H-2 DEPLOYED) + auditor re-verification", "the long pole — Codex fixes in the frozen build, then paid re-verify"),
    R(mainnetJsonExists, "deployments/mainnet.json (5 contracts deployed, burnable deployer)", mainnetJsonExists ? "" : "deploy ceremony — Codex/ceremony (needs the audited build)"),
    R(false, "ownership → multisig; deployer holds zero roles; key burned", "deploy ceremony"),
    R(false, "role ceremonies (split roles per #724: settlementBroker / agentTransferBroker / reputationWriter / outflowRecorder; strategySettler ungranted while XCM off)", "2-of-3 asMulti; needs multisig + KMS + Roles-Anywhere provisioned"),
    R(false, "1Password mainnet vaults + 4 SA tokens (run bootstrap-mainnet-vault.mjs)", "needs DEC-5 (vault topology) + an op admin session"),
    R(false, "mainnet env rendered + 3 closing proofs (env-secrets / usdc-config / smoke <24h)", "needs the vault items + deployments/mainnet.json"),
    R(false, "DAILY_OUTFLOW_CAP kept UNARMED until H-1 deployed", "safety gate — do not set a finite cap pre-H-1"),
    R(false, "signer funded with real low-value USDC → ≥3 live claim→submit→verify→settle loops → LIVE", "final step, real funds"),
  ];
}

// ── CLI ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--rpc") args.rpc = argv[++i];
    else if (a === "--json") args.json = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else throw new Error(`unknown flag: ${a}`);
  }
  return args;
}

const HELP = `check-mainnet-deploy-readiness.mjs — pre-deploy dry-run for the mainnet launch sprint (read-only).

  --rpc <url>   override the mainnet eth-rpc (default ${MAINNET.rpc})
  --json        machine-readable output
Exit: 0 = report produced, 1 = chain target unreachable/wrong-chain, 2 = usage.`;

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  if (args.help) return void console.log(HELP);

  const chain = await runChainTarget({ rpc: args.rpc });
  const config = runConfigReadiness();
  const configReady = config.every((c) => c.status !== "fail");
  const mainnetJsonExists = existsSync(join(REPO_ROOT, "deployments/mainnet.json"));
  const sprint = deploySprintChecklist({ chainReady: chain.chainReady, configReady, mainnetJsonExists });

  const result = { chain: chain.checks, config, sprint, chainReady: chain.chainReady, configReady };
  if (args.json) { console.log(JSON.stringify(result, null, 2)); process.exit(chain.chainReady ? 0 : 1); }

  const icon = (s) => (s === "pass" ? "✅" : s === "warn" ? "⚠️ " : "❌");
  console.log(`\n# Mainnet deploy-readiness dry-run (pre-deploy, read-only)\n`);
  console.log(`## A · Chain target  (${MAINNET.rpc})`);
  for (const c of chain.checks) console.log(`  ${icon(c.status)} ${c.name.padEnd(16)} ${c.detail}`);
  console.log(`\n## B · Config readiness (in-repo artifacts + mainnet.env.example)`);
  for (const c of config) console.log(`  ${icon(c.status)} ${c.name.padEnd(42)} ${c.detail}`);
  console.log(`  ·  ceremony outputs (absence EXPECTED pre-deploy):`);
  for (const a of CEREMONY_ARTIFACTS) console.log(`     ${existsSync(join(REPO_ROOT, a.path)) ? "✅" : "⏳"} ${a.path.padEnd(40)} ${a.label}`);
  console.log(`\n## C · Deploy sprint  (rehearsable checklist)`);
  const ready = sprint.filter((s) => s.ready).length;
  for (const s of sprint) console.log(`  ${s.ready ? "✅ READY  " : "⏳ PENDING"} ${s.step}${s.note ? `\n              └ ${s.note}` : ""}`);
  console.log(`\n▶ ${ready}/${sprint.length} sprint steps ready. The long pole is the AUDIT (re-verify a build containing the deployed`);
  console.log(`  MAIN-006 + audit-2 H-1/H-2 fixes). Everything above the audit line parallelizes and is Paseo-independent.`);
  console.log(`  On-chain role/selector checks run POST-deploy via: node scripts/ops/audit-launch-readiness.mjs --profile mainnet`);
  process.exit(chain.chainReady ? 0 : 1);
}

const isCli = process.argv[1] && process.argv[1].endsWith("check-mainnet-deploy-readiness.mjs");
if (isCli) main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
