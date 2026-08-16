# Packet — Canary payout recovery + trigger economics

**Date:** 2026-08-16 · **Author:** Claude (architect) · **Implementer:** Codex · **Operator:** Pascal
**Decision (Pascal, 2026-08-16):** losing ~0.10/run to dropped-key canary wallets is no longer
accepted cost. Future runs must return the payout to operator-controlled funds; historical parked
funds (~1.30 USDC v3-era, more pre-v3) are written off — `sendToAgentFor` requires the from-wallet's
signature and those keys are gone. This supersedes #1085's `accepted_cost` disposition.

## Change 1 — Recovery stage in the canary run
After settle confirmation and BEFORE the ephemeral key is dropped, `run-worker-canary.mjs` signs a
`sendToAgent` authorization: `from = canary wallet`, `recipient = the KMS signer's AAC account
(the reward bank)`, `amount = the settled payout`, fresh nonce, ~24h deadline. The EIP-712
shape is defined by `AgentAccountCore._useSendToAgentAuthorization` (read the contract; do not
invent the domain — reproduce it exactly, the x402 lesson). The run then submits the signed
authorization to the new admin route (Change 2) and polls until the `AgentTransfer` event
confirms. Evidence file: `payoutDisposition.status` gains `"recovered"` with the transfer tx hash;
`"accepted_cost"` remains only for runs where recovery failed (fail-open: a recovery failure must
NEVER fail an otherwise green canary — it degrades the disposition, loudly).

**Destination is the reward bank, NOT the treasury.** Recovered proof-costs are cost recycling,
not revenue; routing them to the treasury would inflate the revenue line made honest on
2026-08-16. (Truth-boundary law.)

## Change 2 — Admin route: submit consented agent transfer
`POST /admin/agent-transfers` (admin/service token): body `{from, recipient, asset, amount,
nonce, deadline, signature}` → backend KMS signer (the `agentTransferBroker`) submits
`sendToAgentFor` and returns the tx hash. Validate recipient ∈ operator-controlled allowlist
(reward bank; configurable) so the route cannot be used to route third-party balances anywhere
else even WITH a signature. Idempotent on (from, nonce). This route is deliberately the same
transport the CW-1 credit keeper will use (consented sweep) — build it once, share it.

## Change 3 — Trigger economics
`decide-worker-canary-trigger.mjs`: (a) skip deploy-triggered runs when a green mainnet canary
completed < 6h ago (the daily scheduled run is never skipped); (b) skip canary on docs-only
deploys (deploy diff touches only `*.md` / `docs/`). 2026-08-16 had FIVE runs (four
deploy-triggered) — under this policy it would have had two.

## Acceptance
1. One live canary run with `payoutDisposition.status: "recovered"`, the AgentTransfer tx hash in
   evidence, and reward-bank liquid delta == payout amount (net canary cost ≈ gas only).
2. A deploy within 6h of a green run produces a skipped-canary decision log line.
3. Recovery-failure path exercised in tests: green run + failed transfer → run passes,
   disposition `accepted_cost`, warning emitted.
