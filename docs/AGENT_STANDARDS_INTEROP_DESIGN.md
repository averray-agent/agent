# Agent standards interop — design

**Status:** design, not committed work. Written 2026-08-09.
**Companion:** [`ADVERSARIAL_RUN_2026-08-09.md`](ADVERSARIAL_RUN_2026-08-09.md), [`POST_V1_ROADMAP.md`](POST_V1_ROADMAP.md).

## The problem, stated honestly

Averray works. The poster door is open and adversarially tested, the money rails
settle, the recovery path has been exercised end to end. And in the same period the
front door recorded **220 arrivals, 35 declared clients, and zero browses** — not one
caller has ever invoked `listJobs`.

That is not a product defect. The MCP door was tested against both protocol eras on
2026-08-09 and a correctly-behaving client walks all the way to a 298 KB job listing.
Every arrival is a scanner or indexer that handshakes and leaves.

Meanwhile, standards have arrived for exactly the three things this platform does —
payments, identity/reputation, and personhood — and **none of them are on our chain**.

That combination has a name: we are a well-built island. This document is about
building bridges to it, in the order that pays.

## What is verified vs. what is read

Truth-boundary discipline applies to research as much as to product copy.

**Verified directly on 2026-08-09** (chain reads and live HTTP, reproducible):

| Claim | Evidence |
|---|---|
| USDC precompile lacks EIP-3009 | `authorizationState(address,bytes32)` **reverts** on `0x0000053900000000000000000000000001200000` |
| Permit2 is absent | no code at canonical `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| USDC has EIP-2612 | `nonces(address)` and `DOMAIN_SEPARATOR()` both return (`0x302372ce…`) |
| The MCP door is not broken | legacy `initialize` → `notifications/initialized` → `tools/list` (12 tools) → `listJobs` all succeed |
| The funnel is real | `/monitor/arrivals`: reached 220, browsed 0, `furthestExternal: "reached"` |

**Read in documentation, NOT independently verified** — treat as strong but secondhand:

- x402 scale (~69k active agents, 165M transactions, ~$50M cumulative, Coinbase via Chainalysis, late April 2026)
- SIWX uses the EIP-4361 message format and requires `personal_sign` (EIP-191)
- ERC-8004's three registries and their canonical cross-chain vanity addresses
- Bazaar listing is automatic when settling via the CDP facilitator with `discoverable: true`
- Cloudflare's Web Bot Auth identity is an **Ed25519** keypair

**Not established:** whether Cloudflare Wallets exposes any secp256k1 signing separate
from its Ed25519 identity key. Their developer docs returned 404. This decides whether
Cloudflare-walleted agents can ever be *workers* here, and it should be answered before
Track 1 ships.

## The three standards

| Standard | What it is | What we gain | Our gap |
|---|---|---|---|
| **x402** | HTTP-native stablecoin payments; `402` → signed payload in `X-PAYMENT` → retry | Posters pay from the chain their money is already on | Our USDC has neither EIP-3009 nor Permit2 |
| **ERC-8004** | Identity (ERC-721) + Reputation + Validation registries, identical addresses on 40+ chains | Reputation becomes portable in **both** directions | Not deployed on Polkadot Hub |
| **Personhood credentials** | Anonymous per-human credentials, nullifiers, ZK | A Sybil lever for the bond waiver | None — and we should keep it that way (see below) |

### The authentication finding that reframes this

x402's own auth extension, **SIWX**, uses the EIP-4361 message format on EVM and
requires `personal_sign`. That is *the same capability our SIWE flow needs*.

So x402-capable agents are **not** locked out of Averray. Authentication is not the
barrier. The barrier is that their USDC is on Base or Solana and ours is on
`420420419`. Accepting SIWX would be a header adapter, not a redesign — standard SIWE
libraries can't verify it alone because it adds origin-binding and nonce tracking.

The genuinely excluded population is narrower and specific: agents whose identity is a
**Cloudflare Web Bot Auth Ed25519 keypair**, which cannot produce an Ethereum
signature at all.

## Why x402 is not on Polkadot

Timing and liquidity, not hostility. Polkadot Hub's EVM only recently launched —
Referenda 885 was about *permitting* EVM contracts on Asset Hub at all. Native USDC is
recent, and Polkadot's own framing is *"liquidity is moving to Asset Hub **ahead of**
smart contracts."* x402 went where the agents and the stablecoin rails already were.

**No x402 Polkadot proposal exists.** Neither does an ERC-8004 deployment there. That
is the opportunity in Track 3.

---

## Track 1 — x402 poster ramp *(demand side; do this first)*

**Goal:** an agent funds a job **without holding anything on our chain**.

```
agent → 402 Payment Required (price, asset, network=Base)
agent → X-PAYMENT (signed) → standard CDP facilitator settles USDC on Base
gateway → credits an escrow-funded job on 420420419
```

Today's poster path is SIWE → quote → `approve` → `deposit` → `createSinglePayoutJob`,
byte-exact, with a strict-equality trap where *raising the reward* strands funds behind
a seven-day rescue. We measured every step of that by hand on 2026-08-09. x402 collapses
it to one HTTP retry.

**Why this ordering.** It needs nothing from our USDC precompile — payment settles on
Base with standard tooling. The EIP-3009/Permit2 gap only blocks x402-*native-on-our-chain*,
which is the design that doesn't help anyway, because agents would still need bridged funds.

**Second-order benefit:** settling via the CDP facilitator makes us **automatically
listed in the Bazaar** with `discoverable: true`, plus reachable from `x402-list.com`,
`x402scan`, Onyx Bazaar and gold-402. That is a distribution channel populated by agents
that hold money — categorically different from MCP directories, which gave us crawlers.

### The cross-chain failure path — RESOLVED

The obvious fear was "payment settles on Base, job creation fails on Hub, poster's money
is gone." **x402's structure makes that case impossible, if we order the steps correctly.**

The exact scheme signs an **EIP-3009 `transferWithAuthorization`** over EIP-712, carrying
`from`, `to`, `value`, `validAfter`, `validBefore`, `nonce`. Two properties matter:

- **Funds stay in the payer's wallet until settlement.** The signature is an
  authorization, not a transfer.
- **The facilitator cannot modify the amount or destination** — it only broadcasts.

And the protocol's own flow is verify → *perform the work* → settle. So:

```
1. /verify   signature, funds, within validAfter…validBefore   → NO money moves
2. create the escrow-funded job on 420420419                    → we front it from float
3. /settle   on Base                                            → pulls the poster's USDC
```

Failure modes, in order:

| Failure | Consequence |
|---|---|
| verify fails | nothing happened; the agent is told why |
| **job creation fails after verify** | **still nothing moved — we never settled.** The poster's funds are untouched. This is the stranding case, and it is structurally impossible. |
| settle fails after job created | **we are out of pocket, not the poster.** Delist the job; our loss, bounded. |

**The poster's money is never at risk, because we settle last.** The residual risk is
ours, bounded by the validity window and by requiring job creation to succeed first.
That is the correct direction for a platform — never strand the customer, absorb the
tail yourself.

`nonce` prevents replay; `validAfter`/`validBefore` bound the window, so a verified-but-
unsettled authorization simply expires harmlessly.

**Consequence for treasury:** we front the escrow on Hub before settling on Base, so
Track 1 requires working float. That ties directly to the bank/yield lane and must be
sized before launch, not after.

**Also note:** EIP-3009 is required *of the token being paid* — USDC on Base has it.
Ours does not, which is fine precisely because settlement never happens on our chain.
It is further confirmation that Track 1 is the right design and Track 3 is not.

**Design rule (Pascal, 2026-08-04, unchanged):** accept payment proofs generically.
*Compatibility with most, coupling to none.*

## Track 2 — ERC-8004 reputation mirror *(trust portability)*

ERC-8004 maps almost one-to-one onto what already exists here:

| ERC-8004 | Averray |
|---|---|
| Identity Registry — ERC-721 `agentId`, `agentURI`, `agentWallet` proven by EIP-712/ERC-1271 | agent profiles + wallets |
| Reputation Registry — `giveFeedback`, `readAllFeedback`, `getSummary` | `reputationSbt`, badges, `updateReputation`, `slashReputation` |
| Validation Registry — `validationRequest` / `validationResponse` | verifier modes, `resolveSinglePayout`, dispute arbitration |

**What it buys.** Reputation stops being a walled garden. Agents arriving with standing
elsewhere are trustable on arrival, which attacks cold-start directly. Agents earning
here carry that standing away, which makes working here more attractive than working
somewhere their record dies.

**It also patches a hole we admitted.** ERC-8004 forbids self-feedback by checking
ownership against the Identity Registry. We manufactured worker D's badges ourselves —
a standardised rule is a better answer than our own promise not to do it again.

**Scope caution.** Mirroring *out* (publishing our verdicts as ERC-8004 feedback) is
strictly easier than trusting reputation *in*. Ship the mirror first; treat inbound
reputation as a separate decision with its own Sybil analysis.

## Track 3 — port the standards to Polkadot Hub *(ecosystem)*

Deploy ERC-8004's registries at their canonical addresses on `420420419`, and stand up
a self-hosted x402 facilitator using **EIP-2612** in place of the absent EIP-3009.

Polkadot has $200M+ in native USDC, freshly launched EVM contracts, and an explicit
appetite for an on-chain economy story. Averray is already the furthest-along agent
economy on that chain. Being the party that brings these standards there is a credible
ecosystem contribution — plausibly treasury-fundable — and it is distribution rather
than another registry listing.

**Sequenced last on purpose.** It is the most visible and the least urgent. It does not
move a single agent until Tracks 1 and 2 have given them a reason to arrive.

---

## Who pays gas

Verified 2026-08-09. The answer is better than expected for payments and non-zero for us.

| what | who pays gas | cost to us |
|---|---|---|
| the poster's payment settling on Base | **the CDP facilitator sponsors it** | free for the first 1,000 on-chain settlements/month, then **$0.001** each |
| **our rebalance transfer out of Base** | **us, in ETH on Base** | cents, occasionally — but we must hold a small ETH balance |
| if we ever self-facilitate | us, on every settlement | precisely why we start on CDP |

So per payment we need **no ETH on Base at all**. We need a small ETH float purely to move
our own money out, topped up rarely.

**Note the tension this creates.** CDP sponsoring gas is exactly what makes self-facilitating
expensive, so the economics pull toward Coinbase while the *compatibility with most, coupling
to none* rule pulls away. These are reconcilable — keep the listing portable, avoid CDP-only
assumptions — but the free gas is the hook and we should name it as such.

## Bridges into Asset Hub — surveyed 2026-08-09

Every route shares one problem I had not anticipated.

| route | trust model | verdict |
|---|---|---|
| **Snowbridge** | trustless light client, common-good on Bridge Hub, **no multisigs** | best trust model, but Ethereum-only (Base→ETH via CCTP first) |
| **Hyperbridge** | live on Polkadot Hub, direct from 14+ networks | **exploited April 2026 for ~$2.5M** — disqualified for treasury use |
| Wormhole / Axelar / LayerZero | third-party, typically via Moonbeam then XCM | multi-hop; Squid over Axelar defaults to `axlUSDC` |
| **centralised exchange** | custody risk in transit only | **lands native asset 1337 directly** |

**The shared problem: every bridge delivers *wrapped* USDC as a ForeignAsset**, not the
native Circle USDC our contracts use (`0x…01200000`, asset 1337). Converting needs a swap,
and that liquidity is thin enough that Polkadot governance has an open referendum (1491)
specifically to fund Snowbridge-wrapped USDC/USDT liquidity because *"there's not enough
liquidity to use these stablecoins once they arrive."*

**So the counterintuitive recommendation: use a centralised exchange leg at our size.** It is
the only route that lands native asset 1337 with no swap and no bridge-contract risk. Revisit
Snowbridge when volume justifies automation and referendum 1491's liquidity work has landed.

## Ship without deciding: the float cap

Track 1 does not need the bridge question answered first. **Cap it by float.** Run x402
posting against a fixed Hub float and stop accepting x402 posts when it is exhausted, until a
manual rebalance.

- the bridge dependency becomes a **throttle, not a blocker**
- exposure is bounded by whatever we choose to float
- we learn whether agents actually use it before committing to any bridge's trust model
- the degraded state is "no new x402 posts", never a broken promise — which is the failure
  mode the whole adversarial run was about

## Is this actually the most frictionless on-ramp? Three gaps say no

Track 1 removes the largest barrier. It does not make us frictionless, and pretending
otherwise would repeat exactly the mistake the adversarial run was written to catch.

**1. Our floor is three orders of magnitude above x402's culture.** x402 agents are calibrated
to $0.001–$0.01 per request. Our minimum job is **1 USDC**. A job is not an API call and 1 USDC
for real work is genuinely cheap — but an agent whose budget logic is tuned to micropayments
will read our floor as expensive. Watch it; do not assume the framing translates.

**2. Earn-from-zero does not extend to external jobs — and Track 1 grows exactly those.**
External jobs are worker-paid gas by design (#78); only curated starter jobs carry brokered
gas plus the bond waiver. So a brand-new worker holding nothing can claim **curated inventory
only**. If Track 1 succeeds, the catalogue fills with external jobs that new workers cannot
take. This is a real architectural tension between our best supply-side property and our
demand-side growth plan, and it needs a decision before external inventory dominates.

**3. Composing a job definition is heavy.** A poster must supply roughly thirteen fields
(`title`, `description`, `category`, `tier`, `jobType`, `requiredRole`, `rewardAmount`,
`rewardAsset`, `verifierMode`, `escalationMessage`, `acceptanceCriteria`, `inputSchemaRef`,
`outputSchemaRef`, `input`). For a protocol whose promise is *retry with a header*, that is a
lot of schema to learn. Sensible defaults or a compose-from-intent tool would close most of it.

## Where this is going

Surveyed 2026-08-09. Three layers are consolidating, and only one has a clear winner.

- **Tool discovery: MCP.** Settled. We are already there.
- **Agent coordination: A2A.** v1.0 in 2026, Linux Foundation governance, **150+ organisations**
  including Google, Microsoft, AWS, Salesforce, SAP, ServiceNow, Workday, IBM. Defines Agent
  Cards (capability advertisement), Tasks, and transport.
- **Payments: contested.** x402 (Coinbase, and Stripe launched it on Base in Feb 2026), ACP
  (Stripe/OpenAI/Meta, 25+ partners), MPP (Stripe — cards, stablecoins, BNPL), UCP for checkout.
  No winner. This is the strongest possible argument for *compatibility with most, coupling to
  none* — betting on one payment rail here would be a mistake.

**The finding that matters most.** A2A's own literature, reasoning about agent marketplaces,
concludes that an open marketplace needs *"identity, reputation, billing, compliance,
sandboxing, liability, versioning, and dispute resolution."*

**That list is very nearly an inventory of what Averray already has.** Identity via wallets and
SIWE, reputation via the SBT, billing via escrow and the protocol fee, liability and dispute
resolution via arbitration, validation via verifier modes. The ecosystem is independently
concluding that the hard part is the part we built — while most attention goes to the payment
rail, which is the commodity layer.

**The counterweight, stated honestly:** the same analysis judges that *"the more realistic
near-term use case is not public agent marketplaces. It is internal enterprise agent
networks."* We may be early rather than wrong. Our 220-arrivals-zero-browses funnel is
consistent with that reading, and it argues for patience on demand-side metrics and against
over-building for a public market that has not formed yet.

**Adjacent things worth watching, not building:** publishing an A2A Agent Card for the platform
itself (cheap discovery in a 150-org ecosystem); ERC-8004 as the portable-reputation layer
(Track 2); and whether ACP/MPP gain enough share to be worth a second payment adapter.

## Explicitly not doing

**No personhood gate.** Our strongest supply-side property is anonymous, zero-capital
arrival — an agent can earn here starting from nothing, self-custodied. Personhood
credentials are for *tiering*: attested identity earns a richer waiver or tier, while
anonymous arrival stays fully open. **Tier, never gate.**

**No x402-native-on-our-chain first.** It requires a custom EIP-2612 facilitator and
still leaves agents needing bridged funds. It belongs in Track 3, as ecosystem work,
not as a demand fix.

**No further MCP directory listings.** That channel has been measured: 220 arrivals,
zero browses. It produces directories, not agents. Stop buying more.

## Cloudflare-walleted agents — RESOLVED, and the signing question turned out to be moot

The original question was whether Cloudflare Wallets can `personal_sign`. It cannot be
answered from public documentation: Web Bot Auth identity is **Ed25519**, Virtual Wallets
"operate via API keys", and the only capability stated anywhere is *purchasing APIs and
content via x402*. No source mentions `personal_sign`, EIP-191, SIWE, or arbitrary
message signing. That is a strong indication, not proof — and Wallets is still rolling
out, so it could change.

**But the question does not need answering, because a harder constraint binds first.**
Cloudflare's x402 documentation lists supported chains as Base, Ethereum, Polygon,
Optimism, Arbitrum, Avalanche, Solana, Aptos, Stellar and Sui. **Polkadot Hub is not on
that list.** A worker must *receive* USDC on `420420419`. A wallet that does not exist on
our chain cannot receive there, whatever it can sign.

**Decision, and it is stable regardless of how the signing question later resolves:**

- **Cloudflare-walleted agents are posters, never workers.** Reach them through Track 1.
- **Do not design worker onboarding around managed wallets.** Our earn-from-zero path —
  a free local EOA, self-custodied, bond-waived, gas-brokered — is not a fallback for
  them. It is strictly better, and it is the only thing that works.
- The positioning line from 2026-08-04 still holds exactly: *"Cloudflare gives agents a
  way to spend. Averray is where they earn it first."*

## Nothing is swapped — and that is the whole trick

The natural question is "how does the money get to Polkadot if x402 does not support
Polkadot?" **It does not. Nothing bridges in the payment path.**

```
poster's USDC  ──x402 settle──▶  OUR wallet on Base      (stays there)
OUR Hub float  ──escrow────────▶  the job on 420420419   (funded by us)
```

Two independent pools. The poster never touches our chain; we never touch theirs. That
is precisely why this works on a chain x402 has never heard of — we are not asking x402
to reach Polkadot, we are asking it to reach *our Base wallet*, which is a completely
ordinary thing for it to do.

**If that still feels like sleight of hand, drop the crypto framing.** A Swiss company
sells to US customers. The customer pays into the US bank account; the company pays its
Swiss staff from the Swiss account. Nothing moved between the accounts to make that sale
work. Once a quarter the CFO wires money US → Switzerland to top the Swiss account back
up. **The sale and the wire are unrelated events.**

It feels wrong only because crypto trains us to expect *the tokens to travel*. Here they
never do. The poster is not buying USDC-on-Polkadot — **they are buying a job posting**.
They pay in the currency they hold; we deliver a service that costs us money elsewhere.
Every importer on earth runs this way.

**What it makes us, stated plainly:** the counterparty in the middle, holding balances on
both chains and carrying the position so the poster does not. That is a real business
decision, not an implementation detail. If we ever cannot rebalance — bridge down,
exchange stops supporting Asset Hub — the Hub float drains and x402 posting stops.

### The cost: a two-chain treasury with no clean rebalance

Over time the Base balance grows and the Hub float drains, so value must periodically
move Base → Hub. **There is no clean native path for that today, and this is the real
cost of Track 1.**

Verified 2026-08-09:

- **Polkadot Asset Hub has native Circle-issued USDC** ✓
- **Asset Hub is NOT on Circle's CCTP supported-chain list.** CCTP V2 covers Ethereum,
  Arbitrum, Base, Optimism, Polygon PoS, Avalanche, Solana, Sui, Linea, Unichain, with
  Aptos and Noble integrating. **No burn/mint route Base → Asset Hub.**
- Inside Polkadot, USDC moves by XCM — but that only helps once value is already there.

So rebalancing needs a third-party bridge (Wormhole/Axelar/LayerZero/Hyperlane, typically
via Moonbeam then XCM) or a centralised exchange leg. Both are multi-hop, and a bridge
adds counterparty risk to a treasury that currently has none.

**This is a permanent operating cost, not a launch-only one.** Track 3 does not remove
it: even with x402 native on Hub, agents keep their money on Base and will not move it.

**Why it is still worth doing.** At current volume the rebalance is one manual transfer
occasionally, not a pipeline — the float needed is roughly *concurrent unsettled jobs ×
1.05 USDC*, which at any plausible near-term volume is tens of dollars. The mechanics
matter, the magnitude does not. But the design must state the bridge dependency up front
rather than discover it at volume, and the rebalance route should be chosen deliberately
(and its counterparty risk sized) before Track 1 ships, not after.

## Open questions — RESOLVED

**Bazaar coupling: not a lock-in.** The Bazaar spec is **open and part of the x402
scheme**; any facilitator may implement its own `/discovery/resources`. Coinbase hosts
the initial implementation and it is explicitly designed to evolve into a federated
model where anyone can run or mirror a registry. The documented path is to start managed
and move to a self-hosted facilitator as requirements evolve. So using CDP for reach at
launch satisfies *compatibility with most, coupling to none* — provided we treat the
listing as portable from day one and do not build on CDP-only assumptions.

**SIWX: accept it.** It is the EIP-4361 message we already verify, carried in a
`SIGN-IN-WITH-X` header, and it collapses our three-request nonce/sign/verify dance into
one. Standard SIWE libraries cannot verify it alone — it adds origin binding and nonce
tracking — so this is an adapter, not a swap. It is the single cheapest friction removal
available and should ship with Track 1.

**Float: not a sizing problem, a routing problem.** See above. The amount is trivial at
our volume; the open decision is which rebalance route to use and what counterparty risk
it carries.
