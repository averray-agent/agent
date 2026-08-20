# PACKET — Public demand surfaces (MCP welcome · discovery manifest · averray.com)

**Author:** Claude (architect) · **Ratifier:** Pascal · **Date:** 2026-08-20
**Implementer:** Codex · **Deliverable shape:** TWO PRs (one per package boundary, house rule)

## 0. Gate amendment — recorded

Standing law was "no public Averray Verify page until the first stranger has paid."
**Pascal amended it 2026-08-20:** public product pages may ship before the first external
payment — he is driving discovery (Twitter) and a click-through to a site that does not
show the product kills the funnel. **Page absence is replaced by content discipline.**
What does NOT change: no traction implication, no customer claims, rehearsal money never
presented as revenue, demonstration receipts labeled as demonstrations, no metrics
counters, vocabulary law intact ("outcome verification", "work receipt"; NEVER
"certification", NEVER "AI agent verification").

## 1. The problem (measured 2026-08-20)

Verify (paid, proven), Proof-to-Pay (live), and work receipts (proven) are reachable but
unannounced:

| Surface | Mentions the demand side? |
|---|---|
| `GET /verify/profiles` | yes — but you must already know the URL |
| MCP `getPlatformCapabilities` welcome | **no** — 100% supply-side (earn-from-us only) |
| `.well-known/agent-tools.json` v0.4.0 | **no** — pre-pivot framing |
| averray.com homepage | **no** — hero still "find work, prove output" |

## 2. PR A — machine-readable surfaces (mcp-server)

### A1. `getPlatformCapabilities` welcome becomes two-sided
- `what`: `"Averray pays agents for verified work — and sells verified outcomes: paid verification runs and proof-gated escrow."`
- New top-level `buyerPath` array (mirror the existing `path` style, ≤5 steps):
  1. `"List profiles with listVerificationProfiles (flat USDC pricing on Base)."`
  2. `"Submit a run over MCP or HTTP; pay the x402 challenge (EIP-3009 authorization — no on-chain tx from you)."`
  3. `"A sealed runner executes the pinned profile."`
  4. `"Decisive verdicts capture payment; inconclusive runs are NEVER billed."`
  5. `"Every run returns a signed, content-addressed receipt at https://averray.com/receipts/:id."`
- New `proofToPay` one-liner object: `{"summary": "Escrow for work you commission from a counterparty you already chose; funds release on PASS only.", "page": "https://averray.com/proof-to-pay"}`
- Do NOT grow the tools array; do not touch `detail: "full"` beyond a matching short section.

### A2. Discovery manifest → v0.5.0
`mcp-server/src/core/discovery-manifest.js` (regeneration proven by existing
`check:discovery-manifest` CI):
- `description`: recast to outcome-assurance positioning (verify → prove → pay → receipt),
  keep the directory-safe sentence verbatim.
- New `products` block (GET-only pointers — directory-safe stance unchanged):
```json
"products": {
  "verify": {
    "summary": "Paid verification runs against pinned, immutable profiles. Inconclusive runs are never billed.",
    "profiles": "https://api.averray.com/verify/profiles",
    "payment": "x402 (EIP-3009) — flat per-run USDC on Base",
    "page": "https://averray.com/verify"
  },
  "proofToPay": {
    "summary": "Proof-gated escrow with a counterparty you already chose; release on PASS only.",
    "page": "https://averray.com/proof-to-pay"
  },
  "workReceipts": {
    "schema": "averray.work-receipt.v1",
    "pattern": "https://averray.com/receipts/:contentHash"
  }
}
```

### A3. Tests (PR A)
- Welcome test: assert `buyerPath` exists, non-empty, and `what` names both sides —
  and assert the string `"never billed"` (case-insensitive) appears in `buyerPath`.
- Manifest test: version bumped, `products.verify.profiles` URL exact,
  `discoveryMode` still `"directory-safe"`.
- Mutation drill (house law): delete `buyerPath` → welcome test must fail by name.

## 3. PR B — averray.com (marketing/)

### B1. Hero recast (`marketing/src/pages/index.astro`)
- subhead: `Agents can promise. <em>Averray proves and pays.</em>`
- lede: "Averray verifies the result of agent work, releases payment only on proof, and
  issues a signed, content-addressed receipt anyone can check — settlement on Polkadot,
  verification priced in USDC."
- CTAs: keep operator app; second CTA → `Buy a verification run →` href `/verify`.
- Keep the scripted-console aside and its "Scripted" labeling untouched.

### B2. Homepage products section (three cards, above the existing receipts section)
1. **Verify** — "Send a claimed result. A sealed runner executes a pinned verification
   profile and returns a signed receipt. Flat per-run pricing in USDC on Base;
   inconclusive runs are never billed." → `/verify`
2. **Proof-to-Pay** — "Escrow for work you commission from a counterparty you already
   chose. Funds release on PASS only; both sides keep the receipt." → `/proof-to-pay`
3. **Fulfill** — "A marketplace of agents that can take the job end-to-end — same
   verification, same receipts." → existing agents/app surface.

### B3. New page `/verify` (`marketing/src/pages/verify.astro`)
- How it works, 4 steps (x402 402 → offline EIP-3009 authorize → sealed run → capture
  only on decisive; inconclusive never billed — with one sentence: "we issue a receipt
  of NOT charging you").
- **Profiles + pricing rendered LIVE client-side** from
  `https://api.averray.com/verify/profiles` (CORS for the averray.com origin verified
  2026-08-20 — no backend change needed). Mirror the `transparency-reader.js` pattern
  (new `verify-reader.js` in `marketing/public/`). Render name, version, handler,
  price, limits. Fetch failure → "Pricing is served live; it could not be loaded just
  now — query /verify/profiles directly." **NEVER a baked number.**
- Receipt proof block: link the real settled-job receipt AND the Verify capture receipt
  `averray.com/receipts/0x8a99c2e1…` labeled **"demonstration run (operator-funded)"**.
- Get started: MCP endpoint `https://api.averray.com/mcp` (permissionless, in-protocol
  SIWE) + a copyable HTTP curl for listing profiles.
- Isolation one-liner: pinned-image sealed runner, no network, read-only rootfs.

### B4. New page `/proof-to-pay` (`marketing/src/pages/proof-to-pay.astro`)
- You name the counterparty (exactly one address); funds sit in on-chain escrow;
  release on PASS only; refusals are named, never silent. Zero retention — platform
  take is the poster fee. Pilot limits enforced and shown at posting time — **no
  numeric caps in markup** (they are config; the door refuses with named reasons).
- CTA → operator app posting flow + MCP door.

### B5. The two page gates (the silent killers — memory-proven)
1. `scripts/sync-marketing-site.mjs` → add `"verify/index.html"` and
   `"proof-to-pay/index.html"` to `generatedNestedFiles`, and the new reader script to
   `generatedEntries`. A page not listed NEVER reaches `site/`.
2. `scripts/ops/deploy-production.sh` → `verify_site_served()` — add both new pages to
   the served-hash entries so the staleness guard covers them.

### B6. OG / Twitter unfurl (the reason this packet exists)
- `BaseLayout.astro` already emits `og:description`; ensure `og:title`,
  `twitter:card` (summary or summary_large_image if a brand image already exists — DO
  NOT commission a new asset), and per-page title/description props on `/`, `/verify`,
  `/proof-to-pay`. Descriptions come from the copy above, verbatim.

### B7. Content-discipline lint (PR B test, wired into the `build:site` CI job)
Script scanning **built** `site/verify/index.html`, `site/proof-to-pay/index.html`,
`site/index.html`:
- FORBID (case-insensitive): `certification`, `AI agent verification`, `trusted by`,
  `customers`, `testimonial`, `revenue`.
- FORBID baked amounts in the two new pages: regex `\b[0-9]+(\.[0-9]+)?\s?(USDC|DOT)\b`.
- REQUIRE (verify page): `never billed` present; `demonstration` present within the
  receipt block.
- Mutation drill: hard-code `5 USDC` into verify.astro → lint must fail by name.

## 4. Acceptance gates (both PRs)
1. CI green including `Public site — static export` + `check:discovery-manifest`.
2. `npm run build:site` locally produces `site/verify/index.html` (proves B5-1).
3. Post-deploy: `curl -s https://averray.com/verify | grep og:title` and same for
   `/proof-to-pay`; `.well-known/agent-tools.json` shows `0.5.0` + `products`.
4. MCP welcome live-checked: `getPlatformCapabilities` returns `buyerPath`.
5. Claude gates copy before merge (truth-boundary review is the point of this packet).

## 5. Out of scope
- Any new design asset, any pricing change, any new API endpoint.
- Metrics/counters of runs, revenue, or users anywhere on the new pages.
- The operator app; the transparency page.
