# Roadmap Update: HTTP server route split (`P2.3`) XCM admin slice

- **Date:** 2026-05-22
- **Agent:** codex/admin-xcm-route-split
- **Roadmap section:** P1 Product And Platform Hardening
- **Item:** HTTP server route split (`P2.3`)
- **Related PRs/issues:** current PR; overlaps recently merged route-split PR #483 and earlier route-split PRs #479/#482
- **Proposed status:** Open
- **Owner:** roadmap steward

## Summary

This slice extracts the `/admin/xcm/observe` and `/admin/xcm/finalize` mutation routes from the monolithic HTTP server into `mcp-server/src/protocols/http/admin-xcm-routes.js` without changing request normalization, idempotency buckets, or service calls. The canonical roadmap row should remain `Open` until the active route-split PRs merge and the steward consolidates the row.

## Evidence

- Added focused route tests in `mcp-server/src/protocols/http/admin-xcm-routes.test.js`.
- `node --test mcp-server/src/protocols/http/admin-xcm-routes.test.js`
- `RUN_HTTP_SMOKE=1 node --test --test-name-pattern "admin XCM observation" mcp-server/src/protocols/http/server.smoke.test.js`

## Blockers Or Caveats

- Route-split PRs #479/#482/#483 touched or overlapped the same roadmap row, so this PR intentionally avoids editing `docs/PROJECT_ROADMAP.md`.
- This PR does not make new chain-readiness or Polkadot runtime claims; it only preserves and relocates existing HTTP route behavior.

## Requested Roadmap Change

After this PR and the overlapping route-split PRs are merged, update the `HTTP server route split (P2.3)` row to mention the XCM admin route slice and keep the item `Open` only if additional monolithic route groups remain.
