/**
 * Every operator control must either do something or say why it cannot.
 *
 * An audit of the live app found 13 buttons rendered enabled with no handler
 * at all: five Claim buttons on the run queue, the whole run-panel action row
 * (Raise dispute, Request cosign, Abandon, Ping maintainer, …), New job, Open
 * run, a Sort control that could not sort, and Export roster / Invite agent.
 * The run-panel family shared one cause — `SmallGhostBtn` accepted only
 * `children` and `className`, so it was structurally incapable of being wired.
 *
 * The union prop types are the real guard: TypeScript now rejects an unwired
 * enabled control at compile time. This test covers what types cannot — the
 * raw `<button>` elements written inline across the operator components.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..", "..");

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return walk(path);
    return path.endsWith(".tsx") ? [path] : [];
  });
}

/**
 * Tailwind writes conditional styling as `disabled:opacity-50` inside
 * className, which looks exactly like the `disabled` attribute to a naive
 * scan — and would make this whole test pass for the wrong reason. Drop the
 * class strings before looking at attributes.
 */
function attributesOf(tag) {
  return tag
    .replace(/className=\{[\s\S]*?\}(?=\s|\/?>)/gu, " ")
    .replace(/className="[^"]*"/gu, " ")
    .replace(/class="[^"]*"/gu, " ");
}

/** `disabled` with no binding, or bound to a literal true. */
function isAlwaysDisabled(tag) {
  const attrs = attributesOf(tag);
  return /\sdisabled\s*(?=[/>\s])/u.test(attrs) || /\sdisabled=\{true\}/u.test(attrs);
}

const files = [...walk(join(appRoot, "app")), ...walk(join(appRoot, "components"))];

test("no operator button is enabled without a handler", () => {
  const offenders = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    // Opening <button ...> tags, comments stripped so an explanation that
    // mentions a removed control cannot trip the scan.
    const code = source.replace(/\{\/\*[\s\S]*?\*\/\}/gu, "");
    for (const match of code.matchAll(/<button\b[^>]*?>/gu)) {
      const tag = match[0];
      const attrs = attributesOf(tag);
      const wired = /onClick[=\s]/u.test(attrs) || /type="submit"/u.test(attrs);
      if (!wired && !isAlwaysDisabled(tag)) {
        const line = code.slice(0, match.index).split("\n").length;
        offenders.push(`${file.replace(appRoot + "/", "")}:${line}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `enabled button(s) with no onClick — wire them or render them disabled with a title:\n  ${offenders.join("\n  ")}`
  );
});

test("a disabled operator button explains itself", () => {
  const offenders = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8").replace(/\{\/\*[\s\S]*?\*\/\}/gu, "");
    for (const match of source.matchAll(/<button\b[^>]*?>/gu)) {
      const tag = match[0];
      if (isAlwaysDisabled(tag) && !/title[=\s]/u.test(attributesOf(tag))) {
        const line = source.slice(0, match.index).split("\n").length;
        offenders.push(`${file.replace(appRoot + "/", "")}:${line}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `permanently disabled button(s) with no title explaining why:\n  ${offenders.join("\n  ")}`
  );
});

test("the run-panel action button cannot be rendered unwired", () => {
  const panel = readFileSync(join(appRoot, "components/runs/LoadedRunPanel.tsx"), "utf8");
  // The union is what makes an unwired enabled control a type error.
  assert.match(panel, /\{ onClick: \(\) => void; notWired\?: never \}/u);
  assert.match(panel, /\{ onClick\?: never; notWired: string \}/u);
  // And every current call site declares which one it is.
  for (const match of panel.matchAll(/<SmallGhostBtn\b([\s\S]*?)>/gu)) {
    const attrs = match[1];
    assert.ok(
      /onClick[=\s]/u.test(attrs) || /notWired[=\s]/u.test(attrs),
      `SmallGhostBtn call site with neither onClick nor notWired: ${attrs.slice(0, 60)}`
    );
  }
});

test("claiming is disabled while no claim mutation exists", () => {
  const card = readFileSync(join(appRoot, "components/runs/JobCard.tsx"), "utf8");
  assert.match(card, /disabled\n/u, "the Claim button must be unconditionally disabled");
  assert.match(card, /not wired yet/u, "and must say why");
  // If someone adds a real claim call, this test should be updated with it.
  const libFiles = walk(join(appRoot, "lib")).concat(
    readdirSync(join(appRoot, "lib", "api")).map((f) => join(appRoot, "lib", "api", f))
  );
  const hasClaimCall = libFiles
    .filter((f) => /\.(ts|tsx|js|mjs)$/u.test(f) && !/\.test\./u.test(f))
    .some((f) => /["'`]\/jobs\/claim/u.test(readFileSync(f, "utf8")));
  assert.equal(
    hasClaimCall,
    false,
    "a /jobs/claim call now exists — wire the Claim button to it and update this test"
  );
});
