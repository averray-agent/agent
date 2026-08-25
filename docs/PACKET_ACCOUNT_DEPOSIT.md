# PACKET — Account deposit: close the asymmetry with withdraw

Status: READY FOR CODEX · 2026-08-25 · Author: Claude (architect+gate) ·
Repo: **platform (averray-agent/agent), mcp-server + app** · One PR.

## The finding (from a real agent, 2026-08-25)

An external agent tried to add funds to its Averray balance and could not
find a way. Its report: no balance or funding control anywhere before
sign-in; after SIWE the worker board's header offers **Earnings**, which
goes to `/work-withdraw/` — withdraw only. `/earnings` and `/withdraw`
redirect there too. It ended up reading `GET /account` directly to learn it
held 0.15 liquid and 1.05 reserved.

The mechanism it needed **does exist** and is correct — it is simply
undiscoverable:

| direction | MCP tool | app surface | machine-readable recipe |
|---|---|---|---|
| withdraw | `buildWithdrawTransactions` ✓ | `/work-withdraw` ✓ | ✓ |
| **deposit** | **none** | **none** | only nested at `/poster/onboarding` → `workerFacts.selfDeposit` |

A worker needs deposits for real reasons — external jobs are worker-paid, so
a claim bond comes from AAC liquid; posting reserves come from it; a locked
deposit needs it. Burying the recipe inside the *poster* document is the
wrong place for a worker to look, and offering only the outbound half of a
balance is a product hole, not a safety property.

## What to build

### 1 · `buildAccountDepositTransactions` (MCP + HTTP)

Mirror `buildWithdrawTransactions` exactly — same posture, same boundary,
same vocabulary. It returns **wallet-bound unsigned templates**; Averray
never signs, receives, brokers, or relays.

Input: `asset` (default USDC) and `amount` (exact base units, `^[1-9][0-9]*$`
— no floats, same as every money tool). Auth required.

Output, in the shape the withdraw door already uses:

- the account position read (`positions(wallet, token).liquid`) so the caller
  can see what it has before it adds,
- template 1: `approve(AgentAccountCore, amount)` on the token,
- template 2: `deposit(token, amount)` on AgentAccountCore, marked with the
  `approve_confirmed_on_chain` prerequisite the poster flow already uses,
- the `broadcast` block (own RPC, own signer, no relay) and
  `EARNINGS_BOUNDARY`.

**Reuse the existing recipe, do not restate it.** `workerFacts.selfDeposit`
in the poster-onboarding service already encodes these writes and the
`depositAmountRawFormula`; the tool must derive from that same source so the
two can never disagree. A test asserts the tool's templates match the
published recipe for the same inputs.

Say plainly in the description what the ecosystem does not do for you:
**AgentAccountCore has no `depositFor` path** — nobody can deposit on your
behalf, a brokered claim does not broker the deposit, and you pay this
transaction's gas in DOT.

### 2 · Make it discoverable

- Add the tool to `MCP_TOOLS`, and — like `getPosterOnboarding` — decide
  its discovery placement deliberately. Recommendation: **discovery-safe**,
  since knowing how to fund an account is exactly what a browsing agent
  needs; it is authenticated to *call*, but its existence is not a secret.
  Whichever you choose, the manifest-consistency test must pass and any
  omission must be explicit in `CONNECTED_ONLY_TOOLS`.
- Surface the funding recipe on the **worker** side too, not only inside
  `/poster/onboarding` — an `accountFunding` block on the worker-facing
  onboarding surface, sourced from the same code.

### 3 · The app surface

`/work-withdraw` becomes both directions rather than withdraw-only: keep the
existing withdraw flow untouched and add a deposit path that produces the
same two templates for the signed-in wallet. The header link may stay
"Earnings"; the page must no longer imply one-way. Do not invent a new route
— `/earnings` and `/withdraw` already redirect here and that stays true.

## Non-negotiables (each pinned by a test)

1. **No custody, no relay, no signing.** No key input, no signed
   transaction, no broadcast offer. Grep the new surface for those
   affordances, exactly as the postJob packet required.
2. **Templates match the published `selfDeposit` recipe** for identical
   inputs — one source of truth.
3. **Exact base-unit integer strings**; no floats anywhere.
4. **The withdraw path is byte-identical** — same templates, same gas-grant
   behaviour, same errors.
5. **Hub USDC labelling** per the copy lock (asset 1337,
   `eip155:420420419`), never presented as x402-payable.
6. Manifest consistency holds; committed mirrors regenerated through the
   generator with `[allow-generated]` if discovery changes.

## Out of scope

Any brokered or sponsored deposit (the contract has no `depositFor` and this
packet does not add one), deposit-pool/locked-tier flows (separate
products with their own tools), alternate assets beyond the supported set,
and fiat on-ramps.

## Handback requirements

PR number; green CI including manifest consistency and the packed handshake;
the no-custody and recipe-parity test names; one fixture-shaped
`buildAccountDepositTransactions` response pasted verbatim; the discovery
placement chosen and why; and confirmation the withdraw path is unchanged.
