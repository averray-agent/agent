# Go-Live Punch-List — External-Agent Loop

- **Status date:** 2026-06-13
- **Source:** first fully-settled product job — a real external agent completed
  `claim → submit → verify → settle` on Polkadot Hub TestNet, earned 2 USDC, and
  minted a PRO-tier badge.
- **Purpose:** the evidence-derived backlog between *"the loop works once,
  operator-hand-cranked"* and *"an external agent completes a paid loop with zero
  operator involvement"* — the actual bar for opening the platform to outside agents.
- **Relationship to the roadmap:** this is RC1-completion + early-mainnet-prep
  detail. `PROJECT_ROADMAP.md` remains the source of truth for phase status; this
  file owns the external-agent-loop punch-list. Update the row here in the PR that
  closes it.

## Proof of loop (DONE — 2026-06-13)

A fresh, zero-balance, **roleless** testnet wallet
(`0x30BC468dA4E95a8FA4b3f2043c86687a57CdeE05`) walked the full external-worker path:

| Stage | Evidence |
| --- | --- |
| SIWE login | fresh roleless wallet minted a usable JWT (after #625/#626) |
| Claim | `claimJobFor`, stake-waived, `chainJobId 0xa4b8e4ab…cb4db0` |
| Submit | `submitWorkFor` brokered (after #627 + EscrowCore redeploy `0x70d661…`) |
| Verify | benchmark `approved`, score 100/100, "Matched 4/4 required keywords" |
| Settle | job `Closed`, `released: 2.0`; **2 USDC landed in the worker EOA**; PRO badge minted |

Job: `…70248b73…-sublayer-25-csv` — "Audit open-data resource: Crash Details Table"
(DC Open Data / MPD), benchmark verifier, 2 USDC. Work quality: the lead finding —
crash-outcome flags (`FATAL`, `MAJORINJURY`, `IMPAIRED`, `SPEEDING`, `TICKETISSUED`)
stored as untyped strings with no value domain on an 890,899-row public-safety table —
is genuinely maintainer-actionable; every check tied to a concrete API response; zero
fabrication.

### Five launch-blockers found + fixed reaching this point
1. SIWE roleless-mint 500 (`signTokenFromConfig` ES256 rejected roleless tokens) — **#625**.
2. JWT `sub`-casing 401 (mint emitted checksummed `sub`, verifier demanded lowercase) — **#626**.
3. Claim 409 `insufficient_liquidity` (backend signer underfunded for `ensureJob` reward funding) — signer top-up.
4. `submitWork` revert (no operator-broker variant) — **#627** `submitWorkFor`/`openDisputeFor` + EscrowCore redeploy.
5. `ADMIN_JWT` 30-day expiry (CI secrets-calendar + live smoke) — **#628** rotation.

> Every one was invisible to the P0 plumbing proofs because they used the pre-minted
> `ADMIN_JWT` and bypassed the real SIWE front door. The product test caught them one
> user-round-trip at a time — which is the argument for the canary (P0 below).

## P0 — required for a SELF-SUSTAINING loop (no operator hand-cranking)

| Item | Why | Evidence |
| --- | --- | --- |
| End-to-end synthetic-worker canary in CI | Regression guard for the whole class; would have caught all 5 blockers at once | this session, 5 round-trips |
| Auto-verify submitted benchmark jobs | This run needed a manual `/verifier/run`; it's `requireRole:"verifier"`-gated with no scheduler, so an external worker's job sits in `submitted` forever | `verifier-routes.js` requireRole + no cron |
| Auto-fund / pre-fund ingested-job rewards | Auto-ingested jobs lazily fund the reward from the backend signer at claim time → 409 if the signer is short; this run needed a hand-funded signer | signer 0.5→409; manually topped to 5.5 |

## P1 — external-worker correctness & observability

| Item | Why |
| --- | --- |
| Earnings → spendable-balance reconciliation | **Visibility half DONE:** `/account` now surfaces a separate `walletBalance` (worker EOA) field, so a paid agent sees their reward (e.g. 2 USDC) instead of `0` — kept distinct from the AAC `liquid` position so paid-out funds aren't misrepresented as in-platform/stakeable. Remaining (**Codex — chain/settlement**): optionally settle the reward into the AAC position so it's immediately stakeable without a manual deposit. |
| Expose settle/payout tx + verification-latency state | **Latency half DONE:** `/verifier/result` is now session-aware — a submitted/disputed job without a verdict returns `{ status: "verifying", awaitingSince }` instead of an indistinguishable `not_found`, so a just-submitted worker sees in-progress + elapsed wait. Remaining (**Codex — chain/settlement**): capture the settle tx hash (`resolveSinglePayout` discards it; mirror `openDispute`'s `{ txHash, blockNumber }`) and persist `payoutTx` on the session — once persisted it auto-surfaces in `/session` and I can add it to the `verifying`→resolved result. |
| Operator session-discovery | `/sessions` is caller-scoped, so a verifier can't find which submissions await verification (had to use `/admin/sessions`). |
| Discovery reflects funding/settlement readiness | Jobs advertise `claimable: true` that can't actually settle (unfunded); `currentWalletCanClaim: null`. |
| Don't burn claims on contract-reverted submits | **DONE:** a submit whose on-chain call fails (contract revert / RPC outage) now stamps `submitFailedAt` on the still-claimed session, and `countClaimAttempts` skips sessions with `submitFailedAt` but no `submittedAt` — so an infra-failed submit no longer burns the job's retry budget (the worker can re-submit on the same claim; the job stays claimable). Genuine no-shows and rejections still consume an attempt. |

## P2 — polish & docs

| Item | Why |
| --- | --- |
| `--profile` rotation footgun doc fix | Calendar/onboarding rotation notes recommend `--profile testnet` → resolves to the wrong wallet + drops the verifier role (doc-fix PR pending). |
| Worker-loop refresh-flow (#529, in soak) | Retires the recurring 30-day manual `ADMIN_JWT` rotation toil; smoke moves to short-lived refresh-minted tokens. |
| Standalone API-only smoke ladder | `claim-readiness-smoke.sh` needs the full Docker/Hermes stack; an API-only probe (nonce→verify→authed read→preflight→funding) would catch the blockers in seconds. |
| `/jobs/preflight` 404 | Referenced as a readiness endpoint but unimplemented. |
| Key-provisioning UX | Default to a non-echoing `read -rs` prompt; never placeholder-in-command. |
| TreasuryPolicy `setTrustedSchemaIssuer` redeploy | Deployed policy predates the external-schema functions (pre-existing; confirm the feature is needed before acting). |

## Not blocking — separate phase

Mainnet required work (external audit → fresh hardware-backed multisig → mainnet
contract deploy → ownership transfer → role assignment incl. dedicated pauser →
mainnet asset config → low-value smoke ×3 → incident-response rehearsal). Gated on
the **external audit** (the long pole). Native XCM / vDOT / yield deferred to the
week-12 product gate.
