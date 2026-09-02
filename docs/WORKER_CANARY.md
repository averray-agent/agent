# External-Worker Canary

A CI canary that walks the **real external-worker loop** end to end — the same
front door an outside agent uses — and asserts every stage, so the class of
launch-blockers found on 2026-06-13 can never silently reach production again.

- **Script:** [`scripts/ops/run-worker-canary.mjs`](../scripts/ops/run-worker-canary.mjs)
- **Tests:** [`scripts/ops/run-worker-canary.test.mjs`](../scripts/ops/run-worker-canary.test.mjs) (offline; one deliberate per-stage break flips the right assertion red)
- **Gate:** `CHECK_WORKER_CANARY_PROOF=1 ./scripts/ops/check-hosted-stack.sh`
- **Workflow:** [`.github/workflows/hosted-worker-canary.yml`](../.github/workflows/hosted-worker-canary.yml) — dispatchable + daily (`37 6 * * *`) + post-deploy (`workflow_run` on **Deploy Production**)

## Why it exists

The first fully-settled product job surfaced five blockers **one user-round-trip
at a time** (SIWE roleless-mint 500 · JWT `sub`-casing 401 · claim 409 ·
`submitWork` revert · `ADMIN_JWT` expiry). Every prior hosted proof used the
pre-minted multi-role `ADMIN_JWT` and bypassed the SIWE front door, so none of
them could see those bugs. This canary uses a **roleless** wallet for the worker
stages and only the `ADMIN_JWT` for the operator stages, so the whole class
fails loud here — in CI — before it reaches an external agent. See
`docs/GO_LIVE_PUNCHLIST.md` (P0).

## Stages (each failure names the bug-class it guards)

| # | Stage | Asserts | Guards |
| - | --- | --- | --- |
| 1 | SIWE | nonce → sign → verify → roleless token | #625 roleless-mint 500 |
| 2 | Account | authed `GET /account`, not 401 `claims_mismatch` | #626 `sub`-casing |
| 3 | Claim | claim the disposable job, not 409; onboarding waiver applies **or** worker pre-funded | claim-funding 409 + `claimJobFor` brokering |
| 4 | Submit | structured output → `submitted`, no on-chain revert | #627 `submitWorkFor` |
| 5 | Verify | operator `/verifier/run` → `approved` (until auto-verify lands) | verification stall |
| 6 | Settle | EscrowCore job `Closed` + `released == reward`, and worker balance rose by reward in **`usdc.balanceOf(workerEOA)` AND `AAC.positions(worker).liquid`** | settlement / payout reconciliation |
| 7 | Freshness | the long-lived operator `ADMIN_JWT` isn't within N days (default 7) of expiry | #628 `ADMIN_JWT` expiry |

The worker stages (1–4) run on the roleless token; the operator stages
(create/fund/verify/cleanup) run on the `ADMIN_JWT`. Stages 5 and 7 are
structured to become **no-ops** once auto-verify and the short-lived
refresh-token flow land (a short-lived operator token skips the freshness gate;
`WORKER_CANARY_VERIFY_MODE=auto` polls the public verifier result instead of
operator-triggering).

## Disposable job + cleanup

Each run posts its own **upfront-funded** benchmark job (small reward, default
`0.1 USDC`) so the loop never depends on the lazy `ensureJob` path, then
**archives it in a `finally` block** so canary jobs never accumulate or pollute
the public board. It never consumes claim attempts on real board jobs.

## Safety

- **Testnet-only.** The script loads `deployments/testnet.json`, refuses any
  profile but `testnet`, and asserts the live `chainId` is `420420417`
  (Polkadot Hub Paseo). It will not drive a paid loop against mainnet.
- **Never the admin JWT for worker stages.** The worker identity is a dedicated,
  roleless testnet wallet; the `ADMIN_JWT` is used only for the operator stages.

## One-time provisioning (operator)

1. **Generate the roleless worker key** (address-only output; the private key is
   written to a gitignored `.keys/` file at mode 0600, never echoed):

   ```sh
   node scripts/ops/rotate-admin-generate-key.mjs --out .keys/canary-worker-testnet.txt
   # note the printed address; it is the canary worker EOA
   ```

2. **Store it in 1Password** in `prod-backend` (VPS-readable; `prod-critical` is
   not). Single item, no archived-ghost duplicate:

   ```sh
   op item create --vault prod-backend --category 'API Credential' \
     --title 'canary-worker-testnet' \
     "private key[concealed]=$(cat .keys/canary-worker-testnet.txt)" \
     'address[text]=0x…' \
     'chain[text]=Paseo Asset Hub TestNet (chainId 420420417)' \
     'notes[text]=Roleless external-worker CI canary wallet. NOT admin/verifier.'
   op read 'op://prod-backend/canary-worker-testnet/private key' >/dev/null  # verify
   rm .keys/canary-worker-testnet.txt
   ```

3. **GitHub Actions secrets** the workflow needs:
   - `OP_SERVICE_ACCOUNT_TOKEN_PROD_SMOKE` — reads `op://prod-smoke/admin-jwt/password` (operator `ADMIN_JWT`). Already used by the dispute-verdict proof.
   - `OP_SERVICE_ACCOUNT_TOKEN_PROD_BACKEND` — a least-privilege service account scoped to **read** `op://prod-backend/canary-worker-testnet`.

4. **Keep the worker claimable.** A fresh wallet's first
   `onboardingWaiverClaimCount` (3) claims are stake/fee-waived **only when the
   job is explicitly marked `onboardingWaiverEligible`**. The canary's disposable
   job sets that curated-job flag, and the scheduled/post-deploy runs mint a fresh
   ephemeral wallet each time, so every run is a first eligible claim inside the
   waiver. The **dedicated persistent wallet** is used only by manual dispatch
   (without `allow_ephemeral`); after its 3 eligible-waiver claims it needs its
   `AgentAccountCore` position **pre-funded** with ≥ the per-claim lock to keep
   claiming — use that path on demand to exercise the funded/staked-claim flow.
   Stage 3 fails loud if a persistent wallet is both waiver-exhausted and
   underfunded.

## Running it locally

```sh
# Against prod testnet with the dedicated wallet + a refresh/admin operator token:
CHECK_WORKER_CANARY_PROOF=1 \
ADMIN_JWT="$(op read op://prod-smoke/admin-jwt/password)" \
WORKER_CANARY_WORKER_PRIVATE_KEY="$(op read 'op://prod-backend/canary-worker-testnet/private key')" \
WORKER_CANARY_EVIDENCE_FILE=artifacts/worker-canary.json \
  ./scripts/ops/check-hosted-stack.sh

# One-off with a throwaway wallet (always within the onboarding waiver), no op needed:
WORKER_CANARY_ALLOW_EPHEMERAL=1 \
ADMIN_JWT="…" \
  node scripts/ops/run-worker-canary.mjs
```

### Knobs

| Env / dispatch input | Default | Purpose |
| --- | --- | --- |
| `WORKER_CANARY_REWARD_AMOUNT` | `0.1` | Disposable-job reward (USDC). |
| `WORKER_CANARY_VERIFY_MODE` | `operator` | `operator` triggers `/verifier/run`; `auto` polls the public result (no-op once auto-verify lands). |
| `WORKER_CANARY_TOKEN_MIN_DAYS` | `7` | Fail if the operator `ADMIN_JWT` is within this many days of expiry. |
| `WORKER_CANARY_ALLOW_EPHEMERAL` | off | Use a throwaway random worker wallet instead of the 1Password key. |
| `WORKER_CANARY_KEEP_JOB` | off | Leave the disposable job live instead of archiving (debug). |
| `WORKER_CANARY_EVIDENCE_FILE` | — | Where to write the sanitized evidence JSON. |

## Evidence artifact

The run writes a sanitized JSON doc (no tokens or keys) — stage timings, tx
hashes, claim mechanism, verifier outcome, on-chain release amount, and where
the payout landed (EOA vs AAC) — uploaded as `hosted-worker-canary-<run_id>`
and summarized in the job step summary.
