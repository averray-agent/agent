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

**We carry the cross-chain risk.** That is the honest cost and it must be designed, not
waved at: what happens when payment settles on Base and job creation on Hub fails? The
answer must be a stated refund path, not silence — the lesson from finding F2.

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

## Open questions before Track 1 ships

1. Does Cloudflare Wallets expose secp256k1 signing separate from the Ed25519 identity
   key? Decides whether their agents can ever be workers here.
2. What is the cross-chain failure design — payment settles on Base, job creation fails
   on Hub? Needs a stated, poster-visible refund path.
3. Do we accept SIWX (`SIGN-IN-WITH-X` header) alongside our SIWE, so x402 agents
   authenticate in one request instead of three?
4. Bazaar listing appears to require the CDP facilitator specifically. Does that
   couple us to Coinbase in a way the "coupling to none" rule forbids, and is there a
   federated path?
