# Roadmap Update: HTTP server route split (`P2.3`)

- **Date:** 2026-05-24
- **Agent:** codex/dispute-route-split
- **Roadmap section:** RC1 Launch Readiness
- **Item:** HTTP server route split (`P2.3`)
- **Related PRs/issues:** PR pending
- **Proposed status:** Open
- **Owner:** Roadmap steward

## Summary

The next narrow route-split slice extracts the authenticated dispute endpoints from `server.js` into `mcp-server/src/protocols/http/dispute-routes.js`. The route module keeps the existing response shapes and idempotency behavior while exposing `listDisputes()` back to the activity alert feed.

## Evidence

- New route module: `mcp-server/src/protocols/http/dispute-routes.js`
- Focused tests: `mcp-server/src/protocols/http/dispute-routes.test.js`
- Local checks to be recorded in the PR body after completion.

## Blockers Or Caveats

- The canonical `P2.3` row remains Open because this is one slice of the larger server split, not full closure.
- No Polkadot protocol semantics changed in this slice.

## Requested Roadmap Change

Append a fifteenth-slice note to the `HTTP server route split (P2.3)` row after the PR merges: dispute routes (`/disputes`, `/disputes/:id`, `/disputes/:id/verdict`, `/disputes/:id/release`) moved to `dispute-routes.js` with tests for auth, listing, idempotent replay, verdict recording, session transition, release recording, and unrelated path handling.
