#!/usr/bin/env node
//
// check-ai-instruction-integrity.mjs — supply-chain hygiene gate.
//
// Lints AI-instruction files for invisible-character injection. This is
// the defense against the TrapDoor-class persistence vector documented
// by Socket on 2026-05-24: a compromised npm/PyPI/Crates dependency
// installs a hook that appends ZERO-WIDTH UNICODE to `AGENTS.md`,
// `CLAUDE.md`, or `.cursorrules`, planting instructions that a coding
// assistant reads but a human reviewer cannot see in a normal text
// editor.
//
// The characters we forbid:
//   U+200B  ZERO WIDTH SPACE
//   U+200C  ZERO WIDTH NON-JOINER
//   U+200D  ZERO WIDTH JOINER
//   U+2060  WORD JOINER
//   U+FEFF  ZERO WIDTH NO-BREAK SPACE  (exception: legitimate BOM at
//           position 0 of the file is allowed; codepoint anywhere else
//           is a violation)
//
// What we scan, by default:
//   - Every tracked file matching AGENTS.md, CLAUDE.md, .cursorrules
//     (case-sensitive — these are the AI-assistant config names the
//     TrapDoor advisory specifically called out).
//   - docs/*.md at the repo root (the durable knowledge surface; any
//     of these could be read into an assistant's prompt).
//
// Exit codes:
//   0  all files clean (or no matching files found, which is fine)
//   1  one or more files contain forbidden codepoints
//   2  setup error (cannot list git tree, etc.)
//
// Library mode: `runCheck({ root, files? })` returns { ok, violations }
// so the test file can assert against tempdir fixtures without driving
// the CLI.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_ROOT = resolve(__dirname, "..", "..");

// Forbidden codepoints (numeric, not regex — easier to scan + report).
const FORBIDDEN = new Map([
  [0x200b, "U+200B ZERO WIDTH SPACE"],
  [0x200c, "U+200C ZERO WIDTH NON-JOINER"],
  [0x200d, "U+200D ZERO WIDTH JOINER"],
  [0x2060, "U+2060 WORD JOINER"]
]);
// U+FEFF is handled separately: allowed at position 0 (BOM), forbidden elsewhere.
const FEFF = 0xfeff;

const DEFAULT_BASENAMES = new Set(["AGENTS.md", "CLAUDE.md", ".cursorrules"]);
const DEFAULT_DOC_PREFIXES = ["docs/"];

/**
 * Resolve the list of files to scan, relative to `root`.
 *
 * Strategy: use `git ls-files` to enumerate only tracked content. We
 * intentionally do NOT walk the filesystem so that node_modules,
 * worktree copies, and transient untracked junk are excluded
 * automatically.
 */
export function listTargets(root = DEFAULT_ROOT) {
  let lines;
  try {
    lines = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
  } catch (error) {
    throw new Error(`unable to list tracked files via git: ${error.message}`);
  }

  const targets = [];
  for (const path of lines) {
    const isAiConfig = DEFAULT_BASENAMES.has(basename(path));
    const isRootDoc = DEFAULT_DOC_PREFIXES.some(
      (prefix) => path.startsWith(prefix) && path.endsWith(".md")
    );
    if (isAiConfig || isRootDoc) targets.push(path);
  }
  return targets;
}

/**
 * Scan a single file's contents (string) for forbidden codepoints.
 * Returns array of { line, column, codepoint, name }. Empty array =
 * clean.
 */
export function scanContent(content) {
  const violations = [];
  let line = 1;
  let col = 0;

  for (let i = 0; i < content.length; i += 1) {
    const cp = content.codePointAt(i);
    if (cp === undefined) continue;

    // Track 1-based line/column for human-readable output.
    if (cp === 0x0a /* \n */) {
      line += 1;
      col = 0;
      continue;
    }
    col += 1;

    if (FORBIDDEN.has(cp)) {
      violations.push({ line, column: col, codepoint: cp, name: FORBIDDEN.get(cp) });
    } else if (cp === FEFF) {
      // BOM at the very start of the file is legitimate (UTF-8 BOM).
      // Anywhere else, it's a TrapDoor-shaped injection signal.
      const isBom = i === 0;
      if (!isBom) {
        violations.push({ line, column: col, codepoint: cp, name: "U+FEFF ZERO WIDTH NO-BREAK SPACE (mid-file)" });
      }
    }

    // Surrogate-pair codepoints occupy two UTF-16 units; skip the trail.
    if (cp > 0xffff) i += 1;
  }

  return violations;
}

/**
 * Public entry point. Walks targets, scans each, returns a structured
 * result.
 *
 * @param {object} options
 * @param {string} [options.root]   — repo root (defaults to this repo)
 * @param {string[]} [options.files] — explicit list of paths to scan
 *   (relative to root, or absolute). When omitted, `listTargets(root)`
 *   is used.
 */
export function runCheck({ root = DEFAULT_ROOT, files } = {}) {
  const targets = Array.isArray(files) ? files : listTargets(root);
  const violations = [];

  for (const target of targets) {
    const abs = isAbsolute(target) ? target : join(root, target);
    if (!existsSync(abs)) continue; // gracefully skip removed files
    const content = readFileSync(abs, "utf8");
    const hits = scanContent(content);
    for (const hit of hits) {
      violations.push({
        path: isAbsolute(target) ? relative(root, target) : target,
        ...hit
      });
    }
  }

  return { ok: violations.length === 0, violations };
}

// ── CLI ───────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const invokedAsScript = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (invokedAsScript) {
  try {
    const result = runCheck();
    if (result.ok) {
      const count = listTargets().length;
      console.log(`ai-instruction-integrity: scanned ${count} file(s); no zero-width Unicode found.`);
      process.exit(0);
    }
    for (const v of result.violations) {
      process.stderr.write(`${v.path}:${v.line}:${v.column}: ${v.name}\n`);
    }
    process.stderr.write(
      `\nai-instruction-integrity: ${result.violations.length} violation(s). See ` +
      `https://socket.dev/blog/trapdoor-crypto-stealer-npm-pypi-crates for context on this ` +
      `attack pattern. If a legitimate file requires zero-width Unicode, refactor the file or ` +
      `add an explicit allowlist entry to this script with a justification.\n`
    );
    process.exit(1);
  } catch (error) {
    process.stderr.write(`ai-instruction-integrity: ${error.message}\n`);
    process.exit(2);
  }
}

// ── helpers ───────────────────────────────────────────────────────────

function basename(p) {
  const idx = p.lastIndexOf("/");
  return idx === -1 ? p : p.slice(idx + 1);
}

function isAbsolute(p) {
  return p.startsWith("/");
}
