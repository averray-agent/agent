# PACKET — backend read pressure: the auto-verifier's minute scan, the journeys read, and the bank watch's block decode

Status: **ready for Codex, 2026-09-25.** Three independent PRs. Evidence comes from
Pascal's read-only VPS log pulls, public `/health` and public chain reads; no
production access needed. A separate backend hotfix is in flight (handed over
directly) — do that one first.

## 1. What the board showed

2026-09-25 06:23Z, Hermes: **CAPABILITIES RED** — `Submitted-job auto-verifier is
unhealthy (auto_verification_errors); persistent submitted session count: 0`.

Backend log, 06:15–06:45Z: five runs failed, each on a different session, all
`auto_verify.claim_reconciliation_failed code=blockchain_unavailable getJob failed: request timeout`.

| time (UTC) | session |
|---|---|
| 06:15:01 | `wiki-en-80171159-citation-repair-in-the-suburbs-of-moscow-r20:0xba9888Ed…` |
| 06:20:23 | `oss-radsilent-vectormbe-31-…:0x93A0b714…` |
| 06:22:34 | `worker-canary-1790023075526:0x2eECace0…` (job reopened 2026-09-21; nothing left to do) |
| 06:41:07 | `pr-zero-shelter-zero-shelter-149:0xF53fc386…` |
| 06:45:27 | `oss-lingdojo-kana-dojo-28847-…:0x191c8220…` |

The runs in between were clean; `/health` was green again after 06:45. Measured by
Claude at ~06:50Z, both RPCs answer the same escrow `jobs(bytes32)` eth_call in
≈40 ms p50 (max 202 ms, 25 calls each), against the backend's 750 ms read cap
(`RPC_REQUEST_TIMEOUT_MS`) — the slowness was on the VPS side. In the same hour the
backend's most expensive route was `GET /admin/worker-journeys`: 35 calls, 180 s
total (≈5.1 s each); six CPU samples of the backend over 30 s read 0.5, 2.2, 12.0,
0.9, 86.2 and 0.6 %.

## 2. PR 1 — the minute scan stops re-reading finished claims, and one transient read is not critical

Facts (origin/main `af2a0905`):
- `SubmittedJobAutoVerifierService.runOnce` reconciles every `claimed` and `expired`
  session among `listRecentSessions(200)` each minute; each one costs a `getJob` read.
- `JobExecutionService.reconcileClaimSession` persists nothing for an `expired`
  session whose job is Open, Closed or held by another wallet, so a finished claim is
  re-read every minute until it falls out of the 200-session window.
- `summaryErrorsOutcome(summary, "auto_verification_errors")` makes ONE failed
  operation an unhealthy run (no `unhealthyAfter`), and `/health` turns that into a
  critical warning.

**D1 — reconciled marker.** When a reconcile read proves the chain no longer holds a
claim this session could time out (job Open, Closed, or `worker` is another wallet),
persist `claimReconciliation: { reconciledAt, observedState, observedWorker, blockNumber }`
on the session and skip marked sessions in later scans. A new claim that moves the
session back to `claimed` clears the marker. An `expired` session whose job is Claimed
by ANOTHER wallet is marked, not thrown as `claim_reconciliation_worker_mismatch`
(that error stays for `claimed` sessions only).

**D2 — severity by error class.** A run whose errors are ALL transient chain reads in
claim reconciliation (`code: blockchain_unavailable`) becomes unhealthy only after 3
consecutive such runs (the loop already has `key` + `unhealthyAfter` streaks). Any
other error — worker mismatch, settlement failure, verification timeout, any other
code — stays unhealthy on the first run. Every failure is still logged at warn.

Tests (each mutated red → green in the handback): a marked session is not read again;
a session re-claimed after marking is read; an expired session with another wallet's
live claim is marked, not thrown; 1 and 2 consecutive transient runs → healthy, the
3rd → critical; one non-transient error → critical at once; widening the classifier
(e.g. every code counts as transient) fails a test.

Handback: `lastRun.claimReconciliationCandidateCount` from `/admin/status` before and
after deploy.

## 3. PR 2 — the journeys read stops hydrating progression

`AdminJourneyReadService.getWorkerJourneys` (`admin-journey-reads.js:134`) calls
`platformService.listRecentSessions(sessionReadCap)` — 250 sessions at the default
limit — with progression hydration ON (the default), and nothing in the journeys code
reads `progression`. Same defect as #1357 and #1384: one credit-position read per
resolved session, on a route something polls about every 100 s. Pass
`{ progression: false }`; add the #1384-style test that the journeys read never calls
the credit-position reader; list every remaining `platformService.listRecentSessions(`
caller in the handback with the reason it needs progression.

Handback: `durationMs` of `GET /admin/worker-journeys` from the `http.response` logs,
before and after (Pascal pulls it).

## 4. PR 3 — the bank watch decodes only what it needs

`BankXcmV22Runtime.enqueueSubstrateEvents` → `readRequestQueuedEventsAtHash` fetches
and fully decodes the block (`api.rpc.chain.getBlock`) for EVERY Asset Hub block the
`system.events` subscription delivers, although the block is only needed for the
extrinsic hash of a `RequestQueued` from our wrapper. On 2026-09-24 three blocks failed
to decode (12:02:33, 12:04:11, 14:03:03Z):
`createType(SignedBlock) … createType(GeneralExtrinsic):: decodeU8aStruct: failed … on era (index 2/7)`
(@polkadot/api 16.5.6). A failure sets `substrateEventIngestionError`, which only a
watch restart clears, so `getStatus().readyForStaging` stays false until the next
backend restart, and the bank cannot stage a request in that state.

- **D1** — fetch the block only when the decoded events contain a `RequestQueued` from
  `this.wrapperAddress`.
- **D2** — derive the extrinsic hash from raw bytes (the hex extrinsics of the
  `chain_getBlock` JSON, blake2-256) instead of the typed decode; prove it equals the
  typed hash on a historical block that holds one of our requests (the cycle-2 recall
  blocks in `docs/evidence/pool-v21-cycle-2.md`).
- **D3** — ingestion failures are per block: record the failing block hash, retry that
  block until it ingests, and clear the error only when no failed block remains. Never
  skip a block silently.
- **D4** — say in the PR whether Asset Hub's current extrinsic format needs a newer
  @polkadot/api for anything else the backend decodes. Verify against the Polkadot docs
  or the runtime metadata; Claude could not reach the docs MCP on 2026-09-25. An upgrade
  is its own PR with the dependency notes AGENTS.md requires.

Tests: a block with an undecodable extrinsic and no `RequestQueued` → no block fetch,
no error; a block with one → the raw-bytes hash equals the fixture hash; a failed block
keeps `readyForStaging` false until its retry succeeds, then true.

## 5. Out of scope

- `GET /health` costs ≈270 ms per call (≈360 calls/h, mostly the Docker healthcheck);
  the settlement snapshot reads receipts per session. Note for later.
- The 750 ms read cap itself — tuned for request paths; leave it.

## 6. Handback

Three PR numbers, CI, test names with drill evidence, and the before/after numbers named
in each section.
