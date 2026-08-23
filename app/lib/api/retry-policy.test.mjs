/**
 * Guards the SWR retry policy behind `useApi`.
 *
 * The regression: `shouldRetryOnError` excluded 401 only, so a signed-in
 * wallet without `ops:view` retried every capability-gated feed (/transparency,
 * /alerts, /policies, /audit, /admin/*) forever — SWR's default onErrorRetry
 * has no retry cap — and each attempt incremented the backend's
 * `auth_failures_total`. Eight gated hooks per role-less tab.
 *
 * `/transparency` is named above because it was part of that original
 * regression. It has since been opened to the public and its operator page
 * retired, so it no longer appears in the assertion below. The guard it
 * motivated still stands for every feed that is still gated.
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

test("operator feed denials retry while an invalid session stays terminal", () => {
  assert.equal(shouldRetryApiError({ status: 403 }), true);
  assert.equal(shouldRetryApiError({ status: 401 }), false);
});

test("a real operator missing_capability response is retried", () => {
  // The role wall means this can only be mounted by an entitled session.
  const err = {
    name: "ApiError",
    message: "403 Forbidden",
    status: 403,
    body: { code: "missing_capability", message: "requires ops:view" },
  };
  assert.equal(shouldRetryApiError(err), true);
});

test("transient failures still retry", () => {
  assert.equal(shouldRetryApiError({ status: 500 }), true);
  assert.equal(shouldRetryApiError({ status: 502 }), true);
  assert.equal(shouldRetryApiError({ status: 503 }), true);
  assert.equal(shouldRetryApiError({ status: 429 }), true);
});

test("non-401 4xx and unknown error shapes retry", () => {
  assert.equal(shouldRetryApiError({ status: 400 }), true);
  assert.equal(shouldRetryApiError({ status: 404 }), true);
  assert.equal(shouldRetryApiError(new TypeError("Failed to fetch")), true);
  assert.equal(shouldRetryApiError({}), true);
});

test("403 remains an unreachable feed state while retrying", () => {
  assert.equal(feedPresence({ error: { status: 403 } }), "locked");
  assert.equal(shouldRetryApiError({ status: 403 }), true);
});

test("useApi wires the shared policy and hand-rolls no status check", () => {
  assert.match(hooks, /import \{ shouldRetryApiError \} from "\.\/retry-policy\.js"/u);
  assert.match(hooks, /shouldRetryOnError:\s*shouldRetryApiError/u);
  // The regression itself: an inline comparison that forgets 403.
  assert.doesNotMatch(hooks, /shouldRetryOnError:\s*\(/u);
  assert.doesNotMatch(hooks, /err\.status\s*!==\s*401/u);
});

test("every capability-gated feed routes through a shared API hook", () => {
  // These may 403 while an entitled session's role/capability rollout is out
  // of alignment. Shared hooks keep that recovery behavior consistent;
  // useBoundedApi additionally owns the first-paint timeout budget.
  const gated = [
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
      new RegExp(`export const ${hook} = [^;]*use(?:Bounded)?Api\\s*[<(]`, "u"),
      `${hook} must fetch through useApi or useBoundedApi`
    );
  }
  const directCalls = hooks.match(/useSWR\s*[<(]/gu) ?? [];
  assert.equal(directCalls.length, 2, "the two shared API hooks should be the only useSWR call sites");
});

test("bounded operator feeds opt back into the shared recovery policy", () => {
  assert.match(hooks, /useBadges[^;]*shouldRetryOnError:\s*shouldRetryApiError/su);
  assert.match(hooks, /useReceiptDetail[\s\S]*shouldRetryOnError:\s*shouldRetryApiError/u);
  assert.match(hooks, /usePolicies[\s\S]*shouldRetryOnError:\s*shouldRetryApiError/u);
});
