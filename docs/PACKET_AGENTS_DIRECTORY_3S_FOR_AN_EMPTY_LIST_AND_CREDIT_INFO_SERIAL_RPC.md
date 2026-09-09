# PACKET — `/agents` spends 3 s to return `[]`; `/credit` serialises ~9 RPC round trips

Status: ready for implementation. **Two PRs, A then B.** Both are read paths;
no contract, manifest, consent or money-rail change. Every claim below was
measured against production on 2026-09-09 or read from `origin/main`.

## What was measured

`GET https://api.averray.com/agents` returns a 2-byte body (`[]` — no wallet
has given directory consent yet) and takes about three seconds. The cost tracks
the scan window, not the result:

| `?limit=` | rows scanned (`min(max(limit×5, limit), 250)`) | wall time |
|---|---|---|
| 5 | 25 | 0.08–0.10 s |
| 10 | 50 | 0.08–0.09 s |
| 25 | 125 | 0.7–0.9 s |
| 50 (default) | 250 | 2.7–3.3 s |
| 100 | 250 | 2.8–3.3 s |

Doubling the window from 125 to 250 rows multiplies the time by ~4. That is
quadratic, not linear, and nothing in the response justifies it. For scale:
`/jobs` returns 74 KB in 0.22 s, `/pool` in 0.2 s, `/health` in 0.08 s.

`GET /credit` needs SIWE, so it was not re-measured here. The prior figure is
1.7 s warm from the VPS and ~20 s from CI runners (the CreditPool smoke
timeouts), cause never named. The read path below explains the 1.7 s; the 20 s
must be measured, not guessed.

## Defect A — the directory decorates every session with worker progression, then throws it away

`profile-routes.js:160` `buildAgentDirectory` calls `service.listRecentSessions(scanLimit)`.
That is `PlatformService.listRecentSessions` (`platform-service.js:1464`), which
runs `attachWorkerProgression` on **every resolved session** in the window.
Each of those calls `WorkerProgressionService.getProgression(wallet)`
(`core/worker-progression.js:47`), which calls `collectAllWalletSessions`
(`core/worker-daily-exposure.js`): it pages the wallet's **entire** session
history through Redis in pages of 64, attaches stored verification results per
session, then reads reputation, capacity and credit-interest registration.

The directory reads exactly one field of those sessions: `session.wallet`
(`profile-routes.js:166`). Everything else is discarded before the consent
filter even runs. With one worker wallet dominating the recent window (today:
the acceptance/reference wallet plus canary wallets), the cost is
(resolved sessions in window) × (that wallet's full history) — the quadratic
curve above. The Redis listing itself is cheap: `ZRANGE` + N parallel `GET`
(`state-store.js:1960`). The consent read is one `GET` per unique wallet.

Who sits on this: the operator app (`app/lib/api/hooks.ts:88`
`/agents?includeSynthetic=true`, refetched by `LiveDataBridge` on **every**
escrow event), the MCP `listAgents` tool, and every external agent that follows
`llms.txt` to the directory. The same decorated listing also feeds `/badges`,
the operator activity feed and admin sessions (`badge-routes.js:22`,
`operator-activity-feed.js:41,181`, `admin-sessions-routes.js:14`); audit each
for whether it reads `session.progression` at all.

The instrumentation to prove the fix already exists and is what the handback
must use: `http_request_duration_ms{path="/agents"}` (`server.js:1023`) and
the `http.response` log line with `durationMs`.

## Defect B — `/credit` awaits the receipt graph before starting the L1 read, and both readers pin their own block

`credit-pool-door.js:177` `getInfo`:

1. `await this.creditBookDoor.getInfo(wallet)` — inside: `getBlockNumber` →
   `getBlock` → `Promise.all([...])` → `Promise.all([cashLoan, postingLoan])` →
   `underwriter.evaluate` (`Promise.all([evidence, tierPerks])`).
2. Only then `Promise.all([#snapshot, #capacity])` — inside `#snapshot`:
   `getBlockNumber` → `getBlock` → `Promise.all([9 reads])` →
   `Promise.all([balance, allowance, pledged])`.

That is at least nine **sequential** RPC phases plus store reads, against
`services.polkadothub-rpc.com` (measured 50–130 ms per round trip from here).
Nine phases × ~150 ms from the VPS ≈ the 1.7 s. Nothing in phase 2 depends on
phase 1's result, and the second `getBlockNumber`/`getBlock` pair is a repeat.

The ~20 s runner case is a different animal. Today the same public RPC returned
404s after ~10 rapid calls from one client (seen while gating #1354). If the
smoke's failures are rate limiting, the fix is backoff + failover, not a longer
timeout. **Name the cause from per-phase timings before changing anything.**

## The fix

### A — directory reads wallets, not progression (own PR)

- Give `PlatformService` an undecorated listing (`listRecentSessions(limit,
  { progression: false })`, or expose the store listing directly) and use it in
  `buildAgentDirectory`. The directory's per-request cost becomes one `ZRANGE`,
  N session `GET`s and U consent `GET`s (U = unique wallets), then the existing
  per-listed-wallet profile build — which today runs for zero wallets.
- Audit `/badges`, the operator activity feed and admin sessions: switch each
  to the undecorated listing if it never reads `session.progression`; leave
  `/sessions` and anything that does read it on the decorated path.
- For consumers that do need progression, memoise `getProgression` **per wallet
  within one listing call** — 250 sessions of three wallets is three
  computations, not 250. Keep the per-session `settlementSessionId` semantics
  by memoising the expensive `collectAllWalletSessions` read, not the result.
- Do not touch the overscan multiplier, `includeSynthetic`, the consent
  semantics (#1348) or `cache-control: no-store`.

### B — one block, concurrent doors, fewer phases (own PR)

- Fetch the block **once** in `getInfo` and pass `{ blockNumber, block }` (or
  the tag) into both readers; delete the second `getBlockNumber`/`getBlock`.
- Start `creditBookDoor.getInfo` and the L1 `#snapshot`/`#capacity` together
  (`Promise.all`), not sequentially.
- Merge phases whose inputs are only the wallet (allowance / pledged /
  balance reads do not depend on the first batch). Target ≤ 3 sequential
  RPC phases end to end.
- Add per-phase timings to the `http.response` log entry for `/credit` (or a
  labelled histogram) so the runner case gets a real cause; then fix that cause
  (backoff + failover if it is rate limiting). The smoke timeout is not raised
  without a named cause.

## Non-negotiables (each pinned by a test; I run the drills)

1. **Directory performs zero progression reads.** Fake store with a counting
   `listSessionsByWallet`; 250 resolved sessions of one wallet; call the
   `/agents` route; assert zero calls. Mutation: route the directory back
   through the decorated listing — must fail.
2. **Directory store cost is linear.** Same fixture; assert store calls ≤
   1 range + 250 session reads + U consent reads. Mutation: add one extra read
   per session — must fail.
3. **Progression consumers still get it.** The path that reads
   `session.progression` still receives it. Mutation: drop decoration there —
   must fail.
4. **Per-wallet memoisation in a decorated listing.** 250 sessions of 3
   wallets → `collectAllWalletSessions` called 3 times. Mutation: remove the
   memo — must fail.
5. **Credit doors run concurrently.** Stub readers that record start/finish;
   assert the L1 read starts before the receipt-graph read finishes. Mutation:
   reintroduce the `await` — must fail.
6. **One block fetch per `getInfo`.** Counting provider: `getBlockNumber` ≤ 1,
   `getBlock` ≤ 1. Mutation: second reader fetches its own block — must fail.
7. **≤ 3 sequential RPC phases.** Provider stub that delays every RPC by a
   fixed 50 ms; `getInfo` must finish under 4 × 50 ms. Mutation: add a
   sequential phase — must fail.
8. **Production numbers, not curl only.** Handback shows
   `http_request_duration_ms` p50/p95 for `/agents` and `/credit` before and
   after from production `/metrics` (operator reads with the bearer) or the
   `http.response` lines. Targets: `/agents` default < 300 ms; `/credit` warm
   < 600 ms.
9. **Runner cause named.** For the 20 s case: the per-phase timing from a CI
   run and a one-line cause. No timeout increase is accepted as the fix.

## Out of scope

Directory consent or what the directory publishes (#1348). Cross-request
caching of `/agents` (stays `no-store`). Any contract or manifest change.
Replacing the RPC provider.

## Handback

Two PR numbers; green CI (the smoke phase is now discovered by CI after #1356,
so its result counts); the nine test names; drill evidence; the production
before/after figures from the histogram or log for both paths; the named cause
of the runner 20 s.

---

# REVISION 2026-09-09 — B re-scoped: the dominant `/credit` cost is the underwriter's per-request 30-day log scan, which the first draft omitted

A landed as #1357 (gated, queued). Codex's B diagnostic was right and I verified
it against `origin/main`: the cost is not the nine phases described above. It is
`services/receipt-graph-underwriter.js` `readWindow`, run on **every** `/credit`:

1. `getBlockNumber` — 1 call.
2. `findFirstBlockAtOrAfter` (`:197`) — a **binary search over the whole chain
   height** (~20.4 M blocks) for the 30-day cutoff: ~25 sequential `getBlock`.
3. `readLogsChunked` (`:211`) — 30 days ≈ 432 k blocks in `LOG_CHUNK_SIZE`
   = 25 000 steps → 18 chunks, **sequential**, × 3 filters (settlements by
   worker, disputes **unfiltered by worker**, upheld by worker) × 2 escrow
   sources (v3 + the v1 drain) ≈ 108 sequential `getLogs`.

≈ 134 sequential RPC calls per request **independent of history** (Codex
measured 133 for an empty wallet). At 50–150 ms per call against the public
RPC that is 7–20 s cold; the "1.7 s warm" figure was the provider answering
from cache. **The ~20 s runner case is therefore this scan against a
rate-limited public RPC — named, with evidence, and not a timeout problem.**
The original B items (concurrent doors, one block fetch, ≤ 3 phases) still
apply to the L1 reader but are secondary; parallelising the doors cannot make
a 134-call path three phases, as Codex said.

## Revised B scope

**B1 — evidence comes from a store, never from a per-request chain scan.**
The indexer already materialises exactly what the settlement filter derives:
`indexer/ponder.schema.ts:73` `settlement_split` (worker, asset, amounts,
blockNumber, timestamp). Codex chooses one of two sources and says why:

- (a) the indexer (`mainnet-indexer:42069`, Ponder's query endpoint), adding
  a worker index to `settlement_split` and indexing the dispute events the
  underwriter needs if they are not there yet (check `DisputeOpened` /
  upheld verdicts in `indexer/src/index.ts`; anything under `indexer/` rotates
  the schema, replay ≈ 5 min, plan the deploy accordingly). The backend today
  knows the indexer only through `INDEXER_STATUS_URL`; a data client is new
  code and must honour `INDEXER_LAG_BUDGET_SECONDS`.
- (b) the backend's own persisted payout receipts on sessions
  (`services/payout-receipt-backfill.js`), if they carry SettlementSplit
  amounts and upheld-dispute outcomes for the window; otherwise extend the
  backfill so they do.

Either way: when the source is stale or missing, the receipt graph reports
`available: false` with a named reason (`indexer_stale`, `receipt_store_missing`)
in the existing `credit_book_live_read_failed` idiom. It **never** falls back
to the chain scan silently. The chain scan may survive only as an explicit
operator backfill/reconciliation tool, off the request path.

**B2 — cutoff block without a bisect.** If any chain read remains in the path,
the 30-day cutoff block is derived arithmetically from the 6 s block time and
refined with at most two `getBlock` calls, cached per hour. One block fetch per
`getInfo`, passed into every reader.

**B3 — the original items.** Concurrent doors; L1 reader phases merged;
per-phase timings in the `http.response` entry for `/credit`.

**B4 — no timeout change.** With B1 in place the smoke should pass on the
existing timeout; if it does not, the per-phase timings name the next cause.

## Revised non-negotiables (replace 5–9 above)

5. **Zero log scans in the request path.** Counting provider stub: `/credit`
   performs 0 `getLogs` and 0 bisect `getBlock` calls. Mutation: reintroduce
   `readWindow` on the request path — must fail.
6. **Source honesty.** With a stubbed stale indexer / missing receipt store the
   receipt graph reports `available:false` with the named reason and makes zero
   chain calls. Mutation: fall back to the scan — must fail.
7. **Evidence parity.** For a fixture wallet with N settlements across both
   escrow sources and one upheld dispute inside the window plus one outside it,
   the underwriting output from the store equals the output of the old chain
   reader on the same fixture (keep the old reader **in tests only** as the
   oracle). Mutation: drop the out-of-window exclusion — must fail.
8. **One block fetch, concurrent doors, ≤ 3 sequential RPC phases** for what
   remains on chain (the L1 snapshot): 50 ms-per-RPC stub, `getInfo` under
   200 ms. Mutation: add a phase — must fail.
9. **Production numbers.** See the measurement runsheet below; `/credit` warm
   target < 600 ms, and the CreditPool smoke green on the unchanged timeout.
10. **Carry-over nit from #1357.** `listRecentSessionRecords` must throw, not
    return `[]`, when the store lacks `listRecentSessions`; an empty directory
    must mean "nobody consented", never "the store is wrong".

## Measurement runsheet (operator, before and after each deploy)

Correction to the first draft: `http_request_duration_ms` is a count+sum
histogram (`core/metrics.js:99`) — no quantiles. Percentiles come from the
`http.response` log lines. On the VPS:

```bash
for p in /agents /credit; do docker logs agent-mainnet-backend --since 24h 2>&1 | grep 'http.response' | grep "\"path\":\"$p\"" | grep -o '"durationMs":[0-9]*' | cut -d: -f2 | sort -n | awk -v p="$p" '{a[NR]=$1} END {if (NR==0) {print p, "n=0"; exit} print p, "n="NR, "p50="a[int(NR*0.5)+1], "p95="a[int(NR*0.95)+1], "max="a[NR]}'; done
```

Average as a cross-check, from the histogram (the bearer stays in the
container's environment; nothing is pasted anywhere):

```bash
docker exec agent-mainnet-backend sh -c 'curl -s -H "authorization: Bearer $METRICS_BEARER_TOKEN" http://127.0.0.1:8787/metrics' | grep -E 'http_request_duration_ms_(sum|count)\{[^}]*path="/(agents|credit)"'
```

The operator runs both **before** the A deploy, after A, and after B, and
pastes the output lines back. Codex has no production read path by design and
must not be given one; curl from outside is acceptable **additional** evidence
for `/agents` only (public), never for `/credit`.
