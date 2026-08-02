# Bank / yield lane — design workshop (decision doc)

The Bank pillar's yield lane, workshopped **before** any implementation (Pascal's
frame, 2026-08-02: *workshop the idea, see what's best for us, get the
implementation right*). This is a decision document to sign or redirect — not a
packet. The vision it serves: the operator treasury (and later, opt-in agent
balances) earns yield instead of sitting idle — the money-market shape.

> ⚠ **TRUTH-BOUNDARY — read before trusting a single number.** Every figure
> here is a **dated research snapshot (2026-08-02)** from three background
> agents that read chain state directly (Asset Hub / Hydration / Bifrost /
> relay over JSON-RPC), NOT verified by us and in several places **contradicting
> the official wiki/docs (which are stale)**. Nothing here is load-bearing until
> the §5 verification gate is cleared. Full backing detail:
> `scratchpad/yield-venue-research.md` (778 lines), plus the slashing and
> bridging findings in memory `project_bank_yield_workshop`.

---

## 1. Scope — decided

- **Phase 1 uses the OPERATOR TREASURY's own capital only** (Pascal, 2026-08-02).
  No agent funds are exposed until the whole machinery — XCM out, async
  settlement, the observer, the ledger round-trip — is proven on our own money.
  This single decision removes counterparty risk from the entire first build and,
  as §3 shows, dissolves the two scariest problems in the option space.
- Today's treasury is **small** (protocol fee ≈ 0.105 USDC and growing; plus the
  reward bank). That smallness is a feature for phase 1: it sits far below every
  capacity limit below.

## 2. The option space (dated 2026-08-02, unverified)

| Option | Mechanism | ~APY | Denomination | Capacity | Reachable how | Verdict |
|---|---|---|---|---|---|---|
| **Hydration money market — supply USDC** | Lend asset 1337 (real Circle-native USDC) into Hydration's pool (para 2034) | **2.09%** | **USDC (FX-clean)** | **Thin**: ~884k withdrawable; +$1M drops *your own* yield to ~1.06% (you become the market) | XCM from Asset Hub → async | **Phase-1 winner** at treasury scale |
| **Native DOT staking** | `pallet_staking_async` now on Asset Hub; nominate/pool | **~2.5% net** | DOT (**FX-exposed**) | **Unlimited** | Same-chain pallet | Parked — FX + swap depth (below) |
| **Ethereum USDC DeFi (Aave/Sky/Morpho) via Snowbridge** | Bridge → lend on Ethereum | market (higher) | USDC (FX-clean) | **Capped ~6 figs** by Snowbridge USDC float (~$542k) + wrapper risk | Snowbridge V2 (≠ asset 1337 — needs a DEX leg) | Ruled out for now |
| **Bifrost vDOT (the "built" path)** | Liquid-stake DOT for vDOT | **4.48%** (not the 15–18% its app still shows) | DOT (FX-exposed) | Empty — **40.8 vDOT** exists on Asset Hub | XCM/SLPx | Ruled out — dead rails, exploit history |
| **Do nothing** | Idle USDC | 0% | USDC | ∞ | — | **First-class** — the honest baseline |

**Ruled out on evidence, not taste:** vDOT rails are built and empty (TVL −89% in
11 months); **Moonbeam terminated its parachain 2026-07-31** (0 tx now), so any
Moonbeam-hop/SLPx design is dead on arrival; **CCTP / Wormhole / Axelar / LayerZero
have no Polkadot Hub deployment at all**; Snowbridge is the only trustless door to
Ethereum and it can't even move our asset 1337 without a DEX leg it hasn't the
float for.

## 3. The two structural problems — and why phase-1 scope dissolves both

- **FX exposure.** Any DOT-denominated yield (staking, vDOT) earns DOT against
  USDC-denominated obligations. The mitigation would be a deep DOT⇄USDC swap
  path — but the deepest on-chain route is a **$160k Asset Hub pool where a $100k
  swap costs −55.6%**. So DOT strategies aren't just FX-exposed, they're
  FX-*trapped*: you can't cheaply get back to USDC. This is why staking is parked
  despite being unslashable and uncapped.
- **Capacity.** Hydration's USDC pool is thin — at $1M+ you set your own rate
  down to ~1.06%. **But the treasury is nowhere near that knee.** At phase-1
  scale you are a price-taker at the full 2.09%, and capacity only becomes the
  decision when the Bank later opens to agent balances (§7).

The slashing finding (nominators unslashable since 2026-07-06, principal-slash
risk structurally ~0) makes DOT staking *safer* than the old model — but it fixes
the wrong axis. Staking's blocker was never slashing; it's the FX trap. Noted for
the record, not decisive here.

## 4. Recommendation

**Phase 1: supply the treasury's USDC to Hydration's money market — FX-clean,
real asset 1337, audited (Cantina/Spearbit Jan 2025), capped well under the
capacity knee.** It is the only venue that earns *actual USDC* on *actual USDC*
at our scale, and it proves the real machinery on safe, small, own capital.

**The venue is the easy part; the observer is the build.** Reaching Hydration is
an XCM hop from Asset Hub, so this still requires the two things roadmap 3.5 always
implied: **deploy XcmWrapper** (built, `xcmWrapper: null` today) and **build the
XCM observer** that confirms async cross-chain settlement before the ledger credits
yield. That observer is **venue-agnostic** — building it against the safest,
FX-clean venue (Hydration) is the right first target, and it's reusable if we later
add DOT staking or an Ethereum leg. **Truth-boundary for the ledger:** yield stays
MOCK (`simulateYieldBps`) in the UI until the observer confirms real settlement —
never display projected yield as earned.

**Park, don't kill:** native DOT staking (revisit only if a deep DOT⇄USDC path
appears); Ethereum-via-Snowbridge (revisit if we choose to hold Snowbridge-USDC as
a treasury tranche, accepting wrapper risk). **Kill:** vDOT/Bifrost and anything
routing through Moonbeam.

**Also honest:** "do nothing" wins until the observer exists and the yield clears
the two-hop XCM+EVM operational risk. At 2.09% on a treasury measured in single
USDC today, the yield is a *rehearsal*, not revenue — the point of phase 1 is to
get the rails right on money that doesn't matter, so that phase 2 (agent balances)
runs on proven machinery.

## 5. Verification gate — clear before signing this

Load-bearing facts to confirm via the polkadot-docs MCP + an independent chain
read (standing rule: never rely on memory for a Substrate fact):

1. **Nominators unslashable** — `Staking.AreNominatorsSlashable = false` on Asset
   Hub (ref #1910). *(Not decisive for the Hydration recommendation, but decisive
   if staking is ever reconsidered.)*
2. **Hydration USDC supply** — the pool holds genuine asset 1337, the ~2.09% rate,
   the withdrawable depth, and the audit scope.
3. **Asset 1337 vs Snowbridge USDC** — the two-asset identity (confirms Ethereum
   yield needs a DEX leg).
4. **Moonbeam parachain terminated** — before any design assumes it as a hop.
5. **The precompiles** — XCM `0x…0a0000` and the undocumented Asset-Conversion
   `0x…04200000` — code presence and whether a contract can be the XCM origin.

## 6. Stale in-repo docs the research exposed (separate cleanup, own PR)

Both are wrong today and could mislead a future design:
- `docs/strategies/vdot.md` — quotes 5–6% vDOT and a 28-day unbonding; both now
  false (4.48%, 2-day nominator unbonding).
- `docs/HYDRATION_BORROW_MIGRATION.md` — the borrow loop it describes now carries
  **negative** carry (~−2.1%/yr: staking nets ~2.5%, USDC borrow costs ~4.64%).

## 7. Non-goals / phase-2 triggers

Not in phase 1: agent-balance custody (the money-market vision — needs a risk +
disclosure story and re-opens the capacity question); leverage/borrow loops (now
negative-carry); any DOT-denominated strategy; multi-venue routing. The trigger to
re-run this workshop is **opening the Bank to agent balances** — at which point
capacity, the do-nothing baseline, and FX all change weight.
