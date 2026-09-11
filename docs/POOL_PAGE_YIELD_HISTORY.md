# Pool page: recorded history and attribution

Implements `PACKET_POOL_PAGE_SAYS_NOTHING_HAPPENED.md` at `93fff54b`, with
the separate realised-attribution follow-up at `94204e7c`.
Backend and public/operator pool presentation only. No contract, funds,
consent, deployment, or operator-attestation action.

## Truth boundaries

- `/pool` and pool observability share `yieldStatusText` and
  `yieldAttributionText`. Zero principal plus readable, closed history becomes
  `home_after_cycle`; a proven empty ledger alone becomes `not_yet_earning`.
  Missing/inconsistent history becomes `history_unavailable`, without closing
  withdrawals. Positive principal preserves the existing `earning` text.
- The contract's next/active deployment IDs determine the count. The newest
  `venueDeployments(id)` and `venueWrittenOffPrincipalAssets(id)` are read at
  the snapshot block. Actual `VenuePrincipalReturned` cash-return events are
  reconciled to recalled principal; they are not capped at principal when a
  surplus returns. Event blocks supply UTC dates. A missing write-off event
  means no write-off date, not a fabricated date or a zero write-off.
- The existing complete pool event reader is shared with attribution to avoid
  a second historical log scan. The original copy PR left attribution math
  unchanged; the follow-up below includes realised venue results.
- A share price above principal is not proof of yield. Unattributed gains,
  operator additions, and negative venue results each get explicit copy.
  Operator additions are described as **attested against chain evidence**:
  the operator's ledger itself is not an on-chain or exhaustive attestation.
- Deposit-benefit figures are served from the runtime vesting and priority
  policy. Directory listing is also a priority qualifier; the text does not
  imply that a deposit guarantees eligibility or buys a reward. No new envs.
- Marketing fetches the figures/sentences at page load, not build time. The
  legacy card follows its served deployment state. The operator surface uses
  the same sentences and also displays the unattributed amount.
- The registered discovery mirror was regenerated for the plain-language
  capital statement; generated app/site exports are not part of the PR.

## Read-only chain verification

The new reader was checked against public Hub RPC at block **20517831**,
pool `0x9B35A102d656Fb86d798aF81959e09961DEc28E0`:

- Deployment **1**, one completed cycle.
- **9.980137 USDC** out: block **20290751**, **2026-09-05T10:52:24Z**,
  transaction `0xcf3064ebd23fdd53635a216e6e4eca4c393b27ece6e6023847ec5c0cb977b849`.
- **9.928372 USDC** back: block **20422937**, **2026-09-08T20:14:00Z**,
  transaction `0x6ea0e58bac621fe3f60eeea3fbf135c06da6b51f98ec3c644bc8eaa39b71cf44`.
- Difference and persisted write-off: **0.051765 USDC**. The public RPC's
  history returned no write-off event, so its date remains unavailable.

The public RPC briefly lagged the API's snapshot head (`hash not found`);
the successful verification used an older named block. This is a read-only
check, not proof that this PR has deployed.

## Operator step remains Pascal's

No subsidy was attested and no admin credential was obtained. The original
copy PR (#1366) left venue-earned as marked assets minus cost basis only while
principal was deployed, otherwise zero. Attestation alone therefore left the
realised cost in unattributed. The packet corrected that expected readback and
assigned the accounting change to a separate follow-up.

## Follow-up: realised venue attribution

At the snapshot block, `venueEarned` now equals:

```text
sum(VenuePrincipalReturned.returnedAssets - principalReduction)
  - sum_id(venueWrittenOffPrincipalAssets(id))
  + (venueMarkedAssets - deployedPrincipal, only while principal is deployed)
```

Returns from all cycles in the bounded journal and write-offs from every
contract deployment contribute, not just the latest cycle. Returned principal
is not profit. `cumulativeCapital` is unchanged:
deposits plus operator principal minus withdrawals, excluding venue records.
An unreadable outstanding mark still makes attribution unavailable.

With the cycle-1 return events, getter write-off of 51765 (even with no
write-off logs), and 600000 raw operator contribution attested, the fixture
reads venue-earned **-51765**, operator-added **600000**, unattributed **0**.
Without attestation, venue-earned remains **-51765** and the full contribution
of **600000** remains unattributed. A completed profitable cycle attributes only its returned
surplus to venue-earned. Wallet splits keep the same signed pool-level ratio,
rounding and explicit approximation disclaimer; this is not holding-period
attribution. No attestation, contract call that writes state, env change or
production action is part of this follow-up.

The [#1369 gate](https://github.com/averray-agent/agent/pull/1369#issuecomment-5633767192)
verified that cycle 1's write-off was a treasury multisig `revive.call` from a
Substrate origin. Its absence from `eth_getLogs` is expected on every provider,
not a provider gap. #1367 therefore left this loss unattributed; the corrected
reconciliation below uses the contract getter as authoritative. The fixture
results are not a claim that Pascal has attested the contribution.

The three `realised venue pin` tests cover cycle 1, profitable returns and the
shared wallet ratio. Further regressions cover ABI-decoded logs through the
public `/pool` route and copy, cache reuse/extension, multiple returns and
write-offs, snapshot bounds, unchanged capital basis, missing evidence,
offsetting gains/losses at zero NAV gain, and an unreadable live mark.

### Write-off reconciliation follow-up

Before attribution, the reader enumerates deployment IDs from the contract's
`nextVenueDeploymentId` and reads `venueWrittenOffPrincipalAssets(id)` for
each one, all at the attribution snapshot block. This includes deployments
entirely absent from the event journal. Each getter must be at least that
deployment's sum of `VenueLossWrittenOff.assets`; the journal may be a subset
because Substrate-origin write-offs are absent from the Ethereum RPC log view.
Equal global totals cannot hide journal-over-getter on an individual deployment.
This adds one count read plus one getter read
per deployment, without adding a historical log scan. Cached journal reads
are reconciled again at the requested block, including older snapshots.

Missing or partial write-off logs are valid: attribution deducts the full
getter sum exactly once, never the getter plus the journal. Return surplus
still comes from `VenuePrincipalReturned` events. Getter totals are passed as
separate evidence, not invented events or dates, and the raw journal cache is
unchanged. The pure arithmetic helper retains journal-only support for callers
without contract evidence; the production reader always supplies the getter
total (including zero), or fails unavailable.

Only journal-over-getter is an inconsistent write-off amount. That case, or an
unreadable getter, returns `status: unavailable`,
`reason: realised_venue_unavailable`, with an explicit `realisedVenueResult`
status/reason. Mismatches retain the deployment, block and both amounts. No
scalar venue gain, residual or wallet ratio is published from contradictory
or unreadable evidence. No loss is inferred from NAV.

The cycle-history reader consumes the unchanged raw journal and applies the
same getter-authoritative rule to its latest record, without inventing an event
date. `/pool` and withdrawals remain available when attribution is not.
`cumulativeCapital`, wallet arithmetic, contracts, envs and operator authority
are unchanged.

`write-off production pin — getter 51765 and journal zero yield venue-earned
-51765` exercises the public route before/after attestation and the wallet
ratio. The excess pin retains journal **60000** / getter **51765** as unavailable;
the returned-surplus pin attributes profit from EVM return logs. Further tests
cover partial/matching logs without double counting, missing deployments,
per-deployment totals, cache/block boundaries, unreadable getters and an empty
contract ledger.

## Regression pins

1. `pool history pin 1` — actual ABI-decoded ledger/events through the door and
   observability, including changed deployment ID, count, amounts and dates.
2. `pool history pin 2` — no stale measurement promises or insider vocabulary.
3. `pool history pin 3` — unattributed, operator-added and negative venue branches.
4. `pool history pin 4` — no baked figures, including the new attribution line;
   the built content gate also rejects a `1.027463` mutation.
5. `pool history pin 5` — legacy `not_deployed` copy, mutated to deployed/unknown.

Additional tests cover missing history, incomplete returns, unclosed records,
positive returned surplus, missing write-off logs, dynamic benefit policy, and
both clients consuming the API-owned sentences.

All seven applied mutation drills were killed (exit 1) and restored: old
constant, forbidden phrase, each of the three attribution branches, baked
share-price literal, and legacy venue-position sentence. Local verification
also includes the backend suite, ops suite, app tests/typecheck/export build,
marketing build/content gate, and a labelled fixture browser check with no
console errors and a working deposit-terms anchor.
