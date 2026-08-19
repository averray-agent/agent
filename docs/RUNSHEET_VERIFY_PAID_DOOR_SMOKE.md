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


---

# EXECUTED — 2026-08-19 (two armings)

**First arming (06:33Z–07:12Z):** §1–§3 green; §4 became the GOLDEN FAILURE —
run `verify-174ecced` authorized a real 5 USDC EIP-3009 payment, the runner
died at materialization (`spawn git ENOENT`), and the customer was charged
nothing. Root cause was architectural: the Witness executor drives Docker, and
the Docker socket into the internet-facing backend was REFUSED permanently.
Door disarmed (#1170); the dedicated no-listener Witness runner service behind
a default-deny admission proxy was built the same morning (#1171,
PACKET_WITNESS_RUNNER).

**Second arming (#1173, deployed 11:07Z):**

§4 wet leg — run `verify-b22db3c7-c31d-4253-932d-f953362ef142`:
baseline proven failing twice, patch applied, tests passed → **approved** →
**capture on Base**: tx `0xaf8f617595f9d9f59845ff81646c6d33b085993b1c642c7427277c800df1fd86`
(block 50175446, the signer's first-ever Base transaction).

§5 chain verification, all independent: buyer 6.0→1.0 (−5 exact), payTo
1.05→6.05 (+5 exact), signer nonce 0→1, auth nonce consumed, gas ~0.0000005
ETH. Receipt `0x8a99c2e19b75a7e3b19e1aefb4448be162e89480d953c20ad813b8dda12797c0`
public HTTP 200 — `specSource: verify_request`, `valueAtRisk: 5 USDC`, NO
settlement section, `providerClass: external`.

§6 inconclusive rehearsal — run `verify-330eee92`: `target_unreachable`
("artifact fetch returned HTTP 404"), `not_billed`, **and an inconclusive
receipt issued**: `0xb39cf01627f24f604e1b2c0016d57e725c86ab8c305ccb5083b10ab2ba6e22d0`
(public 200) — a portable record of NOT charging. Chain: buyer still 1.0,
signer nonce still 1 (no capture attempted), §6 auth nonce unused.

§7 close-out: door stays ARMED (ratified); the 5 USDC is a rehearsal, never
revenue — buyer is registry-classified as ours; the honest external count
remains **zero external paid runs**, and no public "Averray Verify" page ships
until a stranger pays.
