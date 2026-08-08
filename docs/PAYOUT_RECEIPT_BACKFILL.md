# Payout receipt backfill

`flow.usdcPaid` intentionally becomes unknown when any settled session lacks a
chain-usable payout receipt. Do not weaken that aggregation rule. Repair the
receipt from chain truth instead:

- transaction discovery: the deployed EscrowCore `JobClosed` event, filtered by
  the session's `chainJobId`;
- value proof: AgentAccountCore
  `ReservationSettled(bytes32,address,address,address,uint256)`, topic0
  `0x3cdc0be5ec7141f2342208f6404c1b1852936343f0edf1fda179e6c9f46573ee`;
- no ERC-20 `Transfer` requirement: the Polkadot Hub USDC precompile does not
  emit those logs;
- v2 fee metadata: the deployment-pinned `SettlementSplit` event, corroborated
  against the AAC worker and treasury reservations.

The leading indexed AAC field is `settlementId`, not `jobId`. The decoder is
pinned to the raw log from mainnet transaction
`0x25fa6cd445cabaee33b577f77823b1346ed7b6f69c93cd9c5682c814223ef06e`;
it does not import the contract source ABI.

Run the read-only proof first from the backend environment that owns `REDIS_URL`:

```sh
npm --workspace mcp-server run backfill:payout-receipts
```

The command prints `mode: "dry-run"`, one `chainVerified: true` per repair, and
an aggregate `chainVerified: true`. `candidateCount` is the number selected for
repair and `repairedCount` is the number chain-verified; `storedCount: 0` on a
dry run only confirms that no writes occurred. An RPC, manifest, transaction,
log, job, worker, asset, or amount mismatch exits non-zero before the first
state write. Optionally constrain both passes with repeated `--session-id <id>`
arguments.

Only after reviewing that output, persist the same chain-verified repairs:

```sh
npm --workspace mcp-server run backfill:payout-receipts -- --commit
```

The historical mainnet transaction
`0xb8d8cc3c57b047de60fea15f79f8e453ad18089626eb43d9417d37939302917e`
called `resolveSinglePayout(..., false, ...)`: it is the rejection leg, not the
final payout. The same job later emitted `JobClosed` in transaction
`0x7afd7fbf64eb19e4f579b5ab59bc14c9b3546ee7a910bd0ad44da9fc7d123222`,
whose AAC logs prove a 1,000,000-raw worker payout and 50,000-raw protocol fee.
The backfill deliberately follows that terminal job event instead of relabeling
the resolved session from its stale recorded transaction.
