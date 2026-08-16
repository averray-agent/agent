# Ceremony runsheet — EscrowCore v3 (retention + fee schedule + poster cancel)

> **STATUS: EXECUTED IN FULL.** §§0–5 executed **2026-08-13** by Codex (PR #1111) — v3 live at
> `0xC2Eb191FB75246667226a5D5Db9d821f95a5f793`, deploy blk 19414957, schedule `50000/2000/500/50000`
> live at blk 19415583. §6 + §7 executed **2026-08-16** (Claude architect-gated, Pascal operating):
> **retention proof** — non-waived brokered 0.25 claim by acceptance worker `0x60385dD6…c936`,
> settlement tx `0x4f0c2a63…7038` blk 19535884 carrying `GasRetentionApplied(50000, 250000)` +
> `SettlementSplit(workerAmount 200000, protocolFeeAmount 50000)`: treasury +0.10, the first
> protocol revenue ever charged (poster fee is operator-self-paid — `ensureJob` couples fee waiver
> to the onboarding flag; do not read self-paid fees as external revenue). **Cancel proof** — job
> force-materialized on-chain by the KMS poster (tx `0xae4e95f5…`, floor from 14:26:48Z); early
> attempt REVERTED at 54s inside the floor; `cancelOpenJob` succeeded at 3,623s: tx
> `0x30175585…3b3f` blk 19537354, `JobCancelled(refundedRaw=150000)`, exact reserved→liquid
> release, state Cancelled. §6 findings: listing surface quotes no economics; SDK lacks an
> `estimateNetReward` wrapper. **Erratum:** this runsheet was accidentally re-executed 2026-08-16
> producing a byte-identical twin at `0xa03d7f0F…799F` (wired + scheduled, holds no funds) —
> revocation queued with the §8 legs. New preflight law: check the origin/main manifest + merged-PR
> history before executing any runsheet.

**Prepared:** 2026-08-13 · **Operator:** Pascal · **Architect gate:** Claude (calldata + postconditions) ·
**Source of truth:** merged main (`e0e9404e`+), `PACKET_ESCROWCORE_V3_SPEC.md`, sim script
`simulate-escrowcore-v3-ceremony.mjs`. The pool ceremony's discipline applies throughout: dry-run
first, predictions from the verified signer's pending nonce, postconditions after every leg, and
each step's abort leaves v2 serving untouched.

**Standing facts:** deployer = admin EOA `0x9Ab8531FBb0948C542a31298FD61335f30064239`
(`op://mainnet-critical/admin-eoa-mainnet/credential`; Pascal signs, Claude never touches keys).
Multisig legs: Nova Spektr initiates (auto timepoint), Vault QR countersigns; call-data = SCALE
extrinsic hex from `@polkadot/api` `tx.revive.call(...).method.toHex()`, refTime 4e9 / proofSize
100k / storageDeposit 1e9. Roles are verified **on the contracts**, never from the API's role
model. Ratified schedule initials: `50_000 / 2_000 / 500 / 50_000`.

## §0 Preconditions (all checked before scheduling the day)

- [ ] **Foundry pin rider:** CI's foundry version pinned to match local; `forge --version` printed
      in the CI job. (The one outstanding rider from #1105's gate.)
- [ ] #1106 smoke-identity fast-follow merged (green deploy records restored — cosmetic but we
      start clean).
- [ ] Admin EOA holds ≥ 1 DOT for deploy gas; multisig signatories reachable; Vault device charged.
- [ ] v1 drain status read on-chain (open jobs, residual balances) — determines whether v1 keeps
      its draining slot after cutover or exits the config.
- [ ] Ceremony window agreed: low-traffic, both humans available for ~2h wall-clock (multisig legs
      dominate).

## §1 Step 0 — indexer upgrade (the 2026-08-13 lesson)

The v3-ABI indexer build triggers a Ponder historical backfill that does **not** fit the standard
deploy's 15s window (proven: deploy 31689870084 auto-rollback on public-RPC rate limits).

- [ ] Run the **dedicated** indexer redeploy path (`redeploy-indexer.sh` flow) with the dwellir
      endpoint configured for the backfill, at least a few hours **before** the ceremony.
- [ ] Postconditions: indexer healthy at head; new topics registered
      (`ClaimRetentionSnapshot`, `FeeScheduleChanged`, `JobCancelled`, `GasRetentionApplied`)
      with **zero events** (nothing exists on-chain yet — zero is the correct number).
- **Abort:** rollback to previous build (proven path); ceremony postpones, nothing else affected.

## §2 Day-of preflight — fork-sim against live head

- [ ] `node scripts/ops/simulate-escrowcore-v3-ceremony.mjs --fork-url <dwellir> --expected-deployer 0x9Ab8531F…4239`
- [ ] Sim postconditions all green: predicted address (from the admin EOA's live pending nonce),
      runtime ≤ 24,576, initcode ≤ 49,152, ratified schedule constants, roles + predecessor drain
      permissions.
- [ ] Record the predicted address in the transcript. Claude re-derives the prediction
      independently from the live nonce before §3.
- **Abort:** any sim failure = full stop, nothing signed.

## §3 Deploy — guarded script, admin EOA

- [ ] Dry run: `redeploy-escrowcore.mjs --profile mainnet --expected-deployer 0x9Ab8531F…4239`
      (dry prints intent + prediction; signs nothing).
- [ ] Claude verifies: prediction matches §2, script targets mainnet profile, constructor args
      (policy, accounts, reputation, treasury) match the live addresses.
- [ ] Commit run (Pascal, `--signer-secret-ref op://mainnet-critical/admin-eoa-mainnet/credential`).
- [ ] Postconditions: deployed address == predicted; `eth_getCode` size == sim's runtime bytes;
      `supportsGasRetention() == true`; `retainsClaimFeeOnSuccess() == false`; schedule reads
      `0/0/0/0` or constructor initials (per script design — the authoritative values land in §4).
- **Abort:** address/size mismatch = stop; the orphan deploy is inert (no roles, no wiring).

## §4 Multisig wiring legs — Nova Spektr + Vault

Blobs produced by `redeploy-escrowcore-wire-multisig.mjs` (dry mode prints SCALE hex per leg;
signatory labels from `deployments/mainnet-multisig-owner.json`). **Claude semantically verifies
every blob before Pascal pastes it** (decode → contract, selector, args — the EscrowCore v2
ceremony pattern). Expected legs, in order:

1. `AgentAccountCore.setEscrowOperator(v3, true)` — v3 may reserve/settle on the AAC.
2. TreasuryPolicy role writes for v3 (outflow recorder; settlement-broker surface as the script
   emits them) — **keep v2's roles live** (it drains through its dispute windows).
3. ReputationSBT writer for v3 (badge minting at settlement).
4. `EscrowCore(v3).setFeeSchedule(50_000, 2_000, 500, 50_000)` — the ratified D4 constants land
   on-chain by multisig, `FeeScheduleChanged` emitted and decoded into the transcript.

- [ ] Each leg: initiate in Nova Spektr → verify call-data hex matches Claude's verified blob →
      Vault countersign → wait for inclusion → **postcondition read on the contract** before the
      next leg (operator flag true, roles true, schedule exact).
- **Abort:** any leg's postcondition mismatch = stop; already-landed legs are individually
      reversible (`setEscrowOperator(v3, false)` etc.); v2 unaffected throughout.

## §5 Cutover PR — env, manifest, D-03 pins (one PR, one deploy)

- [ ] One PR: `ESCROW_CORE_ADDRESS` → v3; v2 → the draining slot; v1 per §0's drain reading;
      `deployments/mainnet.json` gains the v3 address + verified runtime hash; **both**
      `knownUnshippedContractChanges` pins (escrowCore + legacyEscrowCore) **deleted** — their
      lifecycle ends here by design.
- [ ] Claude gates the PR (addresses byte-exact vs §3/§4 transcript).
- [ ] Merge → deploy with a **`verify_contract_source=1` dispatch** (the Tier-1 path-match
      early-return gotcha: the pin-deleting deploy must run the full hash verification).
- [ ] Deploy green end-to-end (smoke now runs the fixed wallet-scoped identity).
- **Abort:** deploy red pre-cutover = nothing changed; red post-repoint = repoint back to v2
      (one env change; v2 never stopped being valid).

## §6 Capability-flip verification (Claude, live, within minutes)

- [ ] `supportsGasRetention()` probe now **true** through the platform: job listing +
      `estimateNetReward` + preflight/explain quote the retention line for brokered candidates,
      self-paid quotes zero, identical numbers across all three (economics parity).
- [ ] Poster surfaces quote `max(5%, 0.05)`; `/poster/onboarding` `cancellation` object flips to
      `cancelOpenJob` ("cancel any time after 1h, instant refund") replacing the ~7d tombstone
      promise.
- [ ] Board: worked-cost tile + 80%-of-flat alert armed; Hermes revenue lines (retained gas vs
      poster fees) present and **zero** (honest emptiness).
- [ ] Indexer ingesting the new topics (still zero events pre-acceptance).

## §7 Live acceptance — two small proofs, real money

1. **Retention proof:** post one 0.25 catalogue job; brokered claim + settle by the resident
   worker path; verify on-chain `GasRetentionApplied(jobId, worker, 50_000, 250_000)` decoded
   from the receipt (payout-evidence discipline: read the log, never derive), worker payout =
   0.20, treasury +0.05.
2. **Cancel proof:** post one 0.10 job with no takers expected; wait 1h+; `cancelOpenJob` from
   the poster; verify `JobCancelled` with the exact refund and terminal state; confirm the 1h
   floor rejected an early attempt (dry: expect revert before the hour).

- [ ] Transcript + tx hashes recorded; memory + `ECONOMIC_STRATEGY.md` updated (D2/D4 rows go
      "live"); the F-tier retention rows in `WORKER_PROGRESSION_DESIGN.md` flip from "inert" to
      active.

## §8 Explicitly NOT ceremony-day

v2 drain-and-decommission (runs through its dispute windows; the in-flight first rescue finalizes
2026-08-16 on v2 untouched), v1+v2 operator revocation (the long-open item — executes after both
drain to zero), any D0/G_cat/pool-cap changes, the DepositPool v2 + CreditPool ceremony (next
pool window, separate runsheet), brokered-with-retention product surfaces beyond the quotes
(worker choice architecture ships with the platform work already merged — verify, don't build).
