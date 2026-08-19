# Ceremony runsheet — Pool v2 yield epoch 2 (+ v1 lane recall)

- **Status:** NOT SCHEDULED. The v1 recall in §A is ratified; epoch-2 sizing in
  §B remains deliberately unset.
- **Operator:** Pascal signs. **Gate:** Claude between every authority change
  and every irreversible XCM leg.
- **Reconciliation rule:** every raw unit is principal, operator yield,
  transfer fee, remote execution fee, or an identified refund/residue. The
  unexplained balance must be zero.

---

## §A — Recall the retired v1 Hydration lane · RATIFIED 2026-08-19

### Why this is a two-authority ceremony

The initial KMS-only instruction was wrong and is withdrawn. The phase-1 owner
entry is `onlyOwner` at `HydrationUsdcAdapter.sol:202`, and its call to
`_stageWithdraw` binds the successful/recovery recipient to `msg.sender` at
line 203. The deployed V22-shaped ABI preserves the same law at
`HydrationUsdcAdapterV22.sol:225-227`. The owner is the 2-of-3 treasury
multisig, while `settleRequest` belongs to `TreasuryPolicy.strategySettler`, the
KMS signer. Consequently:

1. the multisig must stage the request;
2. KMS may dispatch and settle, but proceeds return to the multisig;
3. the multisig transfers the exact observed proceeds to KMS;
4. KMS deposits them into AgentAccountCore with the existing funding script.

Trying to collapse those authorities either reverts or sends the money to the
wrong authority.

### Fixed subjects and opening facts

| Fact | Ratified value |
| --- | --- |
| v1 adapter | `0x96091d4477Fe37E79557276d63883bBbbdE73159` |
| all v1 shares / recorded book | `10,000,001` raw USDC |
| pool lane — must not move | `0x88eE70277E486136676c0b50Ed9b7D7A1a31371f` |
| wrapper | `0xF20b35A3f85EC864127B551ce8A64446fC0ed2Bc` |
| owner multisig | `0x01E6eed856e989201F4FF6346E18EAb7e46C874C` |
| KMS strategy settler | `0x5a6836c6D4d293F6E5377E6c28054F4171915813` |
| Hydration holder | `0x48DF881b65E682f05ac24DC8f668A8938225E973` (`0x48df…e7f3` AccountId32) |
| aUSDC | `0x2ec4884088d84e5c2970a034732e5209b0acfa93`, chain `222222`, `https://rpc.hydradx.cloud/` |
| opening observation (2026-08-19) | `14.96xxxx` aUSDC across v1 + pool lanes |

Leg A does not accept a treasury-context argument. It reads the immutable
production deposit fixture for request
`0xeaa4d500…7767`, then derives the context from
`adapter.getAdapterRequest` and re-proves the same account, recipient, settled
shares, strategy, adapter and amounts through `wrapper.getRequest`. Any mismatch
stops before SCALE is emitted.

### Leg A — multisig stages all v1 shares (batch group 5)

Choose a fresh uint64 nonce and a real future dispatch deadline. Generate the
read-only Nova packet:

```sh
node scripts/ops/build-v1-lane-recall-multisig.mjs stage \
  --profile mainnet \
  --nonce <FRESH_UINT64_NONCE> \
  --dispatch-deadline <FUTURE_UNIX_SECONDS> \
  --packet-out /tmp/v1-recall-leg-a.json
```

The packet prints decodable EVM calldata, the exact
`revive.call(...).method.toHex()` SCALE, and its blake2 call hash. Its fixed
Nova envelope is `refTime=4,000,000,000`, `proofSize=100,000`,
`storageDepositLimit=1,000,000,000`. Insert that `revive.call` unchanged as
**§8 batch group 5**. Both signers compare the displayed call hash before the
countersign. After execution, take `requestId` from the packet and re-read the
pending adapter/wrapper request before Leg B.

Gate: `pendingWithdrawalShares == 10,000,001`, the request is owner-bound, and
the pool lane fingerprint is unchanged.

### Leg B — KMS dispatches, observes and settles

Dry-run first. It reads the opening aUSDC balance from Hydration, asserts the
KMS address is a live `strategySettler`, proves the all-shares AAVE 1003→22
route, pins the pool-lane fingerprint, and runs the exact withdraw-sell message
through the existing v2.2 dry-run gate.

```sh
node scripts/ops/v1-lane-recall.mjs \
  --profile mainnet \
  --request-id <LEG_A_REQUEST_ID> \
  --expected-signer 0x5a6836c6D4d293F6E5377E6c28054F4171915813 \
  --evidence-out /tmp/v1-recall-leg-b.jsonl
```

Claude gates the dry-run. Commit uses the same request and append-only evidence
file:

```sh
node scripts/ops/v1-lane-recall.mjs \
  --profile mainnet \
  --request-id <LEG_A_REQUEST_ID> \
  --expected-signer 0x5a6836c6D4d293F6E5377E6c28054F4171915813 \
  --evidence-out /tmp/v1-recall-leg-b.jsonl \
  --commit --use-kms
```

The driver checkpoints immediately after each dispatch. If it restarts with
bitmap `4`, it observes the prior sell and proceeds to home; with bitmap `12`,
it observes the prior home arrival and settles. It never resends a dispatched
leg. If the checkpoint is unavailable, stop and reconstruct the observation
range; do not convert missing evidence into a retry.

Leg-B completion gates:

- v1 `totalAssets`, `totalShares`, and `pendingWithdrawalShares` are all zero;
- request-bound Hydration `Broadcast.Swapped*` proves the 1003→22 unwind;
- the pool lane's assets, shares and pending-withdraw value are byte-exact to
  the opening snapshot;
- the multisig USDC delta equals the observed wrapper home arrival;
- principal, AAVE exit accrual, sell fee, home fee, and remote residue reconcile
  to zero unexplained raw units. Accrual is operator yield on operator capital,
  never depositor yield.

### Leg C — multisig transfers the exact arrived amount to KMS

Only after Leg B has a `phase: "completed"` checkpoint:

```sh
node scripts/ops/build-v1-lane-recall-multisig.mjs transfer \
  --profile mainnet \
  --leg-b-evidence /tmp/v1-recall-leg-b.jsonl \
  --packet-out /tmp/v1-recall-leg-c.json
```

The builder reads the live multisig USDC balance and subtracts Leg B's pinned
opening balance. It emits nothing unless that exact delta equals the proved
home arrival; in particular, it refuses when the multisig balance is below the
expected proceeds. The emitted `USDC.transfer` amount is the observed delta,
not `10,000,001` or another assumed amount. Leg C is its own small Nova
session after XCM settlement; compare its blake2 call hash before countersign.

### Leg D — deposit with the existing script, unchanged

Read `decoded.amount` from `/tmp/v1-recall-leg-c.json`; after Leg C executes,
dry-run and then commit the existing driver unchanged:

```sh
node scripts/ops/fund-signer-usdc-deposit.mjs \
  --profile mainnet \
  --amount <LEG_C_DECODED_AMOUNT_RAW> \
  --expected-signer 0x5a6836c6D4d293F6E5377E6c28054F4171915813 \
  --use-kms

node scripts/ops/fund-signer-usdc-deposit.mjs \
  --profile mainnet \
  --amount <LEG_C_DECODED_AMOUNT_RAW> \
  --expected-signer 0x5a6836c6D4d293F6E5377E6c28054F4171915813 \
  --use-kms --commit
```

Final gate: `AAC.positions(KMS, USDC).liquid` rises by exactly the Leg-C amount.
The end-to-end ledger must still have zero unexplained raw units.

### Funds-in-flight law and abort table

| Observation | State | Required action |
| --- | --- | --- |
| Leg A reverts | nothing moved | Stop; rebuild the packet from fresh state |
| Withdraw-sell dispatched, no remote swap yet | funds in flight | Observe the same request; never dispatch sell again |
| Swap observed, home not dispatched | remote USDC/float | JIT-gate the home leg, then dispatch once |
| Home dispatched, no wrapper arrival yet | funds in flight | Wait for observation or timeout/recovery; never dispatch home again |
| Pool-lane fingerprint changes | **incident: wrong lane may be touched** | Stop immediately, preserve evidence, page Claude |
| Any ledger remainder | reconciliation failed | No Leg C; resolve every raw unit first |

The pool-lane movement row is the incident-class failure. A delayed XCM leg is
the asynchronous design and must not be turned into a double dispatch.

---

## §B — Epoch-2 yield legs · TO BE SET WHEN SCHEDULED

Deliberately empty. Deployment size, `returnBy`, notice tier and observability
gates depend on live pool state on ceremony day.
