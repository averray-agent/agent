# Render Deployment

## Service settings

- Runtime: `Node`
- Root Directory: `mcp-server`
- Build Command: `npm install`
- Start Command: `npm run start:http`
- Health Check Path: `/health`

## Required environment variables

- `DWELLER_RPC_URL` (preferred) or `POLKADOT_RPC_URL` or `RPC_URL`
- `SIGNER_PRIVATE_KEY`
- `AGENT_ACCOUNT_ADDRESS`
- `ESCROW_CORE_ADDRESS`
- `REPUTATION_SBT_ADDRESS`
- `SUPPORTED_ASSETS`
- `REDIS_URL`

## Recommended environment variables

- `REDIS_NAMESPACE=agent-platform`
- `PORT`
  Render sets this automatically for web services.

## Expected health response

Successful deployment should return JSON like:

```json
{
  "status": "ok",
  "persistence": "RedisStateStore"
}
```

If `persistence` reports `MemoryStateStore`, `REDIS_URL` is missing or not being loaded correctly.
