# Polkadot Agent Platform

This repository contains a greenfield implementation of an agent-first treasury and job runtime:

- Foundry contracts for account, escrow, policy, strategy registry, and reputation
- A shared service layer exposed through MCP, A2A, and HTTP
- Discovery and indexing scaffolds for later hosted deployment

The `mcp-server` workspace currently uses a JavaScript runtime source tree. There is no parallel TypeScript build step to maintain.

## Local deployment flow

1. Start a local Anvil chain:

```bash
./scripts/start_anvil.sh
```

2. In another terminal, deploy and configure the contract suite:

```bash
./scripts/deploy_contracts.sh
```

3. Export the addresses returned by the deploy script and write a server env file:

```bash
export AGENT_ACCOUNT_ADDRESS=0x...
export ESCROW_CORE_ADDRESS=0x...
export REPUTATION_SBT_ADDRESS=0x...
export MOCK_DOT_ADDRESS=0x...
./scripts/write_server_env.sh
```

4. Start the service:

```bash
cd mcp-server
set -a
source .env.local
set +a
npm run start:http
```

The HTTP adapter will use live on-chain reads and signed writes whenever the env file contains a valid RPC URL, signer key, and deployed contract addresses.

If you want durable sessions and verifier results, also set:

```bash
REDIS_URL=redis://...
REDIS_NAMESPACE=agent-platform
```

Without `REDIS_URL`, the service falls back to in-memory state for local development.

## Pimlico / ERC-4337 gas sponsorship

The hosted API can now expose a minimal Pimlico-backed gas sponsorship surface when these env vars are set:

```bash
PIMLICO_BUNDLER_URL=https://...
PIMLICO_PAYMASTER_URL=https://...
PIMLICO_ENTRY_POINT=0x...
PIMLICO_SPONSORSHIP_POLICY_ID=...
PIMLICO_CHAIN_ID=...
```

Once configured, the HTTP server exposes:

- `GET /gas/health`
- `GET /gas/capabilities`
- `POST /gas/quote`
- `POST /gas/sponsor`

These endpoints are intended for ERC-4337 user operation quoting and sponsorship. They do not replace the current direct signer flow yet; they add the hosted gas-management path so the platform can evolve toward smart-account execution.

To verify Redis-backed resumability across separate runtimes:

```bash
cd mcp-server
set -a
source .env.local
export REDIS_URL=redis://...
set +a
npm run check:redis
```

That check creates a session in one runtime, verifies it, then loads the same session/result through a second runtime to prove persistence.

## End-to-end local demo

With Anvil running and `mcp-server/.env.local` populated, run:

```bash
cd mcp-server
set -a
source .env.local
set +a
npm run demo:e2e
```

The demo mints mock DOT, deposits into `AgentAccountCore`, creates a funded job, claims it as a worker, submits work, resolves escrow through the verifier role, and checks that payout plus SBT minting completed.

## End-to-end remote demo

To run a real hosted-stack smoke test against the production-like API:

```bash
cd mcp-server
REMOTE_E2E_BASE_URL=https://api.averray.com \
REMOTE_E2E_WALLET=0xFd2EAE2043243fDdD2721C0b42aF1b8284Fd6519 \
npm run demo:e2e:remote
```

That script:

- checks live API health
- creates a unique remote job via `/admin/jobs`
- claims it
- submits work
- runs verification
- confirms the session appears in hosted history

## Render deployment

A starter Render configuration is included at [render.yaml](/Users/pascalkuriger/repo/Polkadot/render.yaml) and a concise deployment checklist lives in [RENDER_DEPLOY.md](/Users/pascalkuriger/repo/Polkadot/mcp-server/RENDER_DEPLOY.md).

The repository now also includes a Ponder indexer workspace:

- Local dev: `npm run dev:indexer`
- Typecheck: `npm run typecheck:indexer`
- Render checklist: [indexer/RENDER_DEPLOY.md](/Users/pascalkuriger/repo/Polkadot/indexer/RENDER_DEPLOY.md)

For ultra-cheap hosted testing, the indexer also supports a low-memory mode via env vars. That mode skips treasury indexing, starts at `latest` for new escrow/reputation events, disables cache, and is intended only to validate viability on very small instances.

The indexer tracks Polkadot Hub TestNet events for:

- `TreasuryPolicy`
- `EscrowCore`
- `ReputationSBT`

## VPS operations

The current self-hosted deployment uses an OVH VPS with Docker Compose under `/srv/agent-stack`.

Operational helpers now live in:

- [scripts/ops/backup-postgres.sh](/Users/pascalkuriger/repo/Polkadot/scripts/ops/backup-postgres.sh)
- [scripts/ops/redeploy-backend.sh](/Users/pascalkuriger/repo/Polkadot/scripts/ops/redeploy-backend.sh)
- [VPS_RUNBOOK.md](/Users/pascalkuriger/repo/Polkadot/VPS_RUNBOOK.md)

Typical production-like flows:

```bash
cd /srv/agent-stack/app
./scripts/ops/backup-postgres.sh
./scripts/ops/redeploy-backend.sh
```
