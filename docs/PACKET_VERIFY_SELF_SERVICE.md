# PACKET — The paid Verify door must be self-service

Status: READY FOR CODEX · 2026-08-25 · Author: Claude (architect+gate) ·
Repo: **platform (averray-agent/agent), mcp-server** · One PR.
Ship this **before** `PACKET_X402_HOP.md` — discovery pointing at a door
nobody can open only advertises frustration.

## The evidence

On 2026-08-25 a competent external agent completed the first paid Verify
run. It succeeded — and that is the problem: it succeeded only because a
human wrote it a ~700-word brief first, and because I had personally walked
the endpoint's validation errors one at a time to discover the request
shape.

x402 exists so a machine can find a paid endpoint and pay it **without a
human explaining anything.** A paid door that needs a hand-written brief has
failed at its own purpose, no matter how correct its economics are.

What the buyer hit, in its own words:

| friction | what it cost |
|---|---|
| `profile` + integer `profileVersion`, not `name@version` | guessed wrong, ate a 400 |
| target rejects `kind` and `ref`; accepts only `repository` + `commit` | two more 400s |
| `gitBundle` and `patch` are hosted `{sha256, bytes, locator, format}` objects, not inline data | had to publish artifacts before it could even see a price |
| `git bundle --all` advertises two heads; the verifier wants one | silent mismatch |
| patch `format` is `file`; bundle `format` is `git-bundle` | discovered by 400 |
| a binary bundle cannot survive GitHub's UTF-8 Contents API | forced a different host |
| `testCommand` is an array, not a string | another 400 |
| a queued `200` carries no settlement header; the tx only appears after PASS | thought it had failed |

**One missing field per response** is the root cause of most of that. It
turned a single request into roughly a dozen round trips.

## A — Say everything that is wrong, at once

Validation must return **all** violations in one response, not the first one
found. Keep the existing error vocabulary and status codes; add the complete
list. An agent should be able to fix its request in one iteration.

## B — Publish a complete worked example

`GET /verify/profiles` already carries each profile's schema, price, and
limits. Add, per profile, a **copy-pasteable example request body** with
every required field populated by a placeholder that shows its *shape* —
real formats, obviously-fake values (`<64-hex>`, `https://example.invalid/…`).

An agent reading only this document must be able to construct a valid
request without a single trial-and-error call. That is the acceptance test:
build the request from the example alone and it must pass validation.

Include the non-obvious facts inline, where they are needed:
- the bundle must advertise exactly one head,
- `format` values are `git-bundle` and `file`,
- artifacts are fetched from your `locator` URL, so they must be reachable
  and byte-stable, and a text-only host will corrupt a binary bundle,
- `testCommand` is an array.

## C — Make the asynchronous shape explicit

A `queued` 200 is not a failure and is not a completed purchase. State in the
response what it is, what to poll, and that the settlement transaction
appears only after a PASS. The buyer above believed the run had silently
failed; that is a bug in our communication, not in its reading.

## D — Reduce the artifact burden if it is cheap

Two hosted artifacts is a real barrier to a first purchase. **Investigate
only** — if inline artifacts under a small size limit are straightforward
and safe, propose it in the handback with the size ceiling you would pick.
Do not implement it in this PR; hosting has security properties (fetch
isolation, size limits, no SSRF) that deserve their own review.

## Non-negotiables (each pinned by a test)

1. **All violations at once**: a request missing four fields returns four
   named violations in one response.
2. **The published example validates**: a test builds the request from the
   example document alone and asserts it passes validation.
3. **The queued response explains itself** — what it is, what to poll, when
   the tx appears.
4. Prices, the payment gate, the 402 challenge, and `inconclusive_not_billed`
   are byte-identical. This packet changes what we *tell* buyers, never what
   we charge them.
5. No new endpoint, env, or capability.

## Out of scope

The payment gate, `/.well-known/x402` (its own packet), implementing inline
artifacts, and any change to verification semantics.

## Handback requirements

PR number; green CI; the three behaviour test names; the published example
for `git-patch-tests-v1` verbatim; the queued-response copy; and your
recommendation on D with a size ceiling.
