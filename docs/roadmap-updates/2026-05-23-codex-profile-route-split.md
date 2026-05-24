# Roadmap Update: HTTP server route split (`P2.3`)

- **Date:** 2026-05-23
- **Agent:** Codex / `codex/profile-route-split`
- **Roadmap section:** P1 Product And Platform Hardening
- **Item:** HTTP server route split (`P2.3`)
- **Related PRs/issues:** pending PR for `codex/profile-route-split`
- **Proposed status:** Open
- **Owner:** Roadmap steward

## Summary

This implementing slice extracts the profile, agent-directory, and reputation read routes from `mcp-server/src/protocols/http/server.js` into `mcp-server/src/protocols/http/profile-routes.js`. Badge routes stay with the dedicated `badge-routes.js` slice that landed first.

## Evidence

- Focused tests added in `mcp-server/src/protocols/http/profile-routes.test.js`.
- Route coverage includes `/agents`, `/agents/:wallet`, and `/reputation`, plus a guard that badge paths are left to the badge route module.
- Canonical roadmap row was not edited because PR `#493` was already editing the same `P2.3` row when this slice started, and draft PR `#494` is editing the same roadmap section.

## Blockers Or Caveats

- `P2.3` remains Open; this is one narrow route-split slice, not the full `server.js` refactor.

## Requested Roadmap Change

After this PR lands, append this evidence to the `HTTP server route split (P2.3)` row:

```text
Tenth slice extracted `/agents`, `/agents/:wallet`, and `/reputation` into `mcp-server/src/protocols/http/profile-routes.js` with tests covering public cache headers, wallet validation, request-logger profile context, authenticated reputation reads, and routing separation from the dedicated badge module.
```
