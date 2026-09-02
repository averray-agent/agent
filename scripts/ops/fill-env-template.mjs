#!/usr/bin/env node
//
// fill-env-template.mjs — operator helper for PR 2.3.
//
// Reads a SCP'd snapshot of the VPS's hand-managed env file and uses
// it to fill the `# TODO(operator)` placeholder lines in the matching
// `deploy/*.env.template`. Produces a filled template the operator
// reviews + commits.
//
// SECRET LINES (op:// references) are NEVER touched — they're already
// correct in the template. Only commented `# TODO(operator)` lines
// are uncommented and populated with the literal value from the env
// snapshot.
//
// Lines in the env snapshot that AREN'T in the template are reported
// as orphans for operator review.
// Lines in the template that have no match in the env snapshot stay
// as `# TODO(operator)` so the operator can decide (leave commented,
// fill manually, or remove).
//
// Usage:
//   node scripts/ops/fill-env-template.mjs \
//     --snapshot /tmp/backend.env \
//     --template deploy/backend.env.template \
//     --out      deploy/backend.env.template.filled
//
// Then review the diff before overwriting the template:
//   diff deploy/backend.env.template deploy/backend.env.template.filled
//   mv  deploy/backend.env.template.filled deploy/backend.env.template
//
// Security:
//   - Reads the snapshot from a local file path. The snapshot may
//     contain secret values (it's a copy of the live env file).
//   - The OUTPUT (filled template) will also contain those values
//     for the keys the template explicitly lists. To avoid leaking
//     real secrets into the template (and into git), this script
//     REFUSES to write any value to a line that has an op:// ref —
//     those stay as op:// references. If a TODO(operator) line in
//     the template matches a key whose snapshot value LOOKS like a
//     secret (long hex, JWT shape, API-key prefix), the script
//     flags it as a likely-secret and leaves the line commented
//     with a `# TODO(secret? value omitted)` marker.

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
  console.error(`Usage: node fill-env-template.mjs --snapshot <env-file> --template <template> --out <filled-template>

Reads --snapshot (a SCP'd copy of the VPS env file), substitutes its
KEY=value pairs into the corresponding # TODO(operator) lines in
--template, and writes the result to --out.

Then review with:
  diff --template --out
  # if happy:
  mv --out --template
`);
  process.exit(2);
}

if (!existsSync(snapshotPath)) {
  console.error(`fill-env-template: snapshot not found: ${snapshotPath}`);
  process.exit(1);
}
if (!existsSync(templatePath)) {
  console.error(`fill-env-template: template not found: ${templatePath}`);
  process.exit(1);
}

// ── Parse snapshot ─────────────────────────────────────────────────────────

const snapshot = readFileSync(snapshotPath, 'utf8');
const snapshotMap = new Map();

for (const raw of snapshot.split('\n')) {
  const line = raw.trimEnd();
  if (!line || line.startsWith('#')) continue;
  const m = line.match(/^([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
  if (!m) continue;
  let [, key, value] = m;
  // Strip surrounding quotes (sh-style env files).
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  snapshotMap.set(key, value);
}

// ── Likely-secret heuristics ───────────────────────────────────────────────

const SECRET_PATTERNS = [
  /^0x[a-fA-F0-9]{60,}$/,                    // hex private key
  /^ey[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/, // JWT
  /^(sk_live_|sk_test_|re_|pk_live_|ghp_|github_pat_|ops_)[A-Za-z0-9_-]{8,}/, // API-key prefixes
  /^[A-Za-z0-9+/=]{80,}$/,                   // long base64-ish
];

function looksLikeSecret(value) {
  if (!value) return false;
  for (const re of SECRET_PATTERNS) if (re.test(value)) return true;
  return false;
}

// ── Process template ───────────────────────────────────────────────────────

const template = readFileSync(templatePath, 'utf8');
const outLines = [];

// Stats
let filledCount = 0;
let skippedSecretCount = 0;
let leftTodoCount = 0;
let opRefLines = 0;
const templateKeys = new Set();
const filledKeys = [];
const orphanKeys = [];

for (const raw of template.split('\n')) {
  // Active KEY=op://... — never touch.
  let m = raw.match(/^([A-Z][A-Z0-9_]*)\s*=\s*op:\/\//);
  if (m) {
    outLines.push(raw);
    templateKeys.add(m[1]);
    opRefLines += 1;
    continue;
  }

  // Active KEY=value (already filled) — keep as is, mark as known.
  m = raw.match(/^([A-Z][A-Z0-9_]*)\s*=/);
  if (m) {
    outLines.push(raw);
    templateKeys.add(m[1]);
    continue;
  }

  // Commented TODO(operator) line: # KEY= ... # TODO(operator) ...
  m = raw.match(/^#\s*([A-Z][A-Z0-9_]*)\s*=.*TODO\(operator\)/);
  if (m) {
    const key = m[1];
    templateKeys.add(key);
    if (snapshotMap.has(key)) {
      const value = snapshotMap.get(key);
      if (looksLikeSecret(value)) {
        // Don't write a likely-secret literal to the template.
        outLines.push(`# ${key}=  # TODO(secret? value in snapshot looks sensitive — confirm and store in 1Password instead)`);
        skippedSecretCount += 1;
      } else {
        // Substitute the literal value, uncomment the line.
        outLines.push(`${key}=${value}`);
        filledKeys.push(key);
        filledCount += 1;
      }
    } else {
      // Snapshot doesn't have this key; leave the TODO as-is.
      outLines.push(raw);
      leftTodoCount += 1;
    }
    continue;
  }

  // Anything else (blank lines, prose comments) — passthrough.
  outLines.push(raw);
}

// Snapshot keys NOT in template → orphans (operator should decide:
// add to template, or remove from snapshot).
for (const key of snapshotMap.keys()) {
  if (!templateKeys.has(key)) {
    orphanKeys.push(key);
  }
}

// ── Write + report ─────────────────────────────────────────────────────────

writeFileSync(outPath, outLines.join('\n'));

console.log(`fill-env-template: wrote ${outPath}`);
console.log(`    template keys total:          ${templateKeys.size}`);
console.log(`    op:// reference lines:        ${opRefLines}`);
console.log(`    filled from snapshot:         ${filledCount}`);
console.log(`    left as TODO(operator):       ${leftTodoCount}`);
console.log(`    likely-secret values skipped: ${skippedSecretCount}`);

if (filledKeys.length > 0) {
  console.log(`\n  Filled keys:`);
  for (const k of filledKeys.sort()) console.log(`    + ${k}`);
}

if (orphanKeys.length > 0) {
  console.log(`\n  Snapshot keys NOT in template (orphans — operator review):`);
  for (const k of orphanKeys.sort()) console.log(`    ? ${k}`);
}

console.log(`\nNext: review the diff before overwriting the template:`);
console.log(`  diff ${templatePath} ${outPath}`);
console.log(`  # if happy:`);
console.log(`  mv  ${outPath} ${templatePath}`);
console.log(`  bash scripts/ops/validate-env-render.sh ${templatePath.match(/(\w+)\.env\.template/)?.[1] ?? 'backend'}`);
