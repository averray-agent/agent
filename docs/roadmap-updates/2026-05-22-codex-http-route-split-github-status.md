# Roadmap Update: HTTP server route split (`P2.3`) GitHub status slice

- **Date:** 2026-05-22
- **Agent:** codex/admin-github-status-route-split
- **Roadmap section:** P1 Product And Platform Hardening
- **Item:** HTTP server route split (`P2.3`)
- **Related PRs/issues:** current PR; overlaps active route-split PR #485
- **Proposed status:** Open
- **Owner:** roadmap steward

## Summary

This slice extracts the read-only `/admin/github/status` route from the monolithic HTTP server into `mcp-server/src/protocols/http/admin-github-routes.js` without changing admin auth, query parsing, or the service call shape. The canonical roadmap row should remain `Open` until the active route-split PRs merge and the steward consolidates the row.

## Evidence

- Added focused route tests in `mcp-server/src/protocols/http/admin-github-routes.test.js`.
- `node --test mcp-server/src/protocols/http/admin-github-routes.test.js`
- `npm --workspace mcp-server test`

## Blockers Or Caveats

- PR #485 is already touching the same roadmap row, so this PR intentionally avoids editing `docs/PROJECT_ROADMAP.md`.
- This PR does not make new chain-readiness or Polkadot runtime claims; it only preserves and relocates existing HTTP route behavior.

## Requested Roadmap Change

After this PR and the overlapping route-split PRs are merged, update the `HTTP server route split (P2.3)` row to mention the GitHub operator status route slice and keep the item `Open` only if additional monolithic route groups remain.
