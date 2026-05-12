#!/usr/bin/env node
//
// check-env-template-structure.mjs — structural lint for Phase 2 env templates.
//
// Runs in CI WITHOUT a 1Password session. Catches:
//   • `op://` references that don't match the canonical 3-segment shape
//     `op://<vault>/<item>/<field>` (op CLI accepts 3 or 4 segments;
//     we enforce 3 for consistency with our inventory).
//   • Vault names that aren't in our known whitelist.
//   • Secrets referenced from the template that don't have a matching row
//     in deploy/secrets-inventory.md.
//   • Inventory rows that reference an op:// path no template uses (orphan).
//   • Template lines that look like raw secrets (long hex strings, JWT-shaped
//     tokens) — those should be op:// refs, not literals.
//
// Does NOT call `op inject`. For that, use scripts/ops/validate-env-render.sh
// with an active 1Password session.
//
// Exit codes:
//   0  all checks passed
//   1  one or more violations found (printed to stderr)

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..');

const TEMPLATES = [
  { runtime: 'backend', path: 'deploy/backend.env.template' },
  { runtime: 'indexer', path: 'deploy/indexer.env.template' },
];

const INVENTORY = 'deploy/secrets-inventory.md';

const KNOWN_VAULTS = new Set([
  'prod-backend',
  'prod-backend-external',
  'prod-indexer',
  'prod-ci',
  'prod-ci-external',
  'prod-smoke',
  'prod-critical',
  'prod-observability',
  // testnet mirrors — accepted but flagged as a warning if used in a prod template
  'testnet-backend',
  'testnet-backend-external',
  'testnet-indexer',
  'testnet-ci',
  'testnet-ci-external',
  'testnet-smoke',
  'testnet-critical',
  // cross-environment
  'multisig',
  'archive',
]);

// Vault-name → runtimes that may legitimately read it (whole-vault scoping,
// matches the four service-account tokens minted in Phase 1).
const VAULT_TO_RUNTIME = {
  'prod-backend': ['backend'],
  'prod-backend-external': ['backend'],
  'prod-indexer': ['indexer'],
  'prod-ci': ['ci'],
  'prod-ci-external': ['ci'],
  'prod-smoke': ['smoke'],
};

// Heuristics for "this looks like a raw secret pasted into the template".
// Not exhaustive — caller should still review by eye.
const RAW_SECRET_HEURISTICS = [
  { name: 'hex private key (32+ bytes)', re: /=[\s]*0x[a-fA-F0-9]{60,}[\s]*$/m },
  { name: 'JWT', re: /=[\s]*ey[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/m },
  { name: 'long base64-ish secret', re: /=[\s]*[A-Za-z0-9+/=]{60,}[\s]*$/m },
  { name: 'API-key prefix', re: /=[\s]*(sk_live_|sk_test_|re_|pk_live_|ghp_|github_pat_)[A-Za-z0-9_-]{8,}/m },
];

const errors = [];
const warnings = [];

function err(file, lineNo, msg) {
  errors.push(`${file}:${lineNo}: ${msg}`);
}
function warn(file, lineNo, msg) {
  warnings.push(`${file}:${lineNo}: ${msg}`);
}

// ── Parse templates ──────────────────────────────────────────────────────

const templateRefs = new Map(); // op:// path → [{file, lineNo, varName, runtime}]

for (const { runtime, path: relPath } of TEMPLATES) {
  const absPath = join(REPO_ROOT, relPath);
  if (!existsSync(absPath)) {
    err(relPath, 0, `template file does not exist`);
    continue;
  }
  const content = readFileSync(absPath, 'utf8');
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i];

    // Hard rule, learned the hard way: `op inject` scans the WHOLE FILE
    // for `op://` substrings (not just KEY=value lines) and tries to
    // resolve every one. A literal `op://` in a comment will fail
    // render with "invalid secret reference". Catch it here so the lint
    // fails on the PR instead of on the operator's terminal.
    if (line.includes('op://')) {
      const isValidAssignment = /^[A-Z][A-Z0-9_]*\s*=\s*op:\/\//.test(line);
      if (!isValidAssignment) {
        err(relPath, lineNo, `comment or non-assignment line contains literal op:// — this trips op inject at runtime; rephrase as "1Password reference" or similar`);
      }
    }

    // Skip blank lines and pure comments (including commented-out
    // TODO placeholders — those are intentionally commented).
    if (/^\s*$/.test(line) || /^\s*#[^=]*$/.test(line) || /^\s*#\s*[A-Z][A-Z0-9_]*=.*TODO\(operator\)/.test(line)) {
      continue;
    }

    // Heuristic: raw secret in plaintext
    for (const { name, re } of RAW_SECRET_HEURISTICS) {
      if (re.test(line)) {
        err(relPath, lineNo, `looks like a raw ${name} — should be an op:// reference, not a literal`);
      }
    }

    // Active KEY=value lines
    const m = line.match(/^([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!m) {
      continue; // not a KEY=value line, skip
    }
    const [, varName, value] = m;

    // If the value is an op:// reference, validate structure
    if (value.startsWith('op://')) {
      const parts = value.slice('op://'.length).split('/').filter((p) => p.length > 0);
      if (parts.length < 3) {
        err(relPath, lineNo, `${varName}: op:// reference has fewer than 3 segments (need vault/item/field): ${value}`);
        continue;
      }
      const [vault, item, ...fieldParts] = parts;
      const field = fieldParts.join('/');

      if (!KNOWN_VAULTS.has(vault)) {
        err(relPath, lineNo, `${varName}: references unknown vault '${vault}'`);
      }

      if (vault.startsWith('testnet-')) {
        warn(relPath, lineNo, `${varName}: references testnet vault '${vault}' from a production template`);
      }

      const allowedRuntimes = VAULT_TO_RUNTIME[vault];
      if (allowedRuntimes && !allowedRuntimes.includes(runtime)) {
        err(relPath, lineNo, `${varName}: ${runtime} template references vault '${vault}' which is only readable by ${allowedRuntimes.join('/')} service-account token`);
      }

      const canonical = `op://${vault}/${item}/${field}`;
      if (!templateRefs.has(canonical)) templateRefs.set(canonical, []);
      templateRefs.get(canonical).push({ file: relPath, lineNo, varName, runtime });
    } else if (value.length > 0) {
      // Literal non-empty value — that's fine for config, but be loud
      // about anything that looks like a secret slipped in.

      // *_JSON= keys MUST parse as valid JSON. This catches the class
      // of bug where someone copy-pastes the shell-escaped form
      // `[{\"symbol\":\"USDC\"}]` into the template — that round-trips
      // fine through `set -a; . file` but breaks docker-compose's
      // env_file: parser, which takes the value literally. We saw
      // exactly this outage on 2026-05-12 when SUPPORTED_ASSETS_JSON
      // had backslash-escaped quotes from `quote_env_value`'s shell
      // format leaking into the template via a copy-paste from
      // /srv/agent-stack/backend.env. The backend fails to start at
      // `parseAssetsJson` in src/blockchain/config.js with no
      // hard-to-diagnose 502s downstream. CI catching it on the PR
      // would have saved a production outage.
      if (varName.endsWith('_JSON')) {
        try {
          JSON.parse(value);
        } catch (e) {
          err(relPath, lineNo, `${varName}: value is not valid JSON (docker-compose env_file: takes the value literally — backslash-escaped \\" form will crash the backend at bootstrap): ${e.message}`);
        }
      }
    }
  }
}

// ── Parse inventory ──────────────────────────────────────────────────────

const inventoryRefs = new Map(); // op:// path → {file, lineNo, varName}
const inventoryAbs = join(REPO_ROOT, INVENTORY);

if (!existsSync(inventoryAbs)) {
  err(INVENTORY, 0, `inventory file does not exist`);
} else {
  const lines = readFileSync(inventoryAbs, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Match table rows: `| `VAR_NAME` | `op://...` | ...`
    const m = line.match(/^\|\s*`([A-Z][A-Z0-9_]*)`\s*\|\s*`(op:\/\/[^`]+)`/);
    if (m) {
      const [, varName, opPath] = m;
      inventoryRefs.set(opPath, { file: INVENTORY, lineNo: i + 1, varName });
    }
  }
}

// ── Cross-check templates vs inventory ───────────────────────────────────

for (const [opPath, sites] of templateRefs.entries()) {
  if (!inventoryRefs.has(opPath)) {
    const { file, lineNo, varName } = sites[0];
    err(file, lineNo, `${varName}: template references ${opPath} but no matching row in ${INVENTORY}`);
  }
}

for (const [opPath, { file, lineNo, varName }] of inventoryRefs.entries()) {
  if (!templateRefs.has(opPath)) {
    // Inventory rows can document items that aren't in templates (CI-side
    // secrets loaded via load-secrets-action, smoke secrets, etc.).
    // Only warn — don't error.
    warn(file, lineNo, `${varName}: inventory row for ${opPath} has no matching template entry (OK if loaded via load-secrets-action in CI)`);
  }
}

// ── Report ───────────────────────────────────────────────────────────────

if (warnings.length > 0) {
  console.log(`check-env-template-structure: ${warnings.length} warning${warnings.length === 1 ? '' : 's'}`);
  for (const w of warnings) console.log(`  warn  ${w}`);
}

if (errors.length > 0) {
  console.error(`check-env-template-structure: ${errors.length} error${errors.length === 1 ? '' : 's'}`);
  for (const e of errors) console.error(`  ERR   ${e}`);
  process.exit(1);
}

console.log(`check-env-template-structure: ok`);
console.log(`    templates checked:  ${TEMPLATES.length}`);
console.log(`    op:// refs in templates:  ${templateRefs.size}`);
console.log(`    inventory rows:           ${inventoryRefs.size}`);
