# D-03 contract-surface freeze, 2026-07-29 — analysis and override record

> **The deploy lane is not broken. The D-03 gate is holding it, correctly.**
> This document is the compatibility rationale the override asks an operator to
> record. It presents evidence; it does **not** grant the override. Sign-off is
> the operator's, with chain/settlement review.

## State

Production is **healthy but stale**:

```
GET https://api.averray.com/health  ->  200 in 0.09s
{"status":"ok","deployedSha":"a39137e2f223a26ab2fc5c2b2dec3c58aa6ea8ee", ...}
```

`a39137e` is the last **successful** deploy, at 11:12 UTC. Four deploys have
failed since — 11:49, 12:30, 13:07, 16:40 — all with:

```
D-03 contract compatibility freeze: refusing production deploy.
persisted at /srv/agent-stack/.deploy-state/contract-surface.frozen-at.mainnet
```

One commit tripped the gate; **stickiness** produced the rest. The marker is
per-profile and re-evaluates the whole undeployed range on every later run, so
each subsequent merge stays frozen until the drift is paired, reverted, or
cleared by dispatch. That is the designed behaviour, not a cascade of new faults.

## What is frozen

Five commits, `a39137e..af9f133`:

| SHA | Title |
|---|---|
| `1b95a0a` | fix: make ceremony orphan scans patient (#856) |
| `0c94609` | fix: require explicit ceremony deployer (#857) |
| `5f3194c` | fix: harden ceremony deploy failures (#858) |
| `a527f61` | fix: resolve multisig signers by profile (#859) |
| `af9f133` | fix: make preflight enforce claim liquidity (#855) |

## Why the gate fired — exactly

`scripts/ops/deploy-production.sh` treats these paths as contract surface:

```
^(contracts/|mcp-server/src/blockchain/|scripts/ops/redeploy-(agent-account-escrow-stack|escrowcore|escrowcore-wire-multisig)\.mjs|scripts/verify_deployment\.sh)
```

Three matched, one per commit:

| Trigger file | Introduced by |
|---|---|
| `scripts/ops/redeploy-agent-account-escrow-stack.mjs` | `1b95a0a` (#856) |
| `scripts/ops/redeploy-escrowcore.mjs` | `5f3194c` (#858) |
| `scripts/ops/redeploy-escrowcore-wire-multisig.mjs` | `a527f61` (#859) |

The required pairing is `deployments/${DEPLOY_CONTRACT_COMPAT_PROFILE}.json`,
i.e. **`deployments/mainnet.json`** for this profile. It was **not** touched in
the range, so the gate refused. **The gate behaved exactly as specified.**

## Evidence bearing on compatibility

Facts, verified against the compare API — not judgements:

- **Zero `.sol` files changed** in the range.
- **`deployments/mainnet.json` unchanged** — no mainnet contract address or ABI
  record moved.
- **`mcp-server/src/blockchain/` unchanged** — no backend chain-adapter change.
- The three triggers are **ops redeploy scripts** for the EscrowCore v2 ceremony,
  which per `docs/ESCROWCORE_V2_PROTOCOL_FEE_MIGRATION.md` is Phase 1 deployed
  but **inert** (production still runs v1).
- Their `.test.mjs` siblings also changed but do **not** match the trigger regex,
  which requires `\.mjs` immediately after the script name.
- Deployment records touched were `deployments/testnet.json` and
  `deployments/{mainnet,testnet}-multisig-owner.json` — **not** the contract
  manifest the gate pairs against.

## Two questions to settle before overriding

**1. Is `af9f133` (#855, "make preflight enforce claim liquidity") tooling-only?**

The other four are unambiguously ceremony scripts. This one touches preflight,
which sits near the live claim path. It did **not** trigger the gate — it rode
along in an already-frozen range. Before clearing the freeze, confirm it carries
no live-behaviour change, because overriding ships it too. Note there is a
separate open workstream on preflight/claim waiver parity
(`docs/PREFLIGHT_WAIVER_PARITY_PACKET.md`); if #855 is part of that, it deserves
its own review rather than release as a side effect of unfreezing.

**2. Should the gate accept `deployments/*-multisig-owner.json` as a pairing?**

As written, only `deployments/<profile>.json` clears the freeze. The EscrowCore
v2 Phase 2 multisig work legitimately edits `*-multisig-owner.json` while
touching `redeploy-escrowcore-wire-multisig.mjs`. If that combination is
intended to be a valid pairing, **every Phase 2 commit will freeze mainnet
again** and the override becomes routine — which erodes a gate whose value is
that it is rare and deliberate.

Deciding this is worth more than clearing today's freeze. A gate that is
overridden habitually stops being a gate.

## Options

1. **Pair it.** Land a `deployments/mainnet.json` update alongside, if one is
   genuinely warranted. Do **not** manufacture a manifest change solely to
   satisfy the gate — that defeats it while appearing to honour it.
2. **Revert the drift.** If the ceremony tooling need not ship now, revert the
   three trigger files from the deploy range; the marker self-clears
   (`clear_contract_freeze_marker … the flagged changes were reverted`).
3. **Override by dispatch.** `workflow_dispatch` with
   `allow_contract_surface_drift=1`, citing this document. Appropriate **only**
   if question 1 resolves cleanly.

## What was not done

No override was set. No deploy was forced. No gate was weakened or disabled.
The freeze marker on the VPS is untouched.

## Reproduction

```sh
gh api repos/averray-agent/agent/compare/a39137e...af9f133 --jq '.files[].filename' \
  | grep -E '^(contracts/|mcp-server/src/blockchain/|scripts/ops/redeploy-(agent-account-escrow-stack|escrowcore|escrowcore-wire-multisig)\.mjs|scripts/verify_deployment\.sh)'

gh api repos/averray-agent/agent/compare/a39137e...af9f133 --jq '.files[].filename' \
  | grep -cE '\.sol$'            # -> 0
```
