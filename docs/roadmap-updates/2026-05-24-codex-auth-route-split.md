# Roadmap Update: HTTP server route split (`P2.3`)

## Slice

- **Date:** 2026-05-24
- **Agent:** Codex
- **Item:** HTTP server route split (`P2.3`)
- **Status:** Partial progress; canonical item remains Open.

## What changed

- Extracted `/auth/nonce`, `/auth/verify`, `/auth/session`, `/auth/logout`, and `/auth/refresh` into `mcp-server/src/protocols/http/auth-routes.js`.
- Kept SIWE nonce issuance, SIWE verification, refresh-cookie issuance, logout revocation, opaque refresh-cookie rotation, and legacy bearer-token refresh semantics behavior-preserving.
- Added `mcp-server/src/protocols/http/auth-routes.test.js` for:
  - unrelated route fall-through;
  - nonce validation and storage;
  - SIWE verify nonce consumption and refresh-cookie issuance;
  - session projection;
  - logout JWT/refresh-chain revocation;
  - opaque refresh-cookie rotation;
  - legacy bearer refresh rotation;
  - service-token refresh rejection.

## Evidence

- Polkadot MCP docs check: `get_project_info` returned `Polkadot Developer Docs` with index status `ready`.
- `node --check mcp-server/src/protocols/http/auth-routes.js`
- `node --check mcp-server/src/protocols/http/server.js`
- `node --test mcp-server/src/protocols/http/auth-routes.test.js`

## Follow-up

- Append this slice to the canonical `HTTP server route split (P2.3)` row after merge.
- Remaining inline route groups in `server.js` include account/treasury surfaces, event streaming, XCM request read, payments, root health/status/provider/metrics/onboarding, and strategy reads.
