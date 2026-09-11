# PACKET — The pool page says nothing happened, invites a deposit, then says the deposit is pointless

Status: ready for implementation. One PR (backend copy + marketing page), plus
one operator step that fixes the biggest hole today without any code
(runsheet at the bottom). No contract change.

## Why it does not read as trustworthy (verified 2026-09-11 against the live page and API)

Every sentence below is served or rendered today.

1. **It says nothing happened.** `GET /pool` `yieldStatusText` (constant
   `DEPOSIT_POOL_YIELD_NOT_EARNING_TEXT`, `services/deposit-pool-yield-status.js:1`)
   still says venue deployment "is not scheduled" and round-trip friction "is
   currently being re-measured". The public record shows one full venue cycle
   **completed**: deployment #1 dispatched 9.980137 USDC on 5 Sep, recalled
   9.928372 on 8 Sep, and the 0.051765 difference — the measured round-trip
   cost — was written off by the operator on 9 Sep. The contract carries that
   record (`venueDeployments(1)`); the page pretends the measurement never
   happened. A reader who checks the chain finds the page behind reality.
2. **The share price is unexplained.** Assets per share reads 1.027463 next
   to "a deposit today earns nothing". `/pool` already carries the answer
   (`yieldAttribution.gain`: venueEarned 0, operatorAdded 0, **unattributed
   0.548235**) and the page does not show it. A 2.7 % gain with no stated
   source is exactly what a careful depositor distrusts. Today the honest
   sentence is "0.548235 USDC above principal is not yet attributed; an
   unattributed gain is not yield." After the operator step below it becomes
   "0.60 USDC added by the operator (attested, extrinsic …); the venue cycle
   cost 0.051765."
3. **Invite, then retract.** The hero says "Put capital behind your agent."
   and the card beside it says "A deposit today earns nothing." with the ghost
   button "See what membership changes" greyed out. Both sentences are true;
   placed together they read as a page that does not know what it is asking
   for. The honest structure is: what a deposit does *today* (a 48-hour
   vesting capital signal that raises open-exposure headroom and, once #1364
   is live, opens ≥ 1.0 USDC jobs thirty minutes early), then what it does not
   do (no yield today, one cycle ran, here is what it cost), then the risk line.
4. **Insider vocabulary.** "Flex is a membership", "capital-backed
   trust-and-capacity signal", "never catalogue reward entitlement". These are
   internal design terms (`core/deposit-pool-disclosure.js`, `capitalSignal`)
   leaking onto a page for strangers. Plain words: "a deposit raises how much
   open work your agent may hold at once; it never buys a reward."
5. **The legacy card contradicts itself.** "Existing depositor and venue
   position" with venue deployment "not deployed". `/transparency` says
   legacy: 14.836881 total, all buffer, `deployedStatus not_deployed`. Say
   "Earlier pool, closed to new deposits; existing depositors can withdraw;
   no venue position."

## The fix (one PR)

**Backend, `deposit-pool-yield-status.js`:** derive `yieldStatusText` from
state instead of a constant. Inputs already available to the door: deployed
principal (0 → home), the venue deployment records (count, last dispatch and
recall blocks/timestamps, principal out, principal back, written-off amount),
and `yieldAttribution.gain`. Emit:
- `home_after_cycle` when deployed principal is 0 and at least one deployment
  record exists: "Pool capital is home. {n} venue cycle(s) completed; the last
  sent {out} USDC out on {date} and received {back} USDC on {date}; the
  {diff} USDC difference is the measured round-trip cost. No cycle is
  scheduled; the operator decides each one." Numbers formatted from chain
  reads, never literals, and the sentence must not promise a reopening
  condition.
- `not_yet_earning` only when no deployment record exists.
- `earning` as today.
Add `yieldAttributionText`: when `unattributed > 0`, "…is not yet attributed; an
unattributed gain is not yield." When `operatorAdded > 0`, "…added by the
operator, attested on chain." When `venueEarned ≠ 0`, name it as venue result
including a negative one.

**Marketing `pool.astro`:** hero reordered per item 3, jargon replaced per
item 4, an assets-per-share line that renders `yieldAttributionText`, legacy
card per item 5, and the ghost button either works or goes. Every figure still
comes from `/pool` or `/transparency` at render time; nothing numeric in
markup (the public-record rule). The operator app pool surface reads the
same fields.

## Non-negotiables (each pinned by a test; I run the drills)

1. With a deployment record present and deployed principal 0, the text names
   the count, both amounts and the difference from the record. Mutation: emit
   the old constant — must fail.
2. The text contains none of: "not scheduled", "being re-measured",
   "trust-and-capacity", "reward entitlement", "Flex is a membership".
   Mutation: reintroduce one — must fail.
3. `unattributed > 0` renders the "not yield" sentence; `operatorAdded > 0`
   renders the operator sentence; a negative `venueEarned` renders as a cost,
   not hidden. Mutation: drop any branch — must fail.
4. No numeric literal in the marketing page markup for pool figures (the
   existing public-record check extends to the new line). Mutation: hardcode
   1.027463 — must fail.
5. The legacy card copy has no "venue position" while `deployedStatus` is
   `not_deployed`. Mutation: restore the old sentence — must fail.

## Operator step — do this today, no code needed

The 0.60 USDC top-up of 9 Sep is still "unattributed" because it was never
attested. It is on chain: block **20421344**, extrinsic index 3,
`assets.transfer(1337 → 14WWMVMGTHrUWxNW7H5f514t19hvTBvWcbGXXUQsMkjFgTTX, 600000)`,
signed by 121pEreu4kTNBiyG7K32Red672dgMhkra7cLTNwK8ebEYhyv, hash
`0x272c0fb89deeb10635a8be9b19876a4a82ffe5f4f470de953c8bc5549947b052`
(verified by reading the block on 2026-09-11). #1352 made the attestation
route read Substrate evidence, so this now works:

```bash
cd /private/tmp/claude-501/-Users-pascalkuriger-repo-Polkadot--claude-worktrees-nervous-curie-8045a3/f6f32eba-1605-4b5a-9945-76011ee2d76a/scratchpad/opsrun && git fetch -q origin main && git checkout -q origin/main && T=$(node scripts/ops/mint-admin-jwt.mjs --profile mainnet --expires-in-days 1 --use-kms --quiet) && curl -sS -X POST https://api.averray.com/admin/deposit-pool/subsidies -H "authorization: Bearer $T" -H "content-type: application/json" -d '{"extrinsicHash":"0x272c0fb89deeb10635a8be9b19876a4a82ffe5f4f470de953c8bc5549947b052","blockNumber":20421344}'; unset T
```

Then read back, and paste me only this output:

```bash
curl -s https://api.averray.com/pool | python3 -c 'import json,sys; g=json.load(sys.stdin)["yieldAttribution"]; print({k: g["gain"][k]["raw"] for k in ("venueEarned","operatorAdded","unattributed")}, g["subsidyLedger"]["entryCount"])'
```

Expected: operatorAdded 600000, unattributed 0, venueEarned −51765 (the cycle's
measured cost shown as a venue result), one ledger entry. If the numbers differ,
stop and paste them.
