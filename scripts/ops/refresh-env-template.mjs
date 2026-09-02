#!/usr/bin/env node
//
// refresh-env-template.mjs — sync template literal values from a snapshot.
//
// Companion to fill-env-template.mjs. Where fill-* only populates
// `# TODO(operator)` lines, refresh-* updates ALREADY-FILLED literal
// values to match what's currently in the snapshot. Operator drift
// is real (someone tightens MIN_SCORE on the VPS, flips DRY_RUN, etc.);
// this script brings the in-repo template back in sync without
// hand-editing.
//
// Critical safety: op:// references are NEVER touched. If the template
// says `KEY=op://...` and the snapshot says `KEY=some-literal`, the
// template stays as op://. That's the firebreak — secret values must
// stay in 1Password, never in the committed template.
//
// Likely-secret values in the snapshot are also rejected: if a snapshot
// line has a secret-shaped value (hex private key, JWT, API-key prefix,
// long base64), we refuse to overwrite an op://-referenced template
// line with it. (You wouldn't WANT that anyway, because the template's
// op:// is what gets rendered by op inject at deploy time.)
//
// Usage:
//   node scripts/ops/refresh-env-template.mjs \
//     --snapshot /tmp/backend.env \
//     --template deploy/backend.env.template \
//     --out      deploy/backend.env.template.refreshed
//
// Then diff to verify the changes are what you expected:
//   diff deploy/backend.env.template deploy/backend.env.template.refreshed
//   mv  deploy/backend.env.template.refreshed deploy/backend.env.template
//   STRICT=1 bash scripts/ops/validate-env-render.sh backend

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const args = process.argv.slice(2);
function getArg(flag) {
  const i = args.indexOf(flag);
  if (i === -1 || i === args.length - 1) return null;
  return args[i + 1];
}

const snapshotPath = getArg('--snapshot');
const templatePath = getArg('--template');
const outPath = getArg('--out');

if (!snapshotPath || !templatePath || !outPath) {
  console.error(`Usage: node refresh-env-template.mjs --snapshot <env-file> --template <template> --out <refreshed>

Updates already-filled KEY=value lines in --template to match values from
--snapshot. Skips op:// references (those stay; they're rendered at
deploy time). Skips likely-secret values in the snapshot.

Then review with:
  diff <template> <out>
  # if happy:
  mv <out> <template>
`);
  process.exit(2);
}

if (!existsSync(snapshotPath)) {
  console.error(`refresh-env-template: snapshot not found: ${snapshotPath}`);
  process.exit(1);
}
if (!existsSync(templatePath)) {
  console.error(`refresh-env-template: template not found: ${templatePath}`);
  process.exit(1);
}

// ── Parse snapshot ────────────────────────────────────────────────────────

const snapshot = readFileSync(snapshotPath, 'utf8');
const snapshotMap = new Map();

for (const raw of snapshot.split('\n')) {
  const line = raw.trimEnd();
  if (!line || line.startsWith('#')) continue;
  const m = line.match(/^([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
  if (!m) continue;
  let [, key, value] = m;
  // Strip surrounding shell-style quotes so we compare the actual value
  // content (Docker Compose env_file does this anyway).
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  snapshotMap.set(key, value);
}

// ── Likely-secret heuristics (same as fill-env-template.mjs) ──────────────

const SECRET_PATTERNS = [
  /^0x[a-fA-F0-9]{60,}$/,
  /^ey[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/,
  /^(sk_live_|sk_test_|re_|pk_live_|ghp_|github_pat_|ops_)[A-Za-z0-9_-]{8,}/,
  /^[A-Za-z0-9+/=]{80,}$/,
];

function looksLikeSecret(value) {
  if (!value) return false;
  for (const re of SECRET_PATTERNS) if (re.test(value)) return true;
  return false;
}

// ── Process template ──────────────────────────────────────────────────────

const template = readFileSync(templatePath, 'utf8');
const outLines = [];

let opRefLines = 0;
let unchanged = 0;
let refreshed = [];
let secretSkipped = [];
let templateOnly = []; // KEY in template, not in snapshot — left alone

for (const raw of template.split('\n')) {
  // Active KEY=op://... — never touch.
  let m = raw.match(/^([A-Z][A-Z0-9_]*)\s*=\s*op:\/\//);
  if (m) {
    outLines.push(raw);
    opRefLines += 1;
    continue;
  }

  // Active KEY=value (already filled).
  m = raw.match(/^([A-Z][A-Z0-9_]*)\s*=(.*)$/);
  if (m) {
    const key = m[1];
    const currentValue = m[2];
    if (!snapshotMap.has(key)) {
      // Template has it but snapshot doesn't — leave alone (likely a
      // template-only var that's intentionally not in the snapshot).
      outLines.push(raw);
      templateOnly.push(key);
      continue;
    }
    const snapshotValue = snapshotMap.get(key);
    if (looksLikeSecret(snapshotValue)) {
      // Snapshot has this key with a secret-shaped value. Refuse to
      // overwrite. Operator should check whether the template's
      // existing value (or an op:// ref) is the right answer.
      outLines.push(raw);
      secretSkipped.push(key);
      continue;
    }
    if (currentValue === snapshotValue) {
      // Already in sync.
      outLines.push(raw);
      unchanged += 1;
      continue;
    }
    // Refresh.
    outLines.push(`${key}=${snapshotValue}`);
    refreshed.push({ key, from: currentValue, to: snapshotValue });
    continue;
  }

  // Anything else (blank lines, comments) — passthrough.
  outLines.push(raw);
}

// Snapshot keys NOT in template = orphans.
const orphanKeys = [];
for (const key of snapshotMap.keys()) {
  if (!outLines.some(line => line.match(new RegExp(`^${key}\\s*=`)))) {
    orphanKeys.push(key);
  }
}

writeFileSync(outPath, outLines.join('\n'));

console.log(`refresh-env-template: wrote ${outPath}`);
console.log(`    op:// reference lines (untouched): ${opRefLines}`);
console.log(`    in sync (no change):               ${unchanged}`);
console.log(`    refreshed (template ← snapshot):   ${refreshed.length}`);
console.log(`    likely-secret values skipped:      ${secretSkipped.length}`);
console.log(`    in template, not in snapshot:      ${templateOnly.length}`);
console.log(`    in snapshot, not in template:      ${orphanKeys.length}`);

if (refreshed.length > 0) {
  console.log(`\n  Refreshed keys (KEY: old → new):`);
  for (const { key, from, to } of refreshed) {
    // Truncate long values so the log stays readable; never print
    // full secret-shaped content.
    const truncFrom = from.length > 60 ? from.slice(0, 57) + '...' : from;
    const truncTo = to.length > 60 ? to.slice(0, 57) + '...' : to;
    console.log(`    ${key}: ${truncFrom}  →  ${truncTo}`);
  }
}

if (secretSkipped.length > 0) {
  console.log(`\n  Likely-secret values in snapshot (template kept as-is):`);
  for (const k of secretSkipped) console.log(`    ! ${k}`);
}

if (templateOnly.length > 0) {
  console.log(`\n  In template only (not in snapshot — operator review):`);
  for (const k of templateOnly) console.log(`    ? ${k}`);
}

if (orphanKeys.length > 0) {
  console.log(`\n  In snapshot only (not in template — operator review):`);
  for (const k of orphanKeys) console.log(`    + ${k}`);
}

console.log(`\nReview the diff before overwriting the template:`);
console.log(`  diff ${templatePath} ${outPath}`);
console.log(`  # if happy:`);
console.log(`  mv  ${outPath} ${templatePath}`);
