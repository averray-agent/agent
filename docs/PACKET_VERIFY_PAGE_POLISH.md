# PACKET — Verify page polish

Status: READY FOR CODEX · 2026-08-27 · Author: Claude (architect+gate) ·
Repo: **platform, marketing** · One PR.
Follow-up to #1311, which is live at `averray.com/verify/`. **The page is
sound** — no baked price, forbidden word absent, byte-identical claim verified
against production. These are consistency defects found by reading the live
DOM, not a rewrite.

## 1. The page and the discovery document disagree in words (sharpest)

| source | text |
|---|---|
| discovery `resources[0].description` | "Inconclusive runs are never **charged**." |
| the page | "Inconclusive runs are never **billed**." |

Same promise, two words — **on a page whose central claim is that what your
agent reads is exactly what it signs.** Any drift between the page and the
machine-readable source quietly undercuts the thesis the page is built on.

**Fix: render that sentence FROM discovery**, the same way the price is
rendered, rather than restating it. If it must be static, quote the discovery
wording verbatim. Pin with a test that fails if the page's static copy diverges
from the served description.

## 2. The same destination is labelled two different ways — twice

| destination | labels in use |
|---|---|
| `api.averray.com/verify/profiles` | "Open live profiles" · "Inspect profiles and worked examples" |
| `api.averray.com/.well-known/x402` | "the discovery document" · "Open live x402 discovery" |

Two doors, four names. On a page whose job is to hand an agent **two URLs**,
naming each of them twice works against the message. Pick one label per
destination and use it everywhere.

## 3. The three cost cards are not structurally parallel

```
PER RUN     | 5 USDC per run                | exact payment · x402 version 2
ASSET       | Base (eip155:8453)            | 0x833589fc…
RECIPIENT   | Published by discovery        | 0x1013e3fe…
```

The middle slot holds three different kinds of thing: a **value**, a **chain**,
and a **provenance note**. "Published by discovery" is also a category error —
*all three* cards are published by discovery; that is the section's whole
point. Give the middle slot one consistent meaning across the three cards.

## 4. "PER RUN" over "5 USDC per run"

The unit is stated twice in adjacent lines. The card label already says it.

## 5. The hero's secondary CTA drops a first-time reader into raw JSON

Primary "Give your agent the API doors →" goes to `#buy` (good — it moves the
reader down the page). Secondary "Open live profiles" jumps straight out to a
JSON endpoint **before the reader has any context for it**. Consider making the
secondary action stay on-page, and keep the raw endpoint links in the "How an
agent buys" section where they are explained.

## Non-negotiables

1. Every existing #1311 guard still passes: no numeric price in markup, the
   forbidden word absent (mutation-tested), both allow-lists intact.
2. The byte-identical claim stays — it is verified true and is the page's
   strongest sentence.
3. No new product, revenue, customer, or certification claim.
4. Truth-boundary review before handback.

## Handback

PR number; green CI; the new/changed test names; the chosen single label per
destination; and confirmation that the page's inconclusive-runs wording now
matches the served discovery description exactly.
