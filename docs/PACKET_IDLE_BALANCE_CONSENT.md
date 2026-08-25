# PACKET — Opt-in consent for idle-balance allocation

Status: READY FOR CODEX · 2026-08-25 · Author: Claude (architect+gate) ·
Repo: **platform (averray-agent/agent), mcp-server** · One PR.
Authority: `MEMO_IDLE_BALANCE_YIELD.md` **B3** (RATIFIED) and
`MEMO_IDLE_BALANCE_ROUTE.md` **R1–R5** (RATIFIED). Read both; the memos win on
any disagreement.

**No contract work. No allocation. This captures consent only.**

## Why this exists

`AgentAccountCore.allocateIdleFunds` is `onlyAccountOrSettlementBroker`, so the
platform *can* move an agent's idle balance into a venue without the agent
acting. **Q1 was answered opt-in** precisely because we can: the first time an
agent discovers we allocated funds it never agreed to, we lose the trust the
platform runs on, and no retention gain is worth that.

This packet builds the gate that makes allocation permissible. It ships **before**
the pool change (R2/R3), so nothing can allocate yet — which is deliberate.

## Mirror the locked-tier consent shape

`locked-tier-service.js` already implements the pattern and it is proven: build
a `terms` object → `hashLockedTierTerms` → SIWE-signed against a `consentUri`
→ verify the signature binds that exact hash. **Reuse this shape**, including
`schemaVersion`, `consentNonce`, `issuedAt`/`quoteExpiresAt`, and a stable
terms hash. Do not invent a second consent idiom.

## The one field that must NOT be copied

Locked-tier terms carry:

```js
fundsMovement: "none — the ledger encumbers existing AAC liquid"
```

That is true for a lock and **false for this**. Allocation genuinely moves an
agent's balance out of `position.liquid` into a venue adapter, and it carries
principal risk. The equivalent field here must say so plainly, in the agent's
terms, not in a footnote. Copying the locked-tier sentence would be the exact
defect class as "NAV share active": a surface describing a benefit or a safety
the holder does not have.

State at minimum: funds leave the liquid balance; they are deployed to a
configured external venue; principal is at risk; return is not instant in all
cases (see R4).

## What to build

**A — Consent capture.** Quote → sign → verify → store, per wallet. The stored
record must bind the wallet, the terms hash, the signature, and the time.

**B — Revocation.** Per **B3**, consent is revocable. Revocation takes effect
for *future* allocation immediately; it does not by itself unwind an existing
position (that is deallocation, and it is out of scope here).

**C — Re-check at use, never at capture only.** Consent is captured now and
acted on later, so the allocation path must re-read live consent at attempt
time. **A cached or stale consent verdict must never authorise a movement** —
same law as the activation gate's "re-evaluated at attempt time, never from a
cached verdict".

**D — Honest availability while the route is dead.** The pool change is not
merged, so allocation is impossible. The surface must report
`available: false` with a named reason (e.g. `route_not_live`) and must **not**
solicit consent for a capability that does not exist. Fail closed, in the same
shape as the deposit-pool door. When R2/R3 land, this flips on config, not on
a code change.

**E — R4's honesty about exit.** If the terms describe how funds come back,
they must match R4: synchronous while the adapter's uncommitted balance covers
it, queued with a disclosed ETA beyond that. Do not promise "instant".

## Non-negotiables (each pinned by a test)

1. **No consent, no allocation.** A test proves the allocation path refuses
   when consent is absent, expired, or revoked — asserting the named refusal
   reason, not just a throw.
2. **Revocation is effective immediately** for subsequent allocation attempts.
3. **The signature binds the exact terms hash.** Mutating any material term
   (wallet, amount basis, asset, venue disclosure, nonce) must invalidate it.
   Prove it by mutation, not by asserting a fixed value.
4. **`fundsMovement` states that funds leave and principal is at risk**, and a
   test asserts it does **not** contain the locked-tier "none —" wording.
5. **`available: false` with a named reason while the route is not live**, and
   no consent may be captured in that state.
6. Consent capture changes **no** balance, position, or allocation.

## Out of scope

The pool contract change (R2/R3), the adapter, registration ceremonies, the
allocation keeper itself, per-agent yield disclosure (B5/Y3 — its own packet),
and anything that moves funds.

## Handback requirements

PR number; green CI; the six test names; the exact served `terms` object for a
consent quote including the `fundsMovement` sentence; the named refusal reasons;
and confirmation that no contract, no balance, and no allocation path changed.
