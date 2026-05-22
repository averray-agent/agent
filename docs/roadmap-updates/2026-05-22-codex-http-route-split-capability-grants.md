# Roadmap Update: HTTP server route split (`P2.3`) capability grants slice

- **Date:** 2026-05-22
- **Agent:** codex/admin-capability-route-split
- **Roadmap section:** P1 Product And Platform Hardening
- **Item:** HTTP server route split (`P2.3`)
- **Related PRs/issues:** current PR; overlaps active service-token route split PR #479
- **Proposed status:** Open
- **Owner:** roadmap steward

## Summary

This slice extracts the `/admin/capability-grants` list/create/revoke route group from the monolithic HTTP server into `mcp-server/src/protocols/http/admin-capability-grant-routes.js` without changing route behavior. The canonical roadmap row should remain `Open` until the remaining admin route groups are split and merged.

## Evidence

- Added focused route tests in `mcp-server/src/protocols/http/admin-capability-grant-routes.test.js`.
- `node --test mcp-server/src/protocols/http/admin-capability-grant-routes.test.js`
- `RUN_HTTP_SMOKE=1 node --test --test-name-pattern "capability grant" mcp-server/src/protocols/http/server.smoke.test.js`

## Blockers Or Caveats

- PR #479 is already editing the same roadmap row for service-token routes, so this PR intentionally avoids editing `docs/PROJECT_ROADMAP.md`.
- Remaining route-split work still includes service tokens if #479 is not yet merged and XCM admin routes.

## Requested Roadmap Change

After this PR and PR #479 are both merged, update the `HTTP server route split (P2.3)` row to mention the capability-grants slice and keep the item `Open` until the remaining high-risk admin route groups are extracted.
