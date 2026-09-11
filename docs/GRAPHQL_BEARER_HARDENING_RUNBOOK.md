# GraphQL bearer hardening — `/graphql` on the indexer

**Status: PREPARED 2026-09-10, NOT EXECUTED.** Gated on
[#1358](https://github.com/averray-agent/agent/pull/1358) (the backend's
`/credit` receipt-graph reader learns to send the bearer) being merged and
deployed first. Every checkbox below is unticked until the operator ticks it.

## 0. Has this already run?

One read, before anything else:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' -X POST https://index.averray.com/graphql \
  -H 'content-type: application/json' --data '{"query":"{ __typename }"}'
```

- `200` — not run. Baseline measured 2026-09-10: `200` on
  `index.averray.com/graphql` (POST and the GET playground) and on
  `app.averray.com/index/graphql`.
- `401` — already live. Do **not** create new 1Password items; go to §5 and
  re-prove.

## 1. Decision record

**Exposure.** `deploy/Caddyfile.averray` proxies the whole Ponder app on
`index.averray.com` with no path restriction, and again under
`app.averray.com/index/*`. `indexer/src/api/index.ts` gates `/graphql` with a
Bearer only when `GRAPHQL_BEARER_TOKEN` is set; the mainnet template had the
key commented out, so production answered arbitrary GraphQL queries and served
the GraphiQL playground to anyone. Chain data is public; the problem is an
unbounded query surface on the indexer's Postgres (DoS and the SQL-layer
transitive-dependency advisories in `docs/THREAT_MODEL.md`).

**Who uses the public indexer host.** Only `/`, `/health`, `/ready` and
`/status`: `scripts/ops/check-hosted-stack.sh`, `scripts/ops/redeploy-indexer.sh`,
the deploy workflow's Hermes post-deploy verification, `PRODUCTION_CHECKLIST.md`,
`INCIDENT_RESPONSE.md`. `/xcm/outcomes` and `/escrow/job-creations` are
documented but have no external consumer found. Nothing in `app/`, `site/`,
`marketing/`, `averray-reference-agent`, `agent-harness` or `buzz` calls
`/graphql`; the operator app never calls `/index/*` at all (the marketing site
prints the host name as a label only). The one real consumer of `/graphql` is
the backend's `/credit` receipt-graph reader from #1358, and it reaches the
indexer over the compose network (`http://mainnet-indexer:42069/graphql`),
never through Caddy.

**Options.**

| | Posture | Verdict |
| --- | --- | --- |
| A | Bearer enforced in the indexer process (`GRAPHQL_BEARER_TOKEN`), backend sends it (`INDEXER_GRAPHQL_BEARER_TOKEN`). Env-only. | **Chosen.** One gate covers both public doors. No Caddyfile change. Not a Ponder/chain input, so no `DATABASE_SCHEMA` rotation. |
| B | A, plus Caddy denies `/graphql` on both public hosts at the edge. | Stronger (a leaked bearer is not exercisable from the internet; refused requests never reach Hono). Deferred: it is a Caddyfile change with its own reload path. Recorded as a follow-up in `docs/THREAT_MODEL.md`. |
| C | Leave `/graphql` public. | Rejected. |

**Why two 1Password items for one secret.** The indexer renders with a
service account that reads only `mainnet-indexer`; the backend's reads only
`mainnet-backend` / `mainnet-backend-external` / `mainnet-observability`.
`scripts/ops/check-env-template-structure.mjs` fails a backend template that
references the indexer vault. So the same string lives in
`mainnet-indexer/graphql-bearer-token` and `mainnet-backend/graphql-bearer-token`.
Both rows are critical-nonempty: a render that leaves either empty fails the
deploy instead of silently reopening the route (indexer) or silently
disabling `/credit` evidence (backend).

**What the change touches (the hardening PR).**

- `deploy/indexer.env.template` — `GRAPHQL_BEARER_TOKEN` activated
  (`prod-indexer` slug; the generator repoints it to `mainnet-indexer`).
- `deploy/backend.env.template` — `INDEXER_GRAPHQL_BEARER_TOKEN` activated
  (`prod-backend` slug → `mainnet-backend`).
- `deploy/*.mainnet.env.template`, `deploy/secrets-inventory.md` — regenerated
  by `node scripts/ops/render-mainnet-backend-env.mjs`; two hand-written
  prod-* inventory rows, both `✅ yes` critical-nonempty.
- `scripts/ops/check-hosted-stack.sh` — the indexer check now asserts the
  indexer's own `401 {"error":"unauthorized"}` on `index.averray.com/graphql`
  and not-200 on `app.averray.com/index/graphql`; optionally proves the
  bearer-authenticated `200` when `INDEXER_GRAPHQL_BEARER_TOKEN` is exported.
- `docs/THREAT_MODEL.md`, `VPS_RUNBOOK.md` — posture text.
- The reader's fail-closed behaviour is untouched and no public route is
  added.

The testnet stack is retired, so the `prod-*` items are not created; if that
stack is ever rendered again, the same two items must exist in `prod-indexer`
and `prod-backend` or the render fails closed.

## 2. Preconditions

- [ ] #1358 merged **and** its deploy-production run is green
      (`gh run list --workflow deploy-production.yml --limit 3`). Without it
      the backend sends no bearer and `/credit` reports
      `receiptGraph.available=false` the moment the indexer starts requiring
      one.
- [ ] The hardening PR is rebased on top of #1358's merge commit.
- [ ] §3 items exist **before** the hardening PR merges. If they do not, the
      deploy fails closed at `validate-env-render.sh` (unresolved reference /
      critical-nonempty). Safe, but a wasted deploy.

## 3. Operator: create the 1Password items (same value, two vaults)

Run on your machine (1Password sessions do not reach a sandboxed shell).

```bash
token="$(openssl rand -hex 32)"
op item create --vault mainnet-indexer --category password --title graphql-bearer-token "password=$token" >/dev/null
op item create --vault mainnet-backend --category password --title graphql-bearer-token "password=$token" >/dev/null
unset token
```

The value rides on `op`'s argv for the duration of each call (visible to `ps`
on your laptop, nowhere else). Then prove the two items agree **without
printing the value**:

```bash
diff <(op read 'op://mainnet-indexer/graphql-bearer-token/password' | shasum -a 256) \
     <(op read 'op://mainnet-backend/graphql-bearer-token/password' | shasum -a 256) \
  && echo "items match"
```

- [ ] `items match` printed.
- [ ] Each service account can read its item (this is what the deploy does):
      `op read` with `OP_SERVICE_ACCOUNT_TOKEN` set to `op-token-mainnet-vps-indexer`
      for the indexer item and `op-token-mainnet-vps-backend` for the backend
      item, output piped to `shasum -a 256` only.

## 4. Merge → deploy: what the log must show

Merging to `main` runs CI then `deploy-production.yml` (auto). Read the
`deploy-production.log` job output. Expected, in order:

- [ ] `Phase 2 PR 2.7d.1: mainnet backend runtime env content changed (before=…, after=…) — will force-recreate`
- [ ] `Phase 2 PR 2.7d.1: mainnet indexer runtime env content changed (before=…, after=…) — will force-recreate`
- [ ] `validate-env-render.sh` for the indexer reports one more
      critical-nonempty variable than the previous deploy (2 instead of 1);
      the backend count is up by one.
- [ ] `Applying persisted host-owned indexer DATABASE_SCHEMA: agent_indexer_mainnet_…`
      with the **same** schema name as the previous deploy.
- [ ] **Absent:** `::warning::Indexer app/config identity changed; automatically rotating DATABASE_SCHEMA`
      and `INDEXER HISTORICAL RE-SYNC STARTING`. The identity hashes only the
      `indexer/` tree, the `POLKADOT_CHAIN_*` + `PONDER_*` keys of the
      template, and the resolved Ponder version
      (`indexer_app_identity` in `scripts/ops/deploy-production.sh`);
      `GRAPHQL_BEARER_TOKEN` is outside all three. If the warning appears,
      something else in the deploy range touched `indexer/` or a `PONDER_*`
      key — expect ~5 minutes of replay and `receiptGraph.available=false`
      with an `indexer_*` reason until `/ready` returns.
- [ ] Hosted smoke prints `Checking indexer /graphql bearer gate` and passes.
- [ ] `https://index.averray.com/ready` is `200` again within about a minute
      (container recreate), not after a replay.

Recreate order inside the deploy is not guaranteed; for the seconds between
the two container recreates one side holds the old (empty) value and
`/credit` may report `receiptGraph.available=false`,
`reason: indexer_evidence_unavailable`. That is the reader's fail-closed
behaviour working, not a fault. The L1 snapshot is unaffected.

## 5. Post-deploy proofs (all required)

### 5.1 Both public doors refuse, the rest of the host stays open

```bash
curl -sS -w '\n%{http_code}\n' -X POST https://index.averray.com/graphql \
  -H 'content-type: application/json' --data '{"query":"{ __typename }"}'
# expect: {"error":"unauthorized"} then 401
curl -sS -o /dev/null -w '%{http_code}\n' https://index.averray.com/graphql
# expect: 401 (GET playground goes through the same middleware)
curl -sS -o /dev/null -w '%{http_code}\n' -X POST https://app.averray.com/index/graphql \
  -H 'content-type: application/json' --data '{"query":"{ __typename }"}'
# expect: 401 (anything but 200 is acceptable here: a basic-auth shell may answer first)
curl -sS -o /dev/null -w '%{http_code}\n' https://index.averray.com/ready
curl -sS https://index.averray.com/ | jq -c .status
# expect: 200 and "ok" — only /graphql changed
```

- [ ] index host POST `401` with the indexer's body
- [ ] index host GET `401`
- [ ] app proxy not `200`
- [ ] `/ready` `200`, `/` status `ok`

### 5.2 The process gate accepts the bearer (on the VPS, value never printed)

The indexer is published on the VPS loopback (`127.0.0.1:52069`), so this
bypasses Caddy and proves the Hono middleware itself. Read the rendered value
into a shell variable only:

```bash
token="$(sudo awk -F= '/^GRAPHQL_BEARER_TOKEN=/{print substr($0, index($0, "=") + 1)}' /run/agent-stack-mainnet/indexer.env)"
curl -sS -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:52069/graphql \
  -H "authorization: Bearer $token" -H 'content-type: application/json' \
  --data '{"query":"{ __typename }"}'
unset token
# expect: 200
diff <(sudo awk -F= '/^GRAPHQL_BEARER_TOKEN=/{print substr($0, index($0, "=") + 1)}' /run/agent-stack-mainnet/indexer.env | sha256sum) \
     <(sudo awk -F= '/^INDEXER_GRAPHQL_BEARER_TOKEN=/{print substr($0, index($0, "=") + 1)}' /run/agent-stack-mainnet/backend.env | sha256sum) \
  && echo "rendered copies match"
```

- [ ] `200` with the bearer
- [ ] `rendered copies match`

### 5.3 `/credit` still reads the indexer (authenticated)

Use your operator session token (the same `AVERRAY_TOKEN` the hosted smoke
uses). The path of the checkpoint provenance in #1358 is
`receiptGraph.underwriting.evidence.provenance`.

```bash
curl -sS -H "authorization: Bearer $AVERRAY_TOKEN" https://api.averray.com/credit \
  | jq '{available: .receiptGraph.available,
         reason: .receiptGraph.reason,
         provenance: .receiptGraph.underwriting.evidence.provenance,
         checkpointTimestamp: .receiptGraph.underwriting.evidence.checkpointTimestamp}'
# expect: available=true, reason=null, provenance="indexer_checkpoint", a recent checkpoint
```

- [ ] `available: true`, `provenance: "indexer_checkpoint"`

If `available` is `false` with `indexer_evidence_unavailable`: the backend's
bearer does not match the indexer's (run 5.2's diff) or the indexer is not
serving (`/ready`). With `indexer_stale` / `indexer_checkpoint_missing`: a
replay is in progress (§4's absent warning was not absent).

### 5.4 The startup warning is gone (with a positive control)

```bash
docker inspect agent-mainnet-indexer --format '{{.State.StartedAt}}'
# must be later than the deploy; a recreated container's log starts fresh
docker logs agent-mainnet-indexer 2>&1 | grep -c 'publicly reachable'
# expect: 0
docker exec agent-mainnet-indexer sh -c 'test -n "$GRAPHQL_BEARER_TOKEN" && echo GRAPHQL_BEARER_TOKEN=set'
# expect: GRAPHQL_BEARER_TOKEN=set   (proves the zero above is not an empty log)
```

- [ ] `StartedAt` after the deploy
- [ ] warning count `0`
- [ ] positive control prints `set`

### 5.5 The schema pin did not move

```bash
cat /srv/agent-stack/.deploy-state/indexer.database-schema.mainnet
sudo awk -F= '/^DATABASE_SCHEMA=/{print $2}' /run/agent-stack-mainnet/indexer.env
# both equal the value from before the deploy
```

- [ ] unchanged

Record the outcome (date, deploy run URL, the five ticks) at the top of this
file under **Status**; the runbook is not done until that line exists.

## 6. Rotation

1. New value: `openssl rand -hex 32`. `op item edit` **both** items
   (`mainnet-indexer/graphql-bearer-token` and
   `mainnet-backend/graphql-bearer-token`), then re-run §3's `diff`.
2. Redeploy: `gh workflow run deploy-production.yml` with default inputs (or
   any push to `main`). The render step always re-renders both env files;
   the content hashes differ, so both containers are force-recreated, and
   the indexer path still runs the host-state schema preflight and keeps the
   persisted schema. Watch §4's lines.
3. Re-run §5. The mismatch window between the two recreates is seconds;
   `/credit` reports `indexer_evidence_unavailable` during it by design.

Never rotate one item without the other: a one-sided rotation is a silent
`/credit` outage that looks like an indexer problem.

## 7. Rollback

Revert the hardening PR as a whole and let the deploy run. The template rows
and the smoke probe travel together on purpose: reverting only the templates
leaves `check-hosted-stack.sh` asserting `401` and turns every later deploy
red. After the revert deploys, the indexer logs the `publicly reachable`
warning again and `/graphql` answers `200`. The 1Password items may stay.

There is no hot rollback: `/run/agent-stack-mainnet/*.env` is rendered from
the committed template on every deploy, and hand edits there are overwritten
by the next run.

## 8. Not done (deliberately)

- Option B, edge-deny of `/graphql` at Caddy on both public hosts.
- Removing the operator app's unused `/index/*` proxy so `app.averray.com`
  stops fronting the indexer at all.
- `mcp-server/.env.example` documents none of the `INDEXER_*` keys; that gap
  predates this change.
