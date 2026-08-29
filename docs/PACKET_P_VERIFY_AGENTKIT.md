# PACKET — P-VERIFY-AGENTKIT: make the paying SKU findable

Status: READY FOR CODEX · 2026-08-29 · Author: Claude (architect+gate), from
the Product handover 2026-08-28 · Repo: **platform, marketing + mcp-server** ·
One PR. **No contract changes. No new endpoints. No funds move.**

## The problem, verified live 2026-08-29

Verify is live and takes money: three published profiles
(`git-patch-tests-v1@1`, `mcp-failure-semantics-v1@1`,
`structured-output-evidence-v1@1`), 5 USDC on **Base**, discovery byte-identical
to the live 402.

But `averray.com/llms.txt` — the file agents read first — **opens with Hub
waiver jobs** ("waiver-eligible starter jobs need no bond", "earned 0.40 USDC")
and contains **one** total mention across verify/base/x402. An agent arriving
with Base USDC and `@x402/fetch` is pointed at a chain it cannot pay on.

**This is a copy defect in front of a working product.** That is why it goes
first: the cheapest possible change to the only thing we sell.

## The chain-identity law (applies to every surface)

| product | chain | asset |
|---|---|---|
| **Verify** | Base `eip155:8453` | `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913` |
| **jobs / escrow** | Hub `eip155:420420419` | asset 1337, `0x0000053900000000000000000000000001200000` |

**Never advertise x402 against Hub USDC.** The x402 payment requirements are
EIP-712-domain-bound to Base; a Hub-flavoured x402 claim would be
unsignable-in-practice and false on its face.

## What changes

**A — `llms.txt` leads with Verify.** Add a section naming the SKU, its price
**read from discovery rather than restated**, Base as the chain, and the two
URLs (`/.well-known/x402`, `/verify/profiles`). Hub jobs remain — they are real
— but stop being the first thing an agent with Base money reads.

**B — `listVerificationProfiles` (MCP) names the payment surface.** Today an
agent that finds the tool still has to infer where to pay. It should name the
discovery URL and Base USDC explicitly, and never Hub 1337.

**C — Hero profile.** Present `mcp-failure-semantics-v1@1` first: it needs only
an MCP URL, no git bundle, so it is the lowest-friction first purchase. Keep
the other two published.

**D — A public result URL, if one already exists.** Determine whether an
unauthenticated GET of a run outcome exists (`GET /verify/runs/{runId}` and
`/receipts/{hash}` both return 404 for a bogus id, which does not distinguish
"no route" from "unknown id" — **establish which, do not assume**). If a public
route exists, name it in the docs path. **If it does not, say so and stop** —
do not build one in this PR, and do not convert Verify to `work-receipt.v1`.

## Non-negotiables (each pinned by a test)

1. No surface pairs x402 with Hub USDC, asset 1337, or `eip155:420420419` —
   assert the absence.
2. No price literal in `llms.txt` or MCP copy; the figure comes from discovery.
3. The well-known stays a **single** resource (`POST /verify/runs`). Adding
   `/jobs/x402` is out of scope and would be false.
4. Existing Hub-jobs copy stays accurate — this reorders emphasis, it does not
   delete or downgrade a working product.
5. Truth-boundary review before handback.

## Non-goals

Hub escrow, SIWS, poster x402, a Polkadot x402 scheme, an in-tree AgentKit app,
an `@x402/fetch` dependency, and **no 5 USDC spend in CI**.

## Handback

PR number; green CI; the test names; the exact new `llms.txt` Verify section;
the `listVerificationProfiles` copy; and a definitive answer on whether a
public unauthenticated run-result URL exists today.
