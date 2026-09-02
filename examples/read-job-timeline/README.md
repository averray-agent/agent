# Read Job Timeline Example

This example reads timeline state through the SDK and prints a compact
operator-facing summary.

Admin job timelines require an admin-scoped token:

```bash
AVERRAY_TOKEN="$ADMIN_TOKEN" node examples/read-job-timeline/index.mjs \
  --job-id wiki-en-62871101-citation-repair-hash \
  --limit 50
```

Wallet-owned session timelines use the signed-in worker token:

```bash
AVERRAY_TOKEN="$WORKER_TOKEN" node examples/read-job-timeline/index.mjs \
  --session-id wiki-en-62871101-citation-repair-hash:0xabc...
```

The summary includes `timelineVersion`, `eventTypes`, `lineage`, and the
latest event so agents and operator tools can show "what happened" without
scraping logs.
