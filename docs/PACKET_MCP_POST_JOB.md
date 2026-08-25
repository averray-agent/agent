# PACKET — Roadmap ticket 3: MCP postJob (the buyer half of the loop)

Status: READY FOR CODEX · 2026-08-25 · Author: Claude (architect+gate) ·
Repo: **platform (averray-agent/agent), mcp-server** · One PR.
Depends on: ticket 1 (receipt schema frozen, shipped #1262) — poster docs
reference the frozen receipt shape.

## What Product asked

> P-MCP-LOOP buyer half — MCP `postJob`. An agent should be able to fund and
> post a job from a connected MCP session, not only through documented HTTP.

## The rule that governs this packet

**Averray never signs, receives, brokers, or relays a poster's money.** The
existing `/poster/onboarding` contract is already the truth; these tools
expose that same flow over MCP and return **wallet-bound unsigned
transaction templates** the poster's own signer broadcasts. Copy the posture
of `buildDepositPoolTransactions` verbatim — it is the house pattern.

Do not invent a parallel posting path. Every value these tools return must
come from the same service code that answers `/poster/onboarding`,
`/jobs/draft`, and `/jobs/draft/:id`. If a formula appears in two places,
it is already a bug.

## Tools to add

Three, mirroring the published flow's steps (`draft` → `fund` → `watch`).
Names follow the existing camelCase convention.

### 1. `getPosterOnboarding`
Read-only, no arguments, auth optional. Returns the live poster contract:
mode, chain and asset identity, `economics` (fee semantics, bps, floor,
minimum reward, draft TTL), cancellation terms, worker-facing facts, and the
schema-discovery paths. This is the tool an agent calls first to learn the
rules — it is `/poster/onboarding` over MCP, unchanged.

### 2. `draftJob`
Auth required. Input mirrors the documented `POST /jobs/draft` body
(definition fields plus schema refs). Returns the deterministic funding
quote: `draftId`, `specHash`, the exact reserved amounts, and the funding
terms the escrow will require. **Creates no claimable job** — the published
contract says only the demand attempt is recorded until funding finalizes,
and that must stay true.

### 3. `buildPostJobTransactions`
Auth required, read-only, idempotent. Given a `draftId`, returns the
unsigned templates for the `fund` step in the exact order the flow
documents: `approve` on the token to AgentAccountCore, `deposit` into
AgentAccountCore for `max(posterReserved − positions(poster).liquid, 0)`,
then the escrow create call. Each template carries its ABI fragment,
address, args, and value, plus the broadcast note ("sign locally and submit
through your own RPC; Averray has no signed-transaction relay").

Reuse the **published formulas** rather than restating them:
`posterReservedRaw = rewardRaw + opsReserveRaw + contingencyReserveRaw +
max(floor(rewardRaw × posterFeeBps / 10000), posterFeeFloorRaw)`. A test
asserts the tool's computed reserve equals the value the HTTP flow returns
for the same draft.

### Watching
Do **not** add a polling tool. `getJobDefinition` and `listJobs` already
answer "is it live". If the draft's terminal status genuinely cannot be
observed through existing tools, say so in the handback instead of adding
one.

## Non-negotiables (each pinned by a test)

1. **No signing, no relay, no custody.** No tool accepts a private key,
   returns a signed transaction, or offers to broadcast. A test greps the
   new tool surface for those affordances.
2. **Asset and chain labelling** on every money-bearing response, per the
   ratified copy lock: Hub USDC (asset id 1337, `eip155:420420419`) for
   escrow; never presented as x402-payable.
3. **Economics come from one place.** The poster fee is
   **poster-additive** — `max(5%, 0.05)` on top of the reward, never framed
   as a worker deduction — and the external reward floor (1 USDC) is
   disclosed **before** a draft is accepted, not after. Test: a draft below
   the floor is refused with the floor named.
4. **Exact base-unit integer strings** for all amounts (6 decimals), same
   input discipline as the deposit-pool tools. No floats anywhere.
5. **Directory-safe vs connected**: these are connected-session tools.
   Update `MCP_TOOLS` and, if they belong in the directory-safe slice,
   `DISCOVERY_TOOLS` — the manifest-consistency test from #1257 must pass,
   and any deliberate omission goes in `CONNECTED_ONLY_TOOLS` with a
   comment.
6. **Idempotency**: re-calling `buildPostJobTransactions` for the same draft
   returns the same templates; it never creates a second draft.

## Out of scope

The x402 paid hop (ticket 6 — `POST /jobs/x402` stays Base-only and is not
part of this), any change to escrow contracts or settlement, the operator
app's posting UI, cancellation flows (`cancelOpenJob` is already documented
and reachable directly).

## Handback requirements

PR number; green CI including the packed-handshake test and the
manifest-consistency test; the names of the no-signing, reserve-parity,
below-floor-refusal, and idempotency tests; one fixture-shaped
`buildPostJobTransactions` response pasted verbatim; and confirmation of
whether the draft's live status is observable through existing tools (if
not, what is missing).
