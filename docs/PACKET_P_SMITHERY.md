# PACKET — P-SMITHERY: be installable where hosted agents look

Status: READY FOR CODEX (engineering half only) · 2026-08-29 ·
Author: Claude (architect+gate), from the Product handover 2026-08-28 ·
Repo: **platform, mcp-server** · One PR. **Publishing is an operator step, not
an engineering one.**

## Verified live 2026-08-29

| directory | state |
|---|---|
| Official MCP registry `com.averray/mcp` | **already listed** |
| Glama | **already listed** |
| Smithery `smithery.ai/servers/averray` | **404 — absent** |
| `/.well-known/mcp/server-card.json` | **404 — absent** |

So only Smithery is genuinely missing. (This also corrects a submission kit I
produced on 2026-08-28 that treated Glama and the registry as outstanding —
they were already done.)

## What ships, and what does not

**The connect URL is `https://api.averray.com/mcp`** — the real, mutating,
connected runtime with claim/submit/draft. **Do not build a directory-safe
read-only twin.** Mutating tools stay SIWE-gated, which is the actual safety
property; a sanitised twin would advertise a product we do not run.

`DISCOVERY.md`'s "don't submit money-moving MCP" guidance is **stale** and
should be corrected in the same PR, with the reason: the gate is in-protocol
SIWE, not obscurity.

**Engineering half:**

1. **SmitheryBot must not receive 403.** Establish whether it currently does —
   check the UA/allowlist path — and fix if so.
2. **If automatic scanning fails, serve `/.well-known/mcp/server-card.json`**
   describing name, description, tools, and auth as **SIWE** — never a
   fabricated OAuth flow we do not implement.
3. Optional `smithery.yaml`.
4. MCP copy should mention **Verify's 402 on Base**, consistent with
   P-VERIFY-AGENTKIT and never against Hub USDC.

**Operator half (Pascal or Master, not engineering):** publish at
`https://smithery.ai/new`, pasting the connect URL. Smithery auto-scans and
extracts tools, so the count is not typed by hand.

## Non-negotiables (each pinned by a test)

1. The server card, if added, declares SIWE and never a nonexistent OAuth flow.
2. No read-only twin endpoint is introduced.
3. Any MCP payment copy names Base for Verify and never Hub USDC.
4. `DISCOVERY.md`'s stale guidance is corrected, not merely contradicted.

## Non-goals

Cursor Marketplace (a follow-up), Twitter, and any new MCP host.

## Handback

PR number; green CI; whether SmitheryBot was in fact being 403'd; the server
card if one was needed; and the exact URL for the operator to paste.
