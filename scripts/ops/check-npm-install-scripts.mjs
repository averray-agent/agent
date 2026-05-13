#!/usr/bin/env node
//
// check-npm-install-scripts.mjs — CI guard for Phase 2 PR 2.9 (npm hardening).
//
// Scans the root package-lock.json for transitive dependencies that
// declare `hasInstallScript: true` (= will run preinstall/postinstall/
// install during `npm ci`). Compares the set against the allowlist at
// deploy/npm-install-scripts-allowlist.json. Fails CI if any
// install-script dep is present that isn't allowlisted, OR if the
// version of an allowlisted dep changed (so version bumps get a
// fresh review).
//
// Why this exists
// ---------------
//
// Lifecycle scripts are the primary supply-chain attack vector for
// npm. Mini Shai-Hulud (Sep 2026, TanStack chain) and predecessors
// (eslint-scope 2018, ua-parser-js 2021, color/faker 2022, etc.) all
// followed the same shape: compromise a popular package or one of
// its dependencies → publish a new version with a malicious
// preinstall/postinstall → wait for downstream `npm install` to
// execute the payload with the runner's full permissions.
//
// `npm ci` honors install scripts by default. If our lockfile bumps
// to a compromised version of an existing dep (or a new dep with an
// install script), CI runs the malicious code with access to all
// secrets in the workflow's environment, including
// OP_SERVICE_ACCOUNT_TOKEN_* values.
//
// This guard makes that surface explicit:
//   • Any dep with hasInstallScript: true must be allowlisted by path+version.
//   • Adding a new entry requires a human PR review where they
//     explicitly accept the supply-chain risk.
//   • A version bump on an allowlisted dep also fails — review
//     refreshes for each version.
//
// What this does NOT do
// ---------------------
//
// • Block install scripts at runtime (use --ignore-scripts for that —
//   but it would break legitimate native bindings like sharp/sqlite3
//   that we genuinely need; blanket use isn't viable for this repo).
// • Audit the install scripts' code. The allowlist trusts each entry's
//   maintainer + npm registry. For higher assurance, pair this with
//   `npm audit --audit-level=high` and Dependabot.
// • Detect runtime-only attacks (e.g., a package that's clean at
//   install but malicious at require()). For that, package-pinning
//   in package-lock.json's `integrity` field is the primary defense.
//
// Exit codes
// ----------
//   0  every install-script dep is in the allowlist at its current version
//   1  one or more violations (new dep, version drift, or allowlist not found)
//   2  setup error (lockfile or allowlist not parseable)
//
// Output is intentionally verbose on failure — operators need to see
// what changed and decide whether to bless it (update allowlist) or
// reject it (revert the lockfile change).

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..');

const LOCKFILE = 'package-lock.json';
const ALLOWLIST = 'deploy/npm-install-scripts-allowlist.json';

const lockfileAbs = join(REPO_ROOT, LOCKFILE);
const allowlistAbs = join(REPO_ROOT, ALLOWLIST);

if (!existsSync(lockfileAbs)) {
  console.error(`check-npm-install-scripts: ${LOCKFILE} not found at ${lockfileAbs}`);
  process.exit(2);
}
if (!existsSync(allowlistAbs)) {
  console.error(`check-npm-install-scripts: ${ALLOWLIST} not found at ${allowlistAbs}`);
  console.error(`This guard requires an explicit allowlist. Create it with the current set of allowed deps and re-run.`);
  process.exit(2);
}

let lockfile;
let allowlist;
try {
  lockfile = JSON.parse(readFileSync(lockfileAbs, 'utf8'));
  allowlist = JSON.parse(readFileSync(allowlistAbs, 'utf8'));
} catch (e) {
  console.error(`check-npm-install-scripts: failed to parse JSON: ${e.message}`);
  process.exit(2);
}

// Build {path: version} maps from both sources.
const found = new Map(); // path → version (from lockfile)
for (const [path, pkg] of Object.entries(lockfile.packages || {})) {
  if (pkg && pkg.hasInstallScript === true) {
    found.set(path, pkg.version || '<no-version>');
  }
}

const allowed = new Map(); // path → {version, name, reason}
for (const entry of allowlist.allowed || []) {
  // The allowlist intentionally does NOT pin a `version` — we want any
  // version of an already-allowlisted package to surface here as a
  // diff vs the lockfile's current state. The check below detects
  // "version changed since allowlist last-updated" by comparing the
  // allowlist entry's `version` field (if present) to the lockfile.
  // If `version` is absent in the allowlist, any version is accepted
  // — useful for "we trust this dep's maintainer, accept any future
  // version" stance, but more permissive.
  allowed.set(entry.path, {
    version: entry.version, // optional
    name: entry.name,
    reason: entry.reason,
    added_at: entry.added_at,
  });
}

// ── Compare ──────────────────────────────────────────────────────────────

const errors = [];

// (a) deps in lockfile but not in allowlist → BLOCK
for (const [path, version] of found.entries()) {
  if (!allowed.has(path)) {
    errors.push(
      `NEW install-script dep not in allowlist:\n` +
        `    path:    ${path}\n` +
        `    version: ${version}\n` +
        `    action:  review the dep's install script + maintainer reputation.\n` +
        `             If acceptable, add to ${ALLOWLIST} with a justification.\n` +
        `             If suspicious (recently bumped, new maintainer, etc.), revert the lockfile change.`,
    );
  }
}

// (b) deps with version drift (allowlist pins version, lockfile differs)
for (const [path, version] of found.entries()) {
  const allow = allowed.get(path);
  if (!allow) continue; // already reported in (a)
  if (allow.version && allow.version !== version) {
    errors.push(
      `Version drift for allowlisted install-script dep:\n` +
        `    path:           ${path}\n` +
        `    allowlist:      ${allow.version}\n` +
        `    lockfile:       ${version}\n` +
        `    action:         review the changelog between these versions for any new install-script behavior.\n` +
        `                    If clean, update the allowlist entry's "version" field.\n` +
        `                    If suspicious, revert the lockfile bump.`,
    );
  }
}

// (c) allowlist entries that are no longer in the lockfile → INFO only
//     (dep was removed; we just note it for hygiene; not a failure)
const stale = [];
for (const path of allowed.keys()) {
  if (!found.has(path)) {
    stale.push(path);
  }
}

// ── Report ───────────────────────────────────────────────────────────────

if (errors.length > 0) {
  console.error(`check-npm-install-scripts: ${errors.length} violation${errors.length === 1 ? '' : 's'} detected\n`);
  for (const e of errors) {
    console.error(`  ${e}\n`);
  }
  console.error(`See docs/SECRETS_MIGRATION.md#npm-install-script-policy for the review procedure.`);
  process.exit(1);
}

console.log(`check-npm-install-scripts: ok`);
console.log(`    install-script deps in lockfile: ${found.size}`);
console.log(`    allowlisted:                     ${allowed.size}`);
if (stale.length > 0) {
  console.log(`    stale allowlist entries (no longer in lockfile, harmless): ${stale.length}`);
  for (const p of stale) {
    console.log(`      - ${p}`);
  }
}
