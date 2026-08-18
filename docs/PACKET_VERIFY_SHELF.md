# PACKET — Averray Verify (the shelf)

- **Status:** SPEC — ready for Codex once the two decisions in §8 are made.
- **Phase:** V of [`OUTCOME_PIVOT_BUILD_PLAN.md`](./OUTCOME_PIVOT_BUILD_PLAN.md). Absorbs
  the x402 verification-runs product (session task #237).
- **Author:** Claude, 2026-08-18, grounded by reading `origin/main`.
- **Exit condition (truth-boundary law):** a stranger pays, gets a verdict and a
  work receipt, and never talks to us. **No public "Averray Verify" page ships
  before that is literally true.**

---

## 0. The finding that shapes this packet

My build plan said profile 1 "mostly exists". Reading the code, that is **wrong in
one important way and right in three others.**

**Wrong:** there is no standalone verification path. `POST /verifier/run` requires a
`sessionId`, and `VerifierService.verifySubmission()` loads a session, runs the
verdict, then settles on-chain. Every verification today is bound to a job, a
claim, a worker and an escrow. Averray Verify has none of those: the customer
brings an artifact, pays, and gets a verdict. **Decoupling the verification engine
from the settlement path is the core build**, not a packaging exercise.

**Right, and it makes the build far cheaper than a rewrite:**

1. **The engine is already separate from the plumbing.** `VerifierRegistry`
   (`services/verifier-handlers.js`) resolves and runs handlers; the session and
   settlement logic lives above it in `verifier-service.js`. A standalone runner
   calls the same registry with a different input source.
2. **Handlers are already named and versioned, with replay fixtures as the pin.**
   `__fixtures__/verifier-replay/{benchmark/v2, deterministic/v1, github_pr/v1,
   human_fallback/v1}`, and `core/verifier-contract.js` already carries `handler`,
   `handlerVersion`, `verifierPolicyVersion`, `verifierConfigVersion`. **A profile
   registry is a naming, publishing and pricing layer over a versioned handler
   model that already exists** — plus the standing law that a handler change
   requires current-version replay fixtures, which is exactly the reproducibility
   guarantee a paid profile must offer.
3. **The new verdicts already fail safe.** Settlement is gated on
   `verdict.outcome === "approved" || "rejected"`, so `inconclusive` and
   `platform_fault` cannot move money by construction. The work receipt (#1158 +
   #1159) already models both.

## 1. The five gaps

### V1 — Standalone verification runs (the core)

A `VerificationRun` that exists without a job, claim, worker, escrow or
settlement:

```
run { runId, profile, profileVersion, customer, target, submittedAt,
      status: queued|running|complete, verdict, receiptId }
```

- New `services/verification-run-service.js` calling `VerifierRegistry` directly.
  It must **not** import the settlement path; a test should assert that no
  blockchain-gateway settlement method is reachable from a verification run.
- `POST /verify/runs` (create + pay), `GET /verify/runs/:runId` (poll), and the
  receipt at the existing `GET /receipts/:receiptId`.
- Timeout and resource bounds per profile; exceeding them yields `inconclusive`,
  never `fail`. **A customer must never be told their artifact failed because our
  runner did.**

### V2 — Profile registry (published, versioned, priced)

Named profiles wrapping existing handlers:

```
profile { name, version, handler, handlerVersion, inputSchema,
          successCriteria, limits{timeout,size}, price, replayFixtureRef, status }
```

- Immutable once published: a change is a new version, never an edit. The
  receipt pins `profile@version`, so a receipt stays reproducible forever.
- `GET /verify/profiles` public, machine-readable, listed in the discovery
  manifest and exposed as an MCP tool.
- Registry lives **on top of** the frozen `AUTO_DECIDABLE_MODES`
  (`submitted-job-auto-verifier.js:33`). Do not widen that constant; the freeze
  is what makes a profile pinnable.

### V3 — `inconclusive` end to end

Already non-settling and already in the receipt. Missing: the verdict vocabulary
in the run path, the reason taxonomy (`target_unreachable`, `flaky`,
`ambiguous_evidence`, `runner_fault`), and the customer-facing rule — **an
`inconclusive` run is not billed**, or is credited a rerun. Decide once, encode
in the pricing table, and state it on the profile listing.

### V4 — x402 intake where payment is the auth

The existing `X402PosterRampService` is **posting**-shaped: a Base→Hub float cap
(`X402_POSTING_FLOAT_CAP_USDC`), a settlement adapter, escrow pre-funding. **A
verify run needs none of it** — no escrow, no worker payout, no Hub-side funding.
Payment is simply the authorisation to run a computation.

So: a new, much smaller `payments/x402-verify-intake.js` reusing the existing
payment-verification primitives (the EIP-712 domain work is already proven — the
token `name()` gotcha applies) with **no float, no bridge, no settlement
adapter**. Flow: `POST /verify/runs` → `402` challenge carrying the profile
price → client repeats with payment → verify → run → receipt.

No SIWE. One curl. Target median setup **< 15 minutes**, which is a success
criterion of the 30-day experiment, so it is a requirement here, not a nicety.

### V5 — Verify-flavoured work receipt

`buildWorkReceipt` currently requires a funding poster, a claim-time `specHash`
and a deadline — all job concepts. For a verify run:

- `intent`: the customer is the poster; `specHash` = hash of the pinned
  `{profile@version, target, inputs}`; `specSource` = `verify_request`;
  `deadline` = the run timeout; `valueAtRisk` = the fee paid (not a worker reward).
- `execution`: the customer's artifact/endpoint, `providerClass: "external"`.
- `verification`: unchanged.
- `settlement`: **absent.** Already supported — settlement is optional and the
  intent/settlement parity check is settlement-conditional.

Add a second entry point (`buildVerifyReceipt`) sharing one canonicalisation and
one content-address function with the job path. **One receipt object, two
producers** — that is the whole point of the pivot.

## 2. The three launch profiles

| Profile | Built on | Real build size |
| --- | --- | --- |
| `git-patch-tests-v1` | `deterministic/v1` + offline git-bundle source binding (strict fsck, single-ref, tamper drill — all live) | **Small.** Engine and evidence exist; needs the standalone runner and an input schema (repo + commit + patch/bundle + test command). |
| `mcp-failure-semantics-v1` | new handler | **Largest.** Needs a bounded failure-profile harness against a customer endpoint: auth boundary, timeout recovery, tool-schema stability, destructive-action safety. Sandbox and egress rules are the hard part, not the assertions. |
| `structured-output-evidence-v1` | `github_pr/v1` already carries a `structured-evidence-approved` replay fixture | **Medium.** Schema conformance plus cited-source support; reuse the existing structured-evidence path. |

Sequence: `git-patch-tests-v1` first (proves the whole rail end to end with the
least new surface), then `structured-output-evidence-v1`, then
`mcp-failure-semantics-v1`. **Ship profile 1 alone if that is what it takes to
make the exit condition true this month** — one purchasable profile beats three
unpurchasable ones.

Naming law: "MCP Outcome Receipt", "verification profile", "tested by Averray".
Never "certification", never a blanket "safe" badge, never "AI agent
verification" (ERC-8126 owns that phrase for security posture).

## 3. Tests that must exist

- **No-settlement isolation:** a verification run cannot reach a settlement call.
  Mutation-drill it — wire settlement in deliberately and the test must fail.
- **Profile immutability:** re-running a pinned `profile@version` against the same
  inputs reproduces the same verdict and the same `receiptId`.
- **Inconclusive never bills** (or always credits — per §8) and never presents as
  a failure of the customer's artifact.
- **Runner-fault classification:** a deliberately broken runner yields
  `inconclusive`/`platform_fault`, never `fail`.
- **Payment gating:** an unpaid `POST /verify/runs` returns `402` and performs no
  work; a replayed payment proof does not buy two runs.
- **Receipt parity:** a verify receipt and a job receipt share one
  canonicalisation and content-address function (same fixture, same hash rules).

## 4. Explicitly out of scope

Routing, aggregation across receipts, the validator marketplace, the warranty,
continuous monitoring, and the GitHub issue-to-bounty app. All gated in the build
plan; do not let them creep in here.

## 5. Decisions for Pascal

1. **Pricing per profile**, and the `inconclusive` rule (not billed vs free
   rerun). Anchor: measured lifecycle gas is ~$0.059, and a verify run carries no
   settlement and no worker payout, so gross margin at low single-digit USDC is
   real. Recommendation: flat per-run price per profile, published on the profile
   listing, and **`inconclusive` is never billed** — it is the honest default and
   it protects the north-star metric from being gamed by our own runner flakiness.
2. **Where verify revenue lands.** x402 pays on **Base**; the treasury multisig is
   on **Hub**. Job revenue (poster fees, retention) already flows to the Hub
   treasury, so verify revenue arriving on Base is a new pot. Recommendation:
   accumulate on Base and sweep to the Hub treasury on a schedule, so the
   protocol-revenue line stays single-sourced — but the sweep must be explicit
   and evidenced, never implied. **Until it is decided, verify revenue must not be
   presented anywhere as protocol revenue.**
