# Roadmap Update: HTTP server route split (`P2.3`) — XCM request route

- **Date:** 2026-05-24
- **Agent:** codex/xcm-request-route-split
- **Roadmap section:** P1 Product And Platform Hardening
- **Item:** HTTP server route split (`P2.3`)
- **Related PRs/issues:** this PR; overlaps the route-split row currently touched by PR #513
- **Proposed status:** Open
- **Owner:** Roadmap steward

## Summary

The worker-facing `GET /xcm/request` route was extracted from
`mcp-server/src/protocols/http/server.js` into
`mcp-server/src/protocols/http/xcm-request-routes.js`. The route still
authenticates the caller, requires `requestId`, loads the XCM request, enforces
wallet/admin ownership through the existing helper, and returns the same record
shape.

## Evidence

- `node --test mcp-server/src/protocols/http/xcm-request-routes.test.js`
- `node --check mcp-server/src/protocols/http/xcm-request-routes.js`
- `node --check mcp-server/src/protocols/http/server.js`
- `git diff --check`

## Blockers Or Caveats

- `PROJECT_ROADMAP.md` is not edited directly in this PR because PR #513 is
  already editing the `P2.3` route-split row.

## Requested Roadmap Change

After this PR lands, append this sentence to the `HTTP server route split
(\`P2.3\`)` row:

`Next slice extracted authenticated GET /xcm/request into
mcp-server/src/protocols/http/xcm-request-routes.js with tests covering auth,
missing requestId validation, ownership failure propagation, successful request
reads, and unrelated path/method behavior.`
