# PACKET — Roadmap ticket 6: the x402 hop (`/.well-known/x402`)

Status: READY FOR CODEX · 2026-08-25 · Author: Claude (architect+gate) ·
Repo: **platform (averray-agent/agent), mcp-server** · One PR.
**Dependency now satisfied.** Product gated this on Verify-on-Base being
proven; it was, on 2026-08-25 — first purchase, capture tx
`0x72065b109ba4db014430a0d0a325fb0268aab080ab0fa4e1efd9ec16f4554b2e`
SUCCESS on Base block 50431741, receipt `0xe2dc7441…3550` publicly readable
with `result: PASS`. **Closes the roadmap.**

## What Product locked

> `/.well-known/x402` after Verify-on-Base is the only paid hop; `POST
> /jobs/x402` Base-only; copy never says x402 Hub USDC.

## The point of this endpoint

x402 exists so a machine can **discover** a paid endpoint and pay it without
a human explaining anything. Today an agent can only find our paid door if
someone tells it the door exists. `/.well-known/x402` is how it stops needing
to be told.

Judge every decision in this packet against one question: *could an agent
that has never heard of Averray find this, understand the price, pay, and
succeed — with no prose written by a person?* If the answer is no, the
packet is not done.

## A — `GET /.well-known/x402`

Public, unauthenticated, cacheable. Lists every paid hop we serve. For each:
the resource URL, the accepted payment requirements in the same shape the
live 402 already emits (`scheme: "exact"`, network, asset, `payTo`,
`maxAmountRequired`, `extra` carrying the EIP-712 domain), a human-and-machine
readable description, `mimeType`, and a pointer to the endpoint's input
contract.

**Derive it from the same configuration that produces the live 402 challenge.**
If the well-known document and the actual challenge can disagree, an agent
that trusts discovery will build a payment we reject. A test asserts the
advertised requirements are byte-equal to what the endpoint's own 402
returns for the same resource.

Today that list has exactly one entry: the Verify run door.

## B — `POST /jobs/x402`

Base-only, per Product. The `x402-poster-ramp` service and its `SiwxAuthAdapter`
already exist and are unwired; this is the routing plus its contract, not new
payment machinery. Same 402-then-retry pattern as Verify.

## C — The copy lock, mechanically enforced

**Hub USDC is never x402-payable.** Settlement is Hub USDC (asset 1337,
`eip155:420420419`); the paid hops are Base USDC (`eip155:8453`). Add a test
that fails if any x402 surface, well-known entry, or description string pairs
`420420419` with an x402 payment requirement. The lock has held so far
because people remembered it — make it hold because the build enforces it.

## Non-negotiables (each pinned by a test)

1. **Discovery equals reality**: advertised requirements are byte-equal to
   the endpoint's live 402 for the same resource.
2. **Never Hub USDC on an x402 hop**, asserted structurally (C).
3. `/.well-known/x402` is unauthenticated and leaks nothing wallet-specific.
4. `POST /jobs/x402` is Base-only; a non-Base payment is refused with a
   named reason.
5. The existing Verify 402 path is byte-identical — this packet adds
   discovery, it does not touch the proven flow.
6. Manifest consistency holds; committed mirrors regenerated via the
   generator with `[allow-generated]` if discovery copy changes.

## Out of scope

Changing the Verify payment gate itself, adding new paid endpoints, altering
prices, and the buyer-experience fixes — those are
`PACKET_VERIFY_SELF_SERVICE.md`, which should ship **first** if you are
sequencing, because discovery without a usable door only advertises
frustration.

## Handback requirements

PR number; green CI; the six test names; the full `/.well-known/x402`
document as served for the current single entry; and confirmation the live
Verify 402 is unchanged.
