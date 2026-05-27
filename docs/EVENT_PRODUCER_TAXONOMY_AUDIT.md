# Event Producer Taxonomy Audit

Inventory of every `eventBus.publish(...)` call site on `main` (HEAD
89e05e6) and where each one stands against the canonical envelope —
`topic, source, phase, severity, jobId, sessionId, wallet,
correlationId`. Docs / report only; no code changes ship in this
audit pass.

## 2026-05-27 reconciliation

The original audit findings below were accurate at `89e05e6`, but the
runtime has since caught up:

- Gap A is closed: `policy.`, `capability.`, and `service-token.` topics now
  classify into `source: "governance"` with stable phases and revocation
  warning severity.
- Gap B is closed: XCM outcome relay/observe/finalize events now promote
  their `requestId` to top-level `correlationId`.
- Additional producer families discovered after the audit are now classified:
  `jobs.lifecycle.*`, `funded_jobs.*`, and `bootstrap.*`.

The remaining taxonomy watch item is future producer drift: new event families
should either use an existing registered prefix or add classifier coverage and
tests in the same PR.

## How the envelope is filled

`EventBus.normalizeEvent` ([`mcp-server/src/core/event-bus.js`](../mcp-server/src/core/event-bus.js))
auto-derives three of the eight canonical fields when the producer
omits them:

- `source`, `phase`, `severity` — derived from the topic prefix via
  `classifyEventTopic`. Registered prefixes:
  `escrow.`, `account.`, `reputation.`, `content.`, `xcm.`,
  `funding.`, `settlement.`, `dispute.`, `verification.`,
  `recurring.`, `jobs.ingest.`, `system.`, `session.`. Anything else
  falls through to the default
  `{ source: "event_bus", phase: <topic>, severity: "info" }`.
- `correlationId` — auto-falls back to `sessionId || jobId ||
  undefined`. A publish call that provides neither and doesn't pass
  `correlationId` explicitly leaves correlationId as `undefined`.

A producer is **fully canonical** if:

1. Its topic starts with a registered prefix (so `source/phase/
   severity` classify into a real bucket).
2. At least one of `sessionId`, `jobId`, or explicit `correlationId`
   resolves so the event is correlatable.
3. `wallet` is present when the event is wallet-scoped (omitted is
   fine for system-wide events).

## Inventory

22 publish sites across 7 producer files, plus the generic chain-event
forward at `event-listener.js:429` (which publishes whatever each
`registerEscrow/Account/Reputation/Xcm` handler builds via
`buildChainEvent`).

| # | File:Line | Topic | Classified? | jobId | sessionId | wallet | correlationId | Notes |
|---|---|---|---|---|---|---|---|---|
| 1 | [job-execution-service.js:483](../mcp-server/src/core/job-execution-service.js#L483) | `session.*` (dynamic via `publishSessionEvent`) | ✓ (`session.`) | ✓ | ✓ | ✓ | ✓ | Dynamic topic. Callers pass `session.claimed`, `session.submitted`, `session.expired`. All classify cleanly. |
| 2 | [job-execution-service.js:515](../mcp-server/src/core/job-execution-service.js#L515) | `funding.claim_lock_recorded` | ✓ (`funding.`) | ✓ | ✓ | ✓ | ✓ | Fully canonical. |
| 3 | [event-listener.js:432](../mcp-server/src/blockchain/event-listener.js#L432) | `system.listener_error` | ✓ (`system.`) | — | — | — | — | System-level fault. Design-intentional omissions. |
| 4 | [event-listener.js:520](../mcp-server/src/blockchain/event-listener.js#L520) | `system.provider_error` | ✓ (`system.`) | — | — | — | — | Same. |
| 5 | [event-listener.js:534](../mcp-server/src/blockchain/event-listener.js#L534) | `system.reconnect` | ✓ (`system.`) | — | — | — | — | Same. |
| 6 | [event-listener.js:429](../mcp-server/src/blockchain/event-listener.js#L429) (chain forward) | All `escrow.*` / `account.*` / `reputation.*` / `content.*` / `xcm.*` topics via `buildChainEvent` | ✓ | ✓ | ✓ | ✓ | ✗ (falls back to sessionId/jobId) | Canonical for the 5 chain prefixes. `buildChainEvent` itself never sets explicit `correlationId` — relies on the bus fallback. |
| 7 | [xcm-settlement-watcher.js:73](../mcp-server/src/services/xcm-settlement-watcher.js#L73) | `xcm.outcome_observed` | ✓ (`xcm.`) | — | — | — | **✗** | `requestId` is the natural correlation key; surfaced inside `data.requestId` but not promoted to `correlationId`. See gap **B** below. |
| 8 | [xcm-settlement-watcher.js:105](../mcp-server/src/services/xcm-settlement-watcher.js#L105) | `xcm.request_auto_finalized` | ✓ (`xcm.`) | — | — | ✓ | **✗** | Same. |
| 9 | [xcm-settlement-watcher.js:120](../mcp-server/src/services/xcm-settlement-watcher.js#L120) | `xcm.request_finalize_failed` | ✓ (`xcm.`) | — | — | — | **✗** | Same. Failure path also omits wallet. |
| 10 | [server.js:2109](../mcp-server/src/protocols/http/server.js#L2109) | `policy.proposed` | **✗** (not in classifier) | — | — | ✓ | — | See gap **A** below. `proposal.id` could be `correlationId`. |
| 11 | [server.js:2314](../mcp-server/src/protocols/http/server.js#L2314) | `dispute.verdict_recorded` | ✓ (`dispute.`) | ✓ | ✓ | ✓ | ✓ | Fully canonical. Also passes explicit `source`/`phase`/`severity`. |
| 12 | [server.js:2408](../mcp-server/src/protocols/http/server.js#L2408) | `settlement.stake_release_recorded` | ✓ (`settlement.`) | ✓ | ✓ | ✓ | ✓ | Fully canonical with explicit source/phase/severity. |
| 13 | [server.js:3704](../mcp-server/src/protocols/http/server.js#L3704) | `capability.grant` | **✗** (not in classifier) | — | — | ✓ | — | See gap **A**. `grant.id` is the natural correlation key. |
| 14 | [server.js:3773](../mcp-server/src/protocols/http/server.js#L3773) | `service-token.issue` | **✗** (not in classifier; also note hyphen) | — | — | ✓ | — | See gaps **A** and **C**. |
| 15 | [server.js:3851](../mcp-server/src/protocols/http/server.js#L3851) | `service-token.rotate` | **✗** | — | — | ✓ | — | Same. |
| 16 | [server.js:3912](../mcp-server/src/protocols/http/server.js#L3912) | `service-token.revoke` | **✗** | — | — | ✓ | — | Same. |
| 17 | [server.js:3972](../mcp-server/src/protocols/http/server.js#L3972) | `capability.revoke` | **✗** | — | — | ✓ | — | Same as 13. |
| 18 | [xcm-observation-relay.js:90](../mcp-server/src/services/xcm-observation-relay.js#L90) | `xcm.outcome_relayed` | ✓ (`xcm.`) | — | — | — | **✗** | Same gap **B**: `requestId` in `data`, not promoted. |
| 19 | [xcm-observation-relay.js:112](../mcp-server/src/services/xcm-observation-relay.js#L112) | `xcm.observer_synced` | ✓ (`xcm.`) | — | — | — | — | Sync-run scope. No natural per-request correlation key. Design-intentional. |
| 20 | [xcm-observation-relay.js:130](../mcp-server/src/services/xcm-observation-relay.js#L130) | `xcm.observer_failed` | ✓ (`xcm.`) | — | — | — | — | Same. |
| 21 | [verification-ingestion-service.js:74](../mcp-server/src/services/verification-ingestion-service.js#L74) | `verification.resolved` | ✓ (`verification.`) | ✓ | ✓ | ✓ | ✓ | Fully canonical. |
| 22 | [verification-ingestion-service.js:120](../mcp-server/src/services/verification-ingestion-service.js#L120) | `dispute.opened` / `settlement.session_resolved` / `settlement.session_rejected` (dynamic) | ✓ | ✓ | ✓ | ✓ | ✓ | Dynamic topic; all three branches classify cleanly. |
| 23 | [recurring-scheduler.js:150](../mcp-server/src/services/recurring-scheduler.js#L150) | `recurring.fired` | ✓ (`recurring.`) | ✓ | — | — | ✗ (falls back to jobId) | System-scheduled; wallet correctly absent. correlationId resolves to `jobId` via fallback. |

## Findings

### Gap A — three topic prefixes not in `classifyEventTopic` (closed)

Affected publish sites: **#10, #13–#17** (policy, capability, service-token).

The classifier in
[`event-bus.js`](../mcp-server/src/core/event-bus.js) has no branch
for `policy.`, `capability.`, or `service-token.`. Events with those
prefixes fall through to the default:

```js
return {
  source: "event_bus",
  phase: topic || "event",  // e.g. "service-token.issue"
  severity: "info"
};
```

That's a working fallback — the event is still published, filterable,
and replayable — but the canonical phase is just the topic itself,
which makes phase-based filtering ("show me all `governance` events")
a non-starter for this family.

Implemented fix: `classifyEventTopic` recognizes these prefixes. The current
runtime mappings are:

| Prefix | `source` | `phase` | `severity` rule |
|---|---|---|---|
| `policy.` | `governance` | `governance` | `info` |
| `capability.` | `governance` | `capability` | `warn` on `capability.revoke`, otherwise `info` |
| `service-token.` | `governance` | `service_token` | `warn` on `service-token.revoke`, otherwise `info` |

Regression coverage lives in
[`mcp-server/src/core/event-bus.test.js`](../mcp-server/src/core/event-bus.test.js).

### Gap B — XCM events with `requestId` not promoted to `correlationId` (closed)

Affected publish sites: **#7, #8, #9, #18**.

All four carry the natural correlation key (`requestId`) inside
`data.requestId` but don't set `correlationId` at the envelope level.
The bus's fallback (`sessionId || jobId || undefined`) leaves these
events with `correlationId: undefined`. A consumer trying to thread
the lifecycle `queued → observed → finalized` (or `queued → observed
→ finalize_failed`) by correlation id can't.

Implemented fix: each request-scoped XCM observer/watcher event sets
`correlationId` to the normalized `requestId`. Regression coverage lives in
[`mcp-server/src/services/xcm-settlement-watcher.test.js`](../mcp-server/src/services/xcm-settlement-watcher.test.js)
and
[`mcp-server/src/services/xcm-observation-relay.test.js`](../mcp-server/src/services/xcm-observation-relay.test.js).

### Gap C — `service-token.` hyphenated topic family

Affected publish sites: **#14, #15, #16**.

The rest of the taxonomy uses dot or underscore as the separator
within a phase (`escrow.dispute_resolved`, `xcm.outcome_observed`).
The `service-token.*` family uses a hyphenated phase identifier,
which is unusual but not actually broken — Gap A above means it
doesn't classify regardless of separator style. Worth deciding (out
of scope here) whether the canonical form should be `service_token.*`
to match the rest of the family.

### Non-gaps

- **`system.*` events** (sites #3–#5) deliberately omit wallet /
  jobId / sessionId / correlationId. These are listener-level
  faults, not user-attributed. Correct as-is.
- **`xcm.observer_synced` / `xcm.observer_failed`** (sites #19, #20)
  are sync-run scope events. They have no natural per-request
  correlation key. Correct as-is.
- **`recurring.fired`** (site #23) has no wallet because it's a
  system-scheduled fire event. `correlationId` resolves to `jobId`
  via the bus fallback. Correct as-is.
- **Chain-event forward via `buildChainEvent`** (site #6) relies on
  the bus's correlationId fallback (`sessionId || jobId`). Almost all
  chain events provide both, so the fallback succeeds. The few
  registrations that omit sessionId (e.g. `escrow.job_funded` doesn't
  derive a session) still have `jobId`, so correlationId falls back
  to the chain job id. Correct as-is.

## What this audit explicitly does NOT do

- Does not change `event-bus.js` or any producer source file.
- Does not propose a topic-naming overhaul (`service-token` vs
  `service_token`, etc.) — that's a separate design decision.
- Does not measure whether downstream consumers (timeline, SSE,
  alerting) actually exercise the `correlationId` field for the
  surfaces in Gap B today.
- Does not attempt to normalize the event ids (some are
  `tx-hash.log-index`, some are `<topic>-<sessionId>-<Date.now()>`,
  some are `<topic>-<grantId>-<Date.now()>`). Id shape isn't in the
  canonical-field list the audit was scoped to.

## Suggested follow-up PRs (separate from this report)

1. **Keep the classifier in lockstep with new producer families.** New
   `eventBus.publish` topic prefixes should add classifier tests in the same
   PR.
2. **(Optional, larger)** Decide on `service-token` vs `service_token`
   topic naming and migrate downstream consumers + tests if the
   underscore form wins.
