import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("desktop gate belongs only to desktop-only routes in the operator shell", async () => {
  const [gate, operatorLayout, workerLayout, signIn] = await Promise.all([
    read("components/shell/OperatorDesktopGate.tsx"),
    read("app/(authed)/layout.tsx"),
    read("app/(worker)/layout.tsx"),
    read("app/sign-in/page.tsx")
  ]);

  assert.match(gate, /The operator control room is built for desktop\./u);
  assert.match(gate, /href="\/work"[\s\S]*Find paid work/u);
  assert.match(gate, /Open on desktop to continue\./u);
  assert.match(gate, /md:hidden/u);
  assert.match(gate, /hidden md:contents/u);
  assert.match(gate, /isDesktopOnlyOperatorPath\(pathname\)/u);
  assert.match(operatorLayout, /<OperatorDesktopGate>/u);
  assert.match(operatorLayout, /<OperatorMobileNavigation/u);
  assert.doesNotMatch(workerLayout, /OperatorDesktopGate/u);
  assert.doesNotMatch(signIn, /OperatorDesktopGate/u);
});

test("withdrawal empty state reads standing independently from the unsigned intent", async () => {
  const withdrawal = await read("components/work/WorkWithdrawal.tsx");

  assert.match(withdrawal, /auth\.authenticated \? "\/me" : null/u);
  assert.match(withdrawal, /disabled=\{building \|\| !hasAvailableBalance\}/u);
  assert.match(withdrawal, /There is no available USDC to withdraw\./u);
  assert.ok(
    withdrawal.indexOf("withdrawalStandingFromIntent(workerQuery.data)")
      < withdrawal.indexOf("withdrawalStandingFromIntent(intent)"),
    "the /me standing read must not wait for a withdrawal intent"
  );
});

test("poster jobs has an in-app canonical redirect", async () => {
  const redirect = await read("app/(authed)/poster/jobs/page.tsx");

  assert.match(redirect, /router\.replace\("\/poster\/"\)/u);
  assert.match(redirect, /href="\/poster\/"/u);
});
