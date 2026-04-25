# Render Deployment

## Service settings

- Runtime: `Node`
- Root Directory: `indexer`
- Build Command: `npm install`
- Start Command: `npm run start`
- Health Check Path: `/health`

## Required environment variables

Every deployment must set these contract addresses and the chain's RPC
endpoint. Booting without any of them fails fast — there is no longer a
silent fallback to pre-existing testnet addresses.

- `TREASURY_POLICY_ADDRESS`
- `ESCROW_CORE_ADDRESS`
- `AGENT_ACCOUNT_ADDRESS`
- `REPUTATION_SBT_ADDRESS`
- `VERIFIER_REGISTRY_ADDRESS`
- `DISCOVERY_REGISTRY_ADDRESS`
- `DISCLOSURE_LOG_ADDRESS`
- `DWELLER_RPC_URL` (preferred) — or `POLKADOT_RPC_URL` — or the legacy `PONDER_RPC_URL_<chainId>` form

Optional:

- `XCM_WRAPPER_ADDRESS`
  Enable indexing of async XCM request lifecycle events when
  `contracts/XcmWrapper.sol` has been deployed for the target environment.

For a Polkadot Hub TestNet deployment:

- `POLKADOT_CHAIN_ID=420420417` (default, can be omitted)
- `POLKADOT_CHAIN_NAME=polkadotHubTestnet` (default, can be omitted)
- `DWELLER_RPC_URL=https://your-dweller-rpc`

For mainnet cutover, set the new chain id, chain name, and RPC plus the
mainnet contract addresses. The config will not start without them.

The `PONDER_*_ADDRESS` aliases are still honoured for backwards compatibility
with earlier deployments.

## Recommended environment variables

- `DATABASE_URL`
  Strongly recommended for hosted deployments. If omitted, Ponder falls back
  to local `PGlite`, which is fine for local development but not durable
  across hosted restarts.
- `NODE_OPTIONS=--max-old-space-size=384`
  Useful on constrained hosts to keep Node's heap below the free-tier memory
  ceiling.

## Free-tier viability mode

If you want to test the concept on a Render free instance before paying, use:

- `PONDER_LOW_MEMORY=true`
- `PONDER_ENABLE_TREASURY=false`
- `PONDER_START_BLOCK_ESCROW=latest`
- `PONDER_START_BLOCK_REPUTATION=latest`
- `NODE_OPTIONS=--max-old-space-size=384`

This reduces memory pressure by:

- disabling RPC cache
- shrinking `eth_getLogs` batch size
- slowing polling
- skipping treasury indexing
- avoiding historical backfill for escrow/reputation

Tradeoff:

- the free-tier mode only indexes new events after the service starts
- it is for viability testing, not historical completeness

## Historical backfill start blocks

For a fresh production deployment, set explicit start blocks so Ponder
backfills from the deployment block of each contract rather than genesis:

- `PONDER_START_BLOCK_TREASURY`
- `PONDER_START_BLOCK_ESCROW`
- `PONDER_START_BLOCK_REPUTATION`
- `PONDER_START_BLOCK_XCM` when `XCM_WRAPPER_ADDRESS` is set

The AgentAccountCore events piggy-back on the escrow start block. If any of
these is omitted it defaults to `0` (full backfill) unless
`PONDER_LOW_MEMORY=true`, which uses `latest`.

## Expected endpoints

- `/health`
  Returns the Ponder health status.
- `/`
  Returns a small JSON payload from the custom API entrypoint.
- `/graphql`
  GraphQL API for indexed data.
- `/sql/*`
  SQL client endpoint exposed by Ponder.
- `/xcm/outcomes`
  Cursor-based feed of terminal XCM request outcomes. This is the
  producer-facing contract the MCP server relay can consume via
  `XCM_OBSERVER_FEED_URL`.
- `/xcm/outcomes/status`
  Runtime status for the external outcome publisher worker.

## Notes

- Local development uses `PGlite` automatically.
- Hosted production-like deployment should use `DATABASE_URL` so indexed
  state survives restarts and redeploys.
- The indexer tracks `TreasuryPolicy`, `EscrowCore`, `AgentAccountCore`, and
  `ReputationSBT` on whichever chain is configured.
- When `XCM_WRAPPER_ADDRESS` is configured, it also indexes `RequestQueued`,
  `RequestPayloadStored`, and `RequestStatusUpdated` from `XcmWrapper`.
- The `/xcm/outcomes` feed currently serves terminal outcomes from the
  indexed `XcmWrapper` request ledger.
- When `XCM_EXTERNAL_SOURCE_TYPE=feed` and `XCM_EXTERNAL_SOURCE_URL` is
  configured, the indexer starts an external outcome publisher worker that
  polls the upstream watcher feed, persists published outcomes in
  Postgres/PGlite, and makes `/xcm/outcomes` serve that published feed
  instead of relying only on the indexed ledger.
- When `XCM_EXTERNAL_SOURCE_TYPE=subscan_xcm` plus
  `XCM_SUBSCAN_API_HOST` and `XCM_SUBSCAN_API_KEY` are configured, the same
  publisher uses Subscan's official XCM API transport as the upstream source.
- The Subscan integration currently relies on documented transport details
  and defensive response-field normalization. The `POST /api/scan/xcm/list`
  endpoint and `x-api-key` auth are documented by Subscan, but the exact
  terminal-outcome field mapping should still be validated against your paid
  plan payload before mainnet use.
- `XCM_EXTERNAL_SOURCE_TYPE=native_papi` is reserved for the native
  Polkadot/Bifrost observer lane. It currently validates
  `XCM_NATIVE_HUB_WS`, `XCM_NATIVE_BIFROST_WS`,
  `XCM_NATIVE_START_BLOCK`, and `XCM_NATIVE_CONFIRMATIONS`, then fails
  clearly until the request-id correlation gate in
  [docs/NATIVE_XCM_OBSERVER.md](../docs/NATIVE_XCM_OBSERVER.md) is complete.
- Captured native evidence should pass
  `npm run validate:native-xcm-evidence -- --file <capture.json>` before it
  is used to justify enabling live native observer reads.
- Use `npm run capture:native-xcm-evidence` to assemble a capture from
  Hub-side and Bifrost-side replay/PAPI artifacts.
- Use [scripts/ops/validate-subscan-xcm-source.mjs](../scripts/ops/validate-subscan-xcm-source.mjs)
  once a staging key is configured. It validates the direct Subscan
  transport, can capture a sanitized sample report, and can verify that the
  indexer is serving the published external feed instead of only the indexed
  fallback.
