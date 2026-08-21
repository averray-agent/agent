# PACKET — L3 posting keeper (purpose-bound job-posting credit, flag-on ready)

**Author:** Claude (architect) · **RATIFIED by Pascal 2026-08-21** — build dispatch-ready; activation stays cohort-gated
**Implementer:** Codex · **Deliverable:** ONE PR (mcp-server). **Build now, ship dormant** —
the on-chain flag stays OFF; activation is a separate multisig ceremony gated on the
ratified sequencing law (L2 cohort with real repayment behavior FIRST).

## 1. What exists vs what this builds

**On-chain, LIVE since the CreditBook ceremony (0x70441c9131Bc47c96E8D839C5B30850924838099):**
`Mode.POSTING` (cap 25), purpose-bound routing — `originate(borrower, amt, POSTING, terms)`
pays `l3PosterWallet`, never the borrower — `repayFromRefund`, and the three multisig
switches (`l3Enabled=false`, `l3PosterWallet=0x0`, empty allowlist).

**This packet builds the OFF-CHAIN orchestration** (CW-ratified flow, spec
`PACKET_CREDIT_L2L3_SPEC.md`):
borrower requests a posting on credit → operator underwrites off-chain
(limit = `min(25, 1.0×net verified earnings)`) → `originate(POSTING)` moves principal
to the poster identity's AAC → keeper posts the borrower's job through the EXISTING
external-poster door from `l3PosterWallet` → tracks the job → on settle, repayment
arrives via the sweep path (`recordSweepRepayment`); on cancel, the refund is
consent-transferred to the book and `repayFromRefund` closes the loan.

## 2. Decisions (CW-ratified; restated as build constraints)

- **Principal never reaches the borrower** — enforced on-chain; the keeper must also
  never construct a path that does (no direct transfers, no borrower-addressed jobs
  funded by the draw).
- **Poster fee NOT waived (CW-7)** and normal retention/gas apply — L3 is wash-negative
  for farming by construction; the keeper takes no step that waives or discounts.
- **Job definition comes from the borrower; posting identity is the operator's.**
  The job carries the borrower's spec verbatim after the SAME validation the external
  poster door applies to any job (no new validation surface, no relaxation).
- **Terms commitment:** `termsHash` = keccak of the canonical terms document
  (pattern proven in the L2 smoke); the keeper stores the preimage with the loan record.
- **One active POSTING loan per borrower** (chain-enforced); the keeper refuses new
  requests while one is open, with a named reason.
- **Flag-off behavior:** with `l3Enabled=false` on-chain, every keeper entry point
  refuses with `l3_disabled` — the module ships fully dark and testable.

## 3. Build shape

1. **`l3-posting-keeper` service** (state-store-backed queue, same idioms as the
   platform-fault remediation queue): request intake → underwrite check (receipt-graph
   net earnings read; formula above) → originate (KMS operator call) → post via the
   external-poster door → job-lifecycle watch → repayment recording.
2. **Admin surface** (inside the existing authed admin family): list L3 requests/loans
   with states; a named-refusal log. No new public surface while dormant.
3. **Config:** poster-wallet address read from chain (`book.l3PosterWallet()` — never
   env-pinned); enablement read from chain (`l3Enabled()`) — the CHAIN is the flag,
   the backend carries no second switch that could disagree.
4. **No contract changes. No AAC changes. No new signing paths** (the operator KMS
   signer already holds every needed authority).

## 4. Tests (all runnable with the flag off)

- Flag-off: every entry point refuses `l3_disabled` (read from a mocked chain flag).
- Fork/mocked-chain loop: enable flag in the fork ONLY → request → underwrite pass →
  originate lands principal at the poster identity (never the borrower — assert both
  balances) → job posted through the real poster-door code path → cancel → refund
  consent-transfer → `repayFromRefund` → loan closed, book whole to the raw unit.
- Underwrite bounds: net-earnings 0 → limit 0 → named refusal; second concurrent
  request → named refusal.
- Mutation drills: (a) removing the flag check must fail the flag-off test by name;
  (b) redirecting principal to the borrower must fail the balance assertion by name.

## 5. Activation ceremony (SEPARATE — not in this PR, gated on the L2 cohort)

One Nova batch by the policy owner: `setL3PosterWallet(w)`,
`setL3PosterAllowlisted(w, true)`, `setL3Enabled(true)` — plus funding `w` for
poster-door fees. Runsheet to be written at scheduling time with measured weights.

## 6. Out of scope

Any relaxation of poster-door validation · borrower-facing UI · interest (chain
enforces zero) · creditBroker (banked) · the activation ceremony itself.
