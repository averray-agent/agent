import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...parts) => readFileSync(resolve(appRoot, ...parts), "utf8");

test("app root serves an honest choice wall instead of forcing the heavy overview route", () => {
  const page = read("app", "page.tsx");
  const entry = read("components", "shell", "RootEntry.tsx");
  assert.doesNotMatch(page, /httpEquiv="refresh"/u);
  assert.match(entry, /Work is visible before a wallet is required\./u);
  assert.match(entry, /href="\/sign-in"/u);
  assert.match(entry, /href="\/work"/u);
  assert.match(entry, /href="https:\/\/averray\.com"/u);
  assert.match(entry, /href="https:\/\/averray\.com\/trust\/"/u);
  assert.match(entry, /href="https:\/\/averray\.com\/agents\/"/u);
});

test("first-paint instrumentation separates navigation, blockers, and live-data milestones", () => {
  const performance = read("lib", "ui", "app-performance.js");
  const layout = read("app", "layout.tsx");
  const workList = read("components", "work", "WorkJobList.tsx");
  const receipts = read("app", "(authed)", "receipts", "page.tsx");

  assert.match(layout, /<AppPerformanceObserver \/>/u);
  assert.match(performance, /first-paint-breakdown/u);
  assert.match(performance, /resourcesByType/u);
  assert.match(performance, /longTaskMs/u);
  assert.match(workList, /work-catalogue-settled/u);
  assert.match(receipts, /receipts-feeds-settled/u);
});

test("receipts defers its secondary policy feed without inventing a value", () => {
  const receipts = read("app", "(authed)", "receipts", "page.tsx");
  assert.match(receipts, /usePolicies\(secondaryFeedsEnabled\)/u);
  assert.match(receipts, /requestIdleCallback/u);
  assert.match(receipts, /feedPresence\(policiesRequest\)/u);
});
