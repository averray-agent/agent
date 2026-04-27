# Content Recovery Runbook

This runbook covers recovery of Averray content-addressed blobs served by
`/content/:hash`.

The current production path stores content records in the configured state
store and appends every write to a private JSONL recovery log. If Redis loses
or corrupts content records, operators can replay that log back into the state
store.

## Scope Boundary

This is backend state recovery only.

- It restores Averray API content records such as job specs, submissions, and
  dispute/verifier reasoning payloads.
- It does not restore blockchain state, SBTs, escrow events, indexed chain
  history, or XCM requests.
- It does not publish content to Polkadot Bulletin Chain, IPFS, or Crust.
- It does not emit `Disclosed` or `AutoDisclosed` events.

Polkadot Bulletin Chain is a separate future storage option with CID-based
retrieval and retention/renewal semantics. Do not describe this replay command
as decentralized storage or on-chain content recovery.

## Inputs

The recovery log is controlled by:

```bash
CONTENT_RECOVERY_LOG_ENABLED=1
CONTENT_RECOVERY_LOG_DIR=/srv/agent-stack/content-recovery-log
```

If `CONTENT_RECOVERY_LOG_DIR` is unset, the backend defaults to
`.content-recovery-log` under its working directory. Production should keep the
directory on durable private storage and include it in host backups.

Each log file is named `YYYY-MM-DD.jsonl`. Each line is a canonical
`content.upserted` record. Replay validates the payload hash before it writes
anything back to the state store.

## When To Use

Use this runbook when:

- `/content/:hash` returns 404 or private/public state is missing after Redis
  loss or restore.
- A Redis backup restore brought back sessions/jobs but not content blobs.
- A recovery drill needs to prove that the JSONL log can rebuild the content
  store.

Do not use it for:

- failed contract deployments
- indexer lag
- missing chain events
- XCM settlement repair

## Recovery Steps

Run commands from the deployed app directory:

```bash
cd /srv/agent-stack/app
```

Load the backend environment that points at the production state store. The
exact file is deployment-specific, but the command must have the same
`REDIS_URL`, `REDIS_NAMESPACE`, and content recovery env used by the backend.
On the current VPS layout, those values usually live in the stack env files:

```bash
set -a
source /srv/agent-stack/.env
source /srv/agent-stack/backend.env
set +a
```

First run a dry run:

```bash
npm --workspace mcp-server run replay:content-recovery -- \
  --dir /srv/agent-stack/content-recovery-log
```

Review the JSON summary:

- `recordsSeen` should match the number of non-empty JSONL lines read.
- `wouldRestore` is the number of records that would be written.
- `skipped` means the state store already has an equivalent or newer record.
- `invalid` must be `0` before applying.
- `errors` lists file and line locations for malformed or hash-mismatched
  records.

If the dry run is clean, apply:

```bash
npm --workspace mcp-server run replay:content-recovery -- \
  --dir /srv/agent-stack/content-recovery-log \
  --apply
```

The command is idempotent. Running it again should move previously restored
records into `skipped`.

## Validation

After applying, validate a known content hash:

```bash
curl -i "https://api.averray.com/content/$CONTENT_HASH"
```

For owner-only content, include a JWT for the owning wallet or an admin token:

```bash
curl -i "https://api.averray.com/content/$CONTENT_HASH" \
  -H "authorization: Bearer $JWT"
```

Expected outcomes:

- Public content returns `200`.
- Owner-only content returns `200` only for the owner or admin.
- Unauthenticated private content returns `403`.
- Missing content still returns `404`; inspect the replay summary and the log
  file that should contain the hash.

## Failure Handling

If `invalid > 0`, do not apply until the bad lines are understood. The replay
tool validates the canonical payload hash; a mismatch means the line is either
corrupt or not from the Averray content recovery writer.

If apply succeeds but `/content/:hash` still returns 404:

1. Confirm the backend is using the same `REDIS_URL` and `REDIS_NAMESPACE` that
   the replay command used.
2. Confirm the recovery log contains the hash:
   ```bash
   rg -n "$CONTENT_HASH" /srv/agent-stack/content-recovery-log
   ```
3. Rerun the replay command in dry-run mode and check whether the record is
   counted as `skipped`, `wouldRestore`, or `invalid`.
4. Check backend logs for state-store connection errors.

If Redis is unstable, stop risky deploys and treat the incident as a storage
integrity problem before continuing normal operations.

## Current Roadmap Position

This runbook completes the operator drill portion of the rc1 content-addressing
slice:

- `/content/:hash` content store: shipped
- append-only recovery log: shipped
- early owner/admin publish: shipped
- replay command: shipped
- operator replay runbook: this document

Remaining work in the broader rc1 content/disclosure lane is separate from this
runbook, especially any on-chain `Disclosed` / `AutoDisclosed` event coupling
and future decentralized content mirrors.
