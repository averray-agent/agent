# Polkadot Agent Platform

This repository contains a greenfield implementation of an agent-first treasury and job runtime:

- Foundry contracts for account, escrow, policy, strategy registry, and reputation
- A shared service layer exposed through HTTP and directory-safe MCP discovery
- Discovery and indexing scaffolds for later hosted deployment

The `mcp-server` workspace currently uses a JavaScript runtime source tree. There is no parallel TypeScript build step to maintain.

## Development setup

After cloning, install the git hooks once so staged commits are scanned for
accidentally-staged `.env` files and private-key-shaped strings:

```bash
./scripts/install-hooks.sh
```

Run the full test matrix locally:

```bash
npm test               # backend + frontend + forge
npm run typecheck:indexer
```

CI runs the same four jobs on every push to `main` and every PR via
[.github/workflows/ci.yml](/.github/workflows/ci.yml).

## Multi-agent branch start

Before any agent starts new work, create its branch through the guarded helper:

```bash
./scripts/ops/start-agent-branch.sh codex/your-task-name
```

The helper fetches `origin`, switches local `main` to the latest
`origin/main`, fast-forwards only, then creates the new branch. This keeps each
agent from starting work on a stale local `main`.

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
export VERIFIER_REGISTRY_ADDRESS=0x...
export DISCOVERY_REGISTRY_ADDRESS=0x...
export DISCLOSURE_LOG_ADDRESS=0x...
export TREASURY_POLICY_ADDRESS=0x...
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

The live API now also exposes a push-only SSE stream at `/events` behind the app proxy as `/api/events`.

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
REMOTE_E2E_PRIVATE_KEY=0xyour-test-agent-private-key \
npm run demo:e2e:remote
```

When `REMOTE_E2E_PRIVATE_KEY` is set, the script runs the full SIWE sign-in
flow — `POST /auth/nonce` → `personal_sign` → `POST /auth/verify` — and uses
the returned JWT on every protected call. Against a `AUTH_MODE=permissive`
deployment you may instead supply only `REMOTE_E2E_WALLET` and skip signing.

That script:

- checks live API health
- signs in with SIWE (when a private key is provided)
- creates a unique remote job via `/admin/jobs`
- claims it
- submits work
- runs verification
- confirms the session appears in hosted history

## Authentication

Protected routes require a signed-in JWT issued via Sign-In with Ethereum
(EIP-4361). The flow:

```
POST /auth/nonce   { wallet }              → { nonce, message }
personal_sign(message) via wallet provider → signature
POST /auth/verify  { message, signature }  → { token, wallet, expiresAt }
POST /auth/logout  (Authorization header)  → revokes the token's jti
```

Subsequent requests pass the token as `Authorization: Bearer <token>`. For SSE
endpoints (`/events`) the token goes as `?token=...` because the browser
`EventSource` API cannot set custom headers — this is the only exception and
the server logs a warning if a token is supplied via query string on any
non-SSE route.

Logout revokes the current token by writing its `jti` into a TTL-bounded
blacklist in the state store. Any subsequent request with that token returns
`401 token_revoked`. Blacklist entries auto-expire alongside the token's own
`exp` so Redis does not grow unbounded.

Public routes (no auth required): `/`, `/health`, `/metrics`,
`/agent-tools.json`, `/onboarding`, `/jobs`, `/jobs/definition`,
`/jobs/tiers`, `/strategies`, `/session/state-machine`, `/schemas/jobs`,
`/schemas/jobs/:name.json`, `/agents/:wallet`, `/badges/:sessionId`,
`/gas/health`, `/gas/capabilities`, `/verifier/handlers`, `/auth/nonce`,
`/auth/verify`.

`AUTH_MODE=strict` (production default) rejects unauthenticated requests on
protected routes with 401. `AUTH_MODE=permissive` (dev default) falls back to
the legacy `?wallet=` query param and logs a warning — useful for local demos
until every caller has been migrated.

Environment variables (see `mcp-server/.env.example`):

- `AUTH_MODE` — `strict` | `permissive`
- `AUTH_JWT_SECRETS` — comma-separated HS256 secrets. First entry signs new
  tokens; rest remain accepted during verification to support zero-downtime
  rotation. Each must be ≥32 characters.
- `AUTH_DOMAIN` — SIWE `domain` and expected verifier check.
- `AUTH_CHAIN_ID` — SIWE `chainId` and expected verifier check.
- `AUTH_TOKEN_TTL_SECONDS` (default 86400) — JWT lifetime.
- `AUTH_NONCE_TTL_SECONDS` (default 300) — SIWE nonce lifetime.
- `AUTH_ADMIN_WALLETS` — comma-separated EVM addresses granted the `admin`
  role claim at sign-in. Required to call `POST /admin/jobs`.
- `AUTH_VERIFIER_WALLETS` — comma-separated EVM addresses granted the
  `verifier` role claim at sign-in. Required to call `POST /verifier/run`.

Roles are pinned at sign-in time by env config; a user picks up role claims
when they SIWE-login, so rotating the env lists invalidates authority at the
next sign-in rather than on every request. Each protected route that needs a
role checks the JWT claim and returns `403 missing_role` on a mismatch.
On-chain escrow resolution is additionally gated by `VerifierRegistry`; in the
current backend-signer architecture, the configured chain signer is the
authorized verifier address.

Key rotation: prepend the new secret to `AUTH_JWT_SECRETS`, redeploy, then
drop the old secret after `AUTH_TOKEN_TTL_SECONDS` has elapsed so that every
token issued under the old key has expired.

## Builder SDK

A small ESM client lives at
[sdk/agent-platform-client.js](/Users/pascalkuriger/repo/Polkadot/sdk/agent-platform-client.js).
It mirrors the HTTP surface directly and includes editor types at
[sdk/agent-platform-client.d.ts](/Users/pascalkuriger/repo/Polkadot/sdk/agent-platform-client.d.ts).

```js
import { AgentPlatformClient } from "./sdk/agent-platform-client.js";

const client = new AgentPlatformClient({ baseUrl: "https://api.averray.com" });

const manifest = await client.getDiscoveryManifest();
const schemas = await client.listJobSchemas();
const lifecycle = await client.getSessionStateMachine();
const profile = await client.getAgentProfile("0xFd2EAE2043243fDdD2721C0b42aF1b8284Fd6519");
```

Authenticated flows reuse the same client after SIWE verification:

```js
client.setToken(token);

const account = await client.getAccountSummary();
const recommendations = await client.getRecommendations();
const claim = await client.claimJob("starter-coding-001", "claim-001");
```

The first public-read example lives in
[examples/profile-lookup](/Users/pascalkuriger/repo/Polkadot/examples/profile-lookup/README.md):

```bash
npm run example:profile-lookup -- \
  --wallet 0xFd2EAE2043243fDdD2721C0b42aF1b8284Fd6519
```

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
- `AgentAccountCore`
- `VerifierRegistry`
- `DiscoveryRegistry`
- `DisclosureLog`

## Contract migration note

The v1.0.0-rc1 backbone extensions for verifier authority, discovery anchoring,
disclosure logging, hash-bound receipt events, terminal reputation slashing, and
claim staking change immutable contract storage and events. Existing deployed
contract instances should be treated as superseded and redeployed with the
updated deploy script before expecting hosted behavior to match this repository.

Threat-model anchors for these trust surfaces live in
[THREAT_MODEL.md](/Users/pascalkuriger/repo/Polkadot/THREAT_MODEL.md).

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
