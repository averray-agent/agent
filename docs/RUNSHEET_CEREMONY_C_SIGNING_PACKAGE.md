# Ceremony C — §4 signing package (seven `revive.call` blobs, 2-of-3 multisig)

Built 2026-09-17 09:16Z from the deployed addresses (evidence:
`docs/evidence/ceremony-c-preflight-2026-09-16.md`, §1 + §2). Every blob was
encoded with `@polkadot/api` `.method.toHex()` against Asset Hub, decoded back
and field-checked (dest, value 0, weights, deposit, data). Weights identical to
Ceremony B: `refTime 20e9 / proofSize 800 000 / storageDepositLimit 0.5 DOT`
(prefix `…000700c817a80402d430000700f2052a01…`).

Signer: policy-owner multisig `14LA8vJD8JeQYMRd5yhiw3hxD7CK5txhfL9GSNPjzLRKc3YK`
(2-of-3: vault `1mhf9yyY…`, nova `121pEreu…`, ledger `16UCRMPz…`; record
`deployments/mainnet-multisig-owner.json`). Its H160 is
`0x01E6eed856e989201F4FF6346E18EAb7e46C874C` = keccak256(accountId32)[12:],
re-derived 2026-09-17 09:40Z, and `policy.owner()` reads exactly that; pool
v2.2's setters gate on `policy.owner()`. Account state at 09:40Z: 6.0009 DOT
free, no pending multisig calls (so the 09-16 test remark is either done or
never started — M1 is low-stakes and doubles as the live test).
Nova Spektr initiates (paste **Call data**), Vault countersigns; before the
second signature compare the **call hash** Vault shows with the one below.

Pre-state at 09:16Z: `poolV22.venueAdapter()` = `0x0`, `poolV22.aggregatorAdapters(aggV22)` = false,
`wrapper.strategyAdapter(AAC_COMMITTED_HYDRATION_V22)` = `0x0`, `wrapper.dispatchPaused()` = false,
both lanes' `pendingDepositAssets`/`pendingWithdrawalShares` = 0.

## Addresses in play

| role | address |
|---|---|
| policy (M1 target) | `0x226F14252A98BD2eA140271647De20132F09AF20` |
| strategy registry (M2) | `0x38af424415c1CE033e5Cee01f94551CDb824D404` |
| pool v2.2 (M3, M7) | `0x3A2dd08F85009474117CaFC476b6629AE04fB2A9` |
| wrapper (M4, M5, M6) | `0xF20b35A3f85EC864127B551ce8A64446fC0ed2Bc` |
| locked aggregator v2.2 (embedded in M1–M3) | `0x1b3f9B45e0B8672A4FF95Caf67Bf4dbEa385455f` |
| lane v2.2 (embedded in M5) | `0xd3d76AB8f4642B54C04Be8091F01Be66e91a1aa1` |
| venue adapter v2.2 (embedded in M7) | `0x2894667cF9A54D94695Ca168B81154aA50955722` |

## Order and timing

M1 → M2 → M3 any time. **M4, M5, M6 in one sitting** (M4 pauses the wrapper the
cycle-2 recall needs on 2026-09-22; both pending counters read 0 now, so the
window is open). M7 in the same session. **09-21 rule:** if M6 is not
countersigned by 2026-09-21 12:00Z, the cycle-2 recall waits for M6 — never
`recall` against a paused wrapper.

## The seven calls

### M1 — `policy.setApprovedStrategy(aggregatorV22, true)`
- to `0x226F14252A98BD2eA140271647De20132F09AF20`, value 0
- EVM data `0x12a7bd4c0000000000000000000000001b3f9b45e0b8672a4ff95caf67bf4dbea385455f0000000000000000000000000000000000000000000000000000000000000001`
- **Call data** `0x5a01226f14252a98bd2ea140271647de20132f09af20000700c817a80402d430000700f2052a01110112a7bd4c0000000000000000000000001b3f9b45e0b8672a4ff95caf67bf4dbea385455f0000000000000000000000000000000000000000000000000000000000000001`
- **Call hash** `0xcf98228c46f0ad7e2f8cea1a19574b406678e10b7ed7644da79999d57c3ef19d`
- post-read: `policy.approvedStrategies(0x1b3f9B45…)` = true

### M2 — `registry.registerStrategy(aggregatorV22)`
- to `0x38af424415c1CE033e5Cee01f94551CDb824D404`, value 0
- EVM data `0xf5c2c4300000000000000000000000001b3f9b45e0b8672a4ff95caf67bf4dbea385455f`
- **Call data** `0x5a0138af424415c1ce033e5cee01f94551cdb824d404000700c817a80402d430000700f2052a0190f5c2c4300000000000000000000000001b3f9b45e0b8672a4ff95caf67bf4dbea385455f`
- **Call hash** `0xf15d1365ec17e93f843826792cfb73aae67e298f9ed3374dc3bcadf2c37d72a1`
- post-read: `registry.getStrategy(AAC_LOCKED_DEPOSIT_POOL_V22)` → adapter `0x1b3f9B45…`, active (no separate `setStrategyActive` — A4 lesson)

### M3 — `poolV22.setAggregatorAdapter(aggregatorV22, true)`
- to `0x3A2dd08F85009474117CaFC476b6629AE04fB2A9`, value 0
- EVM data `0x693478c60000000000000000000000001b3f9b45e0b8672a4ff95caf67bf4dbea385455f0000000000000000000000000000000000000000000000000000000000000001`
- **Call data** `0x5a013a2dd08f85009474117cafc476b6629ae04fb2a9000700c817a80402d430000700f2052a011101693478c60000000000000000000000001b3f9b45e0b8672a4ff95caf67bf4dbea385455f0000000000000000000000000000000000000000000000000000000000000001`
- **Call hash** `0xefced5abc14bb79b5431b3c6a4c23470d5ff88f326ca65e0fd2182a8edbdc08b`
- post-read: `poolV22.aggregatorAdapters(0x1b3f9B45…)` = true

### M4 — `wrapper.setDispatchPaused(true)` — only with both lanes' pending counters at 0
- to `0xF20b35A3f85EC864127B551ce8A64446fC0ed2Bc`, value 0
- EVM data `0x1f59d6fb0000000000000000000000000000000000000000000000000000000000000001`
- **Call data** `0x5a01f20b35a3f85ec864127b551ce8a64446fc0ed2bc000700c817a80402d430000700f2052a01901f59d6fb0000000000000000000000000000000000000000000000000000000000000001`
- **Call hash** `0x0d7c57e3561b166e9c9d5135db95540585c09c80da57d1e71a79e56e18d0f5ff`
- post-read: `wrapper.dispatchPaused()` = true

### M5 — `wrapper.setStrategyAdapter(AAC_COMMITTED_HYDRATION_V22, laneV22)` — needs paused
- to `0xF20b35A3f85EC864127B551ce8A64446fC0ed2Bc`, value 0
- EVM data `0xeda96b664141435f434f4d4d49545445445f485944524154494f4e5f5632320000000000000000000000000000000000d3d76ab8f4642b54c04be8091f01be66e91a1aa1`
- **Call data** `0x5a01f20b35a3f85ec864127b551ce8a64446fc0ed2bc000700c817a80402d430000700f2052a011101eda96b664141435f434f4d4d49545445445f485944524154494f4e5f5632320000000000000000000000000000000000d3d76ab8f4642b54c04be8091f01be66e91a1aa1`
- **Call hash** `0x5ced67139d367c54f07b74d67d5600bc47354925c3e3f4e15d9c352de1da689c`
- post-read: `wrapper.strategyAdapter(0x4141435f434f4d4d49545445445f485944524154494f4e5f5632320000000000)` = `0xd3d76AB8…`; `strategyAdapter(AAC_IDLE_HYDRATION_V1)` still `0x2E01Bff9…`

### M6 — `wrapper.setDispatchPaused(false)` — same sitting as M4
- to `0xF20b35A3f85EC864127B551ce8A64446fC0ed2Bc`, value 0
- EVM data `0x1f59d6fb0000000000000000000000000000000000000000000000000000000000000000`
- **Call data** `0x5a01f20b35a3f85ec864127b551ce8a64446fc0ed2bc000700c817a80402d430000700f2052a01901f59d6fb0000000000000000000000000000000000000000000000000000000000000000`
- **Call hash** `0xdba64717229b6d30ee5213e89b9143fd6670e999fe0eb9ff734da1dd3c24e535`
- post-read: `wrapper.dispatchPaused()` = false

### M7 — `poolV22.setVenueAdapter(adapterV22)` — SET-ONCE; later changes only via `proposeVenueAdapter` (7-day timelock)
- to `0x3A2dd08F85009474117CaFC476b6629AE04fB2A9`, value 0
- EVM data `0x5711cd380000000000000000000000002894667cf9a54d94695ca168b81154aa50955722`
- **Call data** `0x5a013a2dd08f85009474117cafc476b6629ae04fb2a9000700c817a80402d430000700f2052a01905711cd380000000000000000000000002894667cf9a54d94695ca168b81154aa50955722`
- **Call hash** `0xd8c5c0642ad5f9add243ce7a3def6263191099144d1d43cc3efdb736ef724b18`
- post-read: `poolV22.venueAdapter()` = `0x2894667c…`

## Eyeball rules (before the second signature)

- M3 and M7 target `0x3a2dd08f…` (v2.2), never `0x9b35a102…` (v2.1).
- M1–M3 embed `1b3f9b45…` (aggregator v2.2); M5 embeds `d3d76ab8…` (lane v2.2); M7 embeds `2894667c…` (adapter v2.2).
- M4/M6 data ends in `…01` / `…00` respectively. Value 0 everywhere.
- The call hash Vault displays must equal the one listed. If Nova shows a
  different hash, stop; do not sign.

## Handback

Per call: extrinsic hash + timepoint (block, index) of the final approval, and
the post-read. Claude re-reads every post-state from chain before §5b/§6.
