# Render Deployment

## Service settings

- Runtime: `Node`
- Root Directory: `indexer`
- Build Command: `npm install`
- Start Command: `npm run start`
- Health Check Path: `/health`

## Required environment variables

- `PONDER_RPC_URL_420420417`
  Use `https://eth-rpc-testnet.polkadot.io/` for Polkadot Hub TestNet.

## Recommended environment variables

- `DATABASE_URL`
  Strongly recommended for hosted deployments. If omitted, Ponder falls back to local `PGlite`, which is fine for local development but not durable across hosted restarts.
- `NODE_OPTIONS=--max-old-space-size=384`
  Useful on constrained hosts to keep Node's heap below the free-tier memory ceiling.

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
- Hosted production-like deployment should use `DATABASE_URL` so indexed state survives restarts and redeploys.
- The current config indexes:
  - `TreasuryPolicy`
  - `EscrowCore`
  - `ReputationSBT`
  on Polkadot Hub TestNet.
