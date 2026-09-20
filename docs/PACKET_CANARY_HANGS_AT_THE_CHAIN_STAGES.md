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

## 2. What we do NOT know (and must not guess)

Whether the hang is (a) the KMS signing call (Roles Anywhere session refresh),
(b) `eth_sendRawTransaction` / nonce reads against the primary RPC, (c) the
`tx.wait()` after a broadcast that the RPC never reports, or (d) a lock or
single-flight held by another in-process caller (the 60 s auto-verifier scan,
the idle keeper's exit/fulfil ticks, the pool event-cache extension). The
create-job transaction succeeding seconds earlier argues against a dead RPC or
signer, but does not exclude a per-path lock. **The packet's first deliverable
is the measurement that decides this; no fix before the numbers.**

## 3. Deliverables (one PR unless the measurement forces a second)

**D1 — Stage timing on the brokered chain path.** Structured `info` logs (one
line per stage, with `ms`, `rpcUrl`, `nonce`, `txHash` when known, and the
route + jobId) around: KMS sign, `sendTransaction`, `tx.wait`, and any lock
acquisition, for `claimJobFor` and the submit-side settle. Emit on completion
*and* on abandonment. These lines are what Pascal greps in §4.

**D2 — A server-side deadline that names the stage.** The brokered claim and
submit paths must not hold the socket indefinitely. Bound the path (a single
env knob, default well under 300 s — propose 90 s and say why) and on expiry
return a named error (`brokered_tx_timeout` with `{stage, txHash?}`) *without*
losing the transaction: if a tx was broadcast, persist its hash on the
session/job so the auto-verifier or a follow-up read can converge on it. A
timeout must never orphan a landed claim.

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
