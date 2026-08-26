# PACKET — The Verify page (pivot condition met)

Status: READY FOR CODEX · 2026-08-26 · Author: Claude (architect+gate) ·
Repo: **platform, site/ (marketing)** · One PR.
Authority: the ratified outcome pivot — *"no Verify page until a stranger can
buy."* **That condition is met and proven:** `/.well-known/x402` serves
requirements byte-identical to the live 402 (verified in production), the
published worked example produces a payable 402 with zero trial calls, and a
real 5 USDC purchase settled end to end (Base tx `0x72065b10…4b2e`, receipt
PASS). The gate this page waited on is open.

## What the page is

`averray.com/verify` — the buyer-facing front door for the paid Verify
product. One page, one job: a stranger with an agent and a Base wallet learns
what Verify does, what it costs, and leaves with the two URLs that let their
agent do everything else without a human.

Structure (copy discipline below governs every line):

1. **What it does** — runs your candidate patch/output against the target's
   own tests in an isolated runner and returns a signed receipt with a
   PASS/FAIL verdict. Receipt-keyed, operator-verified — **never**
   "trustless" (the standing copy law from the escrow memo).
2. **What it costs** — read from the live discovery document at render time
   (5 USDC today, Base USDC, x402). **No figure ships in markup** — the
   transparency-page law applies to every marketing surface.
3. **How an agent buys** — the two URLs, verbatim and copyable:
   `https://api.averray.com/.well-known/x402` and
   `https://api.averray.com/verify/profiles` (which carries the worked
   example). State plainly: discovery is byte-identical to the live payment
   challenge, so what your agent reads is exactly what it signs.
4. **Proof, not promises** — link the public receipt of a real settled
   verification. If a public receipt URL is not currently servable for the
   proven run, link the receipt *route* documentation instead and say a
   receipt accompanies every run — do not fabricate an example receipt.

## Laws (each one has burned us before)

- **No invented figures, no invented copy** — every number and every product
  claim from a live API read or an existing ratified surface. When in doubt,
  quote `/verify/profiles` and the discovery doc.
- **Both marketing allow-lists** must include the new page or it silently
  never deploys — name the two files in the handback.
- **Truth-boundary review** on the final copy before handback.
- **Verify is the paid door; worker tools stay free** — the page must not
  blur that boundary (it is the answer to "not another pay-for-API wall").
- No revenue/founder figures — depositor/buyer surface only.

## Pinned by tests

1. Markup contains no numeric price (grep-proof, the transparency pattern);
   the price renders from the discovery fetch.
2. The two URLs appear verbatim and resolve (build-time link check is fine).
3. Allow-lists updated — the existing deploy-visibility test pattern.
4. The word "trustless" does not appear (assert absence — the copy-law guard).

## Handback

PR number; green CI; the two allow-list files; the rendered page copy in
full; confirmation every figure is fetched not baked; the truth-boundary
review verdict.
