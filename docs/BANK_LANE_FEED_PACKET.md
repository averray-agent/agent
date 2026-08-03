# Bank lane feed endpoint — implementation packet

**Owner:** Codex (backend / observer lane)
**Sequence:** after the dust cycle. Leg 2 produces the first calibration event — capture it.
**Consumer contract:** `services/slack-operator/src/bank-feed.ts` in
`depre-dev/averray-reference-agent` (PR #697) — authored and test-covered.
Implement to it exactly; it is the interface, not a suggestion.
**Status of the lane:** the wrapper is armed on mainnet. This is a
definition-of-done item of the active activation, not a later phase.

---

## What to build

A read-only endpoint exposing the Bank lane's data, derived from the #910
observer's reads. Shaped like `/monitor/product-health`: **non-secret,
internal-network, no auth**.

Hermes renders four facts from it — in-flight requests, the aToken position,
the operating float, and the wrapper postage balance — and nothing else needs
to be in the payload.

## Two things it must not be

**Not `/admin/status`.** That route is `requireRole: "admin"`. Minting a third
rotating credential chain so a read-only board can watch a position is a real
key-surface increase for a display concern.

**Not Hermes reading Hydration directly.** Two protocols live behind this data
— the aToken position is `balanceOf` on Hydration's EVM ledger, the operating
float is `Tokens.accounts(…, 22)` over Substrate. Neither belongs in a display
process, and nor does an `@polkadot/api` dependency.

One reader of the chain; Hermes renders.

## The shape

| field | contents |
| --- | --- |
| `position` | `{ raw, source, readAtMs, lastError }` — aToken, `balanceOf(truncate20(convertedAccount))` |
| `float` | `{ raw, source, readAtMs, lastError }` — asset 22, `Tokens.accounts(convertedAccount)` |
| `postage` | `{ raw, source, readAtMs, lastError }` — wrapper postage account |
| `requests` | `{ items[], readAtMs, lastError }` |
| `calibration?` | `{ provenAtMs, provenRaw, provenSource }` |

`items[]` entries: `{ id, kind, phase, ageSeconds, overdue }`.

---

## Five rules that are easy to get wrong

### 1. `readAtMs` is when THAT read completed — not when the response was assembled

The one most likely to be lost. A feed built fresh from a position read that
failed forty minutes ago is exactly the case per-source timestamps exist to
catch, and a single assembly timestamp defeats the entire mechanism *while
looking correct*.

Every section carries its own clock, and they will legitimately differ.

### 2. Raw decimal strings only. Never floats

These are token amounts. `"28463"` — not `0.028463`, not `2.8463e4`. The
consumer formats; the feed transports exactly.

Reconciliation happens against fee constants measured in single raw units
(602 funding / 20,201 sell / 1,402 home), so a lost digit is a lost audit.

### 3. `phase` and `overdue` are yours to decide, and Hermes never recomputes them

`overdue` is your judgement against your own deadline. If the board re-derived
it from `ageSeconds`, the two services would eventually disagree — and then
there are two answers to a question that must have one.

`phase` is an **open string**. The consumer renders unknown values verbatim and
flags them, counts them as in-flight, and never treats them as terminal. Adding
`recovery-pending` therefore needs no board change.

### 4. An empty `items[]` must mean EMPTY, never UNREAD

If the request table could not be read, set `lastError` and leave `readAtMs`
honest. This is the tile whose entire job is the stuck-pending alarm; an
unreadable table rendering "no requests in flight" is all-clear because nobody
could look.

### 5. `null` raw is not zero

An unreadable balance and an empty one are different facts about money. Never
coerce one into the other.

---

## Calibration — backend-owned, durable

The record answers one question: **has this read path ever observed a non-zero
value?**

It belongs to the service that performs the read, because an entity that has
never executed the read cannot attest that it works — the same reason the payout
panel corroborates the funnel from chain rather than from the ledger's own
claim. Proof has to come from outside the thing being proven.

- Set it the first time the position read returns non-zero. **Leg 2 of the dust
  cycle is that event.**
- `provenRaw` = what was seen. `provenSource` = the exact address **and** ledger
  that proved it.
- **Durable across restarts.** A flag in process memory would un-calibrate the
  tile on every deploy.
- **Invalidated on any retarget.** A proof taken against one address says
  nothing about another.
- **A zero can never calibrate anything.**

### Why the rule exists

Hydration's `AssetRegistry.assets(1003)` declares `assetType: "Erc20"`, so
`Tokens.accounts(…, 1003)` returns **zero by design** — the position lives in
the ERC-20 ledger. A tile pointed at the wrong ledger reads 0 and renders a
drained position.

The same shape has already shipped twice on the payout instrument: once watching
the signer EOA instead of `AgentAccountCore`, once watching for an ERC-20
`Transfer` the USDC precompile never emits. Both were confident zeros from a
misconfigured reader, and retargeting is what broke them.

So on the consumer side: a zero from a read path that has never observed a
non-zero value renders as `unverified`, never as `0.00`. A real zero may only
render after the path has proven, at least once, that it can see funds.

---

## Definition of done

- The endpoint returns the contract shape, with per-read timestamps that
  **visibly differ** when one source is stale.
- An induced read failure on any section produces `lastError` — never a zero,
  never an empty array.
- After leg 2, the `calibration` record is present, **survives a restart**, and
  names the aToken address it proved.

Once this lands, the Hermes rendering slice is mechanical: the view models and
their tests already exist behind this seam.
