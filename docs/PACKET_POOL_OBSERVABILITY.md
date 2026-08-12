# PACKET 5 — Pool observability on the Bank pillar (bank-lane step 4)

**Author:** Claude (gates handback) · **Implementer:** Codex · **Operator:** Pascal
**Date:** 2026-08-12 · **Sequencing:** independent of packets 3/4; **must be live before any
external deposit is promoted** (roadmap rule: observability before strangers, never after).

The pool holds other people's money the moment step 3's dogfood runs. The operator must
never learn pool state from Subscan. Two PRs: **5a platform** (internal snapshot endpoint),
**5b board** (Bank-pillar tile + alerts). 5b merges first if convenient — it reads
`UNAVAILABLE` until 5a deploys (the B2 discipline: point at a pre-5a backend and say
unavailable, never zeros).

## 1. 5a — platform: `/monitor/deposit-pool` (internal, agent-mainnet-internal)

One snapshot, all live chain reads plus a bounded event window:

- `totalAssets`, `totalShares`, `sharePrice` (assets-per-share at a named block —
  labeled **cost-basis**: understates unrealised venue value by design, say so in the field
  name or a `pricingModel: "principal-cost-basis"` field, not a footnote)
- `buffer` = `asset.balanceOf(pool)` · `deployed` = `venuePrincipalCostBasis` —
  the two must reconcile: `buffer + deployed == totalAssets`, and the endpoint asserts it,
  emitting `reconciled: false` rather than hiding a mismatch
- caps + utilization (`TOTAL_ASSET_CAP`, `PER_AGENT_ASSET_CAP`, headroom)
- `depositorCount` + recent flows: distinct `Deposit.owner` and the last N
  `Deposit`/`Withdraw`/`RedeemRequested`/`RedeemFulfilled` events from a bounded
  `eth_getLogs` window (state the window in the payload — the two-block-windows lesson)
- `yieldStatus` — the same field packet 4 serves, one source
- Profile without `contracts.depositPool` → `available: false` + reason

## 2. 5b — board: the Bank-pillar pool tile

- Deposits, buffer vs deployed, share price + pricing model, cap utilization, depositor
  count, last flows. Real zeros display as zeros with a **"born empty"** annotation while
  `depositorCount == 0` — on this surface zeros are measurements, not absence; absence is
  only the missing endpoint/profile, which renders `UNAVAILABLE` (state both rules in a
  comment).
- Normalizer follows the arrivals-feed allowlist pattern — every new field optional,
  reconstruction explicit, coherence checks (`buffer + deployed == totalAssets`;
  `sharePrice` consistent with totals) that degrade the tile to a labeled fault rather
  than render impossible numbers.

## 3. The alerts — two new conditions on the money-alert path, one page-worthy joy

1. **The #1051 tombstone probe (critical):** under cost-basis pricing, `sharePrice` can
   change **only** when a qualifying event lands (`OperatorPrincipalContributed`,
   `RedeemFulfilled`, or the owner loss write-off). Detector: share price moved between
   observations with no qualifying event in the same window → **critical page**. This is
   the falsified attack's signature, watched continuously on chain — the difference
   between "we fixed it" and "we would know within five minutes if we were wrong."
2. **Buffer floor (pre-wired OFF):** `buffer < pending unfulfilled redemptions` → red.
   Inert until the yield ceremony deploys capital (pre-yield, buffer == totalAssets);
   ships now with a test proving it OFF, flipped by the same signal that flips
   `yieldStatus` — the ceremony must not need a board release.
3. **First-deposit notification (positive page):** `depositorCount` 0 → 1 pages once —
   a milestone and a security-relevant novelty; dedup so it never re-pages.

## 4. Acceptance (Claude verifies on handback)

- Endpoint reconciliation asserted; a mocked mismatch yields `reconciled: false`, never
  silently adjusted numbers.
- Tile: real-zero state renders zeros + "born empty"; missing endpoint renders
  UNAVAILABLE; the two are visually distinct (test both fixtures).
- Tombstone probe: mocked share-price move without qualifying event → critical alert;
  with a qualifying event → no alert; test both.
- Buffer-floor check present, OFF, flip mechanism tested in both states.
- First-deposit page fires exactly once across repeated observations (dedup test).
- Event window bounded and stated in the payload; log-read failure degrades the flows
  section only, never the live-read fields (partial truth labeled, not discarded).
- `yieldStatus` byte-identical to packet 4's source for the same state.
- Revenue-surface boundary: nothing from this packet reaches the operator app or public
  pages — Hermes board only.
- No changes to `contracts/`, `deployments/`, or any platform money path — 5a is
  read-only.

## 5. Not in scope (named)

Public/transparency-page pool stats (after dogfood, separate decision) · per-depositor
identity display (aggregate + count only; identities are on chain but the pillar does not
need them) · yield-ceremony mechanics (step 5) · historical charts (live truth first).
