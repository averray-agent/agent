# PACKET — The Averray Work Receipt (v1)

- **Status:** SPEC — ready for Codex.
- **Phase:** R (keystone) of [`OUTCOME_PIVOT_BUILD_PLAN.md`](./OUTCOME_PIVOT_BUILD_PLAN.md).
- **Author:** Claude, 2026-08-18. Grounded by reading the live code, not from the
  strategy document.
- **One line:** promote the existing `averray.run-receipt.v1` into
  `averray.work-receipt.v1` — the single portable object every Averray product
  surface emits.

---

## 0. The finding that shapes this packet

The receipt is **not** a greenfield build. `mcp-server/src/core/run-receipt.js`
(175 lines) already builds a signed, canonical, publicly-addressable receipt at
verdict time. Three of the four sections in the pivot's receipt model already
exist and are populated on every settled job today.

| Where it lives | What it already does |
| --- | --- |
| `core/run-receipt.js` | Builds `averray.run-receipt.v1`; `RUN_RECEIPT_SCHEMA_VERSION`; validates that only `approved`/`rejected` reach a receipt |
| `services/verification-ingestion-service.js:171` | Calls `buildRunReceipt` on the verdict path — including the autonomous no-JWT settlement path |
| `protocols/http/badge-routes.js:137` | Serves `GET /badges/:sessionId/run` |
| `core/badge-receipt-signing.js` | ES256/KMS detached signature envelope; `buildBadgeSigners` |
| `core/canonical-content.js` | `hashCanonicalContent` — the canonical-JSON hasher to reuse for the receipt id |

**Therefore: this packet is a diff, not a rewrite.** Anything below that is not
listed as a gap must be left alone.

## 1. Present shape (verified 2026-08-18)

```
schemaVersion  averray.run-receipt.v1
kind           "run"          receiptType "verification_verdict"
sessionId, jobId, worker, chainJobId
verifier    { mode, handler, version, wallet }
verdict     { outcome, reasonCode, evidenceHash, policyTags, rationaleHash }
settlement  { worker, treasuryAccount, asset, assetSymbol,
              workerAmount(+Raw), protocolFeeAmount(+Raw), protocolFeeBps }
timestamps  { claimedAt, submittedAt, verifiedAt }
signers, canonicalUrl
```

## 2. The five gaps

### G1 — No intent section (the biggest gap)

`specHash` is the chain commitment to the served job definition. It is pinned at
claim time and re-checked at settlement (`core/claim-job-integrity.js`), and it
**never reaches the receipt**. A receipt that omits it cannot prove *what was
agreed*, only what was delivered — which is precisely the half a buyer needs.

Add an `intent` block:

```
intent {
  specHash            bytes32   REQUIRED — from the claim-time snapshot
  specSource          enum      "chain_verified" | "chain_unavailable_fail_open"
  successPolicy { profile, version }   see G3
  valueAtRisk   { asset, amount, amountRaw }   the reward pinned at claim
  deadline            iso8601   claim expiry / submission deadline
  poster              address   who funded it
  posterClass         enum      "operator" | "external"   (self-traffic honesty)
  approvalGrantHash   bytes32   OPTIONAL — reserved for #238, omit until it lands
}
```

`specSource` is load-bearing: `claim-job-integrity.js` has a documented
fail-open path when the chain read is unavailable at claim time. A receipt must
say which of the two happened rather than implying a verified pin that was not
performed.

### G2 — Gas retention is invisible in settlement

**This is a truth-boundary defect in production today, not merely a missing
feature.** EscrowCore v3 charges worker-side gas retention (live since
2026-08-13; first charge 2026-08-16, tx `0x4f0c2a63…`, `GasRetentionApplied(50000,
250000)`). The receipt's `settlement` block records `workerAmount` — which is
*already net of retention* — plus the poster fee, and nothing else.

Consequence: on the proven settlement, a worker's receipt shows a 0.20 payout for
a job advertised at 0.25, **with no field that explains the missing 0.05.**

Good news on cost: the data is already flowing. `blockchain/abis.js:205` declares
the event and `blockchain/event-listener.js:96` registers a handler that emits
`escrow.gas_retention_applied` onto the timeline with `retainedRaw` and
`rewardRaw`. The gap is only that `normalizeSettlement()` in `run-receipt.js`
predates the fee era and reads three fields (`workerAmountRaw`,
`protocolFeeAmountRaw`, `protocolFeeBps`). **No new capture is required — the
receipt builder needs to consume evidence the platform already has.**

Add to `settlement`:

```
rewardAmount(+Raw)      the gross pinned reward (0.25 in the proven case)
gasRetentionAmount(+Raw)  from GasRetentionApplied
gasRetentionBps
brokered                bool — retention only applies to brokered claims
waived                  bool — onboarding waiver (waived ⇒ retention 0)
settlementTx            the settlement transaction hash
```

Invariant the tests must assert: `rewardAmountRaw == workerAmountRaw +
gasRetentionAmountRaw + protocolFeeAmountRaw` for a poster-side-additive fee era,
or the receipt is not internally reconcilable. Any job where that does not hold
is a bug to surface, not to round away.

### G3 — Verdict vocabulary is too narrow for Verify

`FINAL_OUTCOMES` is `{approved, rejected}`. The Verify shelf needs two more, and
neither is a contract change:

- `inconclusive` — the profile ran but could not decide (flaky target,
  environment failure, ambiguous evidence). **No settlement action**; routes to
  human review or refund. Must never silently read as `rejected`.
- `platform_fault` — our fault. Carries `workerConsequence: "none"` explicitly in
  the receipt so the fairness invariant is *visible in the artifact*, not only
  enforced in code.

Add `verdict.workerConsequence` (`"none" | "stake_slashed" | "no_payout"`) and
widen `FINAL_OUTCOMES`. Settlement still fires on `approved` alone.

Rename `verifier.handler`/`version` into the profile vocabulary the product
sells — `successPolicy { profile, version }` in `intent`, mirrored by
`verifier { profile, version, wallet, mode }`. Keep the old keys as aliases for
one release; the profile registry in Phase V pins these values.

### G4 — Artifact and source-binding evidence is collapsed into one hash

Today: `evidenceHash` = hash of the verification input. That proves *what was
checked*, not *what was submitted* or *whether the source was bound*. The
offline git-bundle binding (strict fsck, single-ref, tamper drill) produces
exactly this evidence and it is not surfaced.

Add to a new `execution` block (moving the existing worker/chainJobId fields in
beside them, keeping top-level aliases for one release):

```
execution {
  provider          address (= worker)
  providerClass     "ours" | "external" | "unknown"   from SelfIdentityRegistry
  artifactHash      hash of the submitted artifact
  sourceBinding { method, verified, ref, bundleHash }   git-bundle result
  evidenceHash      unchanged
  environment       verifier runtime identity
}
```

`providerClass` is what makes the north-star metric (external verified outcomes
settled per week) derivable **from receipts alone**.

### G5 — No content-addressed receipt id, and the URL says "badge"

The receipt is keyed by `sessionId` and served under `/badges/:sessionId/run`.
For a portable object referenced from MCP responses, ERC-8004 validation entries,
and PRs, we need:

- `receiptId` = `hashCanonicalContent(receipt-without-signers)` — content-
  addressed, stable, verifiable by a third party who re-canonicalizes.
- `GET /receipts/:receiptId` (JSON) and `GET /receipts/:receiptId` HTML page on
  the public site. Keep `/badges/:sessionId/run` as a permanent alias — nothing
  that exists may break.

Naming law: badges attest reputation, receipts attest work. Do not merge them.

## 3. Deliverables

1. `core/work-receipt.js` — `averray.work-receipt.v1`, built by extending
   `buildRunReceipt` rather than forking it. Old schema version continues to
   validate; new fields are additive.
2. Retention capture: plumb `GasRetentionApplied` + gross reward from the
   settlement event decode into the verification/settlement object that
   `verification-ingestion-service.js` already passes in.
3. Intent capture: carry the claim-time `specHash` snapshot through the session
   so it is available at verdict time.
4. Verdict widening: `inconclusive`, `platform_fault`, `workerConsequence`.
5. Routes: `GET /receipts/:receiptId` JSON + public HTML page; `/badges/:sessionId/run`
   alias retained.
6. Backfill (best-effort, forward-emit is the contract): re-derive receipts for
   settled jobs where all evidence exists. The canary and acceptance-wallet runs
   qualify and make good fixtures — including the 2026-08-16 retention job, which
   is the regression fixture for G2.

## 4. Tests that must exist

- **Reconciliation invariant** (G2): a settled brokered non-waived job's receipt
  satisfies `reward == worker + retention + posterFee`. Assert against the real
  2026-08-16 settlement as a fixture.
- **Waived path**: `waived: true ⇒ gasRetentionAmountRaw == "0"` and the
  reconciliation still holds.
- **Fail-open honesty** (G1): when claim-time chain read was unavailable, the
  receipt says `chain_unavailable_fail_open` — never `chain_verified`.
- **Verdict fairness** (G3): a `platform_fault` receipt always carries
  `workerConsequence: "none"`; mutating the code to emit a consequence must fail
  the test (mutation-drill style, per the design-handback gate law).
- **Content addressing** (G5): re-canonicalizing a served receipt reproduces its
  `receiptId`; any field mutation changes it.
- **No regression**: existing `run-receipt.test.js` passes unchanged.

## 5. Explicitly out of scope

Aggregation and scoring (that is Trust Graph); routing; any claim broader than
the single recorded run; ERC-8004 writes (rides #236); warranty language. A
receipt states what happened in one run, with evidence, and nothing more.

## 6. Open decision for Pascal

Public receipt page placement — **recommendation: `averray.com/receipts/:id`**
on the public site, beside the existing transparency page, rather than a
subdomain or an operator-app route. It is a public artifact meant to be linked
from PRs and MCP responses; it must not sit behind the operator shell. Note the
standing gotcha: two allow-lists must be updated or new public marketing pages
silently fail to deploy.
