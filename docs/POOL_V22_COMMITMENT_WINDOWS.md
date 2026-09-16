# Pool v2.2 commitment windows — implementation, not deployment

Authority: `PACKET_POOL_V22_COMMITMENT_WINDOWS.md` on
`claude/packets-2026-08-12` at **96b7b7c7**, including the September 16 rulings.
R1–R6 are ratified. This change does not deploy a contract, change a production
address, move a depositor, quote a venue rate, or execute the measurement cycle.
Pascal runs `RUNSHEET_V21_MEASUREMENT_CYCLE_2.md`; deployment 2 is not this
implementation's funds-movement target.

## Separate contracts; existing pools unchanged

`DepositPoolV22` is a new generation, forked from the v2.1 source. The existing
`DepositPoolV2` and `AacPoolAggregatorAdapter` sources and deployment manifest
remain unchanged. v2.2 has one NAV: **all shares, including Flex, share venue
gains and losses pro-rata**. There are no share classes or differentiated NAVs.

- At most seven days: `max(0, bufferAssets - bufferFloor)` as in v2.1.
- Longer windows: the minimum of that same liquid capacity and
  `max(0, committedAssetsBeyond(returnBy) - longDeployedOutstanding)`.
- The high-water-mark floor does not shrink when its holder commits. The
  September 16 ruling supersedes the draft's claim that it would.
- Commitments block synchronous redemption, notice requests and new pledges.
  A position with pending redemption/pledged shares cannot commit. Expiry is
  a timestamp comparison, never a sweep transaction. New shares minted into
  a committed position inherit its existing expiry.
- Exact holder expiries are retained. Thirteen future weekly buckets cover
  the 90-day horizon; the current partial-week exit bucket is read separately
  for telemetry. A bucket's earliest exact expiry is a conservative lower
  bound: mixing expiries within a week can understate deployable backing,
  never overstate it. The public table explicitly labels this bound. An exact
  return deadline equal to a commitment expiry is covered. A view requesting
  90 full days after a holder committed earlier can therefore return zero;
  operators must leave recall margin inside the remaining commitment.
- First venue binding remains set-once. Subsequent owner proposals restart a
  seven-day timelock, and applying requires no active deployment or recall.
- A successful recall draining the venue realises unreturned principal and
  closes the deployment. Failed/partial recalls do not falsely write off live
  principal. Later-discovered losses retain the owner write-off path. Realised
  losses update the existing write-off getter, so journal/getter attribution
  remains compatible with Substrate-origin events absent from EVM logs.

## Shared commitments and consent

The new synchronous `AacPoolAggregatorAdapterV22` uses strategy
`AAC_LOCKED_DEPOSIT_POOL_V22`. It is **not** the deployed idle v2.1 adapter.
The keeper never uses `requestStrategyDeposit` and never commits the existing
idle-balance adapter. Allocation first lands in adapter float. A later tick
re-reads the measurement gate, ledger, chain and every participant's signed
consent before atomically depositing and committing the shared pool position.

The deadline is the earliest signed consent/ledger expiry of everyone in the
position, capped at 90 days. The adapter accepts an exact deadline, so a
20-day remainder need not be rounded upward into a 30-day promise. A newcomer
whose consent ends before the current commitment stays idle in AAC; its lock
entry in `/me` carries `lock_shorter_than_shared_commitment`. Unknown strategy
shareholders or ledger/chain disagreement refuse all new movements.

New post-ceremony quotes sign `commitmentConsentUntil` and the additional
on-chain exit terms without removing the existing venue-risk sentence.
Old consent lacking this explicit on-chain commitment deadline is not silently
upgraded. T7's non-yield-only consent is not used for a venue allocation.
The operator's R4 commitment is a direct holder, independent of this adapter.

On every lock read, the service reads the chain commitment and AAC position.
A term/principal mismatch forfeits perks, raises `pool-v22:reconciliation-alarm`,
and keeps principal pending rather than pretending it was released. Read
failures remain unavailable. Early exit does not require consent or an open
gate: it waits for commitment expiry, requests the pool notice exit, fulfils
it when liquid, then deallocates back to AAC. The date is an earliest ETA;
the seven-day notice and venue recall can extend actual release. No penalty
or principal haircut is applied; the position still bears pro-rata venue loss.

The first observed T90/co-depositor limitation writes
`pool-v22:isolation-trigger` (`t90_limited_by_co_depositor`). That is the
ratified trigger for a separately reviewed isolated-tranche follow-up.

## Dark switches and measurement evidence

Both default off, with commented entries in `deploy/backend.mainnet.env.template`:

- `POOL_V22_CEREMONY_COMPLETE=1`, plus actual `POOL_V22_ADDRESS` and
  `POOL_V22_AGGREGATOR_ADDRESS`, enables post-ceremony reads/consent terms.
- `POOL_V22_LOCKED_KEEPER_ENABLED=1` additionally enables the bounded keeper.

Neither substitutes for correct AAC strategy registration/roles, nor changes
the canonical pool pointer. Those are independently verified in Ceremony C.
No 1Password item or VPS secret is required by this code change.

The economics gate defaults closed with **`venue_rate_unmeasured`**. There is
no built-in 4.9%/19% rate and no APY environment override. Once the operator
resolves the measurement, its reviewed service-state evidence record at
`pool-v22:measured-venue-rate` has this shape (values deliberately omitted):

```text
approved: true
evidence: durable reference to the reviewed measurement record
principalRaw: exact USDC base units at the start of measurement
yieldRaw: measured growth, not the entry/exit balance difference
elapsedSeconds: measured time span
```

Projection is proportional measured yield over the shortest remaining term,
with **one** round-trip friction per term. Friction uses the larger of the two
measured trips, 51,765 raw (the other is 51,490), and the existing 2x margin.
Fixture rates in tests are not production evidence or external quotations.

## Recovery and rollback

The keeper holds a distributed run lock and persists an intent at
`pool-v22:movement` **before** any write. A crash, failed send, timeout or lost
receipt leaves `pending: true`: subsequent runs refuse with
`movement_reconciliation_required`. An operator must inspect the transaction,
AAC strategy shares, adapter float/pool shares and ledger before repairing
the intent. Never clear it just to retry. The exit request is separately
persisted at `pool-v22:exit`.

Turn off `POOL_V22_LOCKED_KEEPER_ENABLED` to stop new automatic movements;
leave the ceremony/read configuration intact for honest outstanding-lock
visibility. An operator must then complete pending exits. Disabling automation
does not revoke on-chain commitments or restore synchronous liquidity.
Do not roll back to code that treats allocated commitments as liquid locks.

## Ceremony C — operator only

After review and CI: deploy v2.2 and its fresh venue adapter/lane pair;
independently reproduce both creation hashes and complete the D-03 waiver;
fund adapter postage; verify `adapter.pool()`; perform first venue binding;
retire the v2.1 deposit door, migrate operator capital through notice,
and have the operator holder commit. Outside holders migrate at leisure.
Only then record actual addresses/strategy registration, configure the door,
and set the ceremony switch. The v2.1 Solidity contract has no deposit pause
function: retiring its deposit door does **not** claim to disable direct
transactions on that immutable contract.

First long deployment must satisfy both contract capacity and the existing
50% operator policy, with recall margin inside the exact commitment expiry.
The ceremony CLI accepts `--deployment-kind committed` only for the manifest's
explicit `depositPoolV22`, paired with `hydrationDepositPoolAdapterV22` and
`depositPoolLaneV22`. It reads the live 90-day ceiling and exact-window
capacity; legacy proof/standing policies are unchanged. Its settlement
postcondition accounts for the emitted automatic realised loss.
The locked keeper stays off until its fresh adapter is registered, consents
cover on-chain commitments, and measurement evidence opens the gate.

## Drills

`test/DepositPoolV22.t.sol` pins 1–7 and amended 4b. Its stateful Foundry
invariant uses an independent two-holder model, not `deployableFor` as its
oracle, and checks both branches at successful creation. It also exercises
real AAC synchronous allocation through the new adapter and notice exit.
`mcp-server/src/services/pool-v22.test.js` pins amended 8, 9, 10, revoked
consent/exit ordering, unknown participants, crash intents, default-off
configuration and read-time reconciliation. Existing v2.1 differential and
aggregator suites must pass unchanged.
