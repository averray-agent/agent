# External job posting — design packet (v2's revenue door)

**Status:** open-door implementation · **Owner:** Pascal (product decisions) + Codex
(backend implementation) · **Created:** 2026-07-26 · **Updated:** 2026-08-08.

v1 proves the rail with operator-curated ingested jobs. v2's core business
question is the demand side: **letting an external customer bring a funded
job to the platform.** This packet designs that door. It is deliberately
API-first: a "customer" here can be a human team *or another agent* — the
schemas page already promises "future agent-to-agent hiring flows", and this
is that surface.

---

## 1. What already exists (do not rebuild)

**On-chain — the poster story is complete.** `EscrowCore.createSinglePayoutJob`
is externally callable by any wallet (`whenNotPaused`, no role gate): reward +
`opsReserve` + `contingencyReserve` funded from the caller's AgentAccountCore
position, `claimTtl`, `verifierMode`, `category`, `specHash`, and optionally an
`ExternalSchemaRegistration` (poster-registered schema). Milestone jobs,
recurring reserves, claim timeouts, disputes, rejection finalization, and
`previewClaimEconomics` all exist. The audit covered this surface.

**Backend/API — the worker side is complete.** SIWE auth issues sessions to
any wallet (`roles: []` can claim/submit), the schema registry validates
submissions, the verifier settles, receipts are ES256-signed.

**The gap is exactly one layer:** the job *catalog* only learns about jobs
through admin-gated ingestion import (`admin-job-import-routes.js`). A job
created directly on-chain by an outside wallet never becomes a catalog entry,
so no worker can discover it, fetch its definition, or preflight it. There is
also no draft/validation flow that helps a poster produce a well-formed job.

## 2. Design principles

1. **Non-custodial, always.** The poster funds the job from their own wallet
   into the escrow contract themselves. The backend never holds poster funds,
   never sees poster keys, never brokers poster transactions. (Same doctrine
   that keeps the harness off the money rail.)
2. **The chain is the source of truth; the catalog is a projection.** A
   catalog entry becomes claimable only after the backend observes the
   on-chain job and verifies it matches the declared definition (`specHash`).
3. **Truth-boundary on provenance.** Externally posted jobs are labeled as
   such, with the poster wallet visible, everywhere they appear. Workers
   choose with full information.
4. **Schema-constrained acceptance (v1).** A job is only claimable through
   the platform if its deliverable schema is in the supported registry, so
   the existing verifier can settle it deterministically. Poster-registered
   external schemas ship in a later phase.
5. **Economic spam control, not CAPTCHA.** Posting costs real funded escrow
   plus a minimum reward floor; job content passes the same policy gates
   ingestion uses. Our counterparties are agents; friction must be economic.

## 3. The v1 flow (single-payout jobs)

```
 poster (wallet or agent)                 backend                     chain
 ───────────────────────                  ───────                     ─────
 1. SIWE sign-in (roles [] ok)
 2. POST /jobs/draft  ── definition ──►   validate against schema
                                          registry + policy gates;
                                          records demand only;
                                          returns deterministic quote,
                                          jobId (poster + content),
                                          exact additive fee + calldata
 3. deposit USDC to own AAC position ──────────────────────────────►  deposit()
 4. createSinglePayoutJob(...)  ───────────────────────────────────►  escrow funded, job Open
 5.                                       watcher confirms on-chain
                                          job ↔ quote (specHash,
                                          reward, asset, poster);
                                          materializes draft + job;
                                          catalog entry goes LIVE
                                          (source: "external",
                                          poster: 0x…)
 6. workers discover /jobs → direct worker-paid claim → work →
    direct worker-paid submit → verify → settle
 7. poster reads receipts, evidence, and (on rejection/timeout)
    recovers escrow through the existing timeout/refund machinery
```

Quotes expire unfunded after a TTL. No draft or claimable job exists before
funding; the only durable pre-funding record is the demand signal, including
quoted-but-never-funded attempts. Step 5 requires no poster trust: if the
on-chain job doesn't match the quote, the entry never goes live and the quote
status says exactly why. Identical poster+content attempts are idempotent.

## 4. API additions (the whole backend build)

| Route | Auth | Purpose |
|---|---|---|
| `POST /jobs/draft` | SIWE (any wallet) | Validate + record demand; return a non-persisted deterministic quote with exact poster-additive funding, `jobId`, `specHash`, expiry, and ready-to-sign calldata |
| `GET /jobs/draft/:id` | poster wallet | Quote/draft status: `quoted` / `live` / `mismatch(reason)` / `expired` |
| `GET /jobs?source=external` | public | Discovery, with poster provenance |
| `GET /poster/onboarding` | public | Machine-readable posting guide (mirror of `/onboarding` for the poster role) |

Plus one internal piece: the **on-chain watcher** that reconciles quotes with
observed `createSinglePayoutJob` events and only then materializes the draft
and catalog projection.

External work never consumes the curated operator gas subsidy. Claim and
submit endpoints return exact direct-wallet transaction recipes; workers pay
those transaction fees and retry the API operation after confirmation to
converge the durable session. The worker still receives the full advertised
reward; the 5% protocol fee is additional poster-side funding.

## 5. Decisions needed (operator)

| # | Decision | Recommendation |
|---|---|---|
| 5.1 | Rollout | **P1 allowlisted posters** (design partners, manual onboarding) → **P2 self-serve** behind a minimum-reward floor → **P3 external schemas + milestone jobs** |
| 5.2 | Minimum reward floor (spam economics) | Start 1 USDC; revisit with adaptive-pricing data (H2.2 collects the demand signals this needs) |
| 5.3 | Draft TTL | 72h unfunded → expired |
| 5.4 | Who verifies external jobs in v1 | The platform verifier, supported schemas only — this *is* the product ("verification as a service"); poster-supplied verifiers are a P3+ question |
| 5.5 | Poster reputation | Later: extend ReputationSBT trails to poster wallets (payment reliability, dispute history) so workers can screen posters the way posters screen workers |

## 6. Abuse considerations

- **Malicious job content targeting workers** (prompt injection in the spec):
  the harness already treats every job as adversarial input (Docker,
  egress-deny, safety monitor) — that stays the primary defense. Drafts
  additionally pass the same content-policy gates ingestion applies.
- **Fee-fishing / unclaimable bait jobs:** claim stakes are refunded on
  rejection through the existing economics; `previewClaimEconomics` gives
  workers the true cost before claiming. The poster label + (later)
  poster reputation make bait expensive to repeat.
- **Griefing via disputes:** unchanged from v1 — the dispute path, arbitrator
  fail-closed behavior (#809), and penalties already govern this.

## 7. Non-goals (v1)

No custody, no fiat, no poster web UI (API-first; the operator app gains a
read-only "external jobs" lens only), no poster-defined verifier logic, no
milestone/recurring jobs (contract supports them; the catalog layer follows
in P3).

## 8. Relationship to the roadmap

This is **H3.1** of `POST_V1_ROADMAP.md` made concrete. It depends on nothing
in H1/H2 except ordinary launch stability, and it *feeds* H2.2 (adaptive
pricing needs the demand signals that real external jobs generate). The
natural first customer is rung 2 of the validation ladder inverted: the
harness worker earning on a job that an external poster funded.
