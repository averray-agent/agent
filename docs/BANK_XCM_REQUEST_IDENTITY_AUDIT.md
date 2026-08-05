# Bank XCM request identity audit

Date: 2026-08-05

An XCM wrapper request is identified by `(wrapperAddress, requestId)`. Request
ids are deterministic within a wrapper generation and can repeat after a
wrapper replacement. Any off-chain record that can authorize, suppress,
finalize, or render a wrapper request must therefore retain both values.

## Durable and presentation stores

| Surface | Identity after this change | Rationale |
| --- | --- | --- |
| Balance watches and pending/terminal indices | `(wrapperAddress, requestId)` | A watch belongs to the contract that emitted `RequestQueued`. |
| Settlement observations and pending index | `(wrapperAddress, requestId)` | A destination delta from a retired wrapper must not suppress or finalize a current wrapper request. |
| Watch-to-observation join in the Bank feed | Exact `(wrapperAddress, requestId)` | Prevents evidence from one generation satisfying another generation's tile. |
| Board request rows | Carries both fields; derived from the scoped watch | There is no request-id-only secondary index. Retired generations are filtered by the configured wrapper and target. |
| Calibration record | Balance-target source, not request id | Calibration proves a venue balance reader. `validCalibration` invalidates it whenever the configured account or asset target changes, including every converted-account generation change. It neither authorizes nor finalizes requests. |
| Event/evidence correlation ids | `requestId` for search; `wrapperAddress` in authoritative XCM event data | Correlation ids are non-authoritative log labels. No state transition or board join is permitted from correlation id alone. |

## Deliberately generation-agnostic records

| Surface | Why request-id-only is correct |
| --- | --- |
| `AgentAccountCore.strategyRequests` and account-overlay pending/settled request lists | These records share one deployed AgentAccountCore namespace. The contract, not a replaceable wrapper, owns request uniqueness. Treasury-staged adapter requests do not enter this overlay path. A successor AgentAccountCore requires its own migration packet. |
| `XcmWrapper.getRequest`, adapter `getAdapterRequest`, dispatch bitmaps, and parameters | Each lookup is already namespaced by the configured contract instance. Backend callers are bound to the configured wrapper/adapter pair before using them. |
| Runtime event-scan parameter map | Ephemeral within one configured-wrapper scan and discarded after the scan. It is never persisted or joined across generations. |
| HTTP idempotency receipts | Namespaced by route, authenticated caller, and client idempotency key. They prevent duplicate HTTP mutations and are not XCM evidence. |
| Relay cursor | Orders a configured observer feed. It does not identify or settle a request; every relayed observation is stamped with the configured wrapper before persistence. |

## Settlement truth boundary

A destination balance delta is an observation, not a settlement. The board may
render `succeeded` only when all of the following agree:

1. the balance watch is terminal;
2. the scoped observation is processed;
3. the finalizer's post-transaction chain read is stored as
   `result.chainSettlement`; and
4. its wrapper, request id, status, and settled amounts match the observation.

Missing or mismatched chain proof renders `pending-finalize`, even if a balance
delta and a processed observation exist.

## One-time production migration

The only legacy request-id-only observation is the completed v2.2 deposit for
request `0xb609f4d875e0c6f4f4b1dddd90efd687215d1ac9ecd90d0de51b9304f57ecaac`.
Startup migrates it under wrapper
`0xEceE778e11B238D2fc096E56460e7B98DC7B26b8` only if its audited outcome is
Succeeded with `100000` assets, `100000` shares, and `processed=true`.
Any mismatch aborts startup. The current v2.2.1 terminal watch is then resumed
into its own namespace and follows the normal adapter-settlement path; no XCM
leg is dispatched again.
