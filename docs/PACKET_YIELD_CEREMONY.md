# PACKET 6 — The yield ceremony (bank-lane step 5)

**Author:** Claude (gates handback + choreographs the ceremony) · **Implementer:** Codex
(the guarded script) · **Operator:** Pascal (runs it, KMS creds) · **Date:** 2026-08-12

This makes deposits *earn*: pool buffer capital deployed to the venue through the pool's
dedicated lane (`0xAbDca8AA…7f34` → wrapper → XCM → Hydration/Aave — epoch-1's proven
mechanics on the pool's own rails). Everything below uses the pool's real surface:
`deployToVenue(assets, returnBy)` / `settleVenueDeployment` / `recallVenueDeployment` /
`recordVenueReturn` (`DepositPool.sol:357/395/421/484`), all operator-gated to
`0x5a6836…5813` — **KMS-signed ops, not multisig**; the multisig's work ended at the
wrapper registration.

## 0. Preconditions — all four, none waivable

1. **The buffer holds real assets** — the dogfood deposit is done, or Pascal seeds via
   `contributeOperatorPrincipal(assets)` (the operator-principal path exists exactly for
   this; it mints shares to the operator like any depositor, cost-basis rules apply).
   No yield ceremony against an empty pool — there is nothing to deploy and the roadmap
   forbids it.
2. **Observability is live and green** — #1097 deployed, board tile rendering real state,
   tombstone probe armed. The ceremony's own transactions are the probe's first qualifying
   events; running before the watcher exists wastes the proof.
3. **No pending redemptions** (`requestRedeem` queue empty) — read, not assumed.
4. **Fresh heads** — this is a multi-leg async ceremony with XCM in the middle. Same rule
   as the pool deployment: never same-day alongside incident work.

## 1. The policy — decided

- **Deployed fraction cap: ≤ 50% of `totalAssets`.** The buffer keeps ≥ 50% at all times
  at this scale — redemptions must be servable from buffer without a recall.
- **`returnBy` discipline:** every deployment names a real deadline. Proof tranche:
  **+48 hours**. Standing deployments: **+7 days** — the deployed contract's own maximum
  (`VenueDeadlineExceedsNoticeTier`: a deadline may never exceed the shortest redemption
  notice tier, so capital is always recallable before any depositor's exit matures — a
  stronger invariant than this packet's original 14-day figure, which the script rightly
  refuses; corrected 2026-08-12 after Codex's gate finding). Re-deploy on settle, weekly
  cadence. An expired `returnBy` is an incident, not a shrug.
- **Inherited on-chain guards** the ceremony gets for free and the script must surface in
  its evidence blocks: `BufferFloorBreached` (the contract enforces its own buffer floor)
  and `DEPLOYMENT_EPOCH = 1 day` (`DeploymentEpochNotElapsed` — at most one deployment per
  day-epoch, so leg D cannot follow leg A same-day; plan the ceremony across two days or
  accept the epoch wait).
- **At this scale the yield is cents and the point is the loop.** The ceremony's product
  is a *proven* deposit→earn→recall→recognize cycle on the pool's rails, with every book
  entry matching chain — the same thesis epoch-1 proved for the operating position
  (friction 0.202%), now proven where depositors' money lives.

## 2. The ceremony — round trip REQUIRED before any standing deployment

**Leg A — proof tranche out:** `deployToVenue(2_000_000, now+48h)` (2 USDC).
Expected: `VenueDeploymentCreated(deploymentId, adapterRequestId, 2e6, returnBy)`;
`venuePrincipalCostBasis += 2e6`; `buffer + deployed == totalAssets` holds; far-side
evidence (aUSDC position on Hydration carrying the adapter requestId — the epoch-1
evidence pattern) captured before proceeding.

**Leg B — async settle:** `settleVenueDeployment(deploymentId)` once the adapter reports
terminal status. Expected: `VenueDeploymentSettled(…, status, settledAssets)`.

**Leg C — partial recall:** `recallVenueDeployment(deploymentId, 500_000)` (0.5 USDC).
Expected: `recordVenueReturn` fires via the adapter; buffer rises by the returned amount;
**yield recognition math verified by hand**: anything above remaining cost basis for that
tranche is realised yield, share price steps accordingly — the cost-basis rule (#1075 §0)
observed live for the first time. The tombstone probe must classify all of A–C as
qualifying events (no page); its silence here is itself an acceptance item.

**Leg D — standing deployment:** only after A–C reconcile exactly: deploy up to the 50%
policy with the 14-day `returnBy`.

**Abort rule:** any leg's books-vs-chain mismatch stops the ceremony with capital
recallable via C's proven path — the un-revertable part (XCM in flight) is bounded to the
2 USDC proof tranche by construction.

## 3. Codex builds: `scripts/ops/pool-venue-ceremony.mjs`

Mirror the proven money-script shape (`fund-signer-usdc-deposit.mjs` / #1093's repoint):

- Dry-run default; `--commit` + `--use-kms` (operator = the backend KMS signer via
  `op://mainnet-backend/aws-signer-mainnet` creds, `--expected-signer` guard mandatory).
- Subcommands per leg (`deploy`, `settle`, `recall`) each with **precondition asserts**
  (buffer, caps, pending-redemptions-zero, policy fraction) and **postcondition asserts**
  (cost-basis delta exact, reconciliation invariant, event presence) that print the
  evidence block — the log is the ceremony record.
- Refuses `deploy` when `assets > 50%` of totalAssets or when `returnBy` exceeds policy.
- No new contract code, no `deployments/` changes (all addresses already in the manifest).

## 4. Acceptance (Claude gates the script before the ceremony; then gates the ceremony)

Script handback: dry-run against mainnet prints the full leg-A plan with live reads;
guards refuse wrong signer / over-policy / pending redemptions (tests with mocked reads);
postcondition assertions fail loud on injected mismatch. Ceremony: each leg's evidence
block matches my independent chain reads (same discipline as the pool deployment);
`yieldStatus` flips to `earning` automatically at leg A (endpoint + tile + packet-4 field,
one source — verify all three); buffer alert visibly armed; tombstone silent throughout;
share price unchanged through A–B and stepped correctly at C.

## 5. The seams, re-stated one last time (they become real at leg C)

- **Yield-step timing:** a depositor entering just before a profitable recall captures the
  step. Accepted at this scale; the on-chain `NoticeTier` redemption machinery is the
  future lever — economics decided with data, after real deposits behave.
- **Epoch-1's unbooked yield** (operating position, separate books): unchanged by this
  ceremony; revisit at the operating position's own recall.

## 6. Not in scope

Raising pool caps · promoting deposits publicly (after this proves the loop) · lock-up
economics · touching the operating lane's position · EscrowCore v3.
