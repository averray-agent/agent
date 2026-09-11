# Pool page: recorded history and attribution

Implements `PACKET_POOL_PAGE_SAYS_NOTHING_HAPPENED.md` at `93fff54b`.
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
  a second historical log scan. Attribution calculations are unchanged.
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

No subsidy was attested and no admin credential was obtained. There is a
pre-existing mismatch in the packet's expected post-attestation readback:
`buildYieldAttribution` reports venue-earned as marked assets minus cost
basis **only while principal is deployed**, otherwise zero. With the packet's
current inputs, attesting 600000 raw alone would produce operator-added
600000, venue-earned 0, and unattributed **-51765**, not venue-earned -51765
and unattributed 0. Changing that accounting is outside this copy PR. The
cycle history independently discloses the measured cost in either case.

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
