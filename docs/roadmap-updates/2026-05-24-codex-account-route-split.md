# Roadmap Update: HTTP server route split (`P2.3`)

## Slice

- **Date:** 2026-05-24
- **Agent:** Codex
- **Item:** HTTP server route split (`P2.3`)
- **Status:** Partial progress; canonical item remains Open.

## What changed

- Extracted public `/strategies` plus protected `/account`, `/account/borrow-capacity`, `/account/fund`, `/account/allocate`, `/account/deallocate`, `/account/strategies`, `/account/borrow`, and `/account/repay` into `mcp-server/src/protocols/http/account-routes.js`.
- Moved account/treasury-specific strategy math, live adapter overlays, async-XCM treasury option parsing, and timeline normalization into the account route module.
- Kept shared idempotent mutation helpers in `server.js` while threading them into the route module.
- Added low-cardinality metric labels and root endpoint entries for the account route family.
- Added `mcp-server/src/protocols/http/account-routes.test.js` for:
  - unrelated route fall-through;
  - public strategy metadata;
  - wallet account summary reads;
  - live strategy allocation overlays;
  - borrow-capacity reads;
  - sync fund/allocate/repay mutation idempotency;
  - async-XCM allocation receipt storage;
  - async-XCM server-assembled field rejection;
  - strategy portfolio summary/timeline output.

## Evidence

- Polkadot MCP docs check: `get_project_info` returned `Polkadot Developer Docs` with index status `ready`.
- `node --check mcp-server/src/protocols/http/account-routes.js`
- `node --check mcp-server/src/protocols/http/server.js`
- `node --test mcp-server/src/protocols/http/account-routes.test.js`
- `npm --workspace mcp-server test` (819 passing)

## Follow-up

- Append this slice to the canonical `HTTP server route split (P2.3)` row after merge.
- Remaining inline route groups in `server.js` include event streaming, XCM request read, payments, root health/status/provider/metrics/onboarding, and any residual system/status surfaces.
