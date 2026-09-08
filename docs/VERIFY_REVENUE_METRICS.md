# Private Verify revenue and Hub sponsorship readings

`GET /metrics` appends these readings only for the configured metrics bearer.
They are never registered in the shared process-metrics registry, so enabling
unauthenticated process metrics locally does not disclose financial figures.
No new endpoint, environment variable, ledger or payment path is introduced.

## Sources and units

| Series | Source and meaning |
| --- | --- |
| `averray_verify_billed_usdc_total{network="eip155:8453",outcome}` | Sum of existing completed Verify run billing records with `status: captured`, a confirmed-capture transaction hash, and verdict `approved` or `rejected`. USDC, deduplicated by transaction. |
| `averray_verify_billed_runs_total{network="eip155:8453",outcome}` | Count of those captures, separated by decisive verdict. |
| `averray_hub_claim_subsidy_estimate_usdc` | The overnight ledger's sum of retained `session.onboardingSubsidy.estimatedClaimSubsidyUsdc`. An estimate, not measured USDC transfers. |
| `averray_hub_first_withdrawal_grants_dot` | DOT amounts from retained `operator_gas.first_withdrawal_granted` events, deduplicated by transaction. Does not include transfer gas fees. |
| `averray_hub_first_withdrawal_grants` | Number of those distinct retained grants. |

Verify's existing finalizer persists billing only after the payment gate's
confirmed capture. The reader reuses those records; it does not re-submit,
reconcile receipts on-chain, or enumerate every transfer to the receiving
address. Inconclusive/platform-fault outcomes, authorizations without capture,
poster fees, claim-bond fees and reward-bank capital never enter Verify volume.

Hub series are gauges: session/event retention can lower their sums. Calling
them monotonic lifetime counters would fabricate continuity. DOT grants and
USDC-denominated subsidy estimates remain separate; there is no invented FX
conversion, expense total, or net-revenue calculation.

## Coverage and failure behavior

Scrapes share a single read and cache it for 30 seconds. The reader scans at
most 10,000 Verify records / 100 pages; a limit or source failure omits Verify
amounts and sets `averray_financial_metrics_available{source="verify"}` to zero.
The equivalent `source="hub"` flag describes the Hub read, not completeness.
`averray_financial_metrics_as_of_seconds` timestamps the assembly.

The overnight source reads at most 10,000 sessions and requests 5,000 retained
events. `averray_hub_outflow_read_bounded` flags a reached limit or event gap;
zero is not a claim that pre-retention history exists.

Known missing operator spend: transaction gas fees. The gateway returns gas
usage for a first-withdrawal transfer, but the existing grant receipt/event
does not persist its gas cost; other operator transaction fees are not covered
by these ledgers either. `averray_hub_operator_transaction_fees_available` is
therefore zero, with **no fee amount emitted**. That is unavailable expense,
not zero expense. Measuring it requires separate fee evidence; this read-only
packet does not create another ledger to make that number appear.

## Credit pack deferral

The 10× credit pack is deferred: runner and facilitator unit cost is not
recorded, so a cost-covering redemption floor cannot be computed or enforced.
Measuring that cost is separate work.
