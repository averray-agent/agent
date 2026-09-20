# PACKET — The scheduled canary hangs at exactly the stages that send a transaction

Status: **ready for Codex, 2026-09-20.** Evidence is from the three most recent
failed runs' artifacts (`worker-canary-hosted-<run>.json`), their job logs, and
chain reads of the canary jobs on EscrowCore v3. Codex has no production read
path; the operator log pull in §4 is Pascal's.

## 1. What is happening

Every **scheduled** run of `Hosted Worker Canary` since 2026-09-15 has failed
(09-15, 09-16, 09-17, 09-18, 09-19; the schedule fires ≈11:30–12:00Z). Every
**deploy-triggered** run in the same period passed, including two on 09-17 at
08:33Z and 10:24Z — the last of them only 96 minutes before that day's
scheduled failure at 12:00Z. Same code, same SHA (04c0f86c since 09-17 10:24Z).

The failing stage is always one that makes the backend **broadcast a chain
transaction** from the KMS signer and wait for it. The stages before it, which
are pure reads and signatures (`operatorReadiness`, `arrivalAttribution` 201,
`siwe` 200, `account` 200), pass every time.

| run | stage | client error | job on chain after the run |
|---|---|---|---|
| 35218735439 (09-17 12:00Z) | **submit** | `fetch failed` | state 3 Submitted, worker = canary wallet, `brokeredClaims` true → the *claim* landed; the submit's verify-and-settle never resolved |
| 35341179908 (09-18 11:45Z) | **claim** | `fetch failed` | state 1 Open, worker `0x0` → the claim tx **never landed** |
| 35440213593 (09-19 11:28Z) | **claim** | `fetch failed` | state 1 Open, worker `0x0` → the claim tx **never landed** |

Timing from the 09-19 log: `Creating disposable canary job` at 11:29:52Z, the
next line is the cleanup at 11:34:55Z — **303 s**. The canary calls the API
through `globalThis.fetch` with no `AbortSignal`, and undici's default headers
timeout is 300 s, so `fetch failed` here means *the backend held the socket
open for five minutes without answering*, not a refused connection. The job
create (an operator-side chain transaction, also KMS-signed) succeeded seconds
earlier in the same run, so the signer, the RPC and the chain were working at
11:29:52Z; something in the **worker-side brokered path** (`claimJobFor` /
`verifySubmission`) then hung.

Cost so far: five ephemeral 0.1 USDC jobs archived by cleanup (funds return
via the recovery path), and a red heartbeat nobody can trust. The canary is
the only external-worker probe we have.

## 2. Where it hangs — from the backend log of the 09-19 window (Pascal, 2026-09-20) + chain

The container log for 11:28–11:37Z shows the canary's requests (IP 20.169.71.0)
up to `GET /jobs/preflight 200` at 11:29:54, then exactly **two** blockchain
KMS signatures — 11:29:55.881 (285 ms) and 11:29:58.641 (20 ms) — and then
**nothing**: no `http.response` for `POST /jobs/claim` ever, no error, no
further blockchain signature, while `/health` kept answering in 5–100 ms
every 10 s (the event loop was fine) and other wallets did SIWE and reads
normally. The client's cleanup call arrives at 11:34:55.

Chain, by the signer's nonce:

| nonce | tx | what | mined |
|---|---|---|---|
| 2778 | `0x6e9306a4…bde3127` | `createJob` for `keccak("worker-canary-1789817390726")` = `0xfd57b369…` (the canary job) | block 20832906, status 1 |
| 2779 | `0xc2daef5b…809a58` | `setOnboardingWaiverEligible(0xfd57b369…, true)` | block **20832907** (the very next block), status 1 |
| 2780 | — | *never sent* — the signer's nonce stayed 2780 from 11:32Z through 12:07Z | — |

So: `ensureJob` signed the create, its `await createTx.wait()` returned (the
waiver was signed 3 s later), `ensureOnboardingWaiverEligibility` signed the
waiver, and **its `await tx.wait()` never returned** — for a transaction that
was mined one block after the create, status 1. `claimJobFor` was never
signed. The client gave up at 300 s. The job sat Open with worker `0x0`, which
is exactly what the artifacts show.

The waits are unbounded: `mcp-server/src/blockchain/gateway.js` has **34 bare
`await tx.wait()`** call sites and none pass a timeout (`tx.wait(confirms,
timeoutMs)` exists in ethers v6). The provider is a `FallbackProvider`
(`rpc-provider.js`, quorum 1, stall 250 ms, read timeout 750 ms, primary
`services.polkadothub-rpc.com`, backup `eth-rpc.polkadot.io`). Two mechanisms
fit everything observed; D1 distinguishes them:

- **(a) Stalled block subscription.** ethers' `wait()` checks the receipt once
  immediately, then relies on `block` events to re-check. If the immediate
  check ran before the primary had block 20832907 (it was one block behind the
  create's block) and the provider's block poller then stalled or lagged, no
  re-check ever happens. Corroboration: the backend's own external-posting
  observer logged the canary's `JobCreated` (block 20832906, chain time
  11:29:36) only at **11:32:33** — the backend's chain view was ≈3 min behind
  at that moment.
- **(b) A runner answering `null` receipts.** With quorum 1, the first runner
  to answer wins; a lagging runner answering `null` for `eth_getTransactionReceipt`
  is a valid answer and the loop keeps polling that view.

Either way the receipt existed on chain within seconds, and a bounded wait
that re-reads the receipt by hash (and the account nonce) across all runners
would have completed the canary. **This is not canary-specific**: every
brokered claim, submit/settle, and ceremony leg goes through the same bare
`tx.wait()`; an external worker's claim can hang the same way.

Secondary defect seen in the same log: `external_posting.unknown_job_observed`
fired for the platform's own canary create (poster = the KMS signer) — the
observer keys by chain job id before the store has learned it. Log-only today,
but it is a false alarm on the transparency surface; fix or suppress in the
same PR if cheap, otherwise file it.

Clock note for triage: chain block timestamps in this window run ≈20 s behind
the VPS clock (create mined "11:29:36" chain time, signed 11:29:55 VPS time).

## 3. Deliverables (one PR unless the measurement forces a second)

**D1 — Instrument the wait, not the route.** One helper wraps every
`tx.wait()` in the gateway (all 34 sites; no bare calls left, pinned by a
test that greps the source). It logs, per transaction: `txHash`, `nonce`,
the immediate receipt-check result, each block event seen while waiting (or
the absence of any for N seconds), which runner answered, and total `ms`.
Emit on completion *and* on timeout. This is what decides (a) vs (b) on the
next scheduled run.

**D2 — Bound the wait and re-read before failing.** The same helper passes a
timeout to `tx.wait(1, timeoutMs)` (one env knob; propose 60 s and say why —
a Hub block is ≈2 s, 12 confirmations ≈ 30 s). On timeout it does **not**
fail yet: it reads `eth_getTransactionReceipt(txHash)` directly on *each*
runner (bypassing the FallbackProvider's quorum) and reads the signer's
latest nonce; if the receipt exists, it returns it and logs
`tx_wait_recovered_by_reread`. Only if no runner has it does it throw a
named `brokered_tx_timeout` `{stage, txHash, nonce}`, and the hash is
persisted on the session/job so the next read converges. A timeout must
never orphan a landed transaction, and it must never re-broadcast.

**D3 — Canary client honesty.** (i) Pass an explicit `AbortSignal.timeout`
below the server deadline so the client fails on its own terms, with the stage
and elapsed ms in the artifact. (ii) On any claim/submit failure, **read the
job on chain before declaring the stage failed** and record `chainJobId`
(`keccak256(jobId)`; the artifact's `chainJobId` is `null` today, which is why
triage had to compute it) plus the job state and worker. A claim that landed
after the client gave up is a different failure class from one that never
landed, and the artifact should say which. (iii) Cleanup must keep archiving a
stranded job as now.

**D4 — Regression tests** that pin: the deadline fires and returns the named
error with the tx hash when one exists; a landed-after-timeout claim converges
(session reaches claimed on the next read, no second broadcast); the artifact
carries `chainJobId` and the on-chain state for both failure classes; the
timing log lines exist for each stage (assert the log shape, not prose).

Out of scope: changing the schedule, the reward, the recovery path, or the
verifier; anything that makes the canary pass by skipping the chain stages.

## 4. Operator evidence request (Pascal, before or alongside D1)

From the VPS, for the 09-19 window, the backend's own account of those 303 s:

```bash
docker logs agent-mainnet-backend --since 2026-09-19T11:28:00Z --until 2026-09-19T11:37:00Z 2>&1 | grep -iE 'http\.response|/jobs/claim|claim|kms|sendTransaction|nonce|wait|lock|timeout|error' | head -120
```

and the same for 09-18 (`11:44:00Z`–`11:53:00Z`). What we need from it: the
`http.response` line for `POST /jobs/claim` (or its absence), any `kms`/`nonce`
lines in the gap, and whether the auto-verifier or the keeper logged a tick in
the same seconds. Paste to Claude; it feeds D1's placement and decides
between (a)–(d) in §2.

## 5. Handback

PR number, CI link, the test names, the chosen deadline and its justification,
and — after deploy — the next scheduled run's artifact (pass, or a fail that
now names its stage, elapsed ms, and on-chain job state).
