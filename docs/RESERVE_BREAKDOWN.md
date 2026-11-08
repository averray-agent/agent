# Reward-bank reserve breakdown (admin)

`GET /admin/ops/reserve-breakdown` requires `ops:view`, like the other admin
ops reads, and returns `Cache-Control: no-store`. Unauthorized callers receive
401/403 before any chain inventory work. There is no public or MCP alias.

The reader is restricted to Polkadot Asset Hub EVM chain 420420419 and the
packet's EscrowCore v3 `0xC2Eb191FB75246667226a5D5Db9d821f95a5f793`.
It scans signer-indexed JobCreated events from v3's deployment block 19414957
in bounded 10,000-block ranges, four concurrent ranges at a time. The in-memory
creation-id cursor advances only after a complete scan. Every request re-reads
job states and AAC positions; only immutable finalized creation ids are cached.
Concurrent admin requests share an in-flight read.

All chain calls in a snapshot use one finalized block number, whose timestamp
is returned as `chainTimestamp`. The first read after process start includes
historical discovery and may be slower. No indexer, local inventory or inferred
zero substitutes for chain history. Missing RPC/session/catalogue data produces
HTTP 503 with `status: unavailable`, `reason: reserve_breakdown_not_reported`
and null totals. It never returns a partial total as complete.

For each Open, Claimed, Submitted, Rejected and Disputed state, the response
contains jobCount, reservedRaw, oldestAgeSeconds, sweepableNow,
sweepableReservedRaw and admin-only jobs. Amounts are decimal strings in USDC
base units (6 decimals). reservedRaw sums reward + protocolFee + opsReserve +
contingencyReserve. Closed/Cancelled, other assets, external posters and v2 are
excluded. `totalReservedRaw` sums the five groups; `chainReservedRaw` is AAC
positions(signer, USDC).reserved. `unexplainedReserved` is their signed
**chain minus grouped** difference, including negative differences; it is never
clamped or hidden. Other reserve consumers can explain a nonzero difference.

Age is finalized block timestamp minus on-chain createdAt. Empty groups have
null oldest age. Sweepability uses the contract's DISPUTE_WINDOW and
MIN_OPEN_FOR_CANCEL, not hard-coded equivalents. Rejected and Claimed require
strictly past their deadlines. Open requires the cancellation floor and either
a stale/closed catalogue lifecycle or age over 14 days (the future sweeper's
RESERVE_SWEEP_OPEN_MAX_AGE_DAYS setting). Submitted and Disputed never qualify.
A session not in an explicit terminal state excludes the job. Failure to read
complete session history is unavailable, never interpreted as no active claim.

This PR sends no transactions and schedules no sweeper. Eligibility is a
snapshot, not an authorization to send: PR 3 must re-read state and session
activity immediately before a guarded transaction, dedupe receipts, check gas
and enforce the run cap. Its initial mode is log only.

Operator correction supplied 2026-11-03 for PR 3: add
RESERVE_SWEEP_MIN_SIGNER_NATIVE_DOT=2; parse with 18 EVM decimals, not planck.
Before each transaction, balance minus estimateGas times gasPrice must be at
least the floor. Unreadable balance stops. Apply this in log mode too, count
reserve_sweep_gas_floor_stop, and emit admin-only reward_signer_native_low
when balance is below the floor in either mode. No such signer floor existed
before this packet; the XCM delivery-fee minimum is unrelated.
