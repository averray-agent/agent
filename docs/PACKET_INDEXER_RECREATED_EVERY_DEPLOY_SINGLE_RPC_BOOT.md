# PACKET — Every deploy recreates the indexer, and its boot hangs on one public RPC

Status: ready for implementation. Scripts + one template in part A/B-env/C (no
schema rotation). Part B-code touches `indexer/` and therefore rotates the
schema — ship it separately, on purpose.

## What happened

Two consecutive production deploys went RED on 2026-09-05 at the indexer gate:

| run | SHA | PR | `/health` gate (120 s) | rollback's own 120 s wait |
|---|---|---|---|---|
| 33966044174 12:26Z | 7d00aa67 | #1341 | 19+ attempts, timed out | passed after 15 attempts |
| 33970498853 14:00Z | 673e725d | #1342 | 19+ attempts, timed out | passed after 23 attempts |

In both, the backend at the new SHA was already verified live
(`Health and serving-SHA checks passed … deployedSha …`) before the indexer
step ran. The runs were RED **and serving**. The "rollback" recreated the same
image with the same schema and the same env; it "succeeded" only because it
waited another 120 s.

The two green comparison runs (9ada467d 09-04 19:24Z, 6762ed26 09-05 10:30Z)
also recreated the indexer; their `/health` passed after 6 and 14 attempts
(poll = 5 s + up to 5 s curl → roughly 30–140 s). Boot-to-health on this host
is a distribution from ~45 s to >200 s and the gate is a flat 120 s inside it.

## Root cause 1 — the recreate is self-inflicted and deterministic

`deploy/indexer.mainnet.env.template` deliberately carries no
`DATABASE_SCHEMA` ("deploy-production.sh injects the last-good value from
host state after rendering"). The deploy then does, every run:

1. `render_runtime_envs` (deploy-production.sh ≈1264–1300) hashes
   `/run/agent-stack-mainnet/indexer.env` **before** the render (last run's
   file, which contains the injected `DATABASE_SCHEMA=` line) and **after**
   (fresh render, no schema line). They can never match →
   `RUNTIME_ENV_CHANGED_INDEXER=1`.
2. `apply_indexer_database_schema` → "Rendered indexer env contains no
   DATABASE_SCHEMA; resolving it from host state." →
   `write_indexer_schema` (≈1723–1763) appends the same schema and sets
   `RUN_INDEXER=1` and `RUNTIME_ENV_CHANGED_INDEXER=1` **unconditionally**.
3. `deploy()` (≈2268–2302): `RUNTIME_ENV_CHANGED_INDEXER == 1` → "Deploying
   indexer (reason: indexer.env content changed; image unchanged)" →
   `redeploy-indexer.sh` → `docker compose up -d --force-recreate`.

Proof, not inference: all four runs log the identical pair
`Phase 2 PR 2.7d.1: mainnet indexer runtime env content changed
(before=fe009015, after=07da8cfe)`. The file is byte-identical from deploy to
deploy; the only thing that differs between "before" and "after" is the line
the deploy itself appends afterwards. Nothing else changed in indexer.env in
any of the four runs.

Consequence: every deploy of anything — a site copy edit, an ops script —
restarts the indexer and opens a window in which `/health` is down and the
gate is rolled.

## Root cause 2 — the indexer boot depends on one public RPC endpoint

Ponder 0.16.6 runs an `eth_chainId` diagnostic before it serves; `/health`
stayed down for the whole window while it probed (observed in both red runs).
The indexer's RPC resolution (`indexer/ponder.config.ts` `resolveRpcUrl`)
prefers `DWELLER_RPC_URL`, then `POLKADOT_RPC_URL`, then
`PONDER_RPC_URL_<chainId>`. The mainnet template sets only the last:
`PONDER_RPC_URL_420420419=https://eth-rpc.polkadot.io/`. One host, no
fallback. #1176's transport (`indexer/src/rpc-transport.ts`) retries that
probe three times (10 s attempts, 5 s / 15 s waits) for 404 / 5xx / timeouts —
on the same host.

Ponder's own log, dumped by `dump_indexer_diagnostics` in both red runs, every
~20 s for the full 120 s:

```
WARN  JSON-RPC request unexpectedly surpassed timeout … chain=polkadotHubMainnet hostname=custom_transport
WARN  All JSON-RPC providers are inactive action=rpc_diagnostic chain=polkadotHubMainnet
TimeoutError: The request took too long to respond.
URL: https://eth-rpc.polkadot.io/
Request body: {"method":"eth_chainId"}
```

The backend on the same VPS, in the same minutes, was healthy on
`https://services.polkadothub-rpc.com/mainnet/` — its primary
(`RPC_URL`/`POLKADOT_RPC_URL`/`DWELLER_RPC_URL` in
`deploy/backend.mainnet.env.template:351–354`), with `eth-rpc.polkadot.io`
only as `RPC_BACKUP_URLS`. Caveat stated honestly: backend failover is silent,
so this proves the provider *set* was reachable from the VPS, not that
`eth-rpc.polkadot.io` was down for everyone. From outside the VPS at 17:40Z
both endpoints answered `eth_chainId` in ~0.1 s. The failure is
host-and-time local — which is exactly why a single endpoint is the wrong
dependency for a boot gate.

## Root cause 3 — the gate cannot name what it saw

`dump_indexer_diagnostics` (redeploy-indexer.sh ≈184–242) classifies the log
tail against `MigrationError|TypeError|uncaughtException|unhandledRejection|
FATAL|Cannot find module|ECONNREFUSED.*postgres|start_block.*greater` and
printed "(no known fatal-startup patterns matched in the last 120 indexer log
lines)" in both runs, 150 lines below the cause. The same-SHA "schema-only
rollback" then re-renders the same env, restores the same schema, recreates
the same image, waits another 120 s and prints "Rollback succeeded; indexer is
serving the previous build" — which is false: it is the same build. The gate
is a 240 s gate wearing a 120 s label, and the run summary tells the operator
the deploy failed while the backend is live at the new SHA.

## Blast radius

- Every deploy restarts the indexer: a 1–3 minute `/health` outage per deploy,
  indexer-backed backend surfaces see lag, and when the gate loses, the paid
  canary is suppressed as `deploy_not_successful` (#1176's own rationale).
- Every deploy re-rolls the RPC dice. Two losses today; the odds do not
  improve on their own.
- Operators read RED as "not deployed" (I did, for a minute) and may re-run
  or hold a live fix.

## The fix

**A — Stop the self-inflicted recreate** (`scripts/ops/deploy-production.sh`).

- The render diff must compare like with like: strip `^DATABASE_SCHEMA=` from
  the pre-render content before hashing, or hash after the host-state
  injection and compare that to the previous file. Either way, an unchanged
  template + unchanged persisted schema → no `RUNTIME_ENV_CHANGED_INDEXER`.
- `write_indexer_schema` may raise `RUN_INDEXER` / `RUNTIME_ENV_CHANGED_INDEXER`
  only when the schema **value** differs from the value the previous file
  carried (capture `read_current_indexer_schema` before the render). Same
  value → write the line, raise nothing, and log
  `indexer env unchanged apart from host-injected DATABASE_SCHEMA (<schema>); not recreating`.
- Keep the design as it is: the template stays schema-less; host state is
  injected after render; the existing test
  "indexer schema host state survives normal runtime-env renders" (including
  its render→apply ordering assertion) stays green.
- Do not touch `indexer_ponder_config_identity`, `indexer_app_identity` or the
  rotation branches. This packet changes when a container is recreated, never
  which schema it owns.

**B-env — Give the boot probe the provider the platform already trusts**
(`deploy/indexer.mainnet.env.template`, `deploy/indexer.env.template`).

- Add `DWELLER_RPC_URL=https://services.polkadothub-rpc.com/mainnet/`
  (testnet template: `/testnet/`). `resolveRpcUrl` already prefers it.
- `PONDER_RPC_URL_420420419` stays **byte-identical**. It is inside the
  identity hash (`indexer_ponder_config_identity` hashes `POLKADOT_CHAIN_ID`,
  `POLKADOT_CHAIN_NAME` and every `PONDER_*` key); changing it rotates the
  schema and triggers a full historical re-sync from block 18,647,521.
  `DWELLER_RPC_URL` is outside the hash — prove it (test 7).
- The deploy that lands this recreates the indexer exactly once (the env
  really changed). With A in place that is the last unforced recreate.

**B-code — Real fallback in the transport** (`indexer/src/rpc-transport.ts`,
`indexer/ponder.config.ts`). Touching `indexer/` changes `indexer_tree`
identity → schema rotation → historical re-sync with `/ready` staged. Ship it
as its own PR, say the cost in the PR body, and bundle it with the next
`indexer/` change if one is near.

- `createIndexerRpcTransport` takes an ordered URL list — honour the backend's
  names (`RPC_URL` + `RPC_BACKUP_URLS`) so one mental model covers both
  services — and returns a viem `fallback([...])` of per-URL `http` transports
  (Ponder accepts a Transport; it also documents `rpc: string[]` as
  load-balancing + fallback, acceptable if the boot-probe retry is preserved).
- Boot-probe budget must not multiply: the probe reaches the second URL within
  15 s of the first URL's first timeout. The three-attempt retry wraps the
  chain, not each URL. Non-diagnostic traffic keeps `retryCount: 0` per URL;
  the fallback does the switching.

**C — Make the gate honest** (`scripts/ops/redeploy-indexer.sh`).

- Add the RPC-probe signature to the fatal-pattern classifier:
  `All JSON-RPC providers are inactive|JSON-RPC request unexpectedly surpassed timeout|TimeoutError: The request took too long`,
  with a named line: `indexer boot RPC probe timed out against <url>` and a
  pointer to this packet.
- Same-SHA + same-schema "rollback" is a **same-build restart**. Log it as
  that. Never print "serving the previous build" when `PREVIOUS_SHA == HEAD`
  and the restored schema equals the current one.
- One explicit health budget instead of two hidden ones: raise the indexer
  `HEALTH_TIMEOUT_SEC` to 240 (observed pass range 30–200 s after a boot that
  must survive one full ≤50 s probe cycle) and do not recreate the container
  in the same-build case — a recreate resets Ponder's probe progress. Keep
  the recreate for the true rollback case (`PREVIOUS_SHA != HEAD` or a
  different schema).
- When the indexer gate fails after the backend was verified at the new SHA,
  the run summary states: `backend live at <NEW_SHA>; indexer same-build
  restart; run failed on the indexer gate`. RED must never read as "nothing
  deployed".

## Non-negotiables (each pinned by a test)

`scripts/ops/deploy-production.test.mjs` already drives the script with fake
bins; `scripts/ops/redeploy-indexer.test.mjs` spawns it with fixtures;
`indexer/src/api/rpc-transport.test.ts` covers the probe. Extend those, in
their idiom.

1. **Mutation baseline:** a second deploy with an unchanged template and the
   same persisted schema logs no `Deploying indexer` and issues no
   `--force-recreate` for the indexer service. Run this test against
   `origin/main`'s script first and show it RED; then green after A.
2. A non-identity template change (adding `DWELLER_RPC_URL`) recreates
   exactly once; a schema value change recreates; identity-key changes still
   rotate — the existing test "indexer source, resolved Ponder version, or
   contract-config changes rotate while unchanged identity does not" stays
   green untouched.
3. "indexer schema host state survives normal runtime-env renders" stays green,
   including render→apply ordering.
4. Classifier: a fixture containing the exact Ponder lines from run
   33970498853 produces the named RPC-probe line and never
   "(no known fatal-startup patterns matched …)".
5. Same-SHA/same-schema path prints `same-build restart` and the backend-live
   summary, and never "serving the previous build"; a different-SHA rollback
   keeps today's wording and the existing "rollback restores the exact
   last-good schema before recreating the indexer" test.
6. Transport (B-code): first URL times out on `eth_chainId`, second answers →
   probe succeeds inside one Ponder probe cycle; the four existing
   rpc-transport tests stay green (non-diagnostic requests still inherit no
   retry).
7. Identity guard: `indexer_ponder_config_identity` computed for the template
   **with** `DWELLER_RPC_URL` equals the value **without** it. This is the
   line that keeps B-env from rotating the schema; if it fails, stop.

## Prior art and what it did not cover

#1176 (2026-08-19) added the three-attempt boot probe after five deploy reds
from transient `eth-rpc.polkadot.io` 404s. It fixed the edge's 404s on one
host. Today's failures are timeouts on that same single host, on a container
that had no reason to restart. #1176's retry ran exactly as designed and lost.

## Live state while this is open — safe

Indexer healthy (`/health` 200, backend health `indexer synced`), schema
`agent_indexer_mainnet_20260830151333_d19ed879` unchanged, backend at 673e725d
live. Each further deploy carries the same odds until A lands.

## Handback

PR number(s); green CI; the seven test names; the mutation baseline evidence
(test 1 red on origin/main's script, green on the PR); the first production
deploy after merge showing exactly one indexer recreate (env changed by
B-env), and the following deploy showing `not recreating` with no indexer
gate at all. For B-code: the PR body states the re-sync cost and the deploy
log shows the rotation warnings and `/ready` returning within the staged
window.
