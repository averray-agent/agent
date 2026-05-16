# Dispute Verdict Live-Proof Gate

Single-page runbook for proving `POST /disputes/:id/verdict` on the
hosted stack. The launch checklist line ("phase-0 dispute verdict path
exercised on hosted stack") cannot flip on a dry-run alone — the
gateway must dispatch `EscrowCore.resolveDispute` against the deployed
contract, the on-chain tx state must come back to the API, and the
operator must see the right fields on both the response and the
persisted dispute. This doc names the preconditions, the proof
sequence, and the unresolved `/release` semantics question so launch
day is not a guess.

The mechanical harness is already in
[`scripts/ops/run-dispute-verdict-proof.mjs`](../scripts/ops/run-dispute-verdict-proof.mjs)
(dry-run default, live behind `DISPUTE_PROOF_LIVE=1`). The exact
checklist invocation is in
[`PRODUCTION_CHECKLIST.md`](./PRODUCTION_CHECKLIST.md) §7 and is not
duplicated here. This runbook is what an operator reads *before*
flipping `LIVE=1` for the first time.

## Preconditions (must hold before any live verdict)

The proof harness will refuse to mutate if any of the first three
input-level checks fail; the others must be confirmed by the operator
out-of-band before the run is meaningful.

### 1. Operator inputs

- `ADMIN_JWT` set to a JWT issued for the **arbitrator wallet**, not
  any admin/operator wallet. The route accepts `admin` OR `verifier`
  roles, but the on-chain call rests on the wallet being in
  `TreasuryPolicy.arbitrators`.
- `DISPUTE_PROOF_ID` set to a specific real dispute id whose current
  state is `status: "open"` and `verdict: null`. The harness fetches
  the dispute first and refuses to proceed otherwise.
- `DISPUTE_PROOF_VERDICT` set to one of `upheld | dismissed | split |
  timeout`.
- `DISPUTE_PROOF_RATIONALE` set to the arbitrator's reasoning text
  (the harness rejects empty / whitespace-only values).
- For `split` only: `DISPUTE_PROOF_WORKER_PAYOUT` set to a positive
  number ≤ the dispute's remaining payout.

### 2. Capability + role surface

The route is gated by:

- Authentication: `Authorization: Bearer <ADMIN_JWT>`.
- Role: `admin` OR `verifier` per
  [`mcp-server/src/protocols/http/server.js`](../mcp-server/src/protocols/http/server.js)
  at the `/disputes/:id/verdict` handler. Both roles satisfy the
  route guard.
- Capability: `disputes:verdict` is in the `verifier` role expansion
  in [`mcp-server/src/auth/capabilities.js`](../mcp-server/src/auth/capabilities.js)
  (admins inherit it via the verifier role at request time).

If the readiness check fails with a 401/403 here, the JWT was issued
for a wallet without the right role/capabilities — fix the JWT, not
the dispute.

### 3. Gateway + arbitrator config

The route only dispatches on-chain when
`gateway.isEnabled() === true`. With gateway disabled the response
returns `chainStatus: "local_only"` and `txHash: undefined`. That is
intentional (lets the operator surface stay useful during development)
but means **a `local_only` outcome does not pass the launch gate**.

Required env on the backend for live dispatch:

- `AVERRAY_RPC_URL` — Polkadot Hub EVM RPC.
- `ESCROW_CORE_ADDRESS` — deployed `EscrowCore` contract address.
- Arbitrator signer key — the wallet behind this key is what
  `EscrowCore.resolveDispute(...)` is called with.

Required on-chain config:

- The arbitrator signer's wallet must be set true in
  `TreasuryPolicy.arbitrators` via a multisig
  `setArbitrator(arbitratorWallet, true)` call. The reference flow is
  in [`docs/MULTISIG_SETUP.md`](./MULTISIG_SETUP.md). Without this,
  `EscrowCore.resolveDispute` will revert and the verdict will fail
  the chain dispatch.

Required on the deployed `EscrowCore` for the specific dispute id:

- The job state must be in `Disputed`. The verdict route trusts the
  off-chain dispute record's `status: "open"`; the on-chain side
  enforces its own invariant. If the chain says the job is already
  `Resolved` (or never reached `Disputed`), the `resolveDispute` call
  will revert, the response throws, and the harness fails closed
  with a 5xx — no receipt is persisted in that case.

## Proof sequence

Two phases. Both invoke
[`scripts/ops/run-dispute-verdict-proof.mjs`](../scripts/ops/run-dispute-verdict-proof.mjs);
see [`PRODUCTION_CHECKLIST.md`](./PRODUCTION_CHECKLIST.md) §7 for the
exact command lines.

### Phase A — dry-run (always run first)

The harness in dry-run mode (no `DISPUTE_PROOF_LIVE=1`):

1. Validates all inputs locally — refuses on missing id, empty
   rationale, invalid verdict, split-without-payout, etc.
2. Fetches `GET /disputes/:id` and asserts the dispute is currently
   `status: "open"` with no prior verdict. If the dispute was already
   resolved or doesn't exist, the harness exits non-zero **without
   touching any mutation path**.
3. Prints the exact JSON payload it would POST to
   `/disputes/:id/verdict` in live mode.

A clean dry-run is the readiness check. It confirms inputs + dispute
state + capability surface (the `GET` requires `disputes:read` /
`disputes:list`) without paying any mutation cost.

### Phase B — live (only after dry-run is clean)

Flip `DISPUTE_PROOF_LIVE=1`. The harness then:

1. POSTs to `/disputes/:id/verdict` with the validated payload + an
   explicit `idempotencyKey` (`dispute-proof-<id>` by default).
2. Verifies the response shape carries the required evidence fields.
3. Re-fetches `GET /disputes/:id` and confirms the persisted record
   matches the response (catches the failure mode of "API echoed
   back a receipt but did not actually write it").

## What the response must carry

Required evidence fields on the verdict response (the harness asserts
all of these; reproducing here so a reviewer doesn't have to read the
script):

| Field | Constraint |
|---|---|
| `verdict` | One of `upheld | dismissed | split | timeout`, matching the input. |
| `reasonCode` | One of `DISPUTE_LOST | DISPUTE_OVERTURNED | DISPUTE_PARTIAL | ARB_TIMEOUT` (derived from verdict). |
| `reasoningHash` | 0x-prefixed 32-byte hex. Deterministic hash of the canonical reasoning content. |
| `metadataURI` | `urn:averray:content:<hash>` (no `PUBLIC_BASE_URL`) or `<base>/content/<hash>` (with). Always present. |
| `chainStatus` | One of `confirmed | submitted | local_only`. **`confirmed` or `submitted` is the launch-gate pass condition.** |
| `txHash` | Present when `chainStatus ∈ {confirmed, submitted}`. Hex tx hash from `gateway.resolveDispute`. |
| `blockNumber` | Present when `chainStatus === confirmed`. |
| `timeline[]` | Contains a `verdict_submitted` entry with the response fields. |

Required evidence on the re-fetched persisted dispute:

| Field | Constraint |
|---|---|
| `status` | `"resolved"`. |
| `reasoningHash` | Equals the response `reasoningHash` (proves persistence, not just echo). |
| `metadataURI` | Equals the response `metadataURI`. |
| `txHash` | Equals the response `txHash`. |
| `chainStatus` | Equals the response `chainStatus`. |

Required on the side surfaces:

- **`GET /content/<reasoningHash>`** returns the arbitrator reasoning
  record with `contentType: "arbitrator_reasoning"` and
  `visibility: "owner_only"`. The arbitrator and the dispute claimant
  can read; strangers see 403 until the 6-month auto-public window
  elapses. (Tested in `mcp-server/src/protocols/http/server.smoke.test.js`
  for the local_only case; the hosted-stack proof must observe the same
  shape.)
- **`escrow.dispute_resolved` event** (visible via
  `GET /admin/jobs/timeline?topics=escrow.dispute_resolved` or
  `/events`). Per [PR #290](https://github.com/averray-agent/agent/pull/290)
  the event data carries `openedAt`, `windowEndsAt`, `slaSeconds`,
  `reasonCode`, `reasoningHash`, `metadataURI`, `txHash`, `blockNumber`,
  `chainStatus`. A consumer reading this event alone has enough state
  to render the dispute lifecycle without re-fetching the dispute.

## What does NOT pass the gate

- `chainStatus: "local_only"`. The gateway must actually dispatch.
- `chainStatus: "confirmed"` but no matching dispute on re-fetch.
  That's the "echoed but not persisted" failure mode and is a real
  blocker, not a transient — the harness fails closed.
- A clean dry-run by itself. Dry-run proves inputs + dispute state +
  capability surface. It does not exercise the gateway. Both Phase A
  and Phase B must run.

## The unresolved `/release` semantics question

`POST /disputes/:id/release` exists today but it does **not** call
the chain. The handler records a mutation receipt in the state-store
under bucket `dispute_release`, emits an `account.job_stake_released`
event, and appends a `stake_release_recorded` entry to the dispute
timeline. The route's response field `chainStatus` is set to
`settled_by_verdict` when the prior verdict already populated a
`txHash`, and to `local_only` otherwise. No new on-chain call is
issued.

This is structurally fine because **`EscrowCore.resolveDispute`
already moves the stake on-chain at verdict time** — the verdict
call carries the `workerPayout` parameter and the contract settles
the worker side accordingly. The `/release` route exists for
operator-visible record-keeping (and for the future mutual-release
case where the operator wants to log an explicit release event
without re-issuing a verdict, e.g. a settlement reached out of band).

The unresolved question for launch is:

- **Option A (status quo): receipt-only.** `/release` stays a
  record-keeping endpoint. The on-chain stake movement happens in
  the same `resolveDispute` tx as the verdict. Pros: smallest
  surface, no second tx, no second approval gate. Cons: there's no
  way to record an on-chain "release without verdict" event if one
  is ever needed for non-dispute mutual settlements.
- **Option B: introduce an explicit on-chain release.** Add a
  contract function (e.g. `EscrowCore.releaseStake(jobId, ...)`)
  callable by the arbitrator role, separate from `resolveDispute`.
  `/release` would then dispatch through the gateway like
  `/verdict` does. Pros: clean separation of "decide" and "pay
  out." Cons: new contract surface needs an audit pass and a
  deploy; doubles the dispute-side tx cost; requires deciding
  what the new function's stake-movement semantics are.

This decision is not blocking the launch checklist gate (the
checklist only requires the **verdict** path to be proven). But the
ambiguity should be closed before any operator runbook prescribes
`POST /disputes/:id/release` as a step in a real dispute workflow,
because the answer changes what evidence operators should expect
from a release call.

Today: treat `/release` as a record-keeping endpoint. Do not assume
it moves on-chain state. The verdict call is the on-chain action.

## What this runbook does NOT cover

- **Operator-app UI surfacing** of `disputedAt`, SLA countdown,
  `chainStatus`. The backend already exposes those fields per
  [#290](https://github.com/averray-agent/agent/pull/290); the
  frontend gate is tracked separately.
- **Arbitrator key provisioning + multisig `setArbitrator(...)`
  call.** Covered in `docs/MULTISIG_SETUP.md`.
- **Dispute notification path** (email/messaging). Out of band.
- **The proof harness internals.** See
  [`scripts/ops/run-dispute-verdict-proof.mjs`](../scripts/ops/run-dispute-verdict-proof.mjs)
  and its tests
  ([`scripts/ops/run-dispute-verdict-proof.test.mjs`](../scripts/ops/run-dispute-verdict-proof.test.mjs)).
- **Restoring or rolling back a verdict** if it dispatches to the
  wrong on-chain state. There is no rollback; the multisig has to
  issue a corrective `setArbitrator` or contract upgrade if a real
  mistake lands on-chain.
