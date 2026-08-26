# PACKET — v2.1 amendment: bind the venue once, by ceremony, not by nonce

Status: READY FOR CODEX · 2026-08-26 · Author: Claude (architect+gate) ·
Repo: **platform (averray-agent/agent), contracts + forge tests** · One PR.
Authority: `MEMO_IDLE_BALANCE_ROUTE.md` Q1″ (RATIFIED 2026-08-26, recorded
alongside Q1′). Amends the **not-yet-deployed** v2.1 from #1295.

## Why

Three immutable bindings form a cycle: pool→venueAdapter, venueAdapter→pool,
lane→adapter. Deploying v2.1 with a venue therefore requires the
nonce-precomputed multi-CREATE ceremony — the most error-prone ceremony class
we have (the surgical nonce-resume lesson), repeated at every future venue
change. The venue stack has already churned twice. Ratified: the pool's venue
binding becomes **owner-settable, exactly once** — v2.1 deploys plainly with
no venue, the adapter/lane pair deploys against the pool's real address, and
one cold-multisig call binds them.

This deliberately grows #1295's "minimal diff". Say so in the PR rather than
hiding it: the diff is now v2 + aggregator surface + venue setter.

## The change, exactly

1. `venueAdapter` drops `immutable`; everything else about it unchanged.
2. Constructor keeps its signature and behaviour, including accepting a
   non-zero adapter with today's validation — factor the validation block
   (`code.length`, `asset()` match, `lossReporter() != 0`) into one private
   function used verbatim by both the constructor and the setter.
3. New:

```solidity
function setVenueAdapter(IDepositPoolVenueAdapter adapter_) external onlyOwner {
    if (address(venueAdapter) != address(0)) revert VenueAdapterAlreadySet();
    if (address(adapter_) == address(0)) revert ZeroAddress();
    _validateVenueAdapter(adapter_);          // identical to constructor path
    venueAdapter = adapter_;
    emit VenueAdapterSet(address(adapter_));
}
```

`onlyOwner` is the existing `policy.owner()` modifier — the cold 2-of-3.
Set-once means set-once: no unset, no replace, not even by owner. A future
venue swap is a future decision with its own contract, not a hidden lever.

## What this deliberately does NOT solve

The adapter↔lane pair still binds mutually immutably and still deploys as a
precomputed two-CREATE pair. That is acceptable: those contracts are stateless
at deploy and hold no external money. The point of this amendment is that the
**pool** — the contract that holds depositor funds — never again needs nonce
choreography or redeployment over a venue change.

## Non-negotiables (each pinned by a forge test)

1. **Set-once**: a second `setVenueAdapter` reverts `VenueAdapterAlreadySet`,
   including by the owner, including after the first was set via constructor.
2. **Owner-only**: operator and arbitrary callers revert.
3. **Validation parity by mutation**: an adapter failing each constructor
   check (no code / wrong `asset()` / zero `lossReporter()`) is rejected by
   BOTH the constructor and the setter — same error, both paths, each
   condition mutated independently.
4. **Venue-less pool is fully functional pre-bind**: deposits, redeems,
   aggregator flows all work; `deployToVenue` reverts `VenueNotConfigured`.
5. **Post-bind equivalence**: after `setVenueAdapter`, venue mechanics behave
   exactly as a constructor-bound pool — run the existing venue-path tests
   against a setter-bound instance.
6. **The #1295 differential and aggregator suites still pass unchanged.**
7. **D-03**: the waiver entries for `depositPool`/`depositPoolV2` are updated
   to the NEW masked runtime hash (the #1295 hash was never deployed and is
   superseded); drift tooling run as before; `verify_contract_source=1` note
   in the PR description.

## Out of scope

Deployment, the adapter/lane pair, registration calls, keeper, app wiring.

## Handback requirements

PR number; green CI; the seven test names; the new masked runtime hash; the
incremental diff size over #1295; confirmation the validation is one shared
private function; confirmation set-once has no unset/replace path.
