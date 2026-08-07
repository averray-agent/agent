/**
 * Guards the SWR retry policy behind `useApi`.
 *
 * The regression: `shouldRetryOnError` excluded 401 only, so a signed-in
 * wallet without `ops:view` retried every capability-gated feed (/transparency,
 * /alerts, /policies, /audit, /admin/*) forever — SWR's default onErrorRetry
 * has no retry cap — and each attempt incremented the backend's
 * `auth_failures_total`. Eight gated hooks per role-less tab.
 *
 * The hooks module is TypeScript and is not importable from node --test, so
 * the wiring is asserted at the source level, matching the *-truth tests in
 * this folder. The policy itself is plain JS and is exercised directly.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { shouldRetryApiError } from "./retry-policy.js";
import { feedPresence } from "./feed-presence.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (path) => readFileSync(resolve(here, path), "utf8");
const hooks = read("hooks.ts");

test("auth-locked failures are terminal — 403 no longer retries", () => {
  assert.equal(shouldRetryApiError({ status: 403 }), false);
  assert.equal(shouldRetryApiError({ status: 401 }), false);
});

test("a real missing_capability error shape is not retried", () => {
  // What swrFetcher throws for GET /transparency without `ops:view`.
  const err = {
    name: "ApiError",
    message: "403 Forbidden",
    status: 403,
    body: { code: "missing_capability", message: "requires ops:view" },
  };
  assert.equal(shouldRetryApiError(err), false);
});

test("transient failures still retry", () => {
  assert.equal(shouldRetryApiError({ status: 500 }), true);
  assert.equal(shouldRetryApiError({ status: 502 }), true);
  assert.equal(shouldRetryApiError({ status: 503 }), true);
  assert.equal(shouldRetryApiError({ status: 429 }), true);
});

test("non-auth 4xx and unknown error shapes retry — only 401/403 are terminal", () => {
  assert.equal(shouldRetryApiError({ status: 400 }), true);
  assert.equal(shouldRetryApiError({ status: 404 }), true);
  assert.equal(shouldRetryApiError(new TypeError("Failed to fetch")), true);
  assert.equal(shouldRetryApiError({}), true);
});

test("retry policy and rendered presence share one classifier", () => {
  // A feed we stop asking for must be a feed the UI shows as locked, and a
  // feed the UI shows as down/live must stay retryable. Divergence would mean
  // a surface renders "locked for this session" while the tab keeps probing,
  // or a degraded feed silently stops recovering.
  const errors = [
    { status: 401 },
    { status: 403 },
    { status: 404 },
    { status: 429 },
    { status: 500 },
    { status: 503 },
    new Error("network"),
  ];
  for (const error of errors) {
    const locked = feedPresence({ error }) === "locked";
    assert.equal(
      shouldRetryApiError(error),
      !locked,
      `retry decision disagrees with presence for ${JSON.stringify(error)}`
    );
  }
});

test("useApi wires the shared policy and hand-rolls no status check", () => {
  assert.match(hooks, /import \{ shouldRetryApiError \} from "\.\/retry-policy\.js"/u);
  assert.match(hooks, /shouldRetryOnError:\s*shouldRetryApiError/u);
  // The regression itself: an inline comparison that forgets 403.
  assert.doesNotMatch(hooks, /shouldRetryOnError:\s*\(/u);
  assert.doesNotMatch(hooks, /err\.status\s*!==\s*401/u);
});

test("every capability-gated feed routes through useApi", () => {
  // These 403 for a session without the operator capabilities; a raw useSWR
  // here would carry SWR's retry-everything default and reopen the hole.
  const gated = [
    "useTransparency",
    "useAlerts",
    "usePolicies",
    "useAudit",
    "useAdminJobs",
    "useAdminSessions",
    "useProviderOperations",
    "useCapabilityGrants",
  ];
  for (const hook of gated) {
    assert.match(
      hooks,
      new RegExp(`export const ${hook} = [^;]*useApi\\s*[<(]`, "u"),
      `${hook} must fetch through useApi`
    );
  }
  const directCalls = hooks.match(/useSWR\s*[<(]/gu) ?? [];
  assert.equal(directCalls.length, 1, "useApi should be the only useSWR call site");
});
