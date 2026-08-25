# PACKET — Say plainly that the agent surface is complete

Status: READY FOR CODEX · 2026-08-25 · Author: Claude (architect+gate) ·
Repo: **platform (averray-agent/agent), mcp-server** · One PR, copy and
structure only — no auth, no new capability, no new endpoint.

## The finding

An external agent authenticated to our API, read its own balance, and then
went looking for the *app* to do anything with it. It switched Chrome
profiles hunting for an injected wallet, discovered the app only stores a
session after a browser `personal_sign`, and reported: *"API login is done…
The app only stores that JWT in localStorage after a browser personal_sign,
so I'm still trying MetaMask on the desktop."*

Nothing was broken. The agent already had, over MCP and HTTP, everything it
was trying to reach through the browser. It did not know that.

**We are not going to add session adoption.** A "paste your JWT" affordance
is a token-theft vector by construction, and it would teach agents and
humans alike to paste bearer tokens into web pages. The app is the human
surface; MCP/HTTP is the agent surface. The defect is that we never say so.

## What to add

A single, prominent parity statement in `/onboarding` — the document an
arriving agent is already told to read first — naming the agent-surface
equivalent of every account action a human can take in the app.

At minimum, mapped by capability rather than by page:

| what a human does in the app | what an agent calls |
|---|---|
| see available balance | `getAccountPosition` / `GET /account` |
| add funds | `buildAccountDepositTransactions` |
| withdraw | `buildWithdrawTransactions` |
| browse and claim work | `listJobs`, `getJobDefinition`, `preflightJob`, `claimJob` |
| submit work | `submitWork`, `validateJobSubmission` |
| lock a deposit | `quoteLockedDeposit` → `createLockedDeposit` |
| exit a lock | `requestLockedDepositExit` |
| post a job | `getPosterOnboarding` → `draftJob` → `buildPostJobTransactions` |
| read standing / tier / receipts | `GET /me`, `GET /reputation`, `GET /receipts` |

Every name above was checked against `origin/main` before this packet was
written: all fifteen tools exist in `mcp-server/src/protocols/mcp/tools.js`
(26 registered today), and the three routes exist in the HTTP protocol layer.

**Derive the table from both registries — MCP tools *and* HTTP routes.**
This is not a stylistic preference. Reputation is served at `GET /reputation`
with **no MCP tool equivalent**, so a derivation that walks only the tool
registry silently drops the row and the document under-claims what an agent
can reach. A hardcoded table has the opposite failure: it rots the moment a
tool is added, and then it lies. If a mapping cannot be derived from either
registry, leave the row out rather than guessing.

Say the two facts plainly alongside it:

- **The agent surface is complete for accounts.** Everything above is
  reachable without a browser, an injected wallet, or the app.
- **The app cannot adopt an API session, and that is deliberate.** A session
  obtained by API stays with the caller who signed for it; we will never ask
  anyone to paste a bearer token into a page. An agent that wants a browser
  view should sign in there separately with the same wallet.

## Non-negotiables (each pinned by a test)

1. **The table is derived**, and a test proves that adding a tool to the
   registry without a mapping does not silently produce a wrong row.
2. **Every named tool exists** — no advertised name resolves to nothing
   (reuse the manifest-consistency machinery from #1257).
3. **No route, capability, auth path, or env changes.** Copy and structure
   only.
4. The statement about session adoption is accurate and non-defensive: it
   explains the reason, it does not apologise for a missing feature.

## Out of scope

Session adoption in any form, changes to the app, new tools, and any change
to what the listed tools do.

## Handback requirements

PR number; green CI; the derivation test name; the rendered parity section
as served from `/onboarding`; and confirmation that no route, capability, or
auth path changed.
