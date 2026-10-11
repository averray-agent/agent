# Packet: signer clean-up returns idle escrow and pool money to the reward bank

**DIRECTIVE (Codex):** implement this in `averray-agent/agent` as ONE PR from a
fresh worktree off `origin/main`. Do not review or summarise the packet. You
build the tool and its workflow; you do NOT run anything against mainnet. The
operator (Pascal) runs the dry-run and the commit through the workflow, and
Claude gates the preview before any commit.

## Why

A read-only sweep on 2026-10-11 (Hub block 21696163) found about 10 USDC of
reward-bank money that no live job needs. It sits in states that only
end when someone sends a transaction, and nobody has. The reward bank is
the signer's AgentAccountCore position (`positions[0x5a6836…][USDC].liquid`),
16.687749 USDC after today's top-up, with 39.35 reserved. Every reserved
micro-USDC is accounted for by a job. The money below is reserved against jobs
that are finished in fact but not on chain.

| Bucket | Contract | Jobs | Held | Call | Who may call |
|---|---|---|---|---|---|
| A. Stranded canary jobs | v3 EscrowCore `0xC2Eb191F…f793` | 3 Open | 0.30 | `cancelOpenJob(jobId)` | poster only (= signer) |
| B. Rejected, dispute window long over | v3 | 11 Rejected | 4.40 | `finalizeRejectedJob(jobId)` | anyone |
| B. same | legacy v2 `0x590EbE30…C3fC` | 7 Rejected | 1.20 | `finalizeRejectedJob(jobId)` | anyone |
| B'. Cold wallet's v2 rescue never finished | legacy v2 | 1 Rejected (poster `0xA287a52b…7bf6`) | 1.05 | `finalizeRejectedJob(jobId)` | anyone; refund lands in the COLD wallet's AAC position, not the bank |
| C. Bank float in the v2.1 aggregator | AgentAccountCore `0xB1350932…8E57` | strategy `AAC_IDLE_DEPOSIT_POOL_V21`, adapter `0x1DDcA709…5CA5` | ≈4.157482 | `deallocateIdleFunds(signer, strategyId, amount)` | account or settlement broker (= signer) |
| D. Expired claims | legacy v2 | 6 Claimed (worker `0x3742de88…620d`, claims expired 2026-08-10/11) | 2.40 | `handleClaimTimeout(jobId)`, then the tombstone rescue below | anyone |
| E. Signer's own stale Open job | legacy v2 | 1 Open `0x158d074f…090f` | 1.05 | tombstone rescue (`scripts/ops/rescue-open-job.mjs --escrow legacy`) | janitor + signer |

Expected bank gain: A + B + C ≈ **10.06 USDC** immediately (0.30 + 5.60 + 4.16); D + E **3.45 USDC**
after the 7-day dispute window of the rescue. B' returns 1.05 to the cold wallet
(the operator then moves it with the cold key; out of scope here).

The full job list (escrow, state, jobId, poster, worker, held) is the manifest
below. Use these exact ids; do not discover targets at run time.

### Manifest (commit as `scripts/ops/signer-cleanup-2026-10.json`)

```
A  v3  cancelOpenJob        0x26658513c5e5b0a276c63c65251f8bddf05cb578d2acfe4dbbac2a8fbac0ef65
A  v3  cancelOpenJob        0x8e24acd93c8707016a7a7278854535fe8b2ee84b6539f699d09b36ae4baa5b99
A  v3  cancelOpenJob        0xba5ee7e6083e2a804cbd83ff0bb936cb54b396fe8d1b8b9ad78db2360fb14712
B  v3  finalizeRejectedJob  0x003725b8b6aadc5e717dd7422425b30fc17cad1f7dd8247f6defd10ed1fd88c8
B  v3  finalizeRejectedJob  0x3731a59bf514fa07bfe8d57d716f1b74eba509913cb484c7e7ac38cbc56f26bf
B  v3  finalizeRejectedJob  0x577020a1e80e89ead9e3a52dc1482dee151ced416154e5d8c8eb98b96099f982
B  v3  finalizeRejectedJob  0x638404be136308f23d013a0b5da449c6427607b904a33aaea523d79859756f81
B  v3  finalizeRejectedJob  0x715667cf58956d37e47f5f788224ba56f420644cb19c2bde5265df9ec2941df9
B  v3  finalizeRejectedJob  0x7b5c50c14c2914b161e0f77c36d7f1b9c67a2fe2c3e7150643e18584a59e390e
B  v3  finalizeRejectedJob  0x8875848862f23512f626fb003a5729b92cdc5e006a6d713b2bdff555ae33872e
B  v3  finalizeRejectedJob  0x8df0941a9bc6f75ec91dd9aa9569788ecca4940469c9a4708bd3b5d18967318f
B  v3  finalizeRejectedJob  0x9a193458b3b777d52ef0932eabd3801fdde62eb3460e76a033af0ed7c0533e5b
B  v3  finalizeRejectedJob  0xa9617d053aa9d2234ce3cface6f9f96ae6ac5f991fb467f8da09beeb367adec2
B  v3  finalizeRejectedJob  0xc2e4608da6b0a3197ac7da44e9bf0ff7c1629a1c9a968c422f10d3d1fa8376a2
B  v2  finalizeRejectedJob  0x10380993e78142ff1b810132520f8c80a04f12252637bb30665b321ccd4b215e
B  v2  finalizeRejectedJob  0x3aacf564404784ca0b0d899d29f67f66b6235df48467563a41f898a4da77e4a8
B  v2  finalizeRejectedJob  0x4f9d2e67e77d289e5f71fcadb58071a551ec1b0921e6838f79fc1aec4d2c0aa5
B  v2  finalizeRejectedJob  0xbda1e276b8eb6aeda1c5f3c14c54872ce62662e42e8c2127c2e08d65ab503334
B  v2  finalizeRejectedJob  0xd82143b82f9958ee4da366cf1ca1a11c8e7fe8298880068a30bcdc4d4197f41f
B  v2  finalizeRejectedJob  0xe9cc1d460f6570db6ad048174f3467ad2336395c4f929ec8c0808ebbe83ff15d
B  v2  finalizeRejectedJob  0xfab7e747ea0337fb700b80075dedde48b4117e00abb2bd5b64fd697c13f2f6aa
B' v2  finalizeRejectedJob  0xc75efd7b0e098d9f802e7edb15b0bb343dc9c0dadbb5a6f6f8d76e3af55d05a9
C  aac deallocateIdleFunds  AAC_IDLE_DEPOSIT_POOL_V21  amount=full current value, read at send time
D  v2  handleClaimTimeout   0x19d2ce787823b066bdf40911321bdd9d6bff5fe8da787ffa9950c27ef8f65bbf
D  v2  handleClaimTimeout   0x1cd5e39d94c30a0f57381c92325f8c65cc6635498a4bac72d10f3950659a9217
D  v2  handleClaimTimeout   0x5b7931881d58403d4a3ff69162ebb9605c0d7c3c2633547ea5455253f5218899
D  v2  handleClaimTimeout   0xa42ebcba24501330255377d6702f0f8a6a3df1a7171a78bf6b81f5412844150e
D  v2  handleClaimTimeout   0xb569ef0d07c88c54493ea60f3ad11b925ce26116d1258fdf064da0a4d4ea8851
D  v2  handleClaimTimeout   0xef36549595c4152c08047e23ef80d097371a02855e40b1817dc7a0e98668c989
E  v2  rescue (prepare)     0x158d074f71c4f15a7d53305084854ad01bbea36b412ee7eba6471b1dbca5090f
E  v2  rescue (prepare)     the six D jobs, once handleClaimTimeout has reopened them
```

### Out of scope: refuse these even if someone adds them to the manifest

Hard-code a denylist. The tool must refuse to act on these ids and print why:

- **The three v3 disputes** `0x1ca6302b…fd83`, `0xfc11092a…9085`, `0xfd4fdf36…32b4`.
  These are our own platform-fault overturns. Their drafted ruling is "dismissed,
  full payout to the worker" (`RUNSHEET_MAKE_THE_CANARY_CLAIMANT_WHOLE.md`). Only
  the phone arbitrator rules. Never call `autoResolveOnTimeout`: it pays the
  worker only half.
- **v2 Open `0xdbb87130…d873`** (poster `0x089a0A57…8CeE`). Ownership of that
  wallet is unconfirmed.
- Anything on CreditBook, the blind-agent wallet `0x3071Ca2A…`, Base, or any
  pool other than the one strategy in C.

## What to build

1. **`scripts/ops/signer-cleanup.mjs`.** Model it on
   `scripts/ops/fund-signer-usdc-deposit.mjs` (KMS signer, `--profile mainnet`,
   `--expected-signer`) and `scripts/ops/rescue-open-job.mjs` (plan hash,
   explicit confirmation).
   - **Dry-run by default.** Read the chain for every manifest row and classify
     it as `ready`, `already_done` (the target state has been reached: Cancelled /
     Closed / reopened), or `blocked:<reason>` (wrong state, window still open,
     poster ≠ signer for A, claim not expired for D, paused, strategy inactive or
     async for C, …).
     - Print one line per row: bucket, escrow, jobId, current state, held USDC,
       worker, the slash the contract will apply (stake + fee, from the job
       tuple), and the refund recipient.
     - Print totals: the expected change in the bank's liquid and reserved
       balances, and the expected change in the cold wallet's position for B'.
   - **Plan hash.** sha256 over `chainId`, contract addresses, and, for each
     `ready` row, the function, its args, and the pre-state it was classified
     from. A state change between dry-run and commit must change the hash.
   - **`--commit`** requires `--expected-plan-hash` equal to a fresh dry-run's
     hash and `--confirm 'CLEANUP <hash prefix 12>'`.
     - Re-read each row immediately before sending and skip it if it is no longer
       `ready`; skipping is not a failure.
     - Send the transactions one at a time and wait for each receipt.
     - Stop on the first revert or failed receipt, and print what was done and
       what was not.
     - Write a per-transaction evidence log: tx hash, block, the row, and the
       event seen (`JobCancelled` / `JobClosed` / reopened / `StrategyDeallocated`).
   - **C amount.** Compute the amount at send time from the signer's
     `strategyShares` and the adapter's `totalAssets` / `totalShares`, the way
     `deallocateIdleFunds` does: the full position value, never the 4.157482
     literal. Check the adapter's buffer can pay it.
   - **Order.** A, B and B', then C, then D. E stays a separate step: print the
     exact `rescue-open-job.mjs --escrow legacy --phase prepare` commands for the
     7 E jobs, and the `--phase finalize` commands with the earliest allowed time
     (prepare + 7 days).
     - If `rescue-open-job.mjs` cannot take several job ids in one plan, add
       `--job-ids <comma list>` to it with one combined plan hash. Its existing
       single-job tests must stay green.
   - **Postconditions.** After commit, re-read the signer position, compare it
     to the dry-run's expected change, and print the gap.

2. **`.github/workflows/hosted-signer-cleanup.yml`.** Copy the shape of
   `hosted-signer-liquidity-funding.yml`: `workflow_dispatch` with inputs
   `commit` (boolean, default false), `expected_plan_hash` (string) and
   `confirm` (string).
   - Use the same SSH to the VPS, run inside the backend container with KMS,
     pass `--expected-signer` from `deployments/mainnet.json .verifier`, and
     upload the evidence log as an artifact.
   - Set `concurrency` so it never runs alongside
     `hosted-signer-liquidity-funding` or any other job that signs with
     `0x5a6836…`: same signer, same nonce. Find those jobs in the workflows and
     in `scripts/ops` and list them in the PR.

3. **Tests** (`scripts/ops/signer-cleanup.test.mjs`, mocked provider, no
   network). Each must fail if the guard it covers is removed:
   - classification of every state per bucket, including the window still open,
     poster ≠ signer, an unexpired claim and an inactive strategy;
   - a denylisted id in the manifest is refused;
   - a changed pre-state changes the plan hash;
   - commit refuses a mismatched hash or confirmation;
   - a row that turns `already_done` between dry-run and commit is skipped,
     not sent;
   - stop on the first revert;
   - the C amount is computed from shares, and the call is refused when the
     buffer is short;
   - a second commit is a no-op, with every row reporting `already_done`.

## Consumers to check (blocking: list each in the PR with what happens)

These transactions change on-chain job states that other parts of the
platform read:

- **Indexer** (`indexer/`): does it handle `JobCancelled`, `JobClosed` after
  `finalizeRejectedJob`, the claim-timeout reopen, and `StrategyDeallocated` on
  both v2 and v3? If not, say what the indexed state will show.
- **Backend session state** (`mcp-server/src`): what happens to the off-chain
  sessions and catalogue rows for these jobs? Rejected sessions must end up
  closed, not resurrected. The 3 canary jobs must not become claimable or
  listed. The 6 reopened v2 jobs must not appear in `/jobs` as claimable
  between `handleClaimTimeout` and the rescue claim; if they would, the rescue
  must run in the same workflow run or the jobs must be delisted first.
- **Worker canary** (`scripts/ops/run-worker-canary.mjs` and its reservation
  state): confirm the 3 canary job ids are not referenced as live.
- **Monitor** (`depre-dev/averray-reference-agent`, product-health money_path
  and the reward-bank probe), **`/health` `rewardBank`**, and the operator app
  `/disputes`, `/runs` and `/treasury` pages. Say what changes, if anything.

## Checks for the PR

- `npm --workspace mcp-server test`, plus the new script tests.
- `node scripts/ops/signer-cleanup.mjs --profile mainnet` (dry-run, read-only)
  from your workstation if you have an RPC. Paste the full dry-run output in
  the PR. No commit, no KMS.
- PR notes per AGENTS.md: scripts and workflow only; no contract, backend
  runtime or frontend change; no new env. No new dependency.

## Operator runsheet (after merge; Claude gates the preview)

1. Actions → Hosted Signer Cleanup → `commit=false`. Send Claude the run link.
2. Claude checks every row and the plan hash against chain reads.
3. Run it again with `commit=true`, `expected_plan_hash=<hash>` and
   `confirm=CLEANUP <hash prefix 12>`.
4. Claude verifies the events, the bank's liquid and reserved balances, and
   `/health`.
5. Run the E rescue prepare commands from the dry-run output. Seven days later,
   run the finalize commands.
6. B' (the cold wallet's 1.05): give the cold wallet a little DOT, then call
   `sendToAgent(0x5a6836…, USDC, 1050000)` from the cold key. This is the
   operator's step and stays out of the tool.
