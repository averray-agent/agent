# Roadmap Update: Timeline operator UX verification

- **Date:** 2026-05-21
- **Agent:** codex/timeline-operator-ux-verification
- **Roadmap section:** P1 Product And Platform Hardening
- **Item:** Timeline operator UX verification
- **Related PRs/issues:** this PR
- **Proposed status:** Done
- **Owner:** Roadmap steward

## Summary

The operator app already exposes the intended timeline filters for the job timeline surface, and the sessions drawer reuses the same visible filter controls for session movement review. This is a source-level verification fragment, not a hosted proof request, so the requested status is `Done` rather than `Proofed`.

## Evidence

- `app/components/runs/TimelineEventFilters.tsx` defines visible controls for `source`, `topic`, `phase`, `severity`, `wallet`, and `correlationId`, plus URL parse/apply helpers.
- `app/lib/api/hooks.ts` maps those controls into `/admin/jobs/timeline` query params: `topics`, `sources`, `phases`, `severities`, `correlationId`, and `eventWallet`.
- `app/components/runs/JobTimelinePanel.tsx` reads URL-backed filters, passes them to `useJobTimeline`, renders the filter rail, reports hidden events, and supports clearing filters.
- `app/app/(authed)/sessions/page.tsx` and `app/components/sessions/SessionDrawerBody.tsx` reuse the same URL-backed filter controls for the session drawer; the drawer filters session movements client-side because `/session/timeline` does not accept the full `/admin/jobs/timeline` filter set.
- `mcp-server/src/protocols/http/server.js` parses the matching backend query params through `parseEventFilters`.
- `mcp-server/src/core/platform-service.test.js` covers phase, source, correlation ID, and wallet filtering for `getJobTimeline`.

## Blockers Or Caveats

- No hosted browser/operator proof was captured in this fragment, so this should not move to `Proofed`.
- Session drawer filtering is intentionally client-side until `/session/timeline` accepts the same backend filter params as `/admin/jobs/timeline`.

## Requested Roadmap Change

Change only this row in `docs/PROJECT_ROADMAP.md`:

```md
| Timeline operator UX verification | Done | Backend trace filters landed, and the operator app exposes URL-backed job timeline filters for source, topic, phase, severity, wallet, and correlation ID. Session drawer reuses the same controls client-side for session movement review. |
```
