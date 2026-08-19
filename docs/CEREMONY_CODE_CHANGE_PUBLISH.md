# Ceremony — publishing a `code_change` job on mainnet

Status: **written, never executed.** This document exists because the mainnet
admin publish path was undocumented, and an undocumented mainnet admin path gets
a runsheet before it gets executed, not after.

There is no testnet. `testnet.api.averray.com` does not resolve and the only
hosted board reports chainId `420420419`. Every step below touches mainnet.

## 0. What this ceremony is, and what it is not

It publishes **one designated-claimant rehearsal** of the Witness `code_change`
rail: publish → claim → submit → verify, end to end, with a claimant agreed in
advance.

It is **not** an open bounty. That distinction is the whole reason for §1.

## 1. The three questions — answer before anything else

A `code_change` job may not be published until these are answered in writing.
They are preconditions, not context.

### 1.1 Who claims it?

**The Witness must never claim.** It is the verifier; a verifier that competes
for the work it judges is not a verifier. That separation is the basis of the
whole component.

There is currently **no worker in position** to produce a patch for a
`code_change` job. The Hermes reference-agent does report-shaped work.

Therefore an open curated bounty is the WRONG SHAPE. A funded job nobody can
claim becomes parked inventory, and a parked funded job on a public board reads
as demand that does not exist. Name the claimant wallet here, or stop.

### 1.2 What is it for?

Rehearsal, real bounty, or demo. Two of those three must never read as demand,
and the shape differs for each. Write the answer down; "we'll see" is a no.

### 1.3 Why this reward?

Curated lane norms are **0.1–0.4 USDC**. Anything outside that is a pricing
decision that must be justified here.

**Known trap:** the `1 USDC` figure in earlier drafts came from
`external_reward_below_floor` — a constraint on the *external poster* rail,
which this ceremony does not use. It was carried across a rail boundary by
accident. Do not inherit it.

## 2. Abort conditions

Stop and do not proceed if any holds:

- §1 is unanswered, or the named claimant is the Witness
- the target lane is throttled (the throttle is correct; do not route around it)
- the definition's `onboardingWaiverEligible` was not set deliberately — see §3
- the reward is outside lane norms without a written reason
- the board's reported chainId does not match the intended profile
- the reward bank cannot cover reward **plus fee** (see §3)

## 3. `onboardingWaiverEligible` decides the money and the claimant's exposure

`ensureJob` couples the fee waiver to this flag. It is not cosmetic:

| Flag | Bank pays | Claimant |
|---|---|---|
| `true` | reward only | no bond; gas operator-brokered |
| `false` | reward **plus a self-paid fee to the treasury** | bond required; **retention applies** |

Set it deliberately and record why. A definition that arrives with this flag
unexamined is not ready — it decides both what the bank spends and what the
claimant is exposed to.

## 4. Prerequisites

| Item | How to satisfy |
|---|---|
| Admin token | The per-consumer refresh chain, with a **dedicated consumer item** — never the canary's or the deploy consumer's. Short-lived. Minted by the operator. |
| Raw KMS access | **Never.** Nobody gets raw KMS access. If a step appears to need it, that step is wrong. |
| Admin allow-list | Publishing wallet must be in mainnet `AUTH_ADMIN_WALLETS` |
| Reward bank | Liquid balance ≥ reward + fee, verified on-chain, not from memory |
| Definition review | The job definition is a spend against the reward bank and goes through the same gate as any other spend, **before** a token is minted |
| Artifacts | Every contract artifact locator resolves over HTTPS (published contracts may not use local paths) |

## 5. Sequence

### 5.1 Verify the board before touching anything

```bash
curl -s https://api.averray.com/health | grep -o '"chainId":[0-9]*'
```

Must report `420420419`. If it does not, stop — the board is not what you think
it is.

### 5.2 Confirm artifacts resolve

Every `locator.url` in the frozen contract must return `200` with the byte count
the contract declares. A contract whose artifacts 404 cannot be verified after
publication, and the failure will surface only once a claimant is already
committed.

### 5.3 Publish

Use the dedicated publisher. **`post-external-bounty.mjs` cannot publish a
`code_change` job** — it serves the external poster rail, has no notion of the
`codeChange` block, and will fail with progressively more specific errors that
all mean the same thing: wrong rail.

```bash
node witness/bin/publish-code-change-job.mjs \
  --contract <frozen-contract.json> \
  --job <job-definition.json> \
  --api https://api.averray.com \
  --token "$ADMIN_TOKEN" \
  --out publish-evidence.json
```

This POSTs `/admin/jobs`. The backend **reproduces the contract digest from the
contract itself** and rejects a mismatch, so the digest cannot be asserted — it
is recomputed.

### 5.4 Expect `reward_funding_pending`

The job is created **not claimable**. Curated jobs fund from
`ingestion_prefund`, not from a poster wallet. This state is correct, not a
failure.

### 5.5 Record the derived id

The platform **derives** the job id; a supplied `definition.id` is rejected.
Any prepared evidence referencing a human-readable id (e.g.
`witness-code-change-unitless-001`) must be reconciled against the derived
`0x…` id after publication.

The contract digest is unaffected — it covers the contract, not the job
envelope.

### 5.6 Fund, then rehearse

Fund from the reward bank, confirm the job becomes claimable, then have the
**designated claimant from §1.1** claim, submit a patch, and let the Witness
verify.

Archive the job afterwards. A rehearsal left listed becomes inventory.

## 6. What was learned building this path

Recorded so the next person does not repeat it:

- Three dry runs against `post-external-bounty.mjs` produced progressively more
  specific errors — reward floor, missing `input.acceptanceCriteria`, supplied
  `id`, missing `codeChange`. That felt like convergence. It was three
  confirmations that a wrong-rail tool was still wrong. **Progressively better
  errors are not evidence of progress toward a working command.**
- `--profile testnet` selected a testnet RPC while posting to a mainnet board
  until #1168 added a board/profile chain assertion. The guard now refuses that
  combination and names both chain ids.
- The plan answered *how* three times before anyone asked *why* or *who claims
  it*. §1 exists so that ordering cannot repeat.
