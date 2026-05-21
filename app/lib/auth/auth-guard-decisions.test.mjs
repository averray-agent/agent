// Pure-logic tests for the authed-layout guard classifier (P3.7).
//
// The wrapper component just dispatches on the action returned here;
// React rendering, router calls, and the SSR/hydration race live in
// the .tsx component. This file is the side-effect-free contract.

import test from "node:test";
import assert from "node:assert/strict";

import {
  AUTH_GUARD_DEFAULT_NEXT,
  AUTH_GUARD_SIGN_IN_PATH,
  buildSignInRedirect,
  decideAuthGuardAction,
} from "./auth-guard-decisions.js";

test("decideAuthGuardAction: pre-hydration always returns 'checking', regardless of authenticated", () => {
  // The static-export HTML render and the FIRST client render both have
  // hydrated=false; localStorage has not been consulted, so the
  // authenticated flag is meaningless and must not drive a render or
  // redirect. The wrapper renders a neutral placeholder.
  assert.deepEqual(
    decideAuthGuardAction({ authenticated: false, hydrated: false }),
    { action: "checking" }
  );
  assert.deepEqual(
    decideAuthGuardAction({ authenticated: true, hydrated: false }),
    { action: "checking" }
  );
});

test("decideAuthGuardAction: hydrated + authenticated returns 'render' (the operator shell)", () => {
  assert.deepEqual(
    decideAuthGuardAction({ authenticated: true, hydrated: true, currentPath: "/overview" }),
    { action: "render" }
  );
});

test("decideAuthGuardAction: hydrated + unauthenticated returns 'redirect' with next=<currentPath>", () => {
  const result = decideAuthGuardAction({
    authenticated: false,
    hydrated: true,
    currentPath: "/runs/detail",
  });
  assert.equal(result.action, "redirect");
  assert.equal(result.redirectTo, "/sign-in?next=%2Fruns%2Fdetail");
});

test("decideAuthGuardAction: defensively coerces missing/non-boolean fields", () => {
  // The wrapper passes through `useAuth().authenticated` and a local
  // hydration flag. If anything is ever undefined, default to the
  // safer behavior (treat as unhydrated / unauthed).
  // @ts-expect-error — deliberately exercising the coercion path
  assert.deepEqual(decideAuthGuardAction({}), { action: "checking" });
  // @ts-expect-error — deliberately exercising the coercion path
  assert.deepEqual(decideAuthGuardAction({ hydrated: 1, authenticated: 1 }), { action: "render" });
});

// ── buildSignInRedirect path normalization ───────────────────────────

test("buildSignInRedirect: defaults to /overview when currentPath is missing/empty/non-string", () => {
  assert.equal(buildSignInRedirect(undefined), "/sign-in?next=%2Foverview");
  assert.equal(buildSignInRedirect(""), "/sign-in?next=%2Foverview");
  assert.equal(buildSignInRedirect("   "), "/sign-in?next=%2Foverview");
  assert.equal(buildSignInRedirect(null), "/sign-in?next=%2Foverview");
  // @ts-expect-error — exercising non-string defense
  assert.equal(buildSignInRedirect(42), "/sign-in?next=%2Foverview");
});

test("buildSignInRedirect: rejects absolute URLs and protocol-relative URLs (open-redirect defense)", () => {
  // The attacker would phish a victim into clicking an authed link
  // with `?next=https://evil.com`. After sign-in, a naive impl would
  // bounce them to `evil.com`. The guard must collapse such values
  // back to the operator home.
  assert.equal(buildSignInRedirect("https://evil.com/x"), "/sign-in?next=%2Foverview");
  assert.equal(buildSignInRedirect("//evil.com/x"), "/sign-in?next=%2Foverview");
  assert.equal(buildSignInRedirect("javascript:alert(1)"), "/sign-in?next=%2Foverview");
  assert.equal(buildSignInRedirect("data:text/html,<script>"), "/sign-in?next=%2Foverview");
});

test("buildSignInRedirect: refuses to loop /sign-in back to /sign-in", () => {
  assert.equal(buildSignInRedirect("/sign-in"), "/sign-in?next=%2Foverview");
  assert.equal(buildSignInRedirect("/sign-in?next=/whatever"), "/sign-in?next=%2Foverview");
  assert.equal(buildSignInRedirect("/sign-in/anything"), "/sign-in?next=%2Foverview");
});

test("buildSignInRedirect: preserves query strings and hash fragments", () => {
  assert.equal(
    buildSignInRedirect("/runs/detail?id=abc&tab=outputs"),
    "/sign-in?next=%2Fruns%2Fdetail%3Fid%3Dabc%26tab%3Doutputs"
  );
  assert.equal(
    buildSignInRedirect("/sessions#claim-fd2e"),
    "/sign-in?next=%2Fsessions%23claim-fd2e"
  );
});

test("constants: exported defaults match the public contract", () => {
  assert.equal(AUTH_GUARD_SIGN_IN_PATH, "/sign-in");
  assert.equal(AUTH_GUARD_DEFAULT_NEXT, "/overview");
});
