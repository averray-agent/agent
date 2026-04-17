# Render Deployment

## Service settings

- Runtime: `Node`
- Root Directory: `indexer`
- Build Command: `npm install`
- Start Command: `npm run start`
- Health Check Path: `/health`

## Required environment variables

Every deployment must set these four contract addresses and the chain's RPC
endpoint. Booting without any of them fails fast — there is no longer a
silent fallback to pre-existing testnet addresses.

- `TREASURY_POLICY_ADDRESS`
- `ESCROW_CORE_ADDRESS`
- `AGENT_ACCOUNT_ADDRESS`
- `REPUTATION_SBT_ADDRESS`
- `DWELLER_RPC_URL` (preferred) — or `POLKADOT_RPC_URL` — or the legacy `PONDER_RPC_URL_<chainId>` form

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

## Notes

- Local development uses `PGlite` automatically.
- Hosted production-like deployment should use `DATABASE_URL` so indexed
  state survives restarts and redeploys.
- The indexer tracks `TreasuryPolicy`, `EscrowCore`, `AgentAccountCore`, and
  `ReputationSBT` on whichever chain is configured.
