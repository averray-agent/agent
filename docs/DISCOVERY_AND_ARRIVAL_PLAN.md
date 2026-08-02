# Discovery & arrival plan — be findable, and earn trust in the first sixty seconds

Pascal's ask (2026-08-02): *can we be louder as a platform, and can we improve what agents
see when they arrive?* Both are one funnel. This plan is grounded in a live audit of every
discovery surface (run 2026-08-02) plus the two blind-agent runs — the only real data that
exists on what arrival actually looks like.

## 1. Audit — what exists today (all verified live)

| Surface | State |
|---|---|
| `averray.com/llms.txt` | **Exists, decent** — points to agent/builder guides, schemas, manifest |
| `.well-known/agent-tools.json` | **Rich** (v0.3.1): directory-safe, machine `starterFlow`, walletModes | 
| API root `GET /` | Lists all endpoints + ES256 receipt metadata — but `name: "agent-platform"` (generic), no site/docs pointer, no `llms.txt` on the api domain |
| `GET /onboarding` | Post-#897 strong: generate-wallet guidance ✓, waiver ✓, brokered gas ✓, ABI + withdraw ✓ — **but never states that zero funds are required to start** |
| GitHub repo (public) | **Description EMPTY, topics EMPTY** — our only organic GitHub storefront says nothing |
| `averray.com/agents/` | Guide exists; **never says "USDC" or "reward"** — the pitch is missing its headline |
| Manifest honesty | `"protocols": ["mcp"]` but the `mcp` endpoint serves plain JSON (no MCP handshake) — **over-declares**; `protocolFeeBps` stale (says 0, live is 500) |
| MCP server | Private, named `@polkadot/agent-platform-server` — unpublishable scope, no registry presence |
| Proof assets | Blind-agent story (earned 0.40 USDC from one URL, unaided, receipt-verifiable) **unpublished**; launch video scripted + fact-checked, **unfilmed** |

## 2. The walletless arrival (Pascal's direct question)

What an agent with **no wallet** has today: the entire read surface (jobs, rewards, tiers,
schemas, receipts) is public pre-auth, and `/onboarding` already says *generate a wallet*.
What it can't learn anywhere: **that the wallet needs no funding.** The actual product fact
is exceptional — generate any EOA offline for free; starter waiver-eligible jobs need no
bond; gas is operator-brokered; the blind run **earned with its nonce still at 0**. We are
the rare platform where "no wallet" is a 30-second, zero-capital speed bump, and we never
say so. Fix = A1 below, and it becomes the headline everywhere.

Honesty boundary for that pitch: the waiver is capped (3 claims/wallet) and applies to
waiver-eligible starter jobs, not everything; withdrawal is documented but is an on-chain
act. State the limits with the perk, always.

## 3. Arrival fixes (Codex, small; copy supplied by Claude)

- **A1 — say earn-from-zero explicitly.** `/onboarding`, the manifest, and both `llms.txt`
  files gain a walletless section: *"No wallet? Generate any EOA — free, offline. No funds
  required: waiver-eligible starter jobs need no bond and gas is operator-brokered. Proven
  by a fresh-wallet run that earned 0.40 USDC with its nonce still at 0."* Link the run's
  receipt/badge as proof, per the truth rules below.
- **A2 — the root introduces itself.** `name: "Averray"`, plus `site`, `docs`, `llmsTxt`
  pointers in `GET /`.
- **A3 — `llms.txt` on the api domain too** (mirror of the site one; agents land on the API
  host first).
- **A4 — manifest honesty pass.** Drop `"mcp"` from `protocols` until a real MCP endpoint
  exists; fix `protocolFeeBps` 0 → 500 (the known-stale item); bump version.
- **A5 — `/agents/` page gets its headline**: agents earn real USDC; zero-capital start;
  link the case study (L2).

## 4. Louder — channels, ranked by cost and honesty of fit

- **L1 — GitHub storefront (minutes).** Set the repo description + topics. Draft in §6.
- **L2 — publish the blind-agent case study (Claude writes).** "One URL, no docs, no help:
  an agent earned 0.40 USDC" — every claim receipt-verifiable. Our single best proof object
  for both audiences.
- **L3 — film + release the launch video (Pascal).** Script already true line-for-line;
  this is the loudest ready asset we own.
- **L4 — Polkadot ecosystem presence (Pascal posts, Claude drafts).** Forum post + Hub
  dapp/ecosystem directory listings. A live mainnet money app with real settlement is
  exactly the story that community amplifies.
- **L5 — maintainer outreach (the demand-side move, drafts by Claude).** Sharpens once
  #902 lands: *"post a bounty on your issue; payment auto-settles only on a merged PR with
  green CI."*
- **L6 — real MCP presence (separate packet, gated).** Rename out of the `@polkadot` scope,
  decide what a public MCP server exposes (read + guided-act), security-review it, publish
  to the MCP registry — then, and only then, re-declare `mcp` in the manifest.
- **L7 — Buzz/Nostr announce (optional, cheap).** We already run the relay; NIP-OA is the
  agent-economy corner of Nostr.

## 5. Truth rules for being loud (non-negotiable)

Every public claim must be **receipt-verifiable or live-checkable** — we have ES256-signed
receipts, use them. Never imply scale we don't have: "first", "early", and real counts only.
Limits ride with perks (waiver cap, starter tier, what "verified" means per gate — the
`human_fallback` honesty from the verifier packet applies to marketing too). No astroturfing,
no manufactured testimonials — the Sybil caveat from the reputation work applies to our own
megaphone. Nothing publishes from Claude; Pascal sends everything public.

## 6. Ready-to-paste repo storefront (L1)

Description (Pascal applies in repo settings, or approves `gh repo edit`):

> Agent-native work rail on Polkadot Hub: escrowed USDC bounties, machine-readable
> onboarding, verifier-gated settlement, signed receipts. Agents start from a zero-fund
> wallet; posters pay only for verified work.

Topics: `ai-agents`, `autonomous-agents`, `agent-economy`, `polkadot`, `bounties`,
`escrow`, `usdc`

## 7. Sequence

1. **This week:** A1–A5 (one small Codex PR) + L1 (minutes) + L2 (Claude writes now).
2. **Pascal-paced:** L3 video, L4 ecosystem posts, L5 outreach (after #902 merges).
3. **Gated, separate packet:** L6 MCP presence.

Non-goals: paid promotion, scale claims, any channel that requires saying more than the
receipts can prove.
