# MEMO — Receipt-gated escrow release (P-ESCROW-AGENT, roadmap ticket 4)

Status: **RATIFIED — E1–E9 locked (Pascal, 2026-08-24)** · drafted 2026-08-23 ·
Author: Claude (architect) · Implementer: Codex (packet follows roadmap ticket 1, per E8)

## What Product asked

> P-ESCROW-AGENT — receipt-gated Hub USDC (asset 1337) release. Escrow MUST
> consume the `averray.work-receipt.v1` hash/commitment. PASS releases,
> timeout/fail refunds. MCP/HTTP agent-callable. An internal settlementTx /
> operator path is not success.

## What the rails already provide

All facts below verified against `contracts/EscrowCore.sol` and backend source
at `main` = live = `9183852e` on 2026-08-23. No memory, no prose.

1. **Worker commitment already on-chain.** `submitWork(bytes32 jobId, bytes32
   evidenceHash)` stores `latestEvidence[jobId]` and emits it in
   `WorkSubmitted`/`Submitted` (EscrowCore.sol:664–684).
2. **The release path already carries a commitment slot.**
   `resolveSinglePayout(jobId, approved, reasonCode, metadataURI,
   reasoningHash)` (and `resolveMilestone`, same shape) emits `reasoningHash`
   in the `Verified` event at the exact moment of release or rejection
   (EscrowCore.sol:733–766). **The normal settlement path sends
   `ZERO_BYTES32` today** (`gateway.js:2232` default); only dispute verdicts
   populate the slot (deterministic hash, `dispute-resolution.js:258`). The
   slot exists on the money path and is unused — free to claim.
3. **Refund rails exist.** `!approved → _rejectJob`, then
   `finalizeRejectedJob(jobId)` is **permissionless** and refunds only the
   recorded poster; poster `cancelJob` exists behind `MIN_OPEN_FOR_CANCEL`;
   claim expiry is proactively reconciled since #1251.
4. **Verifier authority is a policy-registry set, not an immutable address.**
   `_onlyVerifier()` checks `policy.verifiers(msg.sender)`
   (EscrowCore.sol:275–277). New verifier contracts can be added via the
   policy contract without touching EscrowCore — this makes Option B below a
   one-small-contract change, not a v4.
5. **The receipt is content-addressed and now consumer-projected.**
   `hashWorkReceiptContent` excludes only `receiptId`/`canonicalUrl`/
   `signers`/`signature`; #1257 added the serve-time `result` +
   `assetContext` projections without touching the hash.

## The structural constraint (why Product's letter cannot be taken literally)

The full work receipt for an approved job **requires complete settlement
evidence** — `buildWorkReceipt` throws on approved-without-settlement. The
document containing the settlement tx cannot be an input to that same
settlement. So "escrow consumes the `receiptId`" is impossible as stated for
approved receipts.

What CAN precede release is the **verdict core**: the canonical slice
`{intent, execution, verdict}` — everything the receipt attests except
settlement. The binding then closes in both directions: the release tx's
`Verified` event carries the verdict-core commitment, and the finished receipt
carries the release tx. Receipt → tx → commitment → verdict core ⊂ receipt.
Anyone can replay the loop.

## Options

**A — EscrowCore v4 (contract-enforced).** Release reverts unless the
commitment matches expectations. Full successor deploy: migration of open
jobs, D-03 contract-surface gate + waiver dance, multisig ceremony (gas law:
~0.9 DOT per Hub CREATE + 1.84 upfront hold), and it reopens the audit
posture (the solo audit covered v3's logic). Weeks-scale.

**B — Satellite ReceiptGate verifier.** A one-function contract registered as
a verifier via the policy registry. The backend calls the gate; the gate
requires `commitment != 0` and forwards to `resolveSinglePayout`. Makes the
commitment structurally mandatory without touching EscrowCore or migrating
anything. One CREATE + one policy tx; audit scope is the gate alone. Still a
ceremony (D-03 manifest, multisig law), but the smallest possible one.

**C — Commitment discipline over the existing `reasoningHash` slot.** The
backend stops sending `ZERO_BYTES32`: every non-dispute
`resolveSinglePayout`/`resolveMilestone` sends the verdict-core commitment.
The receipt gains a `chainBinding` section. A public verifier script and doc
let any third party replay a receipt against its release tx. Zero contract
change, zero ceremony, no audit reopen. Enforcement is **by-audit** (a
violation is publicly catchable), not **by-contract** (the chain won't refuse
a wrong hash).

## Recommendation

**C now. B behind a demand trigger. A only if an audit cycle is planned
anyway.** C satisfies "the release transaction consumes the receipt
commitment" verbatim and independently checkably, this week, at zero ceremony
cost. Truth-boundary copy law while on C: we say **"receipt-keyed,
operator-verified"** — never "trustless" — until B or A ships.

## Decision points

- **E1 — Committed slice.** Verdict core = canonical `{intent, execution,
  verdict}` hashed by the existing canonical-content hasher. The work-receipt
  schema doc gains a "commitment" subsection with the exact field list and
  exclusion rules. Additive; **no schemaVersion bump**.
- **E2 — Channel.** The existing `reasoningHash` param on
  `resolveSinglePayout` and `resolveMilestone`. Dispute path keeps its current
  deterministic reasoning hash (senior; `reasonCode` disambiguates context).
  Non-dispute path switches `ZERO_BYTES32` → commitment. No ABI change.
- **E3 — Receipt addition.** `chainBinding { committedVerdictHash,
  verifiedTxHash, logIndex }` — **inside** hashed content for new receipts
  (it is evidence, not decoration). No backfill, no reissue: legacy receipts
  stay byte-stable and simply lack the section.
- **E4 — Refunds.** No new rails. Productize what exists: timeout → rejection
  with a dedicated reasonCode (fed by the #1251 claim-expiry reconciler),
  `finalizeRejectedJob` stays permissionless, poster `cancelJob` after the
  open floor. The agent-callable doc surfaces all three.
- **E5 — Agent surface.** Folds into roadmap ticket 3 (MCP `postJob`): add
  read-side `receiptBinding`/release-status tools. Release authority stays
  verifier-only — agents never gain a signing path.
- **E6 — Trigger for B.** First external escrow counterparty requiring
  contract-enforced release, OR sustained external posting ≥ 50 USDC/week for
  4 weeks, OR a scheduled audit engagement (fold B into its scope).
- **E7 — If B fires.** Gate contract holds no funds, has no admin surface
  beyond policy registration, one function. Budget one CREATE + policy tx;
  multisig law applies (precomputed call hash, Nova shows exactly that hash).
- **E8 — Sequencing.** The E1 slice must freeze together with roadmap
  ticket 1's receipt field set. Ship order therefore: ticket 1 (fields) →
  ticket 4 = schema commitment doc + backend `reasoningHash` + receipt
  `chainBinding` + public verifier script + copy.
- **E9 — Success criterion** (Product's "internal settlementTx is not
  success"): the deliverable is the **public replay path** — given a receipt
  URL, a third party recomputes the commitment and finds it in the `Verified`
  event of the named tx. That check becomes a weekly hosted-proof CI workflow
  over one real receipt, so the binding cannot silently rot.

## Open items before the packet

- Confirm `resolveMilestone` parity end-to-end in the gateway (slot confirmed
  in the contract; check the backend call site).
- Decode one live dispute `Verified` event to confirm the dispute-path
  `reasoningHash` semantics cannot be confused with the commitment
  (reasonCode-scoped).

**RATIFIED** by Pascal, 2026-08-24, all nine decision points as written.
Sequencing per E8: implementation packet is written after roadmap ticket 1
freezes the receipt field set.
