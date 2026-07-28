# Post-v1 roadmap

The coordination doc for everything after the mainnet flip, in the same
spirit as `AUDIT_REMEDIATION.md`: one board, honest statuses, one owner
per row. Edit only your own rows. Created 2026-07-26, when the GO gate
was green and the flip awaited operator authorization.

**Precondition for everything below: the cutover flip** (atomic Caddy
reload → merge #780 → retire testnet). Nothing in Horizon 1 starts
before it.

---

## Horizon 1 — prove it (first days after the flip)

The unbiased-validation ladder (rungs 2–4 of
`project_postlaunch_validation`; rung 1 = the bring-up smokes, done):

| # | Item | Owner | Status |
|---|------|-------|--------|
| 1.1 | Retarget the worker canary to mainnet (`WORKER_CANARY_PROFILE=mainnet`) — part of the flip checklist | Codex | open |
| 1.2 | **Harness worker, rung 2**: implement the money-rail seam per `worker/HANDOFF.md` (#790) — SIWE → claim → host-side clone → invoke worker → PR → validate → submit → settle; run one real mainnet job end-to-end; see 2.7–2.8 for the production delivery loop and verifier gate | Codex | open |
| 1.3 | **Blind-agent test, rung 3**: fresh agent session, zero project context, funded wallet, "earn USDC on averray.com from public info only"; log every stall as an onboarding defect; repeat with ≥2 model families. Protocol to be drafted | Claude | open |
| 1.4 | **Adversarial agent, rung 4** (week one): garbage submissions, claim-spam through the onboarding waiver, prompt injection inside job content; economics must hold (exposure capped by the reward bank) | Claude + Codex | open |
| 1.5 | Ops sweep: revoke the 2026-06-13 leaked SA via the 1Password web console; source + verify a second mainnet eth-rpc backup for `PRODUCT_HEALTH_RPC_BACKUPS`; proxy DNS through Cloudflare because the apex/API/app records currently point directly at the VPS with no DDoS shield (week-one hardening, not launch-day); CSP for marketing + operator app (possible now that fonts are self-hosted); add "Generated output guard" to required checks; mount the Caddy config directory instead of the single file so future cutovers can use atomic rename without leaving the running container on the old inode | Pascal | open |
| 1.6 | Film and release the launch video (script is true line-for-line; releases with the cutover) | Pascal | open |

## Horizon 2 — harden & economize (weeks)

| # | Item | Owner | Status |
|---|------|-------|--------|
| 2.1 | **JWT TTL ≤1h**: replace the hand-minted 30-day admin JWT with automated refresh-flow rotation (groundwork: #672 helper, per-consumer refresh pattern; the #808 Redis-key fix removed the latent rotation bug) | Codex | open |
| 2.2 | **Demand-adaptive reward pricing**: replace static per-source amounts (#778) with pricing by job value and live claim demand; back off to zero when nothing is being claimed. The reward bank stays the hard cap | Codex (design w/ Claude) | open |
| 2.3 | Indexer recovery: resolve the Ponder schema-ownership conflict behind the 502, then expose the public indexer surface | Codex | open |
| 2.4 | Treasury withdrawal convenience: when accrued fees justify it, `setTreasuryAccount` to an EVM-accessible treasury (owner multisig signs once); until then fees accrue safely under 2-of-3 | Pascal | deferred until fees accrue |
| 2.5 | Tier-vocabulary consolidation across list/drawer/backend (noted at #765) | Codex | open |
| 2.6 | Secrets calendar hygiene: RA certs renew 2026-10-12, GitHub PAT 2026-10-13, SA tokens ~2026-09-11 — batch the October renewals | Pascal | scheduled |
| 2.7 | Delivery loop D0 (queue + report adapters + operator page) | Codex | open |
| 2.8 | Verifier claim re-derivation (gates delivery D1 and rung-4 depth) | Codex | open |

## Horizon 3 — grow it (months)

| # | Item | Owner | Status |
|---|------|-------|--------|
| 3.1 | **The demand side** — the v2 business question: who posts paid jobs? Ingested public-good jobs bootstrap supply; revenue needs external job posters. Candidate wedges: paid data-audit jobs, verifier-as-a-service for other agent platforms, bounty escrow for OSS maintainers; delivery is the poster-acquisition path (2.7, 3.6) | Pascal (strategy) | open |
| 3.2 | Harness worker as a standing earner; Phases 6–7 of `agent-harness` complete and the worker inherits skills/learning (Track-A stream; PKT-036 already closing Phase 7) | Track-A chat | in progress |
| 3.3 | Hermes as orchestrator per `HERMES_MULTI_AGENT_ORCHESTRATION_PLAN.md` — operator copilot routes work to Codex/Claude workers | Pascal + Hermes | open |
| 3.4 | `.dot` domains as agent identity: human-readable names on wallets, resolved in profiles/badges. Arrives via the Products Devnet → mainnet; adopt when live | later | watch |
| 3.5 | Strategies/XCM: vDOT adapter stays blocked until native observer evidence passes (deploy script enforces this); revisit with real treasury demand | Codex | blocked by design |
| 3.6 | Delivery D1/D2 (auto modes, upstream bot approvals) | later | open |

## Standing watches

- **Passet Hub → permanent Asset Hub migration** could force a testnet
  redeploy (like V1→V2). The **Polkadot Products Devnet** (launched
  2026-07-23, Paseo-operated, mirrors the upcoming production network) is
  where such changes will appear first — a periodic check there is the
  early-warning channel. Monitor the forum + devnet.
- Reward-bank balance is the spend cap; settlement pauses at zero
  (`signer_liquidity_short`). Top up deliberately, never automatically.
- Every production deploy must verify public `/health` reports the chain ID in
  the durable Caddy selector; keep the assertion and auto-rollback enabled.
- Keep the owner multisig above the existential deposit for as long as it
  owns the contracts (AutoMapper unmaps reaped accounts).
- The kernel/money-rail boundary: the harness never touches signer,
  wallet, escrow, stake, or payout. Claiming/settling stays a separate
  non-LLM service.
