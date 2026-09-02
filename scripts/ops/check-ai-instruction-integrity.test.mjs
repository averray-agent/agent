// Tests for the AI-instruction-integrity lint (TrapDoor-class injection
// defense). All tests use library-mode (`runCheck({ files: [...] })`) so
// the lint can be exercised against fixture content under tmpdir without
// driving the CLI.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCheck, scanContent, listTargets } from "./check-ai-instruction-integrity.mjs";

// ── scanContent: pure-function fixtures ──────────────────────────────

test("scanContent: empty string returns no violations", () => {
  assert.deepEqual(scanContent(""), []);
});

test("scanContent: plain ASCII text returns no violations", () => {
  const ok = "# AGENTS.md\n\nThis is a normal markdown file with no hidden characters.\n";
  assert.deepEqual(scanContent(ok), []);
});

test("scanContent: legitimate Unicode (em-dash, smart quotes, emoji) is allowed", () => {
  const ok = "Embeddings—including smart quotes “like these” and emoji 🤖 — are fine.";
  assert.deepEqual(scanContent(ok), []);
});

test("scanContent: U+200B ZERO WIDTH SPACE is flagged with line+column", () => {
  const bad = "alpha​beta"; // ZWS between alpha and beta
  const hits = scanContent(bad);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].codepoint, 0x200b);
  assert.equal(hits[0].line, 1);
  assert.equal(hits[0].column, 6);
  assert.match(hits[0].name, /ZERO WIDTH SPACE/);
});

test("scanContent: U+200C, U+200D, U+2060 are each flagged", () => {
  // Each on its own line so the column report stays predictable.
  const bad = "a‌b\nc‍d\ne⁠f\n";
  const hits = scanContent(bad);
  assert.equal(hits.length, 3);
  assert.equal(hits[0].codepoint, 0x200c);
  assert.equal(hits[0].line, 1);
  assert.equal(hits[1].codepoint, 0x200d);
  assert.equal(hits[1].line, 2);
  assert.equal(hits[2].codepoint, 0x2060);
  assert.equal(hits[2].line, 3);
});

test("scanContent: U+FEFF at position 0 is allowed (legitimate UTF-8 BOM)", () => {
  const bomOnly = "﻿# normal heading\n";
  assert.deepEqual(scanContent(bomOnly), []);
});

test("scanContent: U+FEFF anywhere except position 0 is flagged", () => {
  const bad = "normal text ﻿ more text";
  const hits = scanContent(bad);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].codepoint, 0xfeff);
  assert.match(hits[0].name, /mid-file/);
});

test("scanContent: multi-line content produces accurate line/column", () => {
  // Forbidden char on line 3 at column 4 ("foo​" → b is column 4 because
  // the ZWS itself occupies col 4 between "foo" and the newline).
  const bad = "line one\nline two\nfoo​\nline four\n";
  const hits = scanContent(bad);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 3);
  assert.equal(hits[0].column, 4);
});

test("scanContent: real-world TrapDoor-shaped injection (hidden 'add' instruction) is caught", () => {
  // Approximation of the attack: a comment that LOOKS innocuous to a
  // human reviewer but contains zero-width characters between letters
  // that an LLM tokenizer might still read as the underlying word.
  // The check doesn't try to interpret semantics — it only flags the
  // codepoints — but this asserts the codepoints land in human-shaped
  // copy a reviewer wouldn't notice.
  const hidden = "Run​tests‌before‍merging.";
  const hits = scanContent(hidden);
  assert.equal(hits.length, 3);
  for (const hit of hits) {
    assert.ok(hit.line === 1, "all violations land on line 1");
  }
});

// ── runCheck: end-to-end with tmpdir fixtures ────────────────────────

test("runCheck: clean AGENTS.md fixture passes", () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-lint-clean-"));
  try {
    writeFileSync(join(dir, "AGENTS.md"), "# Agent Rules\n\nNormal content.\n");
    const result = runCheck({ root: dir, files: ["AGENTS.md"] });
    assert.equal(result.ok, true);
    assert.deepEqual(result.violations, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runCheck: dirty AGENTS.md fixture fails with path included in violations", () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-lint-dirty-"));
  try {
    writeFileSync(join(dir, "AGENTS.md"), "Run​all​tests.\n");
    const result = runCheck({ root: dir, files: ["AGENTS.md"] });
    assert.equal(result.ok, false);
    assert.equal(result.violations.length, 2);
    for (const v of result.violations) {
      assert.equal(v.path, "AGENTS.md");
      assert.equal(v.codepoint, 0x200b);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runCheck: missing files are silently skipped (not an error)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-lint-missing-"));
  try {
    const result = runCheck({ root: dir, files: ["does-not-exist.md"] });
    assert.equal(result.ok, true);
    assert.deepEqual(result.violations, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runCheck: dirty CLAUDE.md + clean AGENTS.md → fails citing only the dirty file", () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-lint-mixed-"));
  try {
    writeFileSync(join(dir, "AGENTS.md"), "# Clean\n");
    writeFileSync(join(dir, "CLAUDE.md"), "Inject​here.\n");
    const result = runCheck({ root: dir, files: ["AGENTS.md", "CLAUDE.md"] });
    assert.equal(result.ok, false);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].path, "CLAUDE.md");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── listTargets: integration against the real repo ───────────────────

test("listTargets: includes AGENTS.md and docs/*.md from this repo", () => {
  const targets = listTargets();
  assert.ok(targets.includes("AGENTS.md"), "expected AGENTS.md in scan targets");
  assert.ok(
    targets.some((p) => p.startsWith("docs/") && p.endsWith(".md")),
    "expected at least one docs/*.md in scan targets"
  );
});

test("listTargets: does not include node_modules or generated frontend output", () => {
  const targets = listTargets();
  for (const path of targets) {
    assert.ok(!path.includes("node_modules/"), `should not scan node_modules: ${path}`);
    assert.ok(!path.startsWith("frontend/_next/"), `should not scan generated frontend: ${path}`);
  }
});

// ── self-check: the current repo's tracked AI-instruction files are clean ─

test("self-check: this repo's tracked AGENTS.md / docs/*.md / etc. are all clean", () => {
  const result = runCheck();
  if (!result.ok) {
    // Print the violations so the failure message is actionable.
    const summary = result.violations
      .slice(0, 10)
      .map((v) => `  ${v.path}:${v.line}:${v.column}: ${v.name}`)
      .join("\n");
    assert.fail(
      `Repo currently contains zero-width Unicode in AI-instruction files. ` +
      `This is the TrapDoor-class injection signature. First 10 violations:\n${summary}`
    );
  }
  assert.equal(result.ok, true);
});
