# Mainnet Automation Plan — running Averray ~99% hands-off

**Goal:** on mainnet, the recurring operations run themselves; humans are in the loop only for
the irreducible, security-by-design 1%. This doc is the reference we build the automation
against. Polkadot-Hub tooling claims here were checked against the Polkadot docs MCP.

## The three layers

**Layer 1 — the product loop (already self-driving; ~99% of all activity).**
ingest → discover → claim → submit → **auto-verify → auto-settle**. Powered by
`AUTO_VERIFY_ENABLED` + `INGESTION_PREFUND_ENABLED`; proven end-to-end by the Hosted Worker
Canary (a real claim→submit→verify→settle with reward released, no human). **Nothing to build
here — it is the product.**

**Layer 2 — the ops layer (what we automate for hands-off).** The recurring chores that needed
a human this cycle: keeping the reward bank funded, watching the loop, catching a bad deploy,
rotating credentials. See the build list below.

**Layer 3 — the human 1% (stays manual, by design).** Multisig signing, incident decisions
(un-pause, fund recovery), the external audit gate, hardware key custody. The aim is not to kill
these but to make them **rare and well-signposted** — alerts tell a human exactly when one of
these is actually needed.

## Layer 2 — build list (priority = how much it hurt operationally)

| # | Automation | Trigger | Tool / script | Mode |
|---|-----------|---------|---------------|------|
| 1 | **Reward-bank auto-top-up** — signer `AAC.liquid` drains as agents earn | `liquid < lowWaterMark` | scheduled `auto-topup-reward-bank.mjs` → reuses `fund-signer-usdc-deposit.mjs --use-kms`, bounded (max/top-up + float-capped) | auto-heal |
| 2 | **Monitoring + alerting** | continuous | Prometheus (`/metrics`) + Grafana + Alertmanager → alert-webhook; BlockScout / Subscan chain-side | alert / page |
| 3 | **Solvency watcher + auto-pause** | each block | off-chain watcher (Substrate API Sidecar / viem) asserting `Σ positions == token balance`, no `liquid < debtOutstanding`, settlement idempotent → **pauser auto-halt** on violation | auto-safe |
| 4 | **Deploy safety** | merge → deploy | CI deploy + **auto-rollback if the post-deploy canary goes red** (the "pinned backend" lesson) | auto-guard |
| 5 | **JWT / credential rotation** | TTL | per-consumer refresh-flow automation (deferred) + rotation cron | auto |
| 6 | **Daily reconciliation report** | daily | solvency / liquidity drift check → digest | report |

**Keystone:** the **Hosted Worker Canary** is the heartbeat — "is the loop completing?" feeds #2
and #4. Everything else hangs off it.

## Tool choices

- **Scheduler:** GitHub Actions cron (already the canary's pattern — versioned, simple). A VPS
  systemd-timer only for steps that need local KMS creds and can't reach them from CI.
- **Monitoring:** Prometheus + Grafana + Alertmanager → the alert-webhook; **BlockScout** +
  **Subscan** for on-chain contract/activity views.
- **Chain reads (watchers):** `viem` (EVM side) + **Substrate API Sidecar** / PAPI (Substrate side).
- **Signed ops:** the existing `--use-kms` scripts (`fund-signer-usdc-deposit.mjs`, …), wrapped in
  the scheduler. No raw keys.
- **Multisig (the human bit):** Polkadot.js Apps, or the **Hub multisig precompile** (EVM-scriptable
  call-data) — but signing stays on hardware. Minimized to deploy + rare role changes.

## Guardrails (so automation can't become a liability)

- Every auto-financial action is **bounded**: max per action + max per day + capped to a small
  operational float, never the whole treasury. A bug tops up $X, not $everything.
- Auto-pause is **fail-safe**: a watcher in doubt pauses; a human decides un-pause.
- Auto-rollback is **canary-gated**: a deploy that reddens the canary reverts itself.

## Honest boundary — what automation does NOT do

Automation handles the **plumbing**: it keeps the float topped, the loop watched, a bad deploy
reverted, the books reconciled. It does **not fund the treasury** — on mainnet the reward bank
pays real USDC, so the **business model** must keep the treasury filled. The auto-top-up only
moves money treasury-float → AAC safely, within caps. "Hands-off operations" is real; "hands-off
economics" depends on revenue, which is out of scope for this doc.

## Status

- [x] Plan captured (this doc).
- [x] **#1 logic built + tested** — `scripts/ops/auto-topup-reward-bank.mjs`: a pure, bounded
      `planRewardBankTopup()` (refill toward target, capped per run, float-capped, `treasuryLow`
      alert) that reads `AAC.liquid` + the wallet float and reuses the audited
      `fund-signer-usdc-deposit.mjs --use-kms` for the actual deposit. Dry-run by default.
      7/7 unit tests on the planner.
- [ ] **#1 activation** — schedule it where `ethers` + the KMS creds live: a VPS systemd-timer,
      or a GitHub Actions cron mirroring `hosted-worker-canary.yml`'s cred pattern (plus
      `npm install --no-save ethers`). Roll out **dry-run first** (monitor + page on
      `treasuryLow`), then flip the scheduled step to `--use-kms --commit` once the bounds are
      trusted. (Coordinate with the current backend-deploy freeze — this is an ops script, it
      does not deploy the backend.)
- [ ] #2–#6 — sequenced after #1.
