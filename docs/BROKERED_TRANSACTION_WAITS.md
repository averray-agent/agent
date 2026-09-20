# Brokered transaction receipt waits

All gateway receipt waits use `transaction-wait.js`. `BROKERED_TX_TIMEOUT_MS`
defaults to **60000** (accepted range 1000–120000). This is a **per-transaction
receipt wait**, not a whole HTTP request deadline: a claim can create a job,
enable its waiver, and claim it in separate transactions. Signing and broadcast
transport budgets are unchanged.

Sixty seconds leaves ample room relative to the packet's approximately two-second
Hub block interval (and approximately 30 seconds for twelve confirmations), while
bounding a stalled receipt subscription well below the previous 300-second client
failure. We still request **one confirmation**, not twelve. After the bound,
receipt and latest-sender-nonce probes run in parallel on every write runner,
bypassing the read quorum; each probe is capped at two seconds. Thus chain waiting
and recovery normally finish within 62 seconds, excluding state-store writes.
Neither a consumed nonce nor an RPC failure alone proves success. A receipt with
status zero remains a revert. The helper never signs or rebroadcasts.

The canary sets `AbortSignal.timeout` to five sixths of the same configured value
(**50000 ms** by default) on claim, submit and verifier HTTP calls. If an operator
overrides the server value, use that same `BROKERED_TX_TIMEOUT_MS` in the canary
environment. A client abort does not cancel the server transaction. The failed
artifact records stage duration, `keccak256(UTF8(jobId))`, and the job's state and
worker **before cleanup**. A read failure is recorded as unavailable. Existing
archive and payout-recovery behavior is unchanged.

## Evidence and durable recovery

Structured info events are `tx_wait_started`, `tx_wait_probe`, `tx_wait_block`,
`tx_wait_block_silence`, `tx_wait_timeout`, `tx_wait_recovered_by_reread`, and
`tx_wait_completed`. They include stage, jobId when applicable, txHash, nonce,
runner origin (never URL credentials/path/query), and total elapsed `ms`.
The final event includes block-event count and silence duration even when no
block was seen. Probe events identify each runner, phase (immediate/recovery),
receipt/null/error, and latest nonce during recovery. This distinguishes missing
block events from runner receipt lag without assuming which caused the incident.

Before waiting, the gateway persists the hash and nonce in the existing durable
service-state store under `brokered-tx:<hash>` and, for job transactions,
`brokered-job:<chainJobId>:<stage>`. Status becomes confirmed, timeout, or failed.
The normal Redis namespace/prefix applies. A `brokered_tx_timeout` response includes
stage, txHash and nonce; claim responses also include the recoverable sessionId.

Before the claim broadcast, `brokered-claim:<sessionId>` pins the admitted job and
economics. A subsequent session read or claim retry can finalize the same wallet's
landed claim from those terms without another broadcast. A still-pending claim
refuses another send and retains its hash. Existing submit/settlement chain
reconciliation and verifier decisions are unchanged; their transaction hashes
are retained in the job journal too.

The external-posting observer recognizes a platform create only when both its
transaction hash and poster match the `ensureJob.create` journal. This suppresses
the known false alarm without suppressing unrelated creates from the same wallet.

## Post-deploy handback

After the operator gate and deployment, capture the deploy SHA and the next
**scheduled** Hosted Worker Canary run's JSON artifact and workflow link. A manual
or deploy-triggered run is not a substitute. No schedule, reward, verifier,
contract or chain-stage bypass changes are part of this fix.
