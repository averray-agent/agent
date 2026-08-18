# PACKET — V4, the paid door (x402 intake for Averray Verify)

- **Status:** SPEC — ready for Codex.
- **Phase:** V4 of [`OUTCOME_PIVOT_BUILD_PLAN.md`](./OUTCOME_PIVOT_BUILD_PLAN.md); completes
  [`PACKET_VERIFY_SHELF.md`](./PACKET_VERIFY_SHELF.md).
- **Author:** Claude, 2026-08-18, grounded in the merged #1161 code on `origin/main`.
- **Why it is its own PR:** this is where money attaches. A bug here either takes
  a stranger's money without running anything, or runs without being paid.
- **Exit condition:** a stranger pays and gets a verdict plus a receipt, without
  talking to us. Until that is literally true, no public "Averray Verify" page.

---

## 0. The good news: the seam already exists and it is the right one

#1161 did not stub payment as an afterthought — it built the correct lifecycle
and left a hole shaped exactly like this packet:

```
authorize()  →  run  →  capture()   only on approved|rejected
                     →  release()   on inconclusive | platform_fault
```

`VerificationRunService` takes an injected `paymentGate`, defaulting to
`UnavailableVerificationPaymentGate`, which throws `402
verification_payment_required` **before any work runs**. Capture is already
gated on a decisive verdict; `inconclusive` and `platform_fault` route to
`release()` + `notBilled(profile)`. Even a *capture failure* degrades the run to
`inconclusive` and bills nothing — if we cannot take the money cleanly we do not
claim a verdict. That is the conservative direction and it must not be relaxed.

**So V4 is one class plus its wiring:** implement `X402VerificationPaymentGate`
against the existing interface and inject it in `bootstrap.js`. **Do not
restructure the lifecycle.**

## 1. The design question, and why x402 answers it natively

x402 looks like pay-then-serve, which appears to fight "inconclusive is never
billed". It does not, because the x402 payment proof is an **EIP-3009
`transferWithAuthorization` signature** — a signed authorization the payee
submits when it chooses. That maps onto the seam exactly:

| Seam | x402 reality |
| --- | --- |
| `authorize()` | Verify the signature **offline**. No chain write. Instant, free. |
| `capture()` | Submit `transferWithAuthorization` on Base. One tx, our gas. |
| `release()` | Simply never submit it. The authorization expires unused. |

**The customer is not refunded for an inconclusive run — they are never charged
at all.** Strictly better than a refund, and honest: nothing to reverse, nothing
to explain.

## 2. `authorize()` — verify, do not trust

Offline checks, all mandatory, failing closed with `402` and a reason:

- Signature recovers to the stated payer over the **EIP-712 domain from the
  token's `name()`** — "USD Coin", **never** `symbol()`. This has bitten us
  before; reproduce `DOMAIN_SEPARATOR` and assert it rather than assuming.
- `value` **exactly equals** `profile.price.amountRaw` — not ≥. An overpayment
  is a mistake we refuse, not a tip we keep.
- `to` is our Base receiving address; `chainId` is Base.
- Nonce unused, `validAfter` passed.
- **`validBefore` leaves a real margin.** This is the failure mode most likely
  to be missed: if the authorization expires while the run executes, we deliver
  a verdict we cannot charge for. Refuse at authorize unless
  `validBefore ≥ now + profile.limits.timeout + CAPTURE_MARGIN` (start at 10
  minutes). The 402 must say so plainly so the client can re-sign.

## 3. Replay — one proof buys exactly one run

Two independent layers, because either alone is insufficient:

1. **Ours:** #1161 already derives `paymentKey = hashCanonicalContent(paymentProof)`
   and keys the run by it. Make the uniqueness constraint explicit and tested —
   a replayed proof must return the **existing** run, never start a second.
2. **The chain's:** EIP-3009 nonces are single-use, so a replayed capture
   reverts. Treat that revert as expected, not as an error to surface.

Idempotency here is a correctness property, not a nicety: retries are normal
client behaviour over a flaky network.

## 4. What this gate must NOT contain

The poster ramp (`payments/x402-poster-ramp.js`) carries a Base→Hub float cap, a
settlement adapter and escrow pre-funding, because posting must fund a Hub-side
escrow before Base payment settles. **A verification run has none of that** — no
escrow, no worker payout, no Hub-side obligation. Reuse the ramp's *payment
verification primitives*; do not inherit its machinery.

- **No float cap.** Nothing is fronted.
- **No bridge, no settlement adapter, no Hub write.** Revenue accumulates on
  Base (ratified) and is swept later as an explicit, evidenced transaction.
- Until the first sweep lands, verify revenue is reported as **its own line** and
  never folded into protocol revenue.

## 5. Close the open gap from #1161

The no-settlement isolation guard is a **static source check** — strong,
self-proving, but blind to settlement reached *indirectly* through a module that
itself imports the gateway. Money now attaches, so add the runtime half: execute
a verification run with a gateway double whose every method throws, and assert
the run completes normally. Static guard stays; they cover different failures.

## 6. Tests

- **Never charged on inconclusive:** an inconclusive run leaves the
  authorization unsubmitted; assert no Base transaction and `billing.status !== "captured"`.
- **Capture failure never yields a paid verdict:** force `capture()` to throw;
  the run must degrade to `inconclusive`, bill nothing, and release.
- **Replay:** the same proof twice returns one run and captures once.
- **Expiry margin:** an authorization expiring inside the run window is refused
  at authorize, before any work.
- **Exact price:** under- and over-payment are both refused.
- **Domain correctness:** a signature built with `symbol()` instead of `name()`
  fails verification — mutation-drill it so the check cannot silently invert.
- **Runtime isolation** (§5).
- **Unpaid still 402s before work**, preserving #1161's behaviour.

## 7. Out of scope

Other profiles, Proof-to-Pay, the Base→Hub sweep mechanics (separate, ceremonied),
refunds (nothing to refund by construction), and any public marketing page.

## 8. Settings

Price $5 flat per run, from the profile registry — not hardcoded here.
Base receiving address and RPC via config, fail-closed if unset: an unset
address must disable the gate back to `402`, never fall back to a default.
