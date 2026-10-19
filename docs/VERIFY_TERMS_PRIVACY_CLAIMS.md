# Verify terms and privacy: implementation evidence

Source packet: `claude/packets-2026-08-12`, `e8f1381b`,
`docs/PACKET_VERIFY_TERMS_AND_PRIVACY.md`. One PR; Claude gates the code and
Pascal approved the public wallet/transaction disclosure on 2026-10-17 and ships
after Claude's gate passes. Both pages derive their date from the first-parent
Git commit that publishes the legal text (UTC), so a later merge shows its actual
date and unrelated rebuilds retain it. CI fetches full history; the Docker deploy
build receives the same date resolved on the host. Coinbase CDP is excluded;
that disclosure belongs to the future x402 poster-rail PR. Workflow language is confined
to this review evidence and the PR, not the public pages or discovery copy.

Rebased onto `origin/main` at `4c4b4e6b` on 2026-10-19, preserving the operator
facts supplied on 2026-10-18. Receipt fix #1501 and per-service log caps #1502
are merged and deployed, as confirmed by the operator. Hosting is with OVH in
Lille, France (EU), and the Verify runner is at OVH in France (EU).

## Credential boundary

`verify-routes.js` extracts the bearer value from
`verification-target-authorization` into `ephemeralCredential`.
`VerificationRunService.createRun` validates `target.auth` parity and passes that
value separately to `McpProbeCoordinator.start`; the queued record explicitly
copies only target/inputs and other public run metadata. The private payment
authorization is a different object. `McpProbeCoordinator.execute` sends the
credential to the isolated prober, clears its local reference in `finally`, and
removes the run's in-flight promise when it finishes. The fixed
`McpFailureSemanticsRunner` creates a new transport for each run; it projects
fixed check descriptions instead of persisting target responses or error bodies.
There is no credential cache, durable retry queue, event payload or public field.
This is lifetime scoping, not a claim of physical memory zeroization in V8.

`verify-credential-privacy.test.js` exercises the real HTTP route, service,
coordinator, internal HTTP prober/client, fixed runner, finalizer, receipt builder,
and KMS receipt signer with local signing keys. Only payment settlement, the
external target transport, grant minting and AWS are fixtures. It sends a sentinel
in the real header and tests approved, rejected, unreachable, platform-fault,
prober-failure and dispatch-failure outcomes. Target errors and responses echo the
sentinel. Assertions inspect every state-store call (including transient writes),
all map/array state, run GET JSON, receipt GET JSON and aliases, signed receipts,
the event log, raw logger/console arguments, serialized logger output, and raw
stdout/stderr writes. Replays
must not dispatch again, a later authenticated run without its header must fail,
and a subsequent unauthenticated run must receive no credential. The real
`server.js` smoke test separately checks stdout/stderr at debug level on refused
requests and the terms redirect. No live payment or external target is used.

No credential persistence leak was found in these paths. The integration test did
find a receipt-signing defect: decisive deterministic verdicts may omit `reason`,
but `buildVerifyReceipt` retained `reason: undefined`, rejected by the strict JWS
canonicalizer. The fix landed in PR #1501 (`a341bd9c`) and is live.
This terms PR is based on that fix and does not change the receipt builder.
The original ten targeted mutations are recorded in
[evidence/verify-terms-privacy/credential-mutations.json](evidence/verify-terms-privacy/credential-mutations.json).

Six additional scope-handback mutations (raw stdout/stderr, independent public
companion, hard-coded date, author date instead of merge date) are recorded in
[evidence/verify-terms-privacy/scope-handback-mutations.json](evidence/verify-terms-privacy/scope-handback-mutations.json).

## Claims and their evidence

Paths below are relative to the repository. The PR body supplies clickable code
citations. Policy commitments are identified separately: source code cannot prove
an operator's address, future refunds, hosting location, or a future retention
promise.

| Public claim | Implementation or policy evidence |
| --- | --- |
| Operator identity, address and contact (§1) | Existing `marketing/src/pages/imprint.astro`; the supplied packet is the operator's assertion. |
| POST endpoint; profile, target and inputs; published profiles, limits and prices (§2) | `createVerifyRoutes` in `mcp-server/src/protocols/http/verify-routes.js`; `validateVerificationRunRequest` and `createRun` in `services/verification-run-service.js`; `services/verification-profile-registry.js`; `core/verification-profile-prices.js`; `core/verify-pricing.js`; `marketing/src/pages/pricing.astro`. |
| Sandboxed execution (§2) | `deploy/docker-compose.mainnet.yml` isolates Witness, structured-output and MCP probers; `services/witness-runner-service.js`, `mcp-probe-coordinator.js`, `mcp-failure-semantics-runner.js`, `mcp-egress-grant-service.js`; Docker proxy and egress policy enforce the runner boundaries. |
| Outcomes and signed receipts (§2, §6) | `VerificationRunService.finalizeExecution`, `core/work-receipt.js:buildVerifyReceipt`, `core/badge-receipt-signing.js:KmsBadgeReceiptSigner` and production-required `loadBadgeReceiptSigningConfig`; `badge-routes.js` publishes JWKS. The text explicitly includes the existing non-billed `platform_fault` outcome. |
| x402, Base USDC, requested-profile quote and exact amount (§3, §9) | `payments/x402-verification-payment-gate.js:authorize`, `paymentRequirements`, `normalizeAuthorization`; `core/verification-profile-prices.js`; `deploy/backend.mainnet.env.template` pins Base chain, USDC contract and RPC. An authorization already reserved for a run keeps its stored price during capture/reconciliation. A new purchase is validated against current requirements; a stale, unreserved proof is not a price lock. |
| Only approved/rejected runs billed; inconclusive/platform faults free (§3) | `VerificationRunService.finalizeExecution` capture branch and `notBilled`; the sentinel tests exercise all outcomes, and the existing receipt/payment suites exercise billing and reconciliation. |
| Unused expiry or on-chain cancellation before capture is not billed (§3) | `X402VerificationPaymentGate.reconcileCapture` checks `AuthorizationCanceled`, nonce state, expiry and transfer evidence; `VerificationRunService.finalizeExecution` converts cancelled/expired results to `not_captured`. Existing X1d–X1f tests remain in the backend suite. |
| Captured payment is a confirmed on-chain USDC transfer (§3) | `X402VerificationPaymentGate.capture` calls `transferWithAuthorization` and waits for successful receipt; reconciliation requires matching transfer evidence. There is no application-level reversal. Chain permanence is an external chain property, not a guarantee established by an application test. |
| Refund by new transfer; dispute within 30 days; review run/receipt/logs; refund own faults, not correctly applied profiles (§4) | Operator policy fixed by the packet and expressed in `marketing/src/pages/terms.astro`. No automatic refund/dispute API is claimed or added. The review artifacts are stored runs/receipts plus technical logs; raw target output and credentials are not retained for dispute review. |
| Submission rights, no secrets/personal data in bodies, scoped revocable credential exception, revocation and no attacks (§5) | Customer obligations in the packet. `assertMcpEndpointCredentialBoundary`, schema validation and `assertEphemeralCredential` enforce the supported credential channel; the new sentinel tests prove its lifetime/persistence boundary. `createVerifyRoutes` calls the `verify_runs` rate limiter before payment or execution. |
| Public run records include target/inputs/verdict/billing, paying wallet address and payment transaction; public receipts by run id (§5–6 and privacy) | `VerificationRunService.getRun` / `publicRun` exposes `customer` and `billing.transactionHash`; `buildVerifyReceipt` includes `intent.poster` / `execution.provider`; unauthenticated GET in `verify-routes.js`; `badge-routes.js` resolves `/receipts/:runId` to the immutable receipt. The private payment proof is stored separately and is not in this projection. |
| Receipt verification using public keys (§6) | `core/badge-receipt-signing.js` canonical bytes and signature verification; `badge-routes.js` JWKS endpoint; the sentinel checks cryptographically verify each signed receipt. |
| Bounded automated evidence, no warranty/audit/certification/legal advice, as-is service (§7) | Profile success criteria and limits in `verification-profile-registry.js`; `buildVerifyReceipt` attestation and evidence hashes describe one run. The warranty disclaimers are operator policy. |
| Run-price liability cap, exclusions and mandatory-law carve-outs (§8); changes published with date (§9); Swiss law, Zurich venue and consumer carve-out (§10) | Fixed operator policy from the packet in `marketing/src/pages/terms.astro`, not executable settlement rules or a claim of legal advice. Pascal's final approval is required. |
| Payer address, signed EIP-3009 amount/nonce/validity and transaction processed (privacy) | `X402VerificationPaymentGate.authorize` verifies and returns authorization fields; `VerificationRunService.createRun` calls `persistableAuthorization`; `state-store.js` keeps the private authorization separately; capture/reconciliation stores the transaction in billing. |
| Run profile, target, inputs, verdict, execution summary and signed receipt processed (privacy) | `VerificationRunService.createRun` / `finalizeExecution`, `McpProbeCoordinator.execute`, and `buildVerifyReceipt`. |
| Legal basis: requested service and legitimate interest (privacy) | Operator's stated processing purposes in the supplied packet; this is a legal/policy statement, not something code can establish. |
| Runs/receipts indefinitely in the live database; payment records 10 years (privacy) | `state-store.js:RESERVE_VERIFICATION_RUN_SCRIPT` writes run and private authorization without expiry; `RedisStateStore.putWorkReceiptDocument` writes receipts without expiry; production Redis uses AOF and a host-mounted data volume in `deploy/docker-compose.mainnet.yml`. Only replay indexes/leases expire. The ten-year business-record retention is an operator commitment; there is no ten-year deletion job or archival SLA proved by this PR. |
| Logs are size-capped per service; oldest entries are deleted at the cap; security and abuse prevention, not profiling (privacy) | The published sentence is the operator policy. It states no time-based log retention. Size caps are the json-file logging anchor on every service in `deploy/docker-compose.mainnet.yml`, landed in #1502 (`4c4b4e6b`): `json-file`, `max-size: 10m`, `max-file: 5`. `scripts/ops/mainnet-compose-logging.test.mjs` parses the Compose file and requires that configuration on every service. `core/logger.js` and `server.js` describe the emitted technical data. |
| Hosting is with OVH in Lille, France (EU); the Verify runner is at OVH in France (EU) (privacy) | Operator-supplied hosting location confirmed on 2026-10-18 in the privacy page. Compose defines the server workload, not provider or geography. |
| Base public RPC and Base (Coinbase) as sub-processor (privacy) | `deploy/backend.mainnet.env.template` sets `BASE_RPC_URL=https://mainnet.base.org`; `createConfiguredX402VerificationPaymentGate` builds the Base providers; `createBaseSubmitter` connects the capture signer. Provider identity is supplied by the packet. |
| AWS KMS in eu-central-2 signs capture (privacy) | `createBaseSubmitter` selects `KmsSigner` for `SIGNER_BACKEND=kms`; `blockchain/kms-signer.js:signTransaction`; production template selects KMS, with region/key resolved from operator secret references. Exact deployed region is an operator-controlled setting; this PR does not access production secrets. |

## Surface inventory

Changed: Astro terms/privacy/footer; shared site/API llms builder; API `/terms`
302, root endpoint list, metric path label; discovery source and all three
committed mirrors; OpenAPI and PUBLIC_COMPANIONS; marketing sync allow-list;
deployment terms/privacy byte checks; built content/date guards; Git merge-date
resolution and CI full-history checkout;
credential integration and HTTP smoke tests. No generated site HTML is committed.

Checked: marketing source llms file and generator; sitemap generator; existing
pricing page; profile registry and payment price guards; receipt serialization
(now isolated in #1501), public receipt route and
signer; payment capture/reconciliation; state persistence/event log; prober/runner
and HTTP logging; deployment Compose/env template. Existing SDK, MCP tools,
price fixtures need no new method or price changes.
No runtime environment, VPS secret, Caddy, indexer or contract change is required.
The Docker site build receives only the public VERIFY_LEGAL_REVISION_DATE metadata
resolved from the host checkout; no new operator configuration is required.
