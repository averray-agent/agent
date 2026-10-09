# Verify capture recovery

X1d addresses the 2026-10-09 gate finding on #1458: a confirmed Base
transfer followed by a failed wait or checkpoint must not be retried as an
unpaid execution. A used EIP-3009 nonce is not payment proof: cancellation
consumes it too.

Before broadcasting, the finalizer persists the original execution and verdict,
`status: executed`, and `billing.status: capturing`. It also checkpoints a Base
block number for legacy fallback. New authorizations record `authorizedAtBlock`
at intake, before the nonce read. The broadcast hash is persisted as
`billing.pendingTransactionHash` before waiting. Retries use the original
verdict, never a new evaluation. Capturing runs expose neither their verdict nor
execution through GET or payment-proof replay.

Recovery uses the known transaction receipt first: status 1 confirms capture;
status 0 goes back through nonce/event reconciliation (an earlier broadcast may
have paid); a missing receipt remains pending. Every capture throw also
reconciles, with the error's name/code logged without payment material.
The scan starts at `authorizedAtBlock`, including cancellations during execution.
Without that legacy field it starts at the persisted checkpoint. It searches for
the payer/nonce's AuthorizationUsed or AuthorizationCanceled event. Capture
requires a successful receipt with a USDC Transfer(from, payTo, value >= required)
in the same transaction. It records that hash and
`billing.proof: reconciled_from_chain`; revenue metrics count it normally.
Cancellation completes inconclusively as `payment_cancelled_by_payer`, unbilled.
No matching event plus an unused nonce permits capture retry.

Scans stop at the final block within `validBefore`, found by bounded binary
search when expired. Each attempt reads at most 10,000 event blocks in chunks
of at most 1,000, persisting progress for larger windows. Once the latest chain
timestamp is past `validBefore`, the nonce is unused and the complete window
contains no AuthorizationUsed, completion is inconclusive
`payment_authorization_expired`, unbilled. Legacy gaps cannot establish that:
unresolved legacy runs contribute to the single counted
`verify_capture_legacy_unresolved` /health warning (30-second cache).

Pending/error retries persist `nextCaptureAttemptAt`: exponential delay from
5 seconds, capped at 5 minutes. No capture RPC happens between attempts.
Finalizer selection pages past sleeping/unfinished rows to fill the due batch;
active-index selection finishes before completions can shift offsets.

An inconsistent head, RPC failure, used nonce without matching payment
evidence, or pending receipt is **not** evidence of non-payment. Leave the run
retryable and investigate Base chain data; do not release or create an
unbilled receipt. Read failures log runId, error name and code without payment
proofs. Per-run isolation lets subsequent runs finalize in the same tick.

The disabled gate and compose-smoke gate explicitly cannot reconcile. The
finalizer logs that condition once per run (persisted marker) and retains the
checkpoint. Do not replace it with a fabricated captured/unbilled verdict.
