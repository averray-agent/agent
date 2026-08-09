# Adversarial run — 2026-08-09, §1 quote/funding boundary

First adversarial run against the **open poster door** on mainnet (chainId 420420419),
per [`ADVERSARIAL_TEST_PROTOCOL.md`](ADVERSARIAL_TEST_PROTOCOL.md).

Attacker wallet `0xA287a52bb9624a4c2fE97E60D59B0de584A37bf6` — a cold wallet with no
balance, no history, no allowlist entry, funded only for this run. Driver:
`scripts/ops/run-adversarial-poster.mjs`.

**Cost of the whole run: 0.049 DOT of gas. Zero USDC lost.**
Closing position: 3.00 wallet + 1.05 AAC liquid + 1.05 reserved in a live job = 5.10 of 5.10.

There is no hosted testnet backend (`testnet.api.averray.com` does not resolve; the edge
serves one backend on mainnet), so this ran against production with the protocol's 1 USDC
floor and stop rule. That constraint should be stated in the protocol doc.

## What held

| # | Property | Evidence |
|---|---|---|
| P1 | A stranger can post end to end | cold wallet → SIWE → quote → fund → live catalogue job `0xc75efd7b…05a9`, tx `0x5dfbf755…a0e6`, block 19253022 |
| P2 | Quote determinism (§1.6) | identical content twice → identical `draftId`/`jobId`/`specHash`, `persisted: false` both times |
| P3 | Content binding | changing reward *or* title changes both `jobId` and `specHash` |
| P4 | Reward floor | `400 external_reward_below_floor {minimumRewardUsdc:"1", requestedReward:"0.5"}` |
| P5 | Rate limiting | `/auth/nonce` 10/min, then `429` + `retry-after: 59` |
| P6 | Underfunding refused (§1.3) | `InsufficientLiquidity()`, no job created, funds recoverable |
| P7 | Duplicate funding refused (§1.1) | `InvalidState()`, exactly **one** catalogue entry from one definition |
| P8 | Surplus deposits safe (§1.4) | over-deposited USDC stays liquid in AAC and withdraws (verified by simulation) |
| P9 | Poster-additive fee | 1.00 reward → worker receives 1.00, poster reserves 1.05, sourced from live `previewProtocolFee` |
| P10 | Draft authorization | owner-only reads; unknown ids `404`; other posters' `draftId`s not derivable from public data |

Both refusals happened at `eth_estimateGas`, so the doomed transaction never reached the
chain and the poster paid nothing for it.

## Findings

### F1 — The two most likely poster mistakes are indistinguishable (medium)

```
0xbb55fd27  InsufficientLiquidity()  → "you are short, deposit more"
0xbaf3f0f7  InvalidState()           → "this job already exists, stop"
```

A poster sees four opaque bytes in both cases. Neither selector appears in
`/poster/onboarding`, in any error table, or anywhere else a poster could decode it —
identifying them required hashing all 53 custom error signatures in `contracts/`.

The correct response is **opposite** in each case: deposit more, versus withdraw and walk
away. Acting on the wrong reading means depositing again into a job that already exists.
`InvalidState()` does not even name the problem.

**Fix:** map expected revert selectors to poster-facing meanings in the onboarding contract.

### F2 — The recovery path is misfiled, and the poster-facing answer is wrong (medium)

A poster looking for their money in the poster contract finds only:

```
cancellation.rescue → "operator-mediated on request, ~7 days"
flow[4].note        → "posters cannot use it as a refund or cancellation route"
```

The correct answer — `AgentAccountCore.withdraw`, liquid, instant, no operator — appears
only under **`workerFacts.withdrawal`**. Verified by simulation that a stuck poster's funds
withdraw successfully right now.

So someone who mistypes an amount by one cent reads that they face a seven-day operator
process, when their money is immediately recoverable.

**Fix:** a `posterFacts.withdrawal` block mirroring the worker one.

### F3 — Strict term matching punishes generosity like an attack (medium)

`firstCreationMismatch` compares six fields by strict equality:

```
specHash, poster, asset, reward, opsReserve, contingencyReserve
```

Any difference marks the draft `status: "mismatch"` with `permanent: true`. Confirmed by
free simulation that **EscrowCore itself accepts a mutated reward** — it has no knowledge
of the quote — so the watcher is the only thing preventing a mislisted job.

The security property is right. The product consequence is that *raising* the reward — an
ordinary, well-meant poster instinct — permanently strands the funds behind the ~7-day
rescue, with no pre-flight warning anywhere.

**Fix:** warn at quote time that terms must match exactly, in both directions.

### F4 — No reward ceiling (low)

`rewardAmount: "1000000000"` returns `200` with a 1.05-billion-USDC reserve. Unfundable by
construction, so it is a dead end rather than a risk. **Not** a truth-boundary problem:
`listExternalPostingDemandSignals` has no consumer, so no aggregate can be inflated by it.

### F5 — Inconsistent error quality (low)

The floor refusal names the rule and the offending value. `rewardAmount: "-1"` returns a
bare `invalid_request` with no detail.

### F6 — Quote expiry is advisory only (informational)

Re-quoting identical content slid `expiresAt` forward while `specHash` stayed identical, so
the 72-hour TTL is bound into neither the spec hash nor the calldata and cannot be enforced
on-chain.

## Not exercised

- **§1.2 live mutation.** Outcome predicted from simulation (chain accepts) plus the
  watcher's comparison code (rejects on `reward`). Running it live would reserve ~1.04 into
  a permanently mismatched job, recoverable only via the ~7-day rescue. Recorded as
  *predicted, not proven* — a code read is not a live proof.
- **The tombstone rescue path itself**, which no outside poster has ever exercised. Worth a
  deliberate, scheduled test rather than a side effect.

## Housekeeping

- Four demand-signal records exist from `0xA287a52b…7bf6`. They are ours. They must not be
  read as external demand.
- Catalogue job `0xc75efd7b…05a9` is **live and genuinely claimable** — its title says "do
  not claim", but nothing enforces that and a worker who claims it earns the 1 USDC.
