# Arbitration from the operator app

Implements `PACKET_ARBITRATION_FROM_THE_APP.md` at `82e01e8a` on
`claude/packets-2026-08-12`. Target deployment: **2026-09-25**. The two
operator-overturned disputes opened at 2026-09-15T20:24Z; their arbitrator
window ends **2026-09-29T20:24Z**. This document is a runbook, not evidence
that either dispute has been signed or paid.

## Preconditions

- CI and the normal serialized production deploy must pass first.
- Sign into the operator app as an admin or verifier. The signing wallet
  is separate from the operator's authenticated review session.
- `PUBLIC_BASE_URL` must point to the public backend so the prepared
  `metadataURI` resolves before signing. Rationales and the deciding wallet
  are public: do not include secrets or private customer information.
- The public WalletConnect project ID and rollout flag already travel in
  `deploy/backend.env.template`, `deploy/backend.mainnet.env.template`, and
  the root `package.json` `build:frontend` static-export command. No new
  secret, arbitrator key, contract, or Reown project is introduced here.
  Check that the existing project's domain allow-list permits the operator
  app. Phone pairing remains an operator acceptance check; local fixtures
  cannot prove access to a real phone wallet.
- The manifest's arbitrator address is only a candidate: the backend checks
  `TreasuryPolicy.arbitrators(address)` live and requires chain **420420419**.
  The backend never receives the arbitrator's private key (credentials plan F6).

## Resolve a chain dispute

1. Open Disputes and select `dispute-99bd8759536d` (playsouthwales).
2. Choose **Dismiss dispute**, enter the public rationale (for example,
   `Platform fault, see #1374`), confirm review authority, then **Prepare arbitration**.
3. Inspect escrow, job ID, worker payout, remaining payout, bytes32 reason,
   and the public rationale link. Preparation stores the rationale but sends
   **no transaction**. Identical inputs replay; changed inputs supersede the
   previous preparation.
4. Connect the registered arbitrator's phone through WalletConnect, or use
   the injected-wallet fallback. Missing WalletConnect build configuration
   is stated explicitly; injected signing remains available.
5. **Sign with the arbitrator wallet** is enabled only for the registered
   account, Hub mainnet, a live Disputed escrow, the current preparation,
   matching calldata/escrow, and a payout within `reward - released`.
   Those checks run again immediately before requesting the signature.
6. Approve the transaction on the wallet. Check its hash and receipt status,
   then wait for **Resolved on chain, converged.** No follow-up verdict or
   stake-release POST is required. The contract performs stake accounting.
7. Repeat for `dispute-0760de0b2118` (TricklePay). The payout is the
   operator's decision; inspect the live amount, not a number from this runbook.

The `DisputeResolved` event's payout is authoritative. A different prepared
payout produces `arbitration_prepared_payout_mismatch` with expected and
actual **base-unit** amounts, while the receipt converges to the chain value.
Retries or a later manual verdict POST reuse the confirmed receipt rather
than transitioning or paying twice. A transient convergence write failure
keeps the listener cursor before the event for retry.

If the wallet reports an uncertain send, inspect its transaction history
before retrying. If chain confirmation occurs while the backend is offline,
do not sign again: check `/disputes/:id`, and use the existing already-Closed
manual verdict convergence path if the listener missed the event. Do not
interpret a locally pending session as proof that the chain transaction failed.

## Decide a human-fallback review

Open Sessions, select the anythingmcp session, and use **Human verdict** as
an admin. Supply a public rationale of at least 20 characters.

- Approve uses the verifier's normal `resolveSinglePayout(true, ...)` path,
  with normal economics and receipt/badge ingestion.
- Reject uses `resolveSinglePayout(false, ...)`. It leaves escrow Rejected
  and preserves the worker's existing seven-day `openDispute` opportunity;
  it does not open arbitration for them.
- Only a locally disputed `human_fallback` verdict on a Submitted escrow is
  eligible. A Disputed escrow is refused: it belongs to the arbitrator.
- The result exposes the human outcome, deciding wallet, rationale hash,
  and transaction; `originalVerdict` preserves the fallback history. Profile
  earnings use the actual worker payout, including normal retention.
- Retries must use the same decision, rationale and operator. A durable
  checkpoint allows a confirmed chain transaction to be recovered without
  sending a second payout if its response or local ingestion failed.

## Verification and fallback

Pinned tests live in `dispute-arbitration-service.test.js`,
`human-verdict-service.test.js`, and `app/lib/chain/arbitration.test.mjs`.
They cover the seven packet drills plus public rationale reads, HTTP roles,
supersession, exact base units, write-failure replay and lost-response recovery.
`scripts/ops/walletconnect-env-contract.test.mjs` pins the existing build/env wiring.

Local browser verification uses only mock API and wallet responses. It proves
the prepare/sign controls, wrong-account refusal, decoded call rendering,
convergence display, and human-review form; it does not prove a live signature.

If deployment slips past September 25, the packet's fallback is the existing
`docs/evidence/arbitration-page-2026-09-15.html` served through an operator-run
tunnel. The operator must act before the September 29 deadline. This change
does not run the fallback, operate production, or sign either dispute.
