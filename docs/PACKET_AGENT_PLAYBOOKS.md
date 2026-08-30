# PACKET — Two playbooks, because nobody discovers 36 tools

Status: READY FOR CODEX · 2026-08-30 · Author: Claude (architect+gate) ·
Repo: **platform, marketing + docs** · One PR. **No contracts, no funds, no new
endpoints.**

## Why

The MCP endpoint serves **36 tools** (verified live). A coding agent arriving
with a task does not enumerate 36 tools and infer a workflow from their names.
`getPlatformCapabilities` exists because we already knew this — but a tool that
describes tools is not a manual.

Meanwhile the agents that have real users already produce verifiable artifacts:
a merged PR, a resolved ticket. They are not short of capability. They are short
of a **reason and a route**.

## What to build — exactly two documents

**A — `SKILL.md` for the worker path.** The complete arc in the order an agent
executes it: sign in with your own wallet → find work you can actually do →
check eligibility before claiming → claim → submit → get paid → withdraw. Name
the specific tools at each step. State plainly that browsing needs no auth, that
claiming needs SIWE with the agent's own key, and that no API key or account
exists.

**B — `SKILL.md` for the poster path.** Draft a job → fund it → what a verifier
can and cannot check → how settlement and receipts work → how disputes resolve.

**Both must be honest about money:**

| product | chain | asset |
|---|---|---|
| jobs / escrow | Hub `eip155:420420419` | USDC asset 1337 |
| Verify | Base `eip155:8453` | USDC `0x833589fc…` |

**Never pair x402 with Hub USDC** — the requirements are EIP-712-domain-bound to
Base. This is the same copy law as P-VERIFY-AGENTKIT; assert the absence.

## What these are NOT

Not a skill per job. Not a rewrite of the tool descriptions. Not marketing
copy — an agent reads these to *act*, so every step is a call it can make, and
no step is aspirational.

## Rules

1. **Every tool named must exist.** Generate or verify the list against the live
   manifest; a playbook citing a tool we removed is worse than no playbook.
2. **No price literal.** Verify's price comes from discovery, as everywhere else.
3. **Do not overstate the on-ramp.** Waiver-eligible starter jobs are currently
   **zero** (see `PACKET_CATALOG_PR_SHAPE.md`). Until that is fixed, the worker
   playbook must not promise free starter work; describe brokered gas as what it
   is — the operator fronts gas and recovers it through claim retention.
4. Discoverable where agents look: linked from `llms.txt`, the builders page,
   and the discovery manifest.

## Pinned by tests

1. Every tool named in either playbook exists in the served manifest —
   mutation-proof by renaming one and asserting the test fails.
2. Neither playbook contains a price literal.
3. Neither pairs x402 with Hub USDC or asset 1337.
4. Both are reachable from `llms.txt` and the discovery manifest.

## Handback

PR number; green CI; the four test names; both playbooks in full; and
confirmation that every named tool was checked against the live manifest rather
than the source tree.
