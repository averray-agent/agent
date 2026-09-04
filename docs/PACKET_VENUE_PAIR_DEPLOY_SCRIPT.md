# PACKET — A deploy script for the v2.1 lane + adapter pair

Status: READY FOR CODEX · 2026-09-03 · Author: Claude (architect+gate) ·
Repo: **platform** · One PR. **No contracts changed. Nothing deployed by CI.**
Feeds STEP 1 of `RUNSHEET_CEREMONY_B_EXECUTABLE.md`.

## Why a script

Pool v2.1 has `venueAdapter() == address(0)` and the legacy adapter cannot be
reused — `0xE2801E6C…` reads `pool() = 0x6061f0aC…`, immutably. Ceremony B needs
a **new pair**, and the two constructors are mutually dependent, so one address
must be predicted from the deployer's nonce. **A hand-run nonce slip produces a
scrap pair**, which is why this is a script and not a console session.

## The actual constructors (read from `origin/main`)

```solidity
// the LANE — deployed FIRST, at nonce N
HydrationUsdcAdapterV22(
  TreasuryPolicy policy_, address asset_, bytes32 strategyId_,
  IXcmWrapperV22 wrapper_, address agentAccountCore_   // <- the PREDICTED adapter
)

// the ADAPTER — deployed SECOND, at nonce N+1
HydrationDepositPoolAdapter(address pool_, IHydrationDepositPoolLane lane_)
// its constructor REQUIRES lane_.agentAccountCore() == address(this)
```

**The cycle is self-checking.** If the prediction is wrong, the adapter's
constructor reverts with `InvalidConfiguration()` — a bad prediction cannot
produce a mismatched pair, only a failed deploy. Preserve that property; do not
add a path that tolerates a mismatch.

## Constructor arguments (verified on-chain 2026-09-03)

| arg | value |
|---|---|
| `policy_` | `0x226F14252A98BD2eA140271647De20132F09AF20` |
| `asset_` | `0x0000053900000000000000000000000001200000` (USDC) |
| `strategyId_` | `0x4141435f49444c455f485944524154494f4e5f56310000000000000000000000` = `AAC_IDLE_HYDRATION_V1` |
| `wrapper_` | `0xF20b35A3f85EC864127B551ce8A64446fC0ed2Bc` |
| `agentAccountCore_` | **predicted** adapter address at nonce N+1 |
| `pool_` | `0x9B35A102d656Fb86d798aF81959e09961DEc28E0` (**v2.1**, never legacy) |
| `lane_` | the lane actually deployed at nonce N |

The `strategyId_` encoding is right-padded ASCII — verified by reproducing the
live `HYDRATION_USDC_POOL_V1` value byte-for-byte before trusting it for the
new id. **Do the same check in the script rather than hardcoding a literal.**

## What to build

`scripts/ops/deploy-venue-pair.mjs`, in the shape of the existing ceremony
scripts:

- **dry run by default**; `--commit` requires `--use-kms`
- `--expected-signer` mandatory in every mode, as elsewhere
- reads the deployer's live nonce, computes the predicted address, and
  **prints the full plan before signing** — both addresses, all constructor
  args, and the strategy id with its ASCII round-trip
- deploys lane then adapter, in that order, in one run
- **verifies before reporting success** (below); on any failure prints the
  scrap pair's addresses and exits non-zero
- emits a `# COMMITTED EVIDENCE` block with the **finality wait from #1332** —
  12 confirmations, re-read receipt and post-state, `REORG WARNING` on
  divergence. This is a mainnet deploy; it gets the same protection as the
  other ceremonies.

## The verification gate — all must pass

```
adapter.lane()          == <deployed lane>
lane.agentAccountCore() == <deployed adapter>
adapter.pool()          == 0x9B35A102…      (v2.1)
adapter.asset()         == 0x00000539…200000
adapter.policy()        == 0x226F1425…
adapter.lossReporter()  != address(0)
lane.asset()            == adapter.asset()
lane.policy()           == adapter.policy()
```

**A pair that fails any check is scrap.** Say so plainly, print both addresses
so they are never mistaken for usable, and exit non-zero. Never bind an
unverified pair.

## Non-negotiables (each pinned by a test)

1. A wrong nonce prediction fails the deploy — prove by mutation; the script
   must never emit success for a mismatched pair.
2. `pool_` is asserted to be v2.1; a legacy address refuses.
3. The strategy id is derived and round-tripped from its ASCII name, not
   hardcoded — mutate the name and the test fails.
4. Dry run signs nothing and reaches the full printed plan.
5. Evidence carries the #1332 finality fields; a receipt whose block hash moves
   withholds evidence and exits non-zero.

## Out of scope

The write-off (STEP 0), the multisig calls, and `setVenueAdapter` — this script
**deploys and verifies only**. It must never call `setVenueAdapter`; that
signature is the operator's, on the multisig, after this output is reviewed.

## Handback

PR number; green CI; the five test names; a full dry-run plan against mainnet
state; and confirmation that the mutation test proves a bad prediction cannot
report success.
