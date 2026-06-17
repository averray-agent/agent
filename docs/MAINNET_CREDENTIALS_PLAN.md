# Mainnet Credentials & Keys — Launch Plan

- **Status date:** 2026-06-16
- **Purpose:** the single reference for *every* credential and private key the
  mainnet (real-funds) launch needs — what must be created fresh, what carries
  over, the order to provision them, and where the friction is.
- **Hard gate:** the **external audit** precedes everything here (see
  [`PROJECT_ROADMAP.md`](./PROJECT_ROADMAP.md) → Mainnet Required Work). This
  plan is the credential/secret half of the post-audit launch sequence.
- **Machine-checkable closing checklist:**
  [`scripts/ops/check-mainnet-env-secrets-proof.mjs`](../scripts/ops/check-mainnet-env-secrets-proof.mjs)
  (`mainnet-env-secrets-proof-v1`), plus `check-mainnet-usdc-config.mjs` and
  `check-mainnet-smoke-proof.mjs`. Lean on these — the definition of "done" is
  already executable.
- **Truth-boundary:** the self-driving loop is currently *proven-but-paused on
  testnet*; this doc plans the mainnet posture, it does not claim mainnet is
  ready. No secret *values* appear here — only names, 1Password paths, env-var
  names, IAM role names, and mechanisms.

## Resolved network identity (was a blocking unknown)

Polkadot Hub **mainnet** EVM network (verified via the Polkadot docs
`smart-contracts/connect.md`):

| | Mainnet | (TestNet, for contrast) |
|---|---|---|
| **`AUTH_CHAIN_ID`** | **`420420419`** | `420420417` |
| RPC (`RPC_URL`) | `https://eth-rpc.polkadot.io/` | `https://eth-rpc-testnet.polkadot.io/` |
| Currency | DOT | PAS |
| Explorer | `https://blockscout.polkadot.io/` | `https://blockscout-testnet.polkadot.io/` |
| Substrate WSS | `wss://polkadot-asset-hub-rpc.polkadot.io` | `wss://asset-hub-paseo-rpc.n.dwellir.com` |

`AUTH_CHAIN_ID=420420419` and the `SHARE_URL_SECRET` requirement (below) are now
enforced by `check-mainnet-env-secrets-proof.mjs` and recorded in
`deployments/mainnet.env.example` ([PR #662](https://github.com/averray-agent/agent/pull/662)).

## Two silent-break traps (no runtime error — just broken)

1. **`AUTH_CHAIN_ID`** — wrong value ⇒ every SIWE sign-in fails. Resolved +
   pinned above.
2. **`SHARE_URL_SECRET`** — today it silently falls back to
   `AUTH_JWT_SECRETS[0]`. Retiring HMAC for mainnet removes that fallback, so
   share-link signing fails closed unless `SHARE_URL_SECRET` is explicitly
   provisioned. Now gated by the env-secrets proof.

---

## 1. Fresh-for-mainnet — MUST be created new (cannot reuse testnet)

~17 credential classes. Almost nothing reuses testnet.

| # | Credential | Custody | Why fresh |
|---|---|---|---|
| F1 | **Owner multisig — 3 fresh hardware-backed signer seeds (2-of-3)** → SS58 mapped to H160 `OWNER` | Hot (password mgr), Warm (paper, separate location), Cold (Ledger 24-word + steel). Seeds NEVER in 1Password/CI/VPS. | Proof: `roleSigners.owner.kind=multisig_mapped_evm`, `hardwareBackedSignerCount>=2`, `freshMainnetKey`, `reusedTestnetKey=false`. Testnet multisig is bounded-risk / not reusable. |
| F2 | **Blockchain-signer KMS key** (secp256k1) → derives the on-chain verifier + serviceOperator address | AWS KMS HSM (non-exportable); access via IAM Roles Anywhere SA on the VPS. No human holds the key. | Proof: `kms.blockchainSigner.keySpec=ECC_SECG_P256K1`, `multiRegion=true`, `rolesAnywhere=true`, `staticAccessKeysRendered=false`. **Multi-region is irreversible at creation.** |
| F3 | **JWT-signer KMS key** (P-256, ES256) → `AWS_JWT_KEY_ID` + `JWT_PUBLIC_KEY_PEM_BASE64` + `JWT_PUBLIC_KEY_FINGERPRINT` | AWS KMS HSM; distinct IAM principal/profile from F2 (key separation). | Proof: `kms.jwtSigner.keySpec=ECC_NIST_P256`, `multiRegion`, `rolesAnywhere`, `publicKeyPemBase64Present`, `publicKeyFingerprint=sha256:…`. PEM/fingerprint are key-derived ⇒ fresh by dependency. |
| F4 | **Burnable mainnet deployer key** → `PRIVATE_KEY` | One-shot operator EOA; optional time-boxed `op://…critical` break-glass item; deleted post-launch. | Must deploy from audited artifacts; transfers ownership to F1 as its last act, then retired. |
| F5 | **Dedicated pauser hardware EOA** → `PAUSER` | **Hardware EOA, out-of-band in operator custody; signs `setPaused(bool)` only, by hand, rarely.** Distinct from owner/verifier/arbitrator; NOT backend env, NOT KMS. | Proof: `roleSigners.pauser.freshMainnetKey`. Backend never signs `setPaused` (read-only `policyContract.pauser()`) — **no backend code change.** Mainnet rehearsal runs `--require-dedicated-pauser`. |
| F6 | **Dedicated arbitrator hardware EOA, human-reviewed** → `ARBITRATOR` | **Hardware EOA — NOT KMS, NOT backend env. The backend holds NO arbitrator signing key**; `resolveDispute` becomes a human-in-the-loop hardware signature, out-of-band. Backend stores the arbitrator ADDRESS for display/validation only. | Proof: `roleSigners.arbitrator.freshMainnetKey`, `rawPrivateKeyFallback=false`, `rawFallbacks.arbitratorPrivateKeyRendered=false`. **Needs backend code changes (see ⚠ below) — deleting the env var alone is NOT enough.** Distinct from owner/verifier/pauser. |
| F7 | **4 mainnet 1Password service-account tokens** (ciDeploy, vpsBackend, vpsIndexer, smokeTests) | Token *items* human-only in the mainnet-critical vault; never readable by any SA (firebreak). | Proof: each `mainnetOnly`, `reusedTestnetToken=false`, `rawTokenRendered=false`; vaults non-empty and excluding `prod-critical`/wildcard. Scope is immutable post-create. |
| F8 | **Fresh mainnet 1Password vault set** (mainnet-critical + scoped backend/backend-external/indexer/ci/ci-external/smoke) | Tiered; human-only critical tier. | `noTestnetReuse.reusedVaultItems` must be empty; per-environment vault separation mandatory. |
| F9 | **IAM Roles Anywhere mainnet CA + 2 client certs + 2 trust anchors + 2 profiles + 2 prod roles** (`averray-signer-prod-role`, `averray-jwt-signer-prod-role`) | CA key human-only (1Password Critical / YubiKey / AWS Private CA — **open decision**); client keys generated ON the VPS, mode 0400 root, never in any SA vault. | New mainnet trust anchors/profiles/roles; testnet ones not reusable. Required so `staticAccessKeysRendered=false`. |
| F10 | **`VPS_SSH_KEY`** (ED25519) + mainnet VPS host/port/user | Private key in mainnet-ci vault; use gated by the GitHub `production` Environment. | Fresh key, mainnet VPS target. Highest-blast-radius CI secret. |
| F11 | **`METRICS_BEARER_TOKEN`** | mainnet backend vault (VPS-SA-readable). | Generate fresh; do not reuse testnet. |
| F12 | **`APP_BASIC_AUTH`** — raw password (human-only) + bcrypt hash (CI-readable) | Split-vault: raw in mainnet-critical, hash in mainnet-ci. | Fresh password; preserve the split-vault invariant (raw NEVER in any SA vault). |
| F13 | **`ADMIN_REFRESH_TOKEN`** (replaces long-lived `ADMIN_JWT`) | mainnet smoke vault (read+write for rotation). | First capture is a manual human SIWE with the fresh mainnet admin wallet; testnet refresh tokens are session-scoped. |
| F14 | **`DATABASE_URL`** (indexer Postgres password) | mainnet indexer vault; Postgres on the VPS. | Fresh DB credential; two-step rotation (DB then OP item). |
| F15 | **`AUTH_ADMIN_WALLETS` / `AUTH_VERIFIER_WALLETS`** (login-seed allowlists) | Addresses public; backing keys human/hardware. | Must NOT carry the testnet hot key `0x6778F050…3ac8`; NEVER re-add the leaked `0xFd2EAE…6519`. |
| F16 | **`SHARE_URL_SECRET`** | mainnet backend vault. | Silent-break trap — see above. |
| F17 | **YubiKey hardware MFA** — 2× YubiKey 5 NFC per operator across the 6 admin-trust-chain accounts (1Password admin, AWS root, AWS IAM, GitHub org, registrar, OVH) | Physical keys; recovery codes in `op://…critical/yubikey-recovery-runbook/notes`. | Mainnet-blocking ([`PHASE_4E_PLAN.md`](./PHASE_4E_PLAN.md)). Validated by `check-hardware-mfa-evidence.mjs`. Today: TOTP everywhere, GitHub org-2FA not enabled. |
| F18 | **Enabled vendor keys** — Resend, alert webhook, GitHub ingestion PAT (fine-grained), + Pimlico/Sentry/Subscan IF enabled | mainnet backend-external / ci-external vaults. | Proof `vendorKeys[]`: `mainnetDedicated`, `reusedTestnetKey=false`, `rawKeyRendered=false` for each enabled vendor. |

> ### ⚠ Arbitrator: keyless backend is NOT self-executing (verified 2026-06-16)
> Deleting `ARBITRATOR_SIGNER_PRIVATE_KEY` from the mainnet env does **not**, by
> itself, make the backend keyless for arbitration. The gateway silently falls
> back to the main signer (`gateway.js:122-124` — `arbitratorSigner = key ? Wallet
> : this.signer`), so `resolveDispute` would then be signed by the **KMS verifier
> key** (a separation-of-powers violation; it reverts on-chain since the verifier
> isn't a registered arbitrator, but the backend still originates a fund-moving
> tx). Realizing F6 needs **three coupled backend changes**, not one:
> 1. remove the `: this.signer` fallback (`gateway.js:122-124`) so `arbitratorSigner` is unset;
> 2. stop the backend signing/broadcasting `resolveDispute` (`gateway.js:1017-1036` + the chain leg in `dispute-routes.js:249-255`) — record the verdict off-chain / hand off an unsigned tx, gated to mainnet;
> 3. stop rendering the key (env follow-up, below).
>
> Doing only (3) → wrong-signer revert; (1)+(3) without (2) → every verdict POST 500s.
> These touch the money-moving dispute path → **Codex/chain-settlement domain**.
> There is also **no tool yet** that emits an unsigned/recipe `resolveDispute` for a
> hardware signer (the only resolution path, `run-dispute-verdict-proof.mjs`, is
> backend-brokered) — a recipe-emitter (arbitrator analogue of
> `rotate-admin-multisig-payload.mjs`) is the biggest net-new launch-time gap.

## 2. Reused or pure config (no secret regeneration)

| Item | Action | Notes |
|---|---|---|
| **USDC escrow asset** — assetId 1337, ERC20 precompile `0x0000…01200000`, 6 decimals, minBalanceRaw 70000 | **REUSE** | Same precompile on mainnet and TestNet — the one correct reuse. `check-mainnet-usdc-config.mjs` re-derives + matches. |
| `JWT_BACKEND=kms` / `JWT_PRIMARY_ALG=kms` | **REUSE values** | Carry the literals forward; they force HMAC retirement. |
| `aws_signing_helper` + `credential_process` mechanism + `aws-credentials.js` profile constants | **REUSE mechanism** | Only the mainnet ARNs/region change. Profile names are hard-coded — VPS config section names must match exactly. |
| Rendered runtime env on tmpfs `/run/agent-stack/{backend,indexer}.env` | **REUSE mechanism** | Same fail-closed render path; verify tmpfs/0400/backup-excluded + `renderedEnvChecksum`. |
| `AUTH_DOMAIN=api.averray.com` | **CONFIG (likely unchanged)** | Must match the mainnet SIWE message domain the frontend sends. |
| `RPC_URL` / `AUTH_CHAIN_ID` | **CONFIG (new values, not secret)** | `https://eth-rpc.polkadot.io/` + `420420419`. Proof exact-matches and rejects testnet/paseo/localhost. |
| Conservative launch economic params (12 values) | **CONFIG (new values)** | Exact-matched by `check-mainnet-usdc-config.mjs`; must also match on-chain TreasuryPolicy params. |
| `JWT_MAX_TTL_SECONDS` | **CONFIG (new value)** | Proof ceiling is 30d, but PHASE_4B intent is ≤1h — pick the tighter value. |

**Retired (rendered nowhere on mainnet):** `AUTH_JWT_SECRETS` (HMAC),
`SIGNER_PRIVATE_KEY`, raw `ARBITRATOR_SIGNER_PRIVATE_KEY`, all static
`AWS_*_ACCESS_KEY_*`, long-lived `ADMIN_JWT`. The proof asserts all six
`rawFallbacks.*=false`. There is **no** Cloudflare/tunnel credential class
(Caddy + Let's Encrypt).

---

## 3. Provisioning runbook (ordered)

Critical chain: **audit → multisig + `map_account` → (MFA / KMS / Roles-Anywhere
/ vaults, parallel) → deploy → ownership transfer → role assignment → env render
→ closing proofs**. Role assignment cannot precede deploy + ownership-transfer
(all setters are `onlyOwner`). Every role mutation is a 2-of-3 `asMulti` two-leg
ceremony.

| Step | Action | Automatable | Tool / GAP |
|---|---|---|---|
| 0 | Pass external audit; freeze audited artifacts | no-multiparty | `prepare-mainnet-audit-freeze.mjs` |
| 1 | Enroll 2× YubiKey across the 6 accounts; flip GitHub org 2FA; registrar FIDO2 | **no-human-hardware** | validate: `check-hardware-mfa-evidence.mjs` |
| 2 | Create mainnet 1Password vault tier + mint 4 SA tokens | partial | 1P admin UI + `op service-account create`; **GAP: vault/token bootstrap script** |
| 3 | Create multi-region KMS blockchain key (secp256k1); derive + verify EVM address | partial | `aws kms create-key`/`replicate-key` → `derive-kms-signer-address.mjs` + `verify-kms-signer.mjs` |
| 4 | Create multi-region KMS JWT key (P-256); capture PEM-base64 + fingerprint | partial | `aws kms create-key` → `verify-jwt-kms-signer.mjs` |
| 5 | Roles Anywhere mainnet CA + 2 trust anchors + 2 profiles + 2 prod roles; client certs on VPS | partial → **no-human-hardware** (CA custody) | `deploy/iam-policies/*-prod-role.json`; **GAP: multi-region role JSON + unscripted IAM apply** |
| 6 | Deploy CloudWatch KMS alarms + fire synthetic events | partial | CloudFormation (PR #532); validate `check-kms-cloudwatch-alarm-proof.mjs` |
| 7 | Multisig ceremony: 3 fresh hardware signers; compute SS58→H160; record | **no-multiparty** | `prepare-multisig-owner-record.mjs --profile mainnet`; **GAP: `deployments/mainnet-multisig-owner.json` doesn't exist yet** |
| 8 | `pallet_revive.map_account()` on the multisig account (wrong owner = bricked contract) | no-multiparty | manual on-chain; recorded in the owner record |
| 9 | Generate burnable deployer key; deploy 5 contracts with `OWNER`=mapped multisig | partial | `rotate-admin-generate-key.mjs` + `deploy_contracts.sh`; **GAP: `deployments/mainnet.json` doesn't exist yet** |
| 10 | `transferOwnership(multisig)` as deployer's LAST act; verify deployer holds zero roles; burn deployer key | partial | `deploy_contracts.sh` (last step) |
| 11 | Multisig `setVerifier(F2)` **AND** `setServiceOperator(F2)` — BOTH required | no-multiparty | `rotate-admin-multisig-payload.mjs` |
| 12 | Multisig `setServiceOperator(escrowCore)` (+ AgentAccountCore defensively) | no-multiparty | `redeploy-escrowcore-wire-multisig.mjs` |
| 13 | Multisig `setArbitrator(F6)` and `setPauser(F5)` | no-multiparty | `rotate-admin-multisig-payload.mjs` |
| 14 | Verify all on-chain roles green | yes | `audit-launch-readiness.mjs` |
| 15 | Rehearse pause/unpause from the dedicated pauser | partial | `run-pauser-rehearsal.mjs --live --require-dedicated-pauser` → `check-pauser-rehearsal-evidence.mjs` |
| 16 | Author mainnet backend env profile (repoint `op://` to mainnet items; remove HMAC; set `SHARE_URL_SECRET`, `AUTH_CHAIN_ID`, launch caps); drop 4 SA tokens to the VPS; render | partial / no-multiparty | `install-op-vps.sh` + `render-vps-env.sh`; **GAP: no committed mainnet backend env profile** |
| 17 | Capture `ADMIN_REFRESH_TOKEN` via human SIWE with the mainnet admin wallet | **no-multiparty** | `get-admin-refresh-token.mjs` (first capture manual) |
| 18 | Capture USDC runtime evidence; validate | partial | `check-mainnet-usdc-config.mjs --runtime-evidence … --require-runtime` |
| 19 | Fund mainnet signer with real low-value USDC; run ≥3 claim→submit→verify→settle loops | partial | `run-hosted-worker-loop.mjs`; liquidity is manual (not auto-mintable) |
| 20 | Validate the 3 closing proofs (<24h fresh, secret-scanned) | yes | `check-mainnet-env-secrets-proof.mjs`, `-usdc-config`, `-smoke --max-completed-age-hours 24` |

---

## 4. Friction reducers (highest leverage)

**Already built (lean on these):** the three proofs, `audit-launch-readiness.mjs`,
`check-hardware-mfa-evidence.mjs`, `check-pauser-rehearsal-evidence.mjs`,
`check-kms-cloudwatch-alarm-proof.mjs`, `check-secrets-calendar.mjs`,
`check-env-template-structure.mjs`, the recipe-printers
(`rotate-admin-multisig-payload`, `redeploy-escrowcore-wire-multisig`), and the
address-derivers (`derive-kms-signer-address`, `verify-kms-signer`,
`verify-jwt-kms-signer`).

**Worth building (highest leverage first):**
1. **One-shot KMS + Roles-Anywhere bootstrap** — wraps `create-key --multi-region`
   (×2, `eu-central-2` + `eu-west-1`) + `replicate-key` + trust-anchor/profile/role
   creation, then auto-runs the verify/derive scripts (collapses the
   error-prone steps 3–6).
2. **Multi-region prod-role JSON templates** — ✅ done in
   [PR #664](https://github.com/averray-agent/agent/pull/664) (JWT role carries
   both `eu-central-2` + `eu-west-1` ARNs; signer role was already a both-ARN
   template).
3. **Mainnet backend env profile + secrets-inventory rows** — repoint `op://`
   paths, remove HMAC, and let `check-env-template-structure.mjs` enforce the
   new keys (`AUTH_CHAIN_ID`, `SHARE_URL_SECRET`).
4. **1Password mainnet vault + 4-token bootstrap** — codify the tiered layout +
   token scopes so the immutable-scope decision is made once, correctly.
5. **Guided multisig-ceremony checklist** (extend `MULTISIG_SETUP.md`) — 3-device
   seed gen, deterministic SS58, `map_account` verification, otherSignatory
   ordering, recovery dry-run, incident tabletop.
6. **Arbitrator hardware-signing kit** (Codex / chain-settlement) — (a) the three
   backend changes in the ⚠ note (fallback removal + dispute-route chain-leg
   disablement, mainnet-gated); (b) a `resolveDispute(...)` recipe-emitter for an
   off-backend hardware signer (analogue of `rotate-admin-multisig-payload.mjs`)
   that echoes the txHash back for display; (c) an arbitrator rehearsal +
   evidence-validator pair (analogue of `run-pauser-rehearsal.mjs`).

**Already done:** the `AUTH_CHAIN_ID` + `SHARE_URL_SECRET` guard rows
([PR #662](https://github.com/averray-agent/agent/pull/662), closes the two
silent-break traps the machine gate previously missed); the KMS region pin +
IAM-role/README reconciliation ([PR #664](https://github.com/averray-agent/agent/pull/664)).

**Irreducible human floor (do NOT design these away):** 3 hardware multisig
signers + Ledger; every role mutation = a 2-of-3 `asMulti` two-leg ceremony;
YubiKey enrollment across 6 accounts; CA-key custody + VPS cert install; the
first `ADMIN_REFRESH_TOKEN` SIWE; real USDC liquidity funding. KMS multi-region
must be set at creation (irreversible).

---

## 5. Decisions

### Decided (2026-06-16)

- **Chain ID** — `420420419` (Polkadot Hub mainnet). Gated by
  `check-mainnet-env-secrets-proof.mjs` ([PR #662](https://github.com/averray-agent/agent/pull/662)).
- **Owner multisig** — **2-of-3**, 3 fresh hardware-backed signers (Hot / Warm /
  Cold).
- **AWS account** — **single account `079209845430`** (same as testnet), with
  fresh keys + distinct prod roles/profiles within it (`reusedTestnetKey=false`).
- **KMS regions** — **primary `eu-central-2`** (Zurich, matches the live signer)
  + **replica `eu-west-1`** (Ireland), both signer + JWT keys multi-region.
  IAM role JSONs + README reconciled in
  [PR #664](https://github.com/averray-agent/agent/pull/664).
- **Arbitrator identity** — **dedicated hardware EOA, human-reviewed**; the
  backend holds no arbitrator signing key (testnet's brokered
  `ARBITRATOR_SIGNER_PRIVATE_KEY` is retired). Dispute resolution is a
  human-in-the-loop hardware signature. **Requires the three backend changes in
  the ⚠ note above — the env-var deletion alone is insufficient.**
- **Pauser identity** — **dedicated hardware EOA**, out-of-band, signs
  `setPaused(bool)` only, by hand. No backend code change needed.

### Still open

1. **Multisig sub-detail** — Hot/Warm/Cold device + backup-location assignments;
   one vs two operators (two doubles YubiKey procurement and shared-account
   enrollment).
2. **Cold-signer hardware** (Ledger?) + **registrar FIDO2 support** (migrate
   pre-mainnet if absent — highest blast radius).
3. **Roles Anywhere CA-key custody** — 1Password Critical ($0) vs YubiKey vs AWS
   Private CA (~$50/mo). Reconcile cert cadence (calendar says 7-day; PHASE_5A
   says 90-day).
4. **`JWT_MAX_TTL_SECONDS`** — proof allows ≤30d; PHASE_4B intent is ≤1h with
   refresh-flow only. Pick the tighter value; retire long-lived `ADMIN_JWT`.
5. **Mainnet vault topology** — confirm the per-runtime scoped vault set; whether
   to keep `APP_BASIC_AUTH` on the mainnet operator UI.
6. **Which optional vendors launch enabled** (Pimlico, Sentry, Subscan) — each
   enabled one needs a mainnet-dedicated key + a `vendorKeys` proof entry.

## Related

- [`PROJECT_ROADMAP.md`](./PROJECT_ROADMAP.md) → Mainnet Required Work (the gate ordering)
- [`SECRETS.md`](./SECRETS.md) / [`SECRETS_MIGRATION.md`](./SECRETS_MIGRATION.md) — vault topology + custody history
- [`PHASE_4E_PLAN.md`](./PHASE_4E_PLAN.md) — hardware MFA enrollment
- [`PHASE_5A_IAM_ROLES_ANYWHERE_PLAN.md`](./PHASE_5A_IAM_ROLES_ANYWHERE_PLAN.md) — KMS / Roles Anywhere
- [`MAINNET_PARAMETERS.md`](./MAINNET_PARAMETERS.md) — the launch economic params
- Closing proofs: `check-mainnet-env-secrets-proof.mjs`, `check-mainnet-usdc-config.mjs`, `check-mainnet-smoke-proof.mjs`
