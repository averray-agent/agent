# Verify capture recovery

X1d addresses the 2026-10-09 gate finding on #1458: a confirmed Base
transfer followed by a failed wait or checkpoint must not be retried as an
unpaid execution. A used EIP-3009 nonce is not payment proof: cancellation
consumes it too.

Before broadcasting, the finalizer persists the original execution and verdict,
`status: executed`, and `billing.status: capturing`. It also checkpoints a Base
block number. The broadcast hash is persisted as
`billing.pendingTransactionHash` before waiting. Retries use the original
verdict, never a new evaluation. Capturing runs expose neither their verdict nor
execution through GET or payment-proof replay.

Recovery uses the known transaction receipt first: status 1 confirms capture;
status 0 establishes a reverted capture; a missing receipt remains pending.
Without a hash it scans from the persisted block through the current head for
the payer/nonce's AuthorizationUsed or AuthorizationCanceled event. Capture
requires a successful receipt with the exact USDC Transfer(from, payTo, value)
in the same transaction. It records that hash and
`billing.proof: reconciled_from_chain`; revenue metrics count it normally.
Cancellation completes inconclusively as `payment_cancelled_by_payer`, unbilled.
No matching event plus an unused nonce permits capture retry.

Scans are bounded to 10,000 blocks, in chunks of at most 1,000. An older
checkpoint, inconsistent head, RPC failure, used nonce without matching payment
evidence, or pending receipt is **not** evidence of non-payment. Leave the run
retryable and investigate Base chain data; do not release or create an
unbilled receipt. Read failures log runId, error name and code without payment
proofs. Per-run isolation lets subsequent runs finalize in the same tick.

The disabled gate and compose-smoke gate explicitly cannot reconcile. The
finalizer logs that condition once per run (persisted marker) and retains the
checkpoint. Do not replace it with a fabricated captured/unbilled verdict.
