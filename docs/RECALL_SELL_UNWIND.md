# Recall sell-leg unwind (operator-run)

Authority: `PACKET_RECALL_SELL_LEG_SILENTLY_NOT_EXECUTED.md` at `0dd530d7`
on `claude/packets-2026-08-12`, including **Rulings — 2026-09-22**.
This changes ops tooling, not contracts or deployment economics. Pascal runs
the commands after Claude's gate. No automatic retries or production writes
are performed by tests or by the default CLI mode.

## Classification and authority to abandon

A withdraw-sell timeout now records far-side evidence before failing. The
reader finds the request's unique canonical Hub `RequestLegDispatched` (leg 2),
uses its timestamp with the existing five-minute skew allowance to bound the
Hydration scan, and scans forward only until the first successful
`messageQueue.Processed` for the topic. It reads that entire block before
stopping: a Transact executes during its message's processing, not later.
Swaps and venue aUSDC debits in every matching processing block (including
earlier unsuccessful processing) are retained. There is no scan to today's head
after a successful Processed has been found. Missing/pruned processing history
or contradictory evidence is still `unknown`.

After finding the processing block, the reader captures a fresh finalized head
and reads **both position balances and `messageQueue.bookStateFor({Sibling:1000})`
at that block**. The runtime's `message_count` is Polkadot JS `messageCount`;
it must be zero. A non-empty or unreadable book means `unknown`, never permission
to abandon. The budget defaults to 180 seconds; `--observation-timeout-ms`
accepts a positive integer (for example `900000`) and is recorded in evidence.
Exhausting any budget does not authorize a write.

| Verdict | Evidence | Next action printed (read-only) |
| --- | --- | --- |
| `sell_executed_unobserved` | One topic-bound, exact-par AAVE 1003→22 swap within the existing accrual ceiling | Resume `stage-recall`; its normal guards still apply |
| `sell_not_executed` | No topic-bound swap or aUSDC debit in processing blocks, exact-topic successful `Processed` from Sibling 1000, empty Asset Hub book, intact position in both balance views | Preview `stage-recall --abandon-unexecuted-sell` |
| `unknown` | Anything else | `status`, then human review; no abandon |

The `messageQueue.Processed.id` must equal this lane request's XCM topic. A
different message delivered in the same block is not evidence. The historical
failure fixture is Hydration block **14870297**, hash
`0x91d5129009b239390e529e4c678731ba4a19a0394684333600e73bfcad95b405`.
Independent historical reads returned **10,215,087** raw aUSDC in both views:

- EVM `balanceOf(0x48DF881b65E682f05ac24DC8f668A8938225E973)` on aToken
  `0x2ec4884088d84e5c2970a034732e5209b0acfa93`, at that block number;
- Substrate `CurrenciesApi.freeBalance(1003, 0x48df881b65e682f05ac24dc8f668a8938225e973f6ebfce08cd5a3835491e7f3)`
  at that finalized block hash. **`tokens.accounts(..., 1003)` is not the
  aToken balance**: the ERC20-backed asset uses CurrenciesApi.

Abandon re-reads the evidence and the Hub records at invocation, even after a
successful dry-run. It requires wrapper Pending Withdraw + bitmap exactly 4,
lane Pending/unsettled with requested and pending shares equal to the staged
shares, the exact pool/venue/lane/reverse-request bindings, and both aToken
balances equal and at least the staged shares. Any topic-bound `Swapped*`,
movement or uncertain read refuses abandonment. It does not dispatch a leg
or require the expired sell deadline to be extended.

The only abandonment write is the lane's:

```text
settleRequest(laneRequestId, Failed, 0, 0, 0, observationBlockHash, bytes32("SELL_NOT_EXECUTED"))
```

The fifth argument is **zero recovery**, not the observed aUSDC. Nothing left
the position. The intact balance remains in `totalAssets`/`totalShares`;
putting it in the recovery slot too would double-count it and cause the venue
adapter to mask Failed as Pending. Both actual balances and their Hydration
observation block/hash remain in the run record; `remoteRef` is that block hash.

The shared #1393 wait helper bounds confirmation at 60 seconds, probes write
runners for a receipt before failing, and emits the transaction hash/nonce.
There is no rebroadcast loop. A timeout preserves the broadcast hash in the
failure evidence; inspect that same transaction and live state before any
next action. Postconditions require wrapper/lane Failed, pending shares and
recovery zero, bitmap still 4, and unchanged lane total assets/shares.

Pool settlement then clears only the recall, with zero returned. Evidence
prints `postcondition.failedRecallCostBasis.beforeRaw` and `afterRaw`; they
must agree. Global principal, buffer, total assets, the active deployment and
its principal/recalled/written-off fields must remain unchanged. No write-off
or principal-return event is allowed.

## Three operator commands, in order

Run from `/app` **inside the deployed backend container**, using its existing
Roles Anywhere/KMS configuration and RPC env. These commands are for cycle-2
recall **2**, not the canonical (v2.2) pool. For **each** command, first omit
`--commit --use-kms`, review the dry-run, then use the committed form below.
Save command stdout and stderr with the ceremony record. Do not run all three
blindly as a shell batch; check the postconditions between commands.

1. Abandon the unexecuted sell (the CLI request ID is the **pool adapter**
   request; the lane ID is discovered and verified from chain):

```sh
node scripts/ops/pool-venue-dispatch.mjs stage-recall \
  --profile mainnet \
  --pool 0x9B35A102d656Fb86d798aF81959e09961DEc28E0 \
  --request-id 0x78db2e491eaf3d0310df7aabbcdcf9abdebccf19ff9e71ef748a7c274b99c31d \
  --recall-id 2 --abandon-unexecuted-sell \
  --observability-url 'http://127.0.0.1:8787/monitor/deposit-pool?pool=0x9B35A102d656Fb86d798aF81959e09961DEc28E0' \
  --expected-signer 0x5a6836c6D4d293F6E5377E6c28054F4171915813 \
  --evidence-out /tmp/recall-2-unexecuted-sell.json \
  --commit --use-kms
```

2. Settle the Failed pool recall. Verify zero returned, active recall 0,
   deployment 2 still active, and equal printed cost basis:

```sh
node scripts/ops/pool-venue-ceremony.mjs settle \
  --profile mainnet \
  --pool 0x9B35A102d656Fb86d798aF81959e09961DEc28E0 \
  --recall-id 2 \
  --expected-signer 0x5a6836c6D4d293F6E5377E6c28054F4171915813 \
  --commit --use-kms
```

3. Create a fresh recall for the same managed principal (not the accrued
   aUSDC balance). Read its actual recall ID and adapter request ID from the
   resulting `VenueRecallRequested` evidence; do not assume ID 3:

```sh
node scripts/ops/pool-venue-ceremony.mjs recall \
  --profile mainnet \
  --pool 0x9B35A102d656Fb86d798aF81959e09961DEc28E0 \
  --deployment-id 2 --assets 10193881 \
  --expected-signer 0x5a6836c6D4d293F6E5377E6c28054F4171915813 \
  --commit --use-kms
```

Step 3 creates a request; it does **not** stage or dispatch XCM. Follow the
existing gated `stage-recall` procedure with the new IDs. The default lane
nonce now follows the recall ID, so an equal-sized retry gets a fresh wrapper
identity. All existing quote, fee, postage, pause and deadline guards remain.
The default staging margin remains six hours before the original deployment
`returnBy` (cycle 2: **2026-09-23T03:50:06Z**, default margin ends
**2026-09-22T21:50:06Z**). The ratified urgent follow-up permits an explicit
`stage-recall --dispatch-margin-seconds 3600` override, but never less than one
hour. The effective/default margin and override flag are logged in the run
record, and both preflight and commit recheck it. Deposit staging cannot use
this flag. With 3600, cycle 2's staging cutoff is **2026-09-23T02:50:06Z**;
the contract deadline itself is unchanged. Abandon and Failed settlement
remain usable afterwards; no override bypasses a contract deadline.

## Retry economics and design constraints

One observed silent failure cost about **0.1 DOT** for the three Hub
transactions plus **0.0217 USDC** in Hydration execution fees. These are the
packet's measured example, not fixed fees or a future quote; abandoning and
settling also require Hub gas.

Both recall creation and staging enforce **three total recall attempts per
deployment**, counting chain `venueRecalls` rather than an editable local
counter. The count includes the original attempt and conservatively includes
unstaged cancellations; process restarts, a different nonce or a smaller
requested amount do not reset it. Attempt 4 stops with `recall_retry_cap` for
human review. Abandonment and settlement remain available at the cap. This is
an operator-tool guard, not a new on-chain limit.

There is **no minimum-output-slack option** for this deployed pair.
`stageRecall` requires `minimumOutput == requestedAssets`, on both the v2.1
and v2.2 pair artifacts. A nonzero `--min-out-slack-raw` is explicitly refused
with that rule; zero is accepted as a no-op. The exact-par minimum was not
the cause found by the replays. Any different minimum law needs a separately
ratified future adapter revision, as does changing the wrapper's deliberate
already-dispatched-bit no-op. No cause for the intermittent inner Transact
failure is asserted by this patch.

## Regression pins

`scripts/ops/recall-sell-unwind.test.mjs` covers all three classifications,
canonical dispatch/topic evidence, independent dual balance reads, each
abandon gate, exact canonical ABI encoding, bounded-wait failure evidence,
postconditions, command-level refusal/re-read behavior, Failed pool settlement,
chain-derived retry caps at both command entry points, and nonzero slack refusal.
`test/RecallSellUnwind.t.sol` proves the exact wrapper finalize call and unchanged
live position on the real lane/wrapper implementations, including why recording
the intact balance as recovery is wrong. The backend-image inventory pin ensures
the new helper ships with both drivers.
