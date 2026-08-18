# RUNSHEET — Averray Verify paid door, first live capture

- **Purpose:** prove the x402 → verify → capture → receipt path with real money,
  once, under control, before a stranger can reach it.
- **Operator:** Pascal signs and runs. **Gate:** Claude, between every phase.
- **Prerequisite met 2026-08-18:** signer `0x5a6836c6D4d293F6E5377E6c28054F4171915813`
  holds **0.00045406 Base ETH** (~1,164 captures at 0.006 gwei). Nonce 0.
- **Value at risk:** 5 USDC that we pay to ourselves, plus a fraction of a cent
  of Base gas. Nothing else can move.

---

## 0. The honesty rule for this exercise

**We are both buyer and seller.** That is fine for a rehearsal and fatal if it
leaks into a number. This run is a **rehearsal, not revenue**:

- The 5 USDC never appears in protocol revenue, the transparency page, or any
  external-verified-outcome count.
- The receipt it produces is real and must stay reachable — but the buyer wallet
  must be registered in the **SelfIdentityRegistry** so every downstream count
  classifies it as ours.
- If the arming window closes before an outsider has paid, the honest statement
  remains "zero external paid runs".

## 1. Pre-flight (read-only, no arming)

Run before touching config. All must pass:

```bash
curl -s https://api.averray.com/verify/profiles | jq
curl -s https://api.averray.com/health | jq '.status'
```

- [ ] `git-patch-tests-v1@1` listed, price **5 USDC**, network **eip155:8453**.
- [ ] health `ok`.
- [ ] Buyer wallet holds **≥5 USDC on Base** and can sign EIP-3009.
- [ ] Buyer wallet address recorded here → `______________________`
      and added to the self-identity registry **before** the run.
- [ ] Claim a target: a repo + commit + failing test we control. Do **not** use a
      third party's repo for a rehearsal.

**Abort condition:** anything above unclear → stop. Nothing has changed yet.

## 2. Arm (the only irreversible-ish step, and it is reversible)

Set `X402_VERIFY_MODE=enabled` in `deploy/backend.mainnet.env.template`, deploy,
then immediately verify:

- [ ] Deploy green (watch it — three deploys failed on 2026-08-18 for unrelated
      reasons; do not assume).
- [ ] `POST /verify/runs` **without** payment returns **402** carrying the
      challenge, and no run is created.
- [ ] `/verify/profiles` still lists correctly.

**Rollback:** set back to `disabled` and deploy. The door shuts; nothing is owed.

## 3. Dry leg — authorize only

Construct the EIP-3009 authorization but **do not** submit the run yet. Verify
offline, exactly as the gate will:

- [ ] Domain built from token **`name()`** = "USD Coin", **never `symbol()`**.
- [ ] `value` **exactly** 5000000 (6dp) — not more, not less.
- [ ] `to` = our Base receiving address.
- [ ] `validBefore` ≥ now + profile timeout + **600s** capture margin.
- [ ] Nonce unused.

**Claude gates this before anything is sent.** Paste the signed authorization
fields (not the private key — never the key).

## 4. Wet leg — the run

```bash
curl -sS -X POST https://api.averray.com/verify/runs \
  -H 'content-type: application/json' \
  -H "x-payment: <authorization>" \
  -d '{"profile":"git-patch-tests-v1","profileVersion":1,
       "target":{...},"inputs":{...}}' | jq
```

Then poll `GET /verify/runs/:runId`.

Expected: `authorized` → running → decisive verdict → `billing.status: captured`
with a Base transaction hash → receipt id.

## 5. Verify the capture on chain — independently

Do **not** accept the API's own word for it:

- [ ] Base tx `status=1`, `from` = `0x5a6836…5813`.
- [ ] Buyer USDC on Base **−5.00**; receiving address **+5.00**.
- [ ] Signer Base ETH decreased by roughly one capture (~0.0000004 ETH).
- [ ] `GET /receipts/:receiptId` resolves; `intent.specSource = "verify_request"`;
      **no `settlement` section**; `valueAtRisk` = the 5 USDC fee.
- [ ] Public page renders at `averray.com/receipts/:id`.

## 6. The inconclusive rehearsal (do this too — it is the honest half)

Re-run with a deliberately unreachable target so the verdict is `inconclusive`:

- [ ] Verdict `inconclusive` with a reason from the taxonomy.
- [ ] **No Base transaction was submitted** — the authorization simply expires
      unused. Confirm the buyer's USDC balance is **unchanged**.
- [ ] `billing.status` is not `captured`.
- [ ] The customer is told the run was inconclusive, **not** that their artifact
      failed.

A paid door that cannot prove it declines to charge is not finished.

## 7. Close out

- [ ] Decide: leave armed, or set `disabled` until outreach produces a buyer.
      **Recommendation: leave armed** — the exit condition is a stranger paying,
      and they cannot if the door is shut.
- [ ] Record both receipt ids here.
- [ ] Memory: first live capture + the inconclusive proof.
- [ ] **Do not** publish an "Averray Verify" page yet. The truth-boundary gate is
      a *stranger* paying, and we just paid ourselves.

## 8. Failure playbook

| Symptom | Meaning | Action |
| --- | --- | --- |
| 402 with `expiry` reason | `validBefore` too near | Re-sign with a longer window; nothing lost |
| Capture reverts | nonce used, or signer out of gas | Run degrades to inconclusive and bills nothing — check ETH, re-sign |
| Verdict `platform_fault` | our runner broke | Nothing billed; fix, rerun |
| Run charged but no receipt | **should be impossible** | Stop, do not retry, capture evidence, page Claude |

Last row is the only one that is an incident. Everything else is the design
working.
