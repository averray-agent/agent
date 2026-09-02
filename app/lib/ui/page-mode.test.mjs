// Pure-logic tests for the operator-app truth-mode classifier (P2.4).
//
// Network and DOM concerns live in the React components that consume
// this classifier; this file is the side-effect-free contract.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..", "..");

// Re-import the module under each demo-mode env state. Node ESM
// caches modules, so we manipulate the env BEFORE the first import.
async function loadFreshClassifier(envValue) {
  if (envValue === undefined) {
    delete process.env.NEXT_PUBLIC_DEMO_MODE;
  } else {
    process.env.NEXT_PUBLIC_DEMO_MODE = envValue;
  }
  // Force a fresh module evaluation per test by tacking a unique
  // cache-buster onto the URL. The classifier is small + has no
  // side effects on import, so this is cheap.
  const cacheBust = `?t=${Date.now()}.${Math.random()}`;
  const mod = await import(`./page-mode.js${cacheBust}`);
  return mod;
}

test("classifyPageDataMode: 'demo' overrides every other state when NEXT_PUBLIC_DEMO_MODE=true", async () => {
  const { classifyPageDataMode, isDemoModeEnabled } = await loadFreshClassifier("true");
  assert.equal(isDemoModeEnabled(), true);
  assert.equal(classifyPageDataMode({ hasData: false, error: new Error("api down") }), "demo");
  assert.equal(classifyPageDataMode({ hasData: true, isLoading: true }), "demo");
  assert.equal(classifyPageDataMode({ hasData: false, isLoading: false }), "demo");
});

test("classifyPageDataMode: 'degraded' wins over loading/empty when an error is present", async () => {
  const { classifyPageDataMode } = await loadFreshClassifier("false");
  assert.equal(classifyPageDataMode({ hasData: false, error: new Error("api down") }), "degraded");
  assert.equal(classifyPageDataMode({ hasData: true, error: new Error("partial"), isLoading: true }), "degraded");
});

test("classifyPageDataMode: 'live' while the initial request is in flight (no fixtures during load)", async () => {
  const { classifyPageDataMode } = await loadFreshClassifier("false");
  assert.equal(classifyPageDataMode({ hasData: false, isLoading: true }), "live");
});

test("classifyPageDataMode: 'empty' once the request has landed with no rows", async () => {
  const { classifyPageDataMode } = await loadFreshClassifier("false");
  assert.equal(classifyPageDataMode({ hasData: false, isLoading: false }), "empty");
});

test("classifyPageDataMode: 'live' when the request has landed with rows", async () => {
  const { classifyPageDataMode } = await loadFreshClassifier("false");
  assert.equal(classifyPageDataMode({ hasData: true, isLoading: false }), "live");
});

test("isDemoModeEnabled: defaults to false when the env var is unset", async () => {
  const { isDemoModeEnabled } = await loadFreshClassifier(undefined);
  assert.equal(isDemoModeEnabled(), false);
});

test("isDemoModeEnabled: any value other than exactly 'true' resolves to false", async () => {
  for (const v of ["false", "TRUE", "1", "yes", "demo", ""]) {
    const { isDemoModeEnabled } = await loadFreshClassifier(v);
    assert.equal(isDemoModeEnabled(), false, `value ${JSON.stringify(v)} should be false`);
  }
});

test("classifyFromRequests: surfaces the first error across N requests", async () => {
  const { classifyFromRequests } = await loadFreshClassifier("false");
  assert.equal(
    classifyFromRequests([{ data: [], isLoading: false }, { error: new Error("boom") }], false),
    "degraded"
  );
});

test("classifyFromRequests: loading wins over empty when any request is still in flight", async () => {
  const { classifyFromRequests } = await loadFreshClassifier("false");
  assert.equal(
    classifyFromRequests([{ data: [], isLoading: false }, { isLoading: true }], false),
    "live"
  );
});

// ── Static fixture-removal guard ────────────────────────────────────────
// P2.4 close criterion: fixture data is removed from any production
// code path that can be triggered without NEXT_PUBLIC_DEMO_MODE=true.
// The two known-orphaned fixture files (DISPUTES, SESSIONS constants)
// were deleted in this PR; if anyone re-adds them this test fails so
// the regression is caught at PR time.

test("regression: components/disputes/data.ts must not exist as a fixture re-entry point", () => {
  const p = resolve(appRoot, "components/disputes/data.ts");
  assert.equal(existsSync(p), false, `${p} was deleted under P2.4 — re-adding it must come with an explicit demo-mode guard`);
});

test("regression: components/sessions/data.ts must not exist as a fixture re-entry point", () => {
  const p = resolve(appRoot, "components/sessions/data.ts");
  assert.equal(existsSync(p), false, `${p} was deleted under P2.4 — re-adding it must come with an explicit demo-mode guard`);
});

test("regression: components/audit/data.tsx must not exist as a fixture re-entry point", () => {
  const p = resolve(appRoot, "components/audit/data.tsx");
  assert.equal(existsSync(p), false, `${p} was deleted under P2.4 — re-adding it must come with an explicit demo-mode guard`);
});
