# PACKET — Arbitration from the app: the arbitrator signs on the phone, the backend does the rest

Status: ready for implementation. **One PR series, deadline-bound:** the two
operator-overturned disputes (`dispute-99bd8759536d` playsouthwales,
`dispute-0760de0b2118` TricklePay) opened 2026-09-15T20:24Z; the contract's
`ARBITRATOR_SLA` lets anyone call `autoResolveOnTimeout` (half payout) from
**2026-09-29T20:24Z**. The operator decided on 2026-09-15 to sign from the
app, not the tunnel page, so this must be live by **2026-09-25**. Fallback
if it slips: `docs/evidence/arbitration-page-2026-09-15.html` served through
a tunnel (the 08-01 method), calldata already gated.

## Why (2026-09-15, verified live)

- The mainnet arbitrator is a phone wallet (`0x7a246c…`, `policy.arbitrators`
  has exactly one member; the backend holds no arbitrator key — this is law,
  see `docs/MAINNET_CREDENTIALS_PLAN.md` F6). Every `resolveDispute` is a
  human signature. Correct, and it should cost two taps, not a terminal
  session, a cloudflared tunnel and a hand-written HTML file — which is what
  it cost on 08-01 and again tonight.
- The operator app cannot reach the phone: `app/lib/auth/wallet-provider.js`
  supports injected and WalletConnect providers, but WalletConnect is
  disabled because `NEXT_PUBLIC_WC_PROJECT_ID` is set nowhere
  (`WalletConnectDisabledError: "WalletConnect mobile signing is not enabled
  yet."`). The disputes drawer's `DecisionPanel` submits `POST
  /disputes/:id/verdict`, which on mainnet fails closed
  (`out_of_band_hardware`) unless the job is already `Closed` on chain.
- After a hardware signature the operator must still POST the verdict by
  hand so the session converges; the `DisputeResolved` listener only emits an
  event (`blockchain/event-listener.js:245`).
- A `human_fallback` verdict (`pr-helpcode-ai-anythingmcp-600:0xD136…`,
  settled `disputed` tonight) moves the session to `disputed` and **never
  touches the chain**: the escrow stays `Submitted`, `resolveDispute` needs
  `Disputed`, the verdict route needs a backend arbitrator, the poster-review
  path refuses curated jobs (`poster_review_external_job_required`). On
  mainnet a human-review verdict has no road to the chain at all.
- The first ceremony (08-01, tx `0x7afd7fbf…`) used a public rationale URL as
  `metadataURI` and `encodeBytes32String("DISPUTE_OVERTURNED")` as the reason
  — the app path must produce the same shape so receipts stay comparable.

## The fix

1. **Prepared resolution.** `POST /disputes/:id/prepare {verdict, rationale,
   workerPayout?}` (admin or verifier role) validates against
   `buildDisputeResolution`, persists the reasoning content record
   (`buildDisputeReasoningReceipt` — the same record the verdict route
   writes today), and returns `{ to: escrow, data, decoded: { jobId,
   workerPayout, reasonCode, metadataURI }, chainId, arbitrator,
   remainingPayout, preparedAt, preparationId }` with `metadataURI =
   publicContentUri(hash)` so the on-chain pointer resolves to the rationale
   before anyone signs. Re-preparing with the same inputs is idempotent;
   different inputs supersede (the chain will only accept one anyway).
2. **Sign from the app.** In the disputes drawer, when
   `arbitration.execution.mode === "out_of_band_hardware"`, the decision panel
   becomes: pick verdict + rationale → **Prepare** → the decoded call is shown
   (jobId, payout in USDC, reason, metadataURI, live escrow state read via the
   backend) → **Sign with the arbitrator wallet** → connect (WalletConnect QR
   for the phone, injected as a fallback), refuse any account that is not the
   registered arbitrator or any chain but 420420419, `sendWalletTransaction`
   with the prepared calldata, show the tx hash and receipt status. The
   button is enabled only when the live escrow is `Disputed` and the payout
   fits `reward − released`. No page, no tunnel.
3. **Automatic convergence.** The `DisputeResolved` listener, for a session in
   `disputed`, runs the same receipt convergence the verdict route runs for an
   already-Closed job (`alreadyResolvedOnChain` branch): verdict receipt with
   `chainStatus: confirmed`, `txHash`, `workerPayout` from the event, session
   `disputed → resolved|rejected`, `operatorOverturn.resolution` when the
   session carries an overturn, idempotent against a later manual POST. The
   drawer shows "resolved on chain, converged" without a second action. A
   `DisputeResolved` whose payout does not match the prepared resolution
   converges with what the chain says and raises a warning naming both.
4. **Human verdict for human-review sessions.** `POST /admin/sessions/human-verdict
   {sessionId, verdict: "approve"|"reject", rationale}` (admin) for a session
   whose local status is `disputed` from a `human_fallback` verdict and whose
   escrow is `Submitted`: approve → `resolveSinglePayout(true,
   HUMAN_REVIEW_APPROVED, metadataURI)` through the verifier signer (normal
   economics, badge, reputation); reject → `resolveSinglePayout(false,
   HUMAN_REVIEW_REJECTED, metadataURI)` — the worker keeps the contract's
   7-day `openDispute` window, exactly as after any rejection. Both persist a
   verdict receipt (`decidedBy`, rationale hash, tx) and transition the
   session; `/verifier/result` projects the human verdict as the current
   outcome with the `human_fallback` verdict as history (reuse
   `projectOverturnedVerification`'s shape). This route never touches a
   `Disputed` escrow — that is the arbitrator's.
5. **WalletConnect on.** Operator item: create a Reown/WalletConnect Cloud
   project (free), set `NEXT_PUBLIC_WC_PROJECT_ID` in the app build env
   (public value, not a secret; deploy templates + the static-export step
   must carry it). Until it is set the drawer says so and offers the injected
   path only.

## Non-negotiables (each pinned by a test; I run the drills)

1. Prepared calldata re-encodes byte-exact from its decoded fields and the
   selector is `resolveDispute(bytes32,uint256,bytes32,string)`; reason is
   `encodeBytes32String`, never keccak. Mutation: keccak the reason — must
   fail.
2. `prepare` refuses a payout above `reward − released`, a verdict outside
   `DISPUTE_VERDICTS`, and a rationale shorter than the existing minimum; it
   never sends a transaction. Mutation: send — must fail.
3. Drawer: the sign button is disabled unless account == arbitrator, chain ==
   420420419 and live state == `Disputed`. Mutation: drop the account check —
   must fail.
4. Convergence: a `DisputeResolved` for a `disputed` session with an overturn
   yields `resolved`, `operatorOverturn.resolution.workerPayout` == event
   payout, receipt `confirmed`; a later manual POST replays the receipt
   without a second transition. Mutation: transition twice — must fail.
5. Human verdict: approve on a `Submitted` escrow pays through
   `resolveSinglePayout(true)`; reject leaves the worker's dispute window;
   the route refuses a `Disputed` escrow and any session not in
   `human_fallback`-disputed state. Mutation: allow it on `Disputed` — must
   fail.
6. Result projection after a human verdict: outcome is the human's, the
   `human_fallback` verdict is `originalVerdict`; the profile counts the
   payout. Mutation: keep the original as current — must fail.
7. With `NEXT_PUBLIC_WC_PROJECT_ID` unset the drawer explains and still
   offers injected signing; with it set, WalletConnect pairing is offered.
   Mutation: hide both — must fail.

## Runbook after landing (operator)

Open Disputes → pick `dispute-99bd8759536d` → dismissed, rationale
"Platform fault, see #1374", Prepare → Sign on the phone → wait for
"converged". Same for `dispute-0760de0b2118` (payout is the operator's call;
full 2.0 recommended). Then Sessions → anythingmcp → human verdict.

## Out of scope

Changing who the arbitrator is; a backend arbitrator signer (refused for
good); split verdicts UI beyond what exists; anything on the contract.
