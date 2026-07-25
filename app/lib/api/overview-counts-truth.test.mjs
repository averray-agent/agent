/**
 * Guards the overview's job counts against the regression found on the live
 * operator app: the mission hero read "16 open runs" and Runs-in-motion read
 * 16, while the lifecycle strip beside them read OPEN 13. Sixteen was the
 * catalog total — three of those jobs were exhausted, and ten of the
 * remaining thirteen were blocked on reward funding with nothing on the page
 * saying so.
 *
 * Source-level assertions, matching the other *-truth tests in this folder:
 * these modules are TypeScript and are not importable from node --test.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..", "..");
const read = (p) => readFileSync(resolve(appRoot, p), "utf8");

const lifecycle = read("lib/api/job-lifecycle.ts");
const treasuryAdapters = read("lib/api/treasury-adapters.ts");
const overviewPage = read("app/(authed)/overview/page.tsx");
const strip = read("components/overview/JobLifecycleStrip.tsx");
const topbar = read("components/overview/OverviewTopbar.tsx");

test("there is one shared definition of open work", () => {
  assert.match(lifecycle, /export function classifyJobRow/u);
  assert.match(lifecycle, /export function countOpenJobs/u);
  // The classifier, not a second inline copy, decides what "open" means.
  assert.match(
    lifecycle,
    /export function buildPublicJobLifecycleSummary[\s\S]*?classifyJobRow\(job\)/u,
    "the public summary must count through classifyJobRow"
  );
});

test("open work never counts exhausted rows", () => {
  const classifier = lifecycle.slice(
    lifecycle.indexOf("export function classifyJobRow"),
    lifecycle.indexOf("export function countOpenJobs")
  );
  assert.match(classifier, /exhausted\s*=\s*\n?\s*status === "exhausted"/u);
  // Both `open` and `claimable` are gated on it.
  assert.equal(
    (classifier.match(/!exhausted/gu) ?? []).length,
    2,
    "open and claimable must both exclude exhausted rows"
  );
});

test("the mission hero counts open jobs, not the raw array length", () => {
  assert.match(overviewPage, /openRuns=\{hasLiveOverview \? countOpenJobs\(jobs\.data\) : 0\}/u);
  assert.doesNotMatch(
    overviewPage,
    /openRuns=\{[^}]*liveJobs\.length/u,
    "openRuns must not be the catalog total"
  );
});

test("Runs in motion counts open jobs, not the raw array length", () => {
  const vital = treasuryAdapters.slice(
    treasuryAdapters.indexOf('label: "Runs in motion"'),
    treasuryAdapters.indexOf('label: "Agents active"')
  );
  assert.match(vital, /countOpenJobs\(jobsPayload\)/u);
  assert.doesNotMatch(
    vital,
    /value:\s*jobs\.length/u,
    "the vital must not report the catalog total as runs in motion"
  );
});

test("blocked work is derived from open-minus-claimable, not a reason string", () => {
  assert.match(lifecycle, /if \(open && !claimable\) \{\s*\n\s*summary\.blocked \+= 1;/u);
  // A new blocking reason must be counted the day it ships.
  assert.doesNotMatch(
    lifecycle,
    /blocked\s*\+=\s*1[\s\S]{0,80}reward_funding_pending/u,
    "blocked must not be gated on a specific reason string"
  );
});

test("blocked and exhausted render as unknown when the source omits them", () => {
  // /admin/status emits neither; null must survive as null, never become 0.
  assert.match(lifecycle, /exhausted:\s*slice\.exhausted === undefined \? null :/u);
  assert.match(lifecycle, /blocked:\s*slice\.blocked === undefined \? null :/u);
  assert.match(strip, /value: number \| null/u);
  assert.match(strip, /slot\.value === null \? "—" : slot\.value/u);
  assert.match(strip, /not reported/u);
});

test("an admin session still sees blocked and exhausted from the public feed", () => {
  assert.match(
    overviewPage,
    /blocked: publicLifecycleSummary\.blocked/u,
    "admin lifecycle data must borrow the buckets /admin/status does not emit"
  );
  assert.match(overviewPage, /exhausted: publicLifecycleSummary\.exhausted/u);
});

test("the lifecycle strip shows every bucket a job can land in", () => {
  for (const label of ["total", "open", "claimable", "blocked", "exhausted", "stale", "paused", "archived"]) {
    assert.match(strip, new RegExp(`label: "${label}"`, "u"), `missing bucket: ${label}`);
  }
  // claimable is a subset of open, not a sibling that sums to total.
  assert.match(strip, /label: "claimable"[\s\S]{0,120}hint: "of open"/u);
});

test("the overview topbar carries no inert controls", () => {
  // Strip comments first — the removal is explained in one, and the
  // explanation naturally names the button it removed.
  const code = topbar.replace(/\{\/\*[\s\S]*?\*\/\}/gu, "").replace(/\/\*[\s\S]*?\*\//gu, "");
  assert.doesNotMatch(code, /Export briefing/u, "the inert Export briefing button is back");
  // Every button left in the topbar must do something.
  const buttons = code.match(/<button[\s\S]*?<\/button>/gu) ?? [];
  for (const button of buttons) {
    assert.match(button, /onClick=/u, `topbar button without a handler: ${button.slice(0, 80)}`);
  }
});
