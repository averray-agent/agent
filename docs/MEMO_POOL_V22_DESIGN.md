# MEMO — What goes in v2.2, if we build it

Status: **DESIGN — decision not taken** · 2026-09-03 · Author: Claude (architect)
Supersedes the open questions in `MEMO_POOL_V22_DEPLOYMENT_WINDOW.md`.
Filter applied: **only features that have already drawn blood.**

## Measured state (v2.1, 2026-09-03)

| | |
|---|---|
| totalAssets | **19.960274** (grew from 13.460274 during this session — a 6.500000 deposit) |
| bufferFloor | 9.908397 |
| **deployable** | **10.051877** |
| venueAdapter | `address(0)` — cannot earn at all |

Holders: `0xdc1Ed106…` 9.908397 (EOA, **sets the floor**) · `0x3742de88…`
6.500000 (EOA, the new deposit) · `0x1DDcA709…` 3.055142 (**contract** — the
aggregator lane) · `0x60385dD6…` 0.496735.

At the measured round trip of **0.051490**:

| window | earns | net | break-even deployable |
|---|---|---|---|
| 7 days | 0.021784 | **−0.029706** | 23.76 |
| 30 days | 0.093359 | **+0.041869** | 5.54 |
| 90 days | 0.280076 | **+0.228586** | 1.85 |

**v2.1 can only use the 7-day window, and that window loses money at this size.**
Both windows that would profit are the ones the contract forbids. That is the
entire economic case for v2.2, stated honestly.

## THE FLOOR IDEA IS DEAD — measured, not assumed

I proposed recomputing `bufferFloor` from *current* positions instead of the
`maxIssuedAgentShares` high-water mark, and called it the biggest economic win.

**Measured: the largest current position is 9.908397 — exactly the high-water
mark.** Recomputing frees **nothing**. The high-water mark is not stale; it is
the live largest holder.

Keep the mechanism in mind for later (it decays value only once that holder
shrinks or leaves), but **it does not justify anything today**. Recorded so
nobody rebuilds the argument from memory.

## What survives the filter

**A — Commitment tracking.** The stated purpose, and the only thing that
unlocks the 30- and 90-day windows *honestly*. Today's 7-day cap exists because
any holder may `requestRedeem(…, Notice7Days)`; lending for 90 days while
promising 7-day exit is a lie the contract currently refuses to tell. v2.2 must
know who has committed for how long and compute **deployable-per-duration**.

**B — Venue rebinding under strict conditions.** `setVenueAdapter` is set-once,
which is *why* a venue change means a new pool — the reason this memo exists.
Allow rebinding only when: no active deployment or recall, a timelock has
elapsed, and the multisig signs. **This is the actual future-proofing: it makes
v2.2 the last pool we have to deploy for this reason.**

**C — NAV that tells the truth without an operator action.** Legacy v2 reported
`totalAssets 14.888371` while holding 14.836881 for days, because consumed
friction is not marked down until someone calls `writeOffVenueLoss`. Settlement
should reconcile principal against what actually returned.

**D — A deployment closes when its recall settles.** Deployment 4 stayed open
because 0.051490 never came back — it was *spent*, not lost. That blocked the
Ceremony B precondition and needed a separate write-off to clear.

C and D are both from failures in the last four days.

## What does NOT go in

The `DEPLOYMENT_EPOCH` cooldown (annoying during the recall, never harmful),
fee-policy knobs, multi-venue support, tranching, and the floor change above.
**No evidence, no feature.**

## The counterweight, stated plainly

Every item is audit surface on a contract holding depositor funds, and v2.2
means migrating depositors a **second** time (they moved to v2.1 on 2026-08-27).
Four features is a materially larger review than one.

**And v2.2 does not avoid Ceremony B — it repeats it.** A new pool needs its own
venue binding, its own set-once decision.

## The honest decision frame

**v2.2 earns its cost only if capital will commit.** Our core user is an agent
parking earnings between jobs; that capital is inherently uncommitted. Build
commitment tracking and the tiers may sit empty — which is what happened with
the retention machinery: correct mechanism, no cohort.

**The alternative needs no contract at all:** at 33.67 of assets the 7-day
window breaks even on its own. We are at 19.960274 — **short by 13.71**, and the
pool grew 6.5 during this session unprompted.

**Recommendation: do not start v2.2 yet.** Bind v2.1 (Ceremony B), run 7-day
cycles with the ~0.0297/cycle subsidy disclosed, and let deposits decide. If
capital arrives, the subsidy ends by itself. If someone asks to lock 30 days for
a better rate, that is the signal to build A–D — and by then the design is here.
