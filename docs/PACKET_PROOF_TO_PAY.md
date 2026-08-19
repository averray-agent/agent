# PACKET — Averray Proof-to-Pay (bring-your-own-counterparty)

- **Status:** SPEC — RATIFIED 2026-08-19 (Pascal). Ready for Codex.
- **Phase:** P of [`OUTCOME_PIVOT_BUILD_PLAN.md`](./OUTCOME_PIVOT_BUILD_PLAN.md).
  Unblocked 2026-08-19: the work receipt (Phase R) is proven live, and the
  Verify rail (Phase V profile 1) has captured its first payment end to end.
- **The product in one line:** the customer brings BOTH sides — their task and
  their provider — and Averray binds spec, escrow, verification, and payout:
  **escrow releases on PASS only.** No marketplace liquidity required. This is
  the surface that removes the cold-start problem.
- **Deliverable law applies:** patch-shaped, never PR-shaped
  (build plan §5b). The provider's deliverable is verified content; we never
  hold write credentials on anyone's repository.

---

## 0. Grounding (read against origin/main, 2026-08-19)

Nearly everything exists. An agreement is an **external poster-funded job plus a
designated claimant**:

| Piece | State |
| --- | --- |
| Spec binding | `specHash` F1–F4, LIVE — the definition (incl. verifier config) is already integrity-pinned at claim |
| Funding | External poster door LIVE (draft → quote → deposit; x402 ramp PROVEN) |
| Verification | benchmark/deterministic auto-verify LIVE; `INCONCLUSIVE` + `PLATFORM_FAULT` + `workerConsequence: none` LIVE |
| Settlement + fees | Poster fee `max(5%, 0.05)` LIVE (v3, first revenue proven); settle → AAC → self-withdraw PROVEN |
| Disputes | 7-day window + arbitrator LIVE |
| Receipt | Work receipt PROVEN live; `providerClass: external` by construction |
| Per-wallet claim gating | `claim-state.js` already computes `currentWalletCanClaim` — **the gate has a home** |
| **Designated-claimant policy** | **MISSING — the one real build** |

## 1. The build: `designatedClaimants`

A new optional field on the external job definition: an array of **exactly one**
EVM address for the pilot (schema allows the array so widening later is not a
breaking change).

- **Claim gate:** for a designated job, `currentWalletCanClaim` is true only
  for the named wallet; every other wallet gets a refusal with reason
  `designated_claimants_only` — in preflight AND at claim (preflight mirrors
  the claim gate; the #834 parity law).
- **Progression valves do not apply to designated claims** (architect ruling,
  gate will hold it): S/E/D and the external reward ceiling exist to manage
  OUR subsidy and progression fairness for workers we route. A buyer-designated
  provider is the buyer's own counterparty — the designation IS the
  authorization. The **claim stake stays** (10% + fee floor, slashable on
  upheld rejection): it protects dispute integrity, not routing, and it keeps
  designated and routed claims economically comparable in disputes.
- **No brokered gas, no retention:** designated jobs set
  `requiresSponsoredGas: false`; the provider claims self-funded, so the v3
  retention lane never applies. The platform's take is the poster fee, full
  stop.
- **Board truth:** a designated job must NEVER read as open supply. It is
  excluded from claimable counts, lane inventory (external jobs already bypass
  lanes), and "open runs" surfaces — shown as `restricted` with the
  designation visible to the two parties and the operator only.
- **Field contract:** external definition validation accepts the new field
  strictly (checksummed address, exactly 1 entry, no other new fields ride in).
  Curated/admin paths may also set it (that is how we rehearse).

## 2. Flow (all existing rails)

```
buyer:    POST /jobs/draft {definition + designatedClaimants:[provider]}
          fund (deposit route or x402)            ← existing
provider: SIWE → preflight (eligible, designated) → claim (stake posted)
          submit patch-shaped deliverable          ← existing
platform: auto-verify against the pinned spec      ← existing
          PASS  → settle: provider net + poster fee to treasury → receipt
          FAIL  → rejection flow (stake rules as today)
          INCONCLUSIVE → holds, human/dispute path; never auto-settles
          PLATFORM_FAULT → workerConsequence: none  ← existing
```

The receipt is the standard work receipt: intent carries the buyer as poster
and the specHash; execution carries the designated provider,
`providerClass: external`; settlement reconciles `posterTotal = reward + fee`.

## 3. Pilot caps (fail-closed, logged, no silent refusals)

- Max **5 concurrent** designated agreements platform-wide.
- Max **25 USDC** reward per agreement.
- Both enforced at draft AND at funding; refusal names the cap and the current
  count, per the no-silent-caps law. Constants in one module; changing them is
  a one-line ratified PR, not an env flip.

## 4. Explicitly out of scope

Provider sourcing (that is Fulfill), profile-pinned verification for jobs
(v2 enrichment — `specHash` already pins the verifier config), multi-claimant
designation, bond-request field beyond the ratified default (§6), any contract
change, any new custody class (external funds already flow through escrow —
the buyer now also names the recipient; Swiss-memo event trigger unchanged).

## 5. Tests that must exist

1. Designated wallet claims; any other wallet refused with
   `designated_claimants_only` — asserted in BOTH preflight and claim
   (parity mutation-drill: break one, the test fails).
2. Designated jobs never appear claimable on public surfaces and never count
   as open inventory.
3. Valve bypass is designated-only: an ordinary external claim still hits the
   ladder; a designated claim skips it; the claim STAKE posts in both.
4. Fee reconciliation on settle: provider net + poster fee, retention ZERO;
   the receipt's `posterTotal = reward + fee` invariant holds.
5. Cap refusals at 6th concurrent and at 26 USDC, each with the named reason.
6. `INCONCLUSIVE` never settles; `PLATFORM_FAULT` carries
   `workerConsequence: none` with the stake returned.
7. External field contract rejects: 2+ claimants, malformed address, or any
   unknown rider field.

**Exit condition:** one agreement completes buyer → designated provider →
verify → settle → public receipt, with the platform supplying neither side.

## 6. Decisions — RATIFIED 2026-08-19 (Pascal)

1. **Pilot caps: 5 concurrent / 25 USDC each.** Worst-case 125 USDC designated
   escrow — a real pilot, boring to a memo. Changing them is a one-line
   ratified PR, never an env flip.
2. **No bond option in the pilot.** The buyer chose their provider; the
   standard claim stake already protects dispute integrity.
   `requireProviderBond` ships later only if a real buyer asks.

### Original framing (kept for rationale)

1. **Pilot caps** — recommend 5 concurrent / 25 USDC each (mirrors the L2 cap
   scale; big enough for a real pilot, small enough to be boring to a memo).
2. **Provider bond default** — recommend NO poster-side bond option in the
   pilot: the buyer chose their provider, the claim stake already protects
   dispute integrity, and every removed field is intake friction removed. A
   `requireProviderBond` option can ship later if a buyer asks for it.
