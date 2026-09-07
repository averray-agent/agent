# PACKET — CI runs 184 of 241 backend test files; no HTTP route test has ever run

Status: ready for implementation. **One PR, three commits in a fixed order** —
the order is the whole point: fixing the glob first turns CI red.

## What happened

Gating PR #1348 surfaced a one-line change to `mcp-server/package.json`:

```diff
-    "test:unit": "node --test src/**/*.test.js",
+    "test:unit": "node --test src/**/*.test.js src/protocols/http/profile-routes.test.js",
```

A test file being appended by hand to a glob that should already match it is a
tell. It does not match, and it never has.

## Root cause — measured, not reasoned

`**` is not recursive in POSIX `sh`, which is the shell npm runs scripts with.
It behaves as a single `*`, so `src/**/*.test.js` means `src/*/*.test.js` —
**exactly two levels deep**. Demonstrated on a scratch tree:

```
src/a/one.test.js      → matched
src/b/c/two.test.js    → NOT matched
```

Measured against the real workspace:

| | count |
|---|---|
| `.test.js` files under `mcp-server/src` | **241** |
| files the glob actually passes to `node --test` | **184** |
| files never executed by CI | **57** |
| HTTP route tests among the 184 | **0** |

Every file under `src/protocols/http/`, `src/payments/adapters/cdp/` and any
other third-level directory has been invisible to CI for as long as this script
has existed. That is the entire HTTP surface: account routes, admin routes,
profile routes, operational routes, job routes.

CI's `Backend — node --test` job runs `npm test --workspace mcp-server`, which is
`test:unit && test:http-smoke`. So a green "Backend" check has never meant the
route layer passes.

## What the dark tests were hiding

All 57 files were executed against `origin/main` and against all three of
#1346/#1347/#1348. Result is identical everywhere: **471 tests, 412 pass, 2 fail,
57 skipped** (the skips are `server.smoke.test.js` self-skipping without
`RUN_HTTP_SMOKE`). The two failures are on `origin/main` and are not caused by
any open PR.

Both were characterised before writing this packet. **Neither is a production
bug** — which is the good news, because it means the glob can be fixed with
test-side changes only.

**1. `operational-routes.test.js` — "GET /health reports service liveness
separately from disabled capabilities"**
Asserts `response.body.addresses.token === "0x0000053900000000000000000000000001200000"`
and reads `undefined` from the mock harness. Production is fine: live
`GET https://api.averray.com/health` returns `addresses.token` with exactly that
value. The test's other expectations name **testnet** addresses
(`agentAccountCore 0x510918E2…`, `escrowCore 0xfE841c2d…`) and the retired
settlement signer `0x31ad432d…` — the one #1084 replaced. This is a pre-mainnet
test that drifted from its harness and was never re-run to notice.

**2. `settlement-adapter.test.js` — "provider identifiers stay inside the adapter
package"**
An architecture-boundary test that walks every `.js`/`.json` under
`mcp-server/src` outside `src/payments/adapters/` and asserts none contains
`\bcdp\b`. The single offender is `payments/x402-discovery.test.js`, which
imports `CdpSettlementAdapter` and uses `https://api.cdp.coinbase.com/...` in a
fixture. Production code is clean — verified independently by grep across
tracked source. The rule is simply too broad: it polices test files as if they
were production modules, and a test that exercises an adapter must name it.

## Blast radius

- A green Backend check is weaker evidence than everyone has been treating it as.
  Every gate decision made on "CI green" for a route-layer change was made on
  incomplete information — including, until this packet, mine.
- Two red tests sat undetected for an unknown period. Neither happened to be a
  production fault. Nothing guarantees the next one won't be.
- #1348's one-line append is a local workaround that fixes its own visibility
  and leaves the other 56 dark. It should be removed once the glob is fixed,
  not left as the pattern for the next person who hits this.

## The fix — in this order

The order is mandatory. Fixing the glob first makes CI red on `main`, which
either blocks every merge or trains people to ignore a red check.

**Commit 1 — repair the two tests. No script change yet.**
- `operational-routes.test.js`: point the expectations at what the harness
  actually configures, and correct the stale testnet/retired-signer addresses so
  the test asserts today's contract. If the harness genuinely should supply a
  token address, fix the harness instead — but say which you chose and why.
- `settlement-adapter.test.js`: narrow the boundary rule to production modules,
  excluding `*.test.js`. The rule's purpose is that *shipped code* must not name
  a provider outside its adapter; a test that constructs the adapter is not a
  violation. Do not silence it by renaming the offending fixture.
- Prove both fail before and pass after, running the files directly.

**Commit 2 — make the runner see every file.**
Replace the broken glob with Node's own recursive discovery. Verified on Node 22
(the version CI pins): `node --test` with no path argument finds nested test
files — confirmed on a scratch tree where it ran both `src/shallow.test.js` and
`src/a/b/deep.test.js`. `server.smoke.test.js` self-skips without
`RUN_HTTP_SMOKE`, so including it in the unit pass is harmless and
`test:http-smoke` continues to run it deliberately.
Whatever form is chosen, the acceptance is numeric: the unit pass must execute
**241** files, not 184.

**Commit 3 — remove #1348's workaround.**
Delete the appended `src/protocols/http/profile-routes.test.js` path. With
commit 2 in place it is redundant, and leaving it implies the glob works.

## Also latent, fix while here

`package.json` root: `test:examples = node --test examples/**/*.test.mjs` has the
identical bug. It happens to be harmless **today** — there is exactly one such
file and it sits at depth 2 — so it is a trap waiting for the second example,
not a live gap. Fix it the same way and say so in the PR body.

Checked and **not** affected: `test:ops` (`scripts/ops/*.test.mjs`, single level),
`test:app` (explicit per-directory list), `indexer test:api`
(`src/api/*.test.ts` — no indexer test file exists outside `src/api/`).

## Non-negotiables (each pinned by a test)

1. **The count is asserted, not eyeballed.** A repository test compares the
   number of `*.test.js` files under `mcp-server/src` against the number the
   configured unit script actually executes, and fails when they diverge. This
   is the test that stops the bug returning in a new shape; without it, commit 2
   is a fix with no guard.
2. Add a nested test file at depth ≥3 in a scratch fixture and prove the
   configured runner picks it up — mutation: place it at depth 3, assert it runs.
3. `operational-routes.test.js` and `settlement-adapter.test.js` both pass, and
   both are proven red before commit 1 (name the assertion each fails on).
4. The boundary rule still catches a **production** module naming `cdp` outside
   the adapter package — add such a file in a fixture and assert the test fails.
   Narrowing the rule must not disarm it.
5. `test:http-smoke` still runs the smoke suite deliberately with
   `RUN_HTTP_SMOKE=1`, and the unit pass still skips it without that variable.

## Live state while this is open

Production is unaffected — both failures are test-side and the live health
payload and production sources are correct. The exposure is evidentiary, not
operational: until this lands, "Backend — node --test" green does not cover the
route layer, and gating decisions should say so out loud rather than imply
coverage that does not exist.

## Handback

PR number; the three commits in order; green CI; the five test names; the
before/after file count (**184 → 241**); the two repaired tests each shown red
before their fix and green after; and confirmation that #1348's appended path is
gone.
