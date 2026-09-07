# RUNSHEET — Write off cycle 1's entry friction and make the subsidy visible

Three steps. **Step 1 is a 2-of-3 multisig ceremony** (Nova Spektr initiates,
Vault QR countersigns). Steps 2 and 3 are operator actions. Doing step 1 alone
reopens deposits but leaves NAV per share at 0.997495 — do all three, close
together.

## Why now, before the recall

Deposits are refused today: `venueMark: shortfall_exceeds_tolerance`,
`depositsBlocked: true`. Cost basis is 9.980137 while the adapter reports
9.930137 managed — a 0.050000 gap against a 0.02 tolerance (10 bps of total
assets). The pool has been closed to new depositors since the dispatch on
09-05 and stays closed for five more days if this waits for the recall.

The gap is **not** a venue loss. It is the entry budget: 0.021702 actually
spent on fees (funding 627 + sell 21,075) and 0.028298 parked as pool float on
Hydration, which is recoverable later. Writing it off states NAV honestly today;
the operator top-up in step 2 puts the value back and step 3 labels it as
operator-added rather than letting the API keep attributing −0.05 to
`venueEarned`.

## The recall math still works after this — checked, not assumed

`_recordVenueReturn` caps the reduction: `principalReduction = min(returnedAssets,
outstanding)`, and `_outstandingVenuePrincipal = principalAssets −
recalledPrincipalAssets − writtenOffPrincipalAssets`.

After step 1: `writtenOff[1] = 50000`, so `outstanding = 9.930137` and
`venuePrincipalCostBasis = 9.930137`. When the recall settles with ~9.93 returned,
`principalReduction = min(received, 9.930137)` drives cost basis to exactly **0**,
and any accrued yield above outstanding lands in the buffer as clean gain. No
underflow on either path. `_maybeCloseVenueDeployment` leaves deployment 1 active
because outstanding stays non-zero, so the recall is unaffected.

---

## Step 1 of 3 — multisig: write off 0.050000

**Verified before this runsheet was written:** `adapter.lossReporter()` =
`0x01E6eed856e989201F4FF6346E18EAb7e46C874C`, which is the manifest `owner` /
`treasuryReserve` multisig; `adapter.pool()` matches v2.1; and a static call of
this exact calldata **from that address succeeds**.

Paste into Nova Spektr's **Call data** field:

```
0x5a019b35a102d656fb86d798af81959e09961dec28e0000700c817a80402d43000029435771101e35f86dc0000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000c350
```

`callHash` `0x2b54e8b4778df3c7799b9fca91c9467e25983f41b46b6411c21d4c62ed5cf806` · 107 bytes.

**Verify on the device before countersigning — decoded round-trip:**

| field | value |
|---|---|
| section.method | `revive.call` (pallet 90, call 1) |
| dest | `0x9b35a102…dec28e0` — DepositPool **v2.1** |
| value | `0` |
| gas limit | refTime **20,000,000,000** / proofSize **800,000** |
| storage deposit limit | `500,000,000` planck = 0.5 DOT (a *limit*, not a cost) |
| inner calldata | `0xe35f86dc…c350` |
| decodes as | `writeOffVenueLoss(deploymentId=1, assets=50000)` |

★ **The weight matters.** A note recording refTime 4e9 / proofSize 100k belongs
to a smaller call and **fails** for this one. 20e9 / 800k is the proven pair.
Nova's Call-data field wants this SCALE extrinsic hex, never raw EVM calldata.

Expect event `VenueLossWrittenOff(deploymentId=1, assets=50000, …)`.

**After step 1, before step 2:** `venuePrincipalCostBasis` 9.930137,
`totalAssets` 19.910274, share price 0.997495, `venueMark` **ok**, deposits
**open**. That price is correct, not a bug — it is the marked price the API has
been quoting all along. Keep the window to step 2 short anyway.

---

## Step 2 of 3 — operator: top up 0.050000 USDC

`bufferAssets()` is simply `token.balanceOf(pool)`, so a plain ERC-20 transfer
lands directly in the buffer.

- token: `0x0000053900000000000000000000000001200000`
- to: `0x9B35A102d656Fb86d798aF81959e09961DEc28E0`
- amount: `50000` (0.050000 USDC, 6 decimals)

```
transfer(0x9B35A102d656Fb86d798aF81959e09961DEc28E0, 50000)
```

Send from an **operator-controlled wallet**, signed by you. This is the subsidy
being paid; it must not come from the reward bank, which is worker payout money.
Which wallet funds it is your call and I have not chosen one.

After: `totalAssets` back to 19.960274, share price back to **1.000000**.

---

## Step 3 of 3 — attest it, so it reads as subsidy and not as venue loss

```bash
curl -sS -X POST https://api.averray.com/admin/deposit-pool/subsidies \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -H "content-type: application/json" \
  -d '{"txHash":"<STEP_2_TX_HASH>"}'
```

The route accepts **only** `txHash` (`admin-yield-subsidy-routes.js:8`); the
attesting wallet comes from auth.

Without this the API keeps reporting `venueEarned: −0.05, operatorAdded: 0` —
the pool page would say the venue lost money when the operator spent it on
friction. The ledger is explicitly `operator_attested` and cannot prove
completeness, because Hub USDC emits no Transfer logs; that caveat is already in
the payload and should stay.

## Verify all three

```bash
curl -s https://api.averray.com/pool | python3 -m json.tool | grep -A4 -E "venueMark|yieldAttribution|sharePrice"
```

Expect: `venueMark.status: ok`, `depositsBlocked: false`, share price
`1000000`, and `yieldAttribution.gain.operatorAdded` showing **0.050000** with
`subsidyLedger.entryCount: 1`.

## What this does not fix

`onboarding_waiver_inventory_below_minimum` is unrelated — that is free-tier job
supply, not pool accounting. And the 0.028298 parked on Hydration stays parked;
it returns on a later sweep and will show up as gain when it does.
