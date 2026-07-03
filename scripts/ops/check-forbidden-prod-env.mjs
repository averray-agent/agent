#!/usr/bin/env node
//
// check-forbidden-prod-env.mjs — fail-closed guard for emergency-bypass env flags.
//
// Some env vars are deliberate emergency/dev hatches that must NEVER ship enabled
// in a production/mainnet environment. The backend already fails closed on the most
// dangerous of these at boot (mcp-server/src/auth/credential-check.js rejects
// JWT_KMS_CREDENTIAL_CHECK_SKIP=1 under NODE_ENV=production without an explicit
// ack). This is the earlier, cheaper guard the THREAT_MODEL ("Boot-Time
// Credential-Check Bypass" §follow-up) asks for: catch a stray enabled flag in a
// COMMITTED env artifact at PR time, before it can ever be rendered into
// /run/agent-stack/backend.env — a clean template can't produce a dirty render,
// since `op inject` only substitutes op:// refs, it never adds keys.
//
// Runs in CI with no 1Password session and no deps (Node stdlib only). Also usable
// at deploy time to scan a rendered env: `--file /run/agent-stack/backend.env`.
//
// Exit codes:
//   0  no forbidden flag is actively enabled
//   1  one or more forbidden flags are enabled (printed to stderr)
//   2  usage error

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// key → why it must never ship enabled in production/mainnet.
export const FORBIDDEN_PROD_ENV_KEYS = {
  JWT_KMS_CREDENTIAL_CHECK_SKIP:
    "emergency boot-time JWT-KMS credential-check bypass (H1). A stray enabled flag masks exactly " +
    "the misconfig the check catches — the backend boots green, then every SIWE sign-in returns 500. " +
    "Emergency use is a RUNTIME-only override (never committed), acknowledged in-process via " +
    "JWT_KMS_CREDENTIAL_CHECK_SKIP_ACK_PRODUCTION.",
  JWT_KMS_CREDENTIAL_CHECK_SKIP_ACK_PRODUCTION:
    "the production acknowledgement for the bypass above. Belongs only in a supervised, incident-scoped " +
    "runtime override — committing it enabled pre-arms the bypass so a future stray SKIP=1 ships silently.",
  AUTH_ALLOW_PERMISSIVE_BROKERING:
    "overrides the fail-closed guard that refuses permissive AUTH_MODE while the blockchain gateway is " +
    "enabled (pre-audit #7). Enabled in production would let an unauthenticated ?wallet= broker on-chain " +
    "operations as an allowlisted wallet. Local-dev only.",
};

const TRUTHY = new Set(["1", "true", "yes", "on"]);

// Committed env artifacts that must stay clean. Globs would need a dep; this
// explicit list + existsSync filter covers every committed env file and tolerates
// the mainnet templates being absent until they land.
export const DEFAULT_TARGETS = [
  "deploy/backend.env.template",
  "deploy/indexer.env.template",
  "deploy/backend.mainnet.env.template",
  "deploy/indexer.mainnet.env.template",
  "deployments/mainnet.env.example",
];

/**
 * Return every forbidden flag that is ACTIVELY (uncommented) assigned a truthy
 * value. Commented lines (documentation) and explicit disables (=0, =false, empty)
 * are fine — the point is to catch an *enabled* bypass, not to ban mentioning it.
 */
export function scanEnvText(text, source = "<input>") {
  const violations = [];
  const lines = String(text).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*#/.test(line)) continue; // comment — documentation is allowed
    const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    if (!Object.prototype.hasOwnProperty.call(FORBIDDEN_PROD_ENV_KEYS, key)) continue;
    // strip surrounding quotes + trailing inline comment isn't stripped (a value
    // with a '#' would be unusual for these boolean flags); compare the bare token.
    const value = m[2].trim().replace(/^["']|["']$/g, "").trim();
    if (TRUTHY.has(value.toLowerCase())) {
      violations.push({ source, line: i + 1, key, value, reason: FORBIDDEN_PROD_ENV_KEYS[key] });
    }
  }
  return violations;
}

function parseArgs(argv) {
  const args = { files: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--file") args.files.push(argv[++i]);
    else if (a === "--help" || a === "-h") args.help = true;
    else throw new Error(`unknown flag: ${a}`);
  }
  return args;
}

const HELP = `check-forbidden-prod-env.mjs — fail if an emergency-bypass env flag is enabled in a committed (or rendered) env file.

  (default)        scan the committed env templates + deployments/*.env.example
  --file <path>    scan an arbitrary file instead (e.g. a rendered /run/agent-stack/backend.env)

Guards: ${Object.keys(FORBIDDEN_PROD_ENV_KEYS).join(", ")}`;

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  if (args.help) {
    console.log(HELP);
    return;
  }

  const targets = args.files.length
    ? args.files.map((f) => ({ rel: f, abs: f }))
    : DEFAULT_TARGETS.map((rel) => ({ rel, abs: join(REPO_ROOT, rel) })).filter((t) => existsSync(t.abs));

  if (targets.length === 0) {
    console.error("check-forbidden-prod-env: no target files found");
    process.exit(args.files.length ? 1 : 0); // explicit --file that's missing is an error
  }

  const violations = [];
  for (const t of targets) {
    if (!existsSync(t.abs)) {
      console.error(`check-forbidden-prod-env: file not found: ${t.rel}`);
      process.exit(1);
    }
    violations.push(...scanEnvText(readFileSync(t.abs, "utf8"), t.rel));
  }

  if (violations.length) {
    console.error(`check-forbidden-prod-env: ${violations.length} forbidden flag(s) enabled:`);
    for (const v of violations) {
      console.error(`  ERR   ${v.source}:${v.line}: ${v.key}=${v.value} is forbidden`);
      console.error(`        ${v.reason}`);
    }
    console.error(`\n  These are emergency/dev hatches. Remove them from committed env files; if a supervised`);
    console.error(`  emergency truly needs one, set it as a runtime-only override at deploy time, not here.`);
    process.exit(1);
  }

  console.log(`check-forbidden-prod-env: ok`);
  console.log(`    files scanned: ${targets.length}  (${targets.map((t) => t.rel).join(", ")})`);
  console.log(`    guarded keys:  ${Object.keys(FORBIDDEN_PROD_ENV_KEYS).length}`);
}

const isCli = process.argv[1] && process.argv[1].endsWith("check-forbidden-prod-env.mjs");
if (isCli) main();
