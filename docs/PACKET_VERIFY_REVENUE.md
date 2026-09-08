# PACKET — P-VERIFY-REVENUE: buyer recipe + separate Base revenue from Hub spend

Status: ready for implementation. **Two PRs** (A: recipe doc; B: instrumentation).
C is a decision, not code. No contract, manifest or x402-rail changes, so D-03
stays quiet.

## ★ Corrected pin — the handover's pin is 11 commits stale

The handover says `9ada467d96753e55d7df164b32c08802ffa6a220` "matches main",
confirmed 2026-09-05. It no longer does. Re-read on 2026-09-08:

| | |
|---|---|
| live `GET /health` → `deployedSha` | **`6cb88d4495d813a85d7ade5c157c2da2b1af6964`** |
| `origin/main` | **`6cb88d4495d813a85d7ade5c157c2da2b1af6964`** (identical) |
| handover pin | `9ada467d…` — **11 commits behind** |

Build against `6cb88d44`. Everything between the two pins is real: GitHub
upstream retirement, catalogue durability + tombstones, directory consent
(`/agents` is now opt-in and returns nothing by default), and the repointed
real-work bundle. A recipe written against `9ada467d` would describe a
directory that no longer behaves that way.

## Verified live before writing this — every "already live" claim holds

Measured against `6cb88d44` on 2026-09-08, not taken from the handover:

| claim | result |
|---|---|
| unpaid `POST /verify/runs` | **402** |
| `accepts[0].network` | `eip155:8453` |
| `accepts[0].asset` | `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913` |
| `accepts[0].payTo` | `0x1013e3fe3f6deb4e61dc023ff69d420dd9ce8f9f` |
| amount | `5000000` (5 USDC) |
| `/.well-known/x402` → `resources` length | **1**, `https://api.averray.com/verify/runs` |
| profiles | 3 — `mcp-failure-semantics-v1@1`, `git-patch-tests-v1@1`, `structured-output-evidence-v1@1`, all 5 USDC Base |
| Hub `420420419` / asset 1337 anywhere in the Verify path | **absent** |
| `llms.txt` Verify Base section | present |

Do not re-implement any of it. The rail works.

**Request shape correction.** A malformed unpaid POST returns **400**, not 402 —
the body needs `profile`, `profileVersion` (integer), `target` (object) and
`inputs` (object). The recipe must show the working shape, which the platform
already publishes as `profiles[].workedExample.request`:

```json
{"profile":"mcp-failure-semantics-v1","profileVersion":1,
 "target":{"endpoint":"https://example.invalid/mcp","transport":"streamable_http"},
 "inputs":{}}
```

A buyer who copies a half-formed body gets a 400 and concludes the rail is
broken. Lead with the worked example, not prose.

## Three corrections to the handover

**1. An out-of-scope item is already done.** The handover lists
"P-JOBS-REAL-THREE ops publish (code #1326; three jobs still not live)". Those
three 2 USDC jobs went live 2026-09-08 ~16:00 UTC and are serving now
(`real-pr-tricklepay-icon-controls-165`, `real-data-cdc-wastewater-quality-audit`,
`real-patch-tricklepay-withdraw-disabled-test-149`). Nothing to exclude; it
shipped.

**2. `inconclusive_not_billed` is not in the 402.** It is a `billingRule` field
on the profile registry (`verification-profile-registry.js:10`). The 402 body
does not contain that token. The recipe must cite the profile as the source of
the billing rule and must not tell a buyer to look for it in the challenge —
they will not find it and will not trust the rest.

**3. `/metrics` is NOT a public surface — this unblocks item 2.** Platform and
founder revenue are Hermes-only and never public
(`POSTER_DOOR_CLARITY_PACKET.md:15`, `PACKET_SOCIAL_SIGNAL_AGENT.md:57`), which
at first reading appears to forbid a Verify-GMV counter. It does not:
`GET /metrics` returns **401** unauthenticated, is absent from the public route
allowlist in `http-helpers.js`, and is bearer-gated by `METRICS_AUTH_REQUIRED`
which fails closed in production (`operational-routes.js:56,192`).

So: **the counters go on `/metrics`.** They must never appear on `/health`,
`/transparency`, the pool page, or any unauthenticated route — `/health` *is*
public and would breach the boundary.

## The fix

### A — the buyer recipe (own PR)

New `docs/VERIFY_PR_GATE.md`. Neither it nor `docs/AGENTKIT_VERIFY.md` exists
today; this is new work, not a rewrite.

Two paths, one page:

- **MCP-gate (hero):** `mcp-failure-semantics-v1@1` — an agent gating on an MCP
  endpoint's failure semantics.
- **PR/patch-gate:** `git-patch-tests-v1@1` — gating a patch on its tests.

The flow, in the order a buyer actually executes it:

1. `GET /.well-known/x402` — discover the resource and the payment terms. State
   that `resources` has exactly one entry and that price is read live from
   there, never restated in prose.
2. `GET /verify/profiles` — take `workedExample.request` verbatim.
3. `POST /verify/runs` unpaid → **402** with the Base terms.
4. Pay Base USDC via x402 EIP-3009 authorization — no on-chain transaction from
   the buyer, no Hub wallet, no browser.
5. `GET /verify/runs/{runId}` — public, unauthenticated.
6. Optional: `averray.com/receipts/{receiptId}`.

Copy discipline, everywhere in the doc: Base `eip155:8453`, USDC
`0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`, payTo
`0x1013e3fe3f6deb4e61dc023ff69d420dd9ce8f9f`. **Never** Hub `eip155:420420419`
or asset `1337` — those belong to worker settlement and have nothing to do with
buying a verification.

Not in this PR: no in-tree AgentKit application, and no CI step that spends
5 USDC.

### B — instrumentation (own PR)

Two figures, readable separately, on `/metrics`.

**(a) Verify billed volume on the Base payTo.** Billed means a decisive verdict —
approved or rejected. **Inconclusive runs are never billed and must never be
counted.** Find the existing settlement record for a paid run and count from it.
If no such record exists, that is the finding: say so in the PR and stop, rather
than inventing a ledger to make the number appear.

**(b) Sponsored Hub outflows.** Reuse what exists — do not build a second
ledger. `overnight-ledger.js` already computes `subsidySpend` from
`session.onboardingSubsidy.estimatedClaimSubsidyUsdc` (`:480`) and already
consumes `operator_gas.first_withdrawal_granted` (`:747`). The work is surfacing
those as a counter, plus any operator Hub spend they miss.

**What is not Verify GMV**, and must be provably excluded: the 5% poster fee,
and the claim-bond `feeBps = 200`. Those are Hub-side worker/poster economics.
Mixing them in would overstate cash revenue with sponsored-market internals —
the exact confusion this ticket exists to end.

### C — the 10× credit pack: DEFER, and here is the stronger reason

The handover's own test is "skip if it needs a new ledger/rail". There is a
sharper one. The pack must "never redeem below runner + facilitator cost", and
**no runner or facilitator cost is recorded anywhere in the tree** — I searched
for it and it does not exist. A floor that cannot be computed cannot be
enforced, so the constraint would ship as prose while the code sold packs at an
unknown margin.

Defer on that basis and say so in the PR. It becomes buildable once unit cost is
measured; that measurement is its own small piece of work, not a rider on this
one.

## Non-negotiables (each pinned by a test)

1. **Well-known stays exactly one resource.** Assert `resources.length === 1` and
   that it is `https://api.averray.com/verify/runs`. Mutation: add `/jobs/x402`
   as an x402 resource — the test must fail. This is the guard against the rail
   quietly acquiring a second, Hub-flavoured door.
2. **No Hub identifiers in Verify surfaces.** Grep the recipe doc and the Verify
   copy for `420420419` and asset `1337`; both must be absent. Mutation: insert
   the Hub chain id into the doc — the test must fail.
3. **Base constants are exact**, asserted as literals: `eip155:8453`,
   `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`,
   `0x1013e3fe3f6deb4e61dc023ff69d420dd9ce8f9f`, `5000000`.
4. **Inconclusive is never billed.** Feed the counter an inconclusive verdict and
   assert the billed total does not move. Mutation: count inconclusive — the
   test must fail. Assert approved *and* rejected both do count.
5. **Poster fee and claim-bond fee are excluded from Verify GMV.** Feed both
   through and assert the Verify counter stays flat.
6. **The counter never becomes public.** Assert `/metrics` requires a bearer and
   that neither `/health` nor the public route allowlist exposes the Verify or
   sponsorship figures. Mutation: add `/metrics` to the public allowlist — the
   test must fail.
7. **The recipe's worked example is the live one.** Assert the request body in
   the doc matches `profiles[].workedExample.request` in shape — same required
   keys — so the doc cannot drift into the 400 that a malformed body produces.
8. **No CI step spends 5 USDC.** Assert no test or workflow performs a paid
   `POST /verify/runs`.

## Out of scope — do not merge into either PR

P-VERIFY-AGENTKIT leftovers · P-SMITHERY · Polkadot x402 · Moonbeam bonds ·
waivers-as-revenue · Twitter · Cursor Marketplace · Hub escrow P1 · rebuilding
the x402 rail. Worker MCP (claim/submit/list) stays free; the cash door is
Verify.

The Hub reward bank (42.075 USDC liquid at time of writing) is **not** Verify
GMV and must not appear in either counter.

## Handback

Two PR numbers; green CI; the eight test names; the mutation evidence for tests
1, 2, 4 and 6 (each shown red before the fix and green after); the corrected pin
`6cb88d44` stated in both PR bodies; and for C an explicit deferral line naming
the missing unit cost. Confirm `/.well-known/x402` still returns exactly one
resource in production after deploy.
