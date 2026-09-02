# D-03 FREEZE CLEAR — Implementation Packet for Codex

**Author:** Claude (gates the handback) · **Implementer:** Codex (PR only) · **Operator:** Pascal (VPS/dispatch only)
**Date:** 2026-08-11 · **Profile:** mainnet

---

## 0. Corrections to the framing before you start

Three premises in circulation are stale. Verify each yourself before writing code.

1. **`origin/main` is `94dd406` (#1079 "Cap per-wallet operator exposure in USDC"), not `f24a825`.** The D-03 conclusion is unchanged (`git diff --name-status f24a825 origin/main -- contracts/ deployments/` is empty), but the deploy that clears the freeze ships #1079's new fail-closed claim gate too.
2. **This worktree's HEAD (`6eb8993`) is NOT main.** Its `scripts/ops/deploy-production.sh` is the pre-#839 gate (1,099 lines, no sticky-freeze code). Every line reference in this packet is against `git show origin/main:<path>`. Grepping the working tree will produce confident wrong answers.
3. **Clearing the freeze and shipping #1078+#1079 to production are the same action.** The waiver PR edits `deployments/mainnet.json`, which is a backend redeploy trigger (`deploy-production.sh:1967`). There is no "clear the freeze without deploying the backend" move.

---

## 1. What is blocked and why

Production is pinned at `85090138`. Five commits are queued (`ba19a5a`, `44f7cfe`, `d186095`/#1075, `f24a825`/#1078, `94dd406`/#1079). The D-03 contract-surface gate refused the deploy and persisted the refusal at `/srv/agent-stack/.deploy-state/contract-surface.frozen-at.mainnet` with `baseline_sha=d186095bb5e10929d4740d4b70492e80b81bdb82`, so every later run re-evaluates from that baseline until the freeze clears. The evaluated range `d186095..94dd406` touches exactly one contract file: `contracts/EscrowCore.sol` (#1078 changed `_releaseClaimEconomics` → `_settleSuccessfulClaimEconomics`, which retains the post-tier claim fee instead of refunding it, and added a `pure` capability probe `retainsClaimFeeOnSuccess()`). EscrowCore v2 is live at `0x590EbE304E0C7672e2abF3161177D2B94a2aC3fC`, is not upgradeable, and holds real escrowed USDC — so the source now compiles to a runtime that matches neither live v2 nor live v1, and Tier 3 classifies both as drift. #1075 is *not* what froze you: `DepositPool.sol` landed inside the baseline commit and is untracked by the gate.

---

## 2. The complete drift set

Range `85090138 → origin/main (94dd406)`, `git diff --name-status -- contracts/` — exhaustive, five files. No build-config drift (`foundry.toml`, `remappings.txt`, `lib/**`, `contracts/lib/*.sol` all unchanged), so no compiler-settings change silently moves every hash.

| Solidity file | Deployable | Logical manifest key(s) | Mainnet address | Waiver entry? |
|---|---|---|---|---|
| `contracts/EscrowCore.sol` | yes (`contract EscrowCore is ReentrancyGuard`) | **`escrowCore`** | `0x590EbE304E0C7672e2abF3161177D2B94a2aC3fC` (v2, live, holds escrow) | **YES — required.** No entry exists today; it has been passing on merit. |
| `contracts/EscrowCore.sol` (same artifact) | — | **`legacyEscrowCore`** | `0x9cCd1DbBB5C354CC6218e55D3cE924A4d631C035` (v1, draining) | **YES — required.** Existing entry (`sha256:64ec86a0…2788` @ `775a826b`) no longer matches and must be **replaced**. |
| `contracts/DepositPool.sol` | yes as Solidity | none | **NOT DEPLOYED** | **NO — adding a key is fatal (exit 2).** |
| `contracts/strategies/HydrationDepositPoolAdapter.sol` | yes as Solidity | none | **NOT DEPLOYED** | **NO.** Distinct from `hydrationUsdcAdapter`. |
| `contracts/interfaces/IDepositPoolVenueAdapter.sol` | interface only | n/a | n/a | **NO.** Only implementor is undeployed. |
| `contracts/interfaces/IDepositPoolAccounting.sol` (new file) | interface only | n/a | n/a | **NO.** Not inherited by anything; used as a call type. |
| `hydrationUsdcAdapter` (unchanged source) | — | `hydrationUsdcAdapter` | `0x96091d4477Fe37E79557276d63883bBbbdE73159` | Existing entry stays untouched. Maps to `HydrationUsdcAdapterV22.sol`, which imports neither changed interface. |

**The aliasing fact that will break a naive waiver:** `scripts/ops/check-contract-provenance.mjs:58-59` maps *both* `escrowCore` and `legacyEscrowCore` to `["EscrowCore.sol","EscrowCore"]`. One compiled artifact, two live addresses, **byte-identical candidate hash**. A waiver naming only `escrowCore` will fail the next real Tier-3 run and rewrite the marker.

**Verified negative — other tracked contracts:** `AgentAccountCore.sol` and `TreasuryPolicy.sol` are byte-identical to `ccaa1112`; `XcmWrapperV22.sol` to `464fd8c0`; `HydrationUsdcAdapterV22.sol` to `3d883912`. **Uncertainty:** this is source-level only. Tier 2 (live chain vs manifest provenance) runs unconditionally and is not waivable by this manifest key; pre-existing live drift on any tracked contract is invisible to source analysis and would surface in the same run.

---

## 3. What to change (Codex — one PR)

### 3.1 Compute the hash — do not guess it, do not use host `forge`

The hash is content-addressed over the full masked runtime and is settings-sensitive (`foundry.toml`: solc 0.8.24, `via_ir`, optimizer runs 200, default `bytecode_hash=ipfs`). A hash produced by a local Mac `forge` is a plausible, undetected error. Use the digest-pinned image the gate itself uses (`deploy-production.sh:79`, `CONTRACT_PROVENANCE_FOUNDRY_IMAGE = ghcr.io/foundry-rs/foundry@sha256:0437526…aadf46`), invoked the same way `run_contract_candidate_build` does (`:515-531`):

```bash
# clean checkout of origin/main (94dd406)
docker run --rm -v "$PWD":/workspace "$CONTRACT_PROVENANCE_FOUNDRY_IMAGE" \
  build --root /workspace --out /workspace/out-d03 --skip test

node scripts/ops/check-contract-source-drift.mjs \
  --profile mainnet --artifacts ./out-d03 --json
```

Exit codes: `0` clean/allowlisted, `1` real drift, `2` environment/config. Read the **per-contract** verdict, not the headline. Record the `candidateMaskedRuntimeCodeHash` printed for `escrowCore` and confirm it is identical to the one printed for `legacyEscrowCore` (it must be — same artifact). That single value goes into both entries. It is derived by `maskedArtifactRuntimeHash(out-d03/EscrowCore.sol/EscrowCore.json)` — sha256 over `deployedBytecode.object` with solc-declared immutable slots zero-filled, emitted as `sha256:<64 lowercase hex>`.

**Do not confuse this with `contractProvenance[addr].runtimeCodeHash`**, which is the raw unmasked sha256 of `eth_getCode`. Different field, different tier. Do not touch `contractProvenance` or `contracts` in this PR.

### 3.2 Edit `deployments/mainnet.json` → `knownUnshippedContractChanges`

Schema (`scripts/ops/check-contract-source-drift.mjs:62-132`): object keyed by a **currently deployed** manifest contract name → **non-empty array** of `{ maskedRuntimeCodeHash (required, /^sha256:[a-f0-9]{64}$/u, unique within the key), reason (required, non-empty after trim), sourceCommit (optional, /^[a-f0-9]{40}$/u) }`. Unknown fields are silently dropped by the normalizer — there is no `expiresAt`, no ticket field, no expiry. Do not try to add one.

**`escrowCore`** — add, exactly one entry:

```json
"escrowCore": [
  {
    "sourceCommit": "<full 40-hex SHA of f24a825 (#1078) — expand it>",
    "maskedRuntimeCodeHash": "sha256:<computed in 3.1>",
    "reason": "<see required content below>"
  }
]
```

**`legacyEscrowCore`** — **REPLACE** the existing entry, do not append. Exactly one entry, same `maskedRuntimeCodeHash`, same `sourceCommit`, its own reason.

The reason strings must state, in plain language, all of:

- **The retained-fee policy is NOT live on chain.** Deployed v2 `0x590EbE30…C3fC` and v1 `0x9cCd1DbB…C035` both still refund `claimStake + claimFee` on success. Source leads the chain deliberately.
- Live v2 does **not** expose the `retainsClaimFeeOnSuccess()` selector, so `mcp-server/src/blockchain/gateway.js:612 readRetainedClaimFeeCapability` reads `false` — which is **true of the chain**. Backend degrades conservatively: brokered gas remains operator exposure.
- **The destination, stated accurately.** Do not write "retained to treasury" — that is what #1078's commit message says and it is wrong for the path that fires on essentially every job. `contracts/AgentAccountCore.sol:652 slashClaimFee` splits by `claimFeeVerifierBps` (mainnet `7000`): the two success paths pass `msg.sender`, so **70% leaves the platform as a real ERC-20 transfer to the verifier EOA `0x5a6836c6D4d293F6E5377E6c28054F4171915813`, counted against `recordProtocolOutflow`; 30% credits treasury.** 100% treasury applies only to the `_resolveDispute` `workerPayout > 0` branch, which passes `address(0)`.
- **This entry is a successor-in-waiting for the EscrowCore v3 ceremony** per `docs/WORKER_PROGRESSION_DESIGN.md` §6.1, **and both entries must be deleted as a step of that ceremony.**

Why "replace, not append" for `legacyEscrowCore` is mandatory: `contracts/EscrowCore.sol` at `775a826b` and at `d186095` are byte-identical, so the stale `sha256:64ec86a0…2788` is exactly reproducible from a revert of #1078. Leaving it in place means a future revert or bad merge would classify **`known-unshipped` instead of `drift`** — the gate failing in the dangerous direction, silently shipping a backend built against an older contract than what is live. Every waived key ends this PR with exactly one entry.

### 3.3 Update the CI pin

`scripts/ops/check-contract-source-drift.test.mjs:173-199` pins the literal mainnet allowlist with `assert.deepEqual` and asserts `allowlist.has("escrowCore") === false`. It runs in CI via `npm run test:ops` (`.github/workflows/ci.yml:131`), and CI must be green for the `workflow_run` deploy to fire at all. Update it to the new contents and **add a comment beside the `deepEqual` naming the v3 ceremony as the deletion trigger.** This test is the only tripwire that will fire again.

### 3.4 Record the deferred obligation

Add a numbered step to the ceremony checklist in `docs/WORKER_PROGRESSION_DESIGN.md` §6.1: *"Delete `knownUnshippedContractChanges.escrowCore` and `.legacyEscrowCore` from `deployments/mainnet.json` and revert the pin in `check-contract-source-drift.test.mjs`."* Also note there that `audit-launch-readiness.mjs` reports `bytecode_selector_missing` for EscrowCore until the ceremony (see §5.4). Do **not** use `docs/SECRETS_CALENDAR.yml` — `expires_at` there is for externally-bounded secrets and mis-typing it blocked every merge in the repo on 2026-08-10; `rotate_by` warns and never blocks. Wrong instrument either way.

### 3.5 Scope

This PR changes exactly: `deployments/mainnet.json`, `scripts/ops/check-contract-source-drift.test.mjs`, `docs/WORKER_PROGRESSION_DESIGN.md`. Nothing else.

---

## 4. How to clear the freeze

**Step 0 — Codex (read-only).** Run §3.1 in a clean `origin/main` checkout. Confirm the drift set is exactly `escrowCore` + `legacyEscrowCore` and nothing else appeared. If a third contract shows `drift`, **stop and hand back** — that is live drift this packet did not anticipate and it needs its own decision.

**Step 1 — Codex (PR).** The §3 changes, one narrow PR off `main`. Do not stack anything else on it.

**Step 2 — Claude (gate).** Handback review per §5. Merge only after that.

**Step 3 — Pascal (dispatch).** After CI is green on main, **do not** let the automatic `workflow_run` deploy be the clearing run. Dispatch it manually with source verification forced on:

```bash
gh workflow run "Deploy Production" --ref main -f verify_contract_source=1
```

Leave `allow_contract_surface_drift` at its default `"0"`. This is load-bearing: Tier 1 has a **pure path match** early return (`deploy-production.sh:655-661`) that clears the freeze the moment `deployments/mainnet.json` appears in range — **before** Tier 3 ever runs. Since the waiver *is* a manifest edit, the clearing deploy would otherwise validate nothing, and a wrong hash would detonate weeks later on a new baseline as an exit-2 refusal that writes no marker and is harder to diagnose. `verify_contract_source=1` (`deploy-production.yml:132-139` → `DEPLOY_VERIFY_CONTRACT_SOURCE` at `:232`) forces the Tier 3 build (`:626-634`) ahead of that early return, so the hash is actually checked on the run that lands it. **A green deploy right after adding a waiver is not, by itself, evidence the hash was right.**

**Step 4 — Pascal (verify from the run log; no VPS access needed).** Require all of:

1. `D-03 contract compatibility freeze: clearing persisted freeze marker at /srv/agent-stack/.deploy-state/contract-surface.frozen-at.mainnet (…)` followed by the indented marker dump. The clear reason should read `compiled runtimes match deployed provenance or an exact known-unshipped manifest entry` — if it instead reads `contract-surface changes are now paired with deployments/mainnet.json`, the Tier-3 verification did **not** run and Step 3's flag did not take; treat the hash as unverified.
2. `D-03 Tier 2: live chain runtime matches deployments/mainnet.json provenance.`
3. Exactly one `AVERRAY_DEPLOY_RESULT=` record.
4. On the **next** run: no `enforcing persisted freeze from` line.

Capture the full run log before closing this out — `clear_contract_freeze_marker` prints then `rm -f`s, so that log is the only surviving record of what was frozen.

**Step 5 — Pascal (post-deploy).** Re-run the Hosted Worker Canary **twice against the same wallet**. The canary mints a fresh ephemeral wallet per run, so a single run never exercises #1079's exposure-*accumulation* path; two runs on one wallet is the cheapest way to touch it before an external agent does.

**Not available:** deploying an older SHA to unstick production. The remote wrapper unconditionally `git checkout main; git pull --ff-only` (`deploy-production.yml:626-628`). The only path is forward through the gate.

---

## 5. Conditions of acceptance (what Claude checks on handback)

1. **Exactly two waived keys**, `escrowCore` and `legacyEscrowCore`, each with **exactly one** entry. The old `legacyEscrowCore` entry (`sha256:64ec86a0…2788`) is **gone**, not appended to. `hydrationUsdcAdapter` untouched. No `DepositPool` or `HydrationDepositPoolAdapter` key — those throw *"is not a currently deployed source-controlled contract"* → **exit 2**, which refuses the deploy **without writing a marker**, a harder-to-diagnose failure than the one being cleared.
2. **Both entries carry the identical `maskedRuntimeCodeHash`**, and Codex shows the container build command and the `check-contract-source-drift.mjs --json` output it came from. A hash without that provenance is rejected. The waiver permits exactly one compiled runtime each — no wildcards exist in the grammar, and any subsequent edit to `EscrowCore.sol` re-arms the freeze by design.
3. **No runtime surface claims fee retention is active.** I will re-verify: `job-catalog-service.js:399` / `platform-service.js:949` still publish `claimFeeRetainedOnSuccess` sourced from the **live probe**, never a constant; `gateway.js:612` still fails closed on missing selector and on throw; `claim-economics.js:217` local mode still hardcodes `false`; `worker-exposure.js:179` still counts gas when retention is false; no copy in `app/`, `site/`, `marketing/`, `discovery/`, `sdk/`, `worker/`, `mcp-server/src/protocols/` asserts retention. **`job-catalog-service.js:467 estimateNetReward` must remain unchanged in this PR** — it returns `Math.max(job.rewardAmount, 0)` for non-native-gas assets, which is correct while retention is inert and becomes a 20% overstatement on a post-waiver 0.25 USDC job the day it goes live. Making it fee-aware belongs to the ceremony, not here.
4. **The v3 obligation is recorded durably** in `docs/WORKER_PROGRESSION_DESIGN.md` §6.1 as a numbered ceremony step, and mirrored as a comment in `check-contract-source-drift.test.mjs`. Not in `SECRETS_CALENDAR.yml`.
5. **Reason strings are accurate**: they say retention is not live on chain, and they describe the 70/30 verifier/treasury split rather than repeating the commit message's "retained to treasury".
6. **Diff scope** is the three files in §3.5.

**Stated uncertainty I am not papering over:** the gate checks bytecode provenance; nothing automates the question of whether a backend caller in the same range depends on the new contract surface. I traced every consumer of `retainsClaimFeeOnSuccess` and each fails closed, so the truth boundary holds today — but it holds because of the live capability probe, not because of the waiver. The waiver's effect is to permanently silence the only automated check that would notice if that probe were ever bypassed. The next backend PR that makes `estimateNetReward` fee-aware, or ships worker copy asserting the fee pays for gas, would deploy with zero friction. That judgement stays human, and §5.3 is where I exercise it.

**Also unverified here:** whether any live mainnet wallet currently holds an open session that #1079's `exposureForSession` would throw on (missing `jobSnapshot.definition` or `.claimEconomics` → `eligible:false` → `ConflictError`). Reading production state is Pascal's, not mine. Worth a spot check before Step 5.

---

## 6. Do NOT do

- **No EscrowCore v3 deployment in this packet.** No redeploy, no drain, no rewire.
- **No ceremony.** Not the six steps in §6.1, not partially, not "while we're in there".
- **Do not touch live v2 `0x590EbE30…C3fC` or v1 `0x9cCd1DbB…C035`** in any way. No admin calls, no parameter changes.
- **Do not broaden the gate.** No new `CONTRACT_ARTIFACTS` mapping, no relaxing of the schema, no adding an `expiresAt` field (the normalizer drops it anyway), no waiver for anything outside the two EscrowCore keys.
- **Do not disable D-03.** Never set `DEPLOY_CONTRACT_COMPAT_FREEZE=0` — it returns before Tier 2, Tier 3, and every clear path, leaves the marker in place, and is settable only by hand-running the script on the VPS. It is the genuine dangerous escape hatch.
- **Do not use `DEPLOY_ALLOW_CONTRACT_SURFACE_DRIFT=1`.** It also silences **Tier 2** (live-chain-vs-manifest, a different failure class), leaves only a `::warning::` in an Actions log, and permanently resets the baseline. Strictly worse than the waiver on both safety and record-keeping.
- **Do not `rm` the marker on the VPS.** It works and leaves no record; the clear must be logged.
- **Do not stack #1077** (OPEN, head `05885ed`, payout health / earnings honesty). This deploy already carries a deliberate contract/backend economics divergence plus a new fail-closed claim gate; adding a third change makes canary failures unattributable.
- **Do not modify `contracts/**`, `contractProvenance`, or `contracts{}` in `deployments/mainnet.json`.**

**Note on the alternative:** the revert of #1078's contract hunk is mechanically cleaner — `EscrowCore.sol` at `d186095` is byte-identical to `775a826b`, the commit live v2 was deployed from, so a revert clears the freeze through Tier 1's "no `contracts/` changes remain" door with no manifest edit, no forge build, and no hash to get wrong, and #1079 still ships intact because it probes capability at runtime. That option was considered and this packet takes the waiver path instead. If the ceremony can be scheduled within days, doing it now beats both.

---

## 7. The deferred obligation — EscrowCore v3 ceremony

**Fee retention is inert.** #1078 changes only source. The live contracts refund `claimStake + claimFee` on success today and will keep doing so until a successor EscrowCore is deployed and rewired. Every worker-facing number in production remains correct; the backend reads `claimFeeRetainedOnSuccess: false` from the chain, and that is the truth, not a fallback we are tolerating.

**What the waiver costs:** the freeze is currently the only mechanism that remembers this obligation — every attempted deploy restates it in the log with the baseline SHA. Waiving deletes that. The schema cannot express "temporary": no expiry, no ticket, unknown fields dropped. So the obligation must be carried by writing, in these places, or it will be forgotten:

1. **`docs/WORKER_PROGRESSION_DESIGN.md` §6.1** — a numbered ceremony step to delete both waiver entries and revert the test pin. Primary record.
2. **`scripts/ops/check-contract-source-drift.test.mjs`** — comment beside the `assert.deepEqual`. This is the only tripwire that fires again, and only once, when someone next edits the allowlist.
3. **The `reason` strings themselves** — they are greppable and permanent; they must name the ceremony.

**Ceremony-day items that must land *with* the redeploy, not after:**

- `mcp-server/src/core/job-catalog-service.js:467 estimateNetReward` must subtract the retained fee. It is described to agents as estimating what they receive after fees and would overstate a post-waiver 0.25 USDC job by 20%.
- `docs/RC1_WORKING_SPEC.md:776` and `docs/AVERRAY_WORKING_SPEC.md:1381` ("Both refunded on success") become false.
- `docs/api/openapi.json` preflight schema (~line 1787) is **already** drifted — it lists `claimFee`/`claimFeeBps` but not the `claimFeeRetainedOnSuccess` field the response now carries.
- Delete both waiver entries; revert the test pin.

**Known red that the waiver does NOT silence:** `scripts/ops/audit-launch-readiness.mjs --profile mainnet` will exit **2** with `reasonCode: "bytecode_selector_missing"` for EscrowCore, punch-line "redeploy EscrowCore". #1078 added `retainsClaimFeeOnSuccess()` to `ESCROW_CORE_ABI` (`mcp-server/src/blockchain/abis.js:78`, selector `0x8e81138c`); `SELECTOR_TARGETS[0]` substring-matches it against live runtime bytecode; the frozen interface `deployments/interfaces/mainnet-escrow-core-v2.json` has 51/51 functions and zero occurrences. That script is in no workflow (`git grep -rn audit-launch-readiness .github/` is empty), so it blocks nothing — but it goes permanently red for anyone running the manual pre-mainnet readiness audit. **Decide before Step 3 whether to accept a red readiness audit or record the intended divergence somewhere the audit reads.** This is the 2026-05-25 `claimJobFor` incident in reverse: then the chain lagged the ABI by accident, now by decision, with no mechanism recording that it is intended.