#!/usr/bin/env node
//
// check-template-matches-manifest.mjs — CI guard for Phase 2 PR 2.6.
//
// After PR 2.6 retired configure_settlement_env, deploy/backend.env.template
// became the single source of truth for settlement values (RPC URLs,
// contract addresses, SUPPORTED_ASSETS_JSON). Previously those values
// were derived from deployments/testnet.json at deploy time and written
// to /srv/agent-stack/backend.env via upsert_env_values.
//
// Risk after the cutover: the manifest is updated (new contracts
// deployed, RPC URL changed, USDC address rotated, etc.) but the
// template isn't, and /run/agent-stack/backend.env ends up with stale
// values. The backend then connects to the wrong addresses without any
// loud signal at deploy time. This script makes that drift a CI failure
// instead of a silent production regression.
//
// What it does:
//   1. Runs scripts/ops/derive-settlement-env.mjs against
//      deployments/testnet.json — the same script the retired
//      configure_settlement_env called.
//   2. Parses its KEY=value output into a Map.
//   3. Reads deploy/backend.env.template and for each derived key,
//      asserts the template has a `KEY=<exact value>` line.
//   4. Reports mismatches with file:line and exit 1.
//
// What it doesn't do:
//   - Validate JSON shape — that's check-env-template-structure.mjs.
//   - Validate the manifest itself — derive-settlement-env.mjs throws
//     on malformed inputs, which propagates here.
//
// Exit codes:
//   0  template matches manifest derivation
//   1  drift detected (mismatched or missing values)
//   2  setup error (manifest missing, derive script error, etc.)

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..');

const MANIFEST = 'deployments/testnet.json';
const DERIVE_SCRIPT = 'scripts/ops/derive-settlement-env.mjs';
const TEMPLATE = 'deploy/backend.env.template';

const manifestAbs = join(REPO_ROOT, MANIFEST);
const deriveAbs = join(REPO_ROOT, DERIVE_SCRIPT);
const templateAbs = join(REPO_ROOT, TEMPLATE);

for (const [label, path] of [
  ['manifest', manifestAbs],
  ['derive script', deriveAbs],
  ['template', templateAbs],
]) {
  if (!existsSync(path)) {
    console.error(`check-template-matches-manifest: ${label} not found at ${path}`);
    process.exit(2);
  }
}

// ── Derive expected values from the manifest ─────────────────────────────

let derived;
try {
  derived = execFileSync('node', [deriveAbs, manifestAbs], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
  });
} catch (e) {
  console.error('check-template-matches-manifest: derive-settlement-env.mjs failed');
  console.error(e.stderr || e.message);
  process.exit(2);
}

const expected = new Map();
for (const line of derived.split('\n')) {
  if (!line.trim()) continue;
  const eq = line.indexOf('=');
  if (eq < 0) continue;
  const key = line.slice(0, eq);
  const value = line.slice(eq + 1);
  expected.set(key, value);
}

if (expected.size === 0) {
  console.error('check-template-matches-manifest: derive script produced zero KEY=value pairs');
  process.exit(2);
}

// ── Index the template by key (last-wins, matching how compose/shell
//    handles duplicate KEY= lines) ────────────────────────────────────────

const templateLines = readFileSync(templateAbs, 'utf8').split('\n');
const templateValues = new Map(); // key → { value, lineNo }

for (let i = 0; i < templateLines.length; i++) {
  const line = templateLines[i];
  // Skip commented-out lines (including TODO(operator) placeholders).
  if (/^\s*#/.test(line)) continue;
  const m = line.match(/^([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
  if (!m) continue;
  const [, key, value] = m;
  templateValues.set(key, { value, lineNo: i + 1 });
}

// ── Compare ──────────────────────────────────────────────────────────────

const errors = [];
for (const [key, expectedValue] of expected.entries()) {
  const actual = templateValues.get(key);
  if (!actual) {
    errors.push(
      `${TEMPLATE}: missing ${key} — manifest derives ${key}=${expectedValue || '(empty)'} but template has no line for it`,
    );
    continue;
  }
  if (actual.value !== expectedValue) {
    errors.push(
      `${TEMPLATE}:${actual.lineNo}: ${key} drift\n` +
        `    manifest: ${key}=${expectedValue || '(empty)'}\n` +
        `    template: ${key}=${actual.value || '(empty)'}`,
    );
  }
}

// ── Report ───────────────────────────────────────────────────────────────

if (errors.length > 0) {
  console.error(`check-template-matches-manifest: ${errors.length} drift${errors.length === 1 ? '' : 's'} between ${MANIFEST} and ${TEMPLATE}`);
  console.error('');
  for (const e of errors) console.error(`  ${e}`);
  console.error('');
  console.error(`Fix: edit ${TEMPLATE} to match the values shown above, or update ${MANIFEST}`);
  console.error(`then run \`node ${DERIVE_SCRIPT} ${MANIFEST}\` to confirm parity.`);
  process.exit(1);
}

console.log(`check-template-matches-manifest: ok`);
console.log(`    keys verified:  ${expected.size}`);
console.log(`    manifest:       ${MANIFEST}`);
console.log(`    template:       ${TEMPLATE}`);
