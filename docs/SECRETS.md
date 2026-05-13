# Secrets — Inventory and Storage Strategy

This is the canonical map of every key, password, token, and credential
the Averray platform depends on. Read this first when:

- You need to rotate a secret and want to know which surfaces it touches
- You're onboarding a new operator and they need access
- You're preparing for mainnet (see also
  [`SECRETS_MIGRATION.md`](SECRETS_MIGRATION.md) for the phase-by-phase
  plan and [`SECRETS_INTEGRATION_PLAN.md`](SECRETS_INTEGRATION_PLAN.md)
  for the security-review-grade design rationale)
- Something looks suspicious and you need to figure out the blast radius

If you find a secret in the code or config that isn't listed here, **add
it**. The whole point of this doc is that there's exactly one
authoritative inventory.

---

## TL;DR

The platform has **~70 secrets across 5 buckets**. Today they live in a
mix of GitHub Actions, plain-text VPS env files, personal password
managers, and hardware wallets. For mainnet we're moving most
human-managed secrets into **1Password Business**, and the hottest
cryptographic key (`SIGNER_PRIVATE_KEY`) into **AWS KMS** so the backend
never holds the private bytes in memory.

| Bucket | Count | Today | Target |
|---|---|---|---|
| GitHub Actions | 9 | repo settings → secrets | synced from 1Password via `op` CLI |
| VPS backend env (`/srv/agent-stack/backend.env`) | ~40 | plain-text on disk | rendered at deploy from 1Password via `op inject` |
| VPS indexer env (`/srv/agent-stack/indexer.env`) | 3 | plain-text on disk | same as backend |
| Local-machine / human passwords (deployer key, signer seeds, SSH passphrases) | ~7 | personal password manager + Ledger | 1Password Business shared vault (where applicable) + hardware wallet (signers) |
| External service tokens (Pimlico, Sentry, GitHub PAT, Subscan, alert webhook, RPC provider) | ~8 | mixed (vendor portals + VPS env) | 1Password Business shared vault |
| **Cryptographic signing key** (`SIGNER_PRIVATE_KEY`) | 1 | plain-text in VPS env | **AWS KMS asymmetric secp256k1 key** (private bytes never exported) |

The 4 highest-risk items, ordered by blast radius:

1. **`SIGNER_PRIVATE_KEY`** — backend signs all on-chain verifications
   with this. Compromise = forged claims. Migration to AWS KMS is the
   single biggest pre-mainnet hardening step.
2. **`VPS_SSH_KEY`** (GitHub Actions secret) — full deploy pipeline
   access. Compromise = production code overwrite.
3. **`AUTH_JWT_SECRETS`** — HMAC for SIWE session tokens. Compromise =
   forge admin JWTs.
4. **Multisig signer seeds** (Hot/Warm/Cold) — owner ops on
   TreasuryPolicy. Loss = lose ability to change platform parameters.

---

## Storage strategy

Each secret class has a target home. The rule of thumb is: **one
canonical source, synced to runtime by automation, never copy-pasted**.

**Note on runtime plaintext**: `op inject` renders env files at
deploy time, which means rendered values exist as plaintext on the
target host (VPS or CI runner) for the duration of the deploy. This
solves the source-of-truth problem (one place to update) but does
NOT eliminate runtime plaintext from disk — the KMS migration of
the signer key is the layer that removes the most valuable runtime
plaintext. See `SECRETS_INTEGRATION_PLAN.md` Section 4c for the
honest trust-boundary analysis.

| Secret class | Where it lives | How runtime gets it |
|---|---|---|
| Backend app secrets (JWT secret, RPC URLs, KMS key id) | 1Password Business → `Averray/Production/Backend` vault | `op inject` renders env at deploy time to tmpfs; per-runtime service token (`prod-vps-backend`); plaintext on tmpfs only |
| Backend vendor tokens (Pimlico, Sentry DSN, Subscan, RPC provider, webhook) | 1Password Business → `Averray/Production/BackendExternal` vault | Same `prod-vps-backend` service token (it has read on Backend + BackendExternal only) |
| GitHub Actions deploy secrets (`VPS_SSH_KEY`, `APP_BASIC_AUTH_PASSWORD_HASH`) | 1Password Business → `Averray/Production/CI` vault | Synced via `1password/load-secrets-action`; per-runtime service token (`prod-ci-deploy`); production deploys gated by GitHub Environment with required reviewers |
| CI vendor tokens (issue-ingestion PAT, CI-side Resend if used) | 1Password Business → `Averray/Production/CIExternal` vault | Same `prod-ci-deploy` token (CI + CIExternal scope) |
| Hosted smoke `ADMIN_JWT` | 1Password Business → `Averray/Production/Smoke` vault (dedicated) | `prod-smoke-tests` service token (Smoke vault only) |
| Indexer env (DB password, RPC URL) | 1Password Business → `Averray/Production/Indexer` vault | Same pattern as backend, with `prod-vps-indexer` service token (scoped to indexer vault only) |
| Service-account tokens themselves + 1Password recovery + AWS root + Roles Anywhere cert metadata + basic-auth RAW password + pauser seed | 1Password Business → `Averray/Production/Critical` vault | **Human-only.** No runtime service account can read Critical. |
| Backend signer key | **AWS KMS** secp256k1 key, multi-region (mainnet), IAM Roles Anywhere / OIDC access | ethers.js `AwsKmsSigner` adapter — backend never holds private key bytes; **still holds temporary AWS credentials** (≤1h lifetime) capable of requesting signatures |
| Operator passwords (basic auth, personal vault items) | 1Password Business → `Averray/Operators` per-user vault | Manual; only used by humans through the 1Password UI |
| Multisig signer seeds | Three independent humans/devices (existing pattern, see [`MULTISIG_SETUP.md`](MULTISIG_SETUP.md)) | Hardware wallets + sealed-envelope offline backups |
| Burnable deployer key (one-time per deploy) | Generated fresh; transferred away from the deployer EOA via `transferOwnership()` to the multisig at the end of `deploy_contracts.sh` | Never persisted long-term |

The one rule that prevents most incidents: **never store a long-lived
secret in shell history, a `.env` committed to the repo, or a Slack
DM**. Use the vault, even for ten-second tasks.

---

## Inventory by bucket

### A. GitHub Actions secrets

These secrets are referenced as `${{ secrets.NAME }}` from
`.github/workflows/*.yml`. Today they're set via the GitHub UI; after
migration they'll be synced from 1Password.

| Name | What | Where used | Owner | Rotation | Blast radius |
|---|---|---|---|---|---|
| `VPS_HOST` | Hostname/IP | `deploy-production.yml` SSH target | Deployer | On infra change | Production VPS reachability |
| `VPS_PORT` | SSH port | Same | Deployer | Rare | Same |
| `VPS_USER` | SSH user | Same | Deployer | On account change | Same |
| `VPS_SSH_KEY` | ED25519 private key | Written to `~/.ssh/id_ed25519` in deploy job | Deployer | **On suspicion of compromise** | Full deploy pipeline access |
| `APP_BASIC_AUTH_USER` | Username | Caddy basic auth on `app.averray.com` | Operator | On policy change | Operator UI access |
| `APP_BASIC_AUTH_PASSWORD` | **Raw** password — stored only in `Averray/Production/Critical` (human-only). Never injected by a service-account token. Used by operators to log in via the browser. | Operator vault item only | Periodic | Operator UI access |
| `APP_BASIC_AUTH_PASSWORD_HASH` | bcrypt/htpasswd hash — this is what CI injects into the Caddy config at deploy time. The raw password is NOT needed in CI. | `Averray/Production/CI` (CI-readable) | Periodic | Same |

**Why split**: the Caddy basic-auth check only needs the hash at
runtime. The raw password is for humans typing it into a browser
login dialog. Storing the raw password in the CI-readable vault
would mean a compromised CI service-account token could read a
credential that operators use to authenticate — a real privilege
escalation against the operator UI. Keep raw passwords out of any
vault a service-account can read.
| `ADMIN_JWT` | Long-lived JWT | Hosted product-proof smoke + ops scripts | Deployer | On expiry (was 30d, expired today) | Backend admin role |
| `RESEND_API_KEY` | Email API key | Bootstrap self-report / alert emails | Deployer | On vendor rotation | Alert email delivery |

### B. VPS backend env (`/srv/agent-stack/backend.env`)

Loaded by `mcp-server/src/services/bootstrap.js`. Today rendered by
`scripts/ops/render-caddyfile.sh` + ssh; target is a single
`op inject -i template.env -o backend.env` step.

**Auth surface** (mcp-server/src/auth/config.js):
| Name | What | Notes |
|---|---|---|
| `AUTH_JWT_SECRETS` | Comma-separated HS256 secrets, newest first | Rotation pattern: prepend new, redeploy, drop old |
| `AUTH_JWT_SECRET` | Legacy single-secret fallback | Prefer the plural form |
| `AUTH_DOMAIN` | Domain string for SIWE validation | E.g., `api.averray.com` |
| `AUTH_CHAIN_ID` | EVM chain ID | 420420417 testnet |
| `AUTH_ADMIN_WALLETS` | Comma-separated 0x addresses | Role claims at login |
| `AUTH_VERIFIER_WALLETS` | Comma-separated 0x addresses | Same |
| `AUTH_MODE` | `strict` \| `permissive` | `strict` in prod |

**Blockchain surface** (mcp-server/src/blockchain/config.js):
| Name | What | Notes |
|---|---|---|
| **`SIGNER_PRIVATE_KEY`** | EVM private key for backend-signed transactions | **Migrating to AWS KMS** (Phase 3) |
| `TREASURY_POLICY_ADDRESS` | Public contract address | Public, but env-pinned |
| `AGENT_ACCOUNT_ADDRESS` | Public contract address | Public |
| `ESCROW_CORE_ADDRESS` | Public contract address | Public |
| `REPUTATION_SBT_ADDRESS` | Public contract address | Public |
| `VERIFIER_REGISTRY_ADDRESS` | Public contract address | Public |
| `RPC_URL` / `POLKADOT_RPC_URL` / `DWELLER_RPC_URL` | Substrate/EVM RPC endpoint | Fallback chain |

**External services**:
| Name | What | Notes |
|---|---|---|
| `REDIS_URL` | Connection string `redis://user:password@host:port/db` | Holds session/nonce state |
| `REDIS_NAMESPACE` | Key prefix | Default `agent-platform` |
| `PIMLICO_BUNDLER_URL` | Pimlico ERC-4337 bundler | Vendor-managed |
| `PIMLICO_PAYMASTER_URL` | Pimlico paymaster | Vendor-managed |
| `PIMLICO_ENTRY_POINT` | ERC-4337 EntryPoint contract | Public |
| `PIMLICO_SPONSORSHIP_POLICY_ID` | Pimlico policy UUID | Vendor-managed |
| `PIMLICO_CHAIN_ID` | Chain ID number | Public |
| `SENTRY_DSN` | Sentry project URL | Vendor-managed |
| `SENTRY_ENVIRONMENT` | `production` / `testnet` | Public-ish |
| `SENTRY_RELEASE` | Git SHA / tag | Public |
| `SENTRY_TRACES_SAMPLE_RATE` | Float 0-1 | Config |
| `XCM_OBSERVER_FEED_URL` | XCM event feed endpoint | Vendor-managed |
| `XCM_OBSERVER_AUTH_TOKEN` | Bearer token for the feed | Vendor-managed |
| `XCM_OBSERVER_ENABLED` | Boolean toggle | Config |
| `XCM_SUBSCAN_API_HOST` | Subscan REST host | Vendor-managed |
| `XCM_SUBSCAN_API_KEY` | Subscan API key | Vendor-managed |
| `GITHUB_TOKEN` | GitHub PAT for issue ingestion | Vendor-managed; expires per GitHub policy |
| `GITHUB_ISSUE_QUERY` | Search query string | Config |

**Operations**:
| Name | What | Notes |
|---|---|---|
| `LOG_LEVEL` | Verbosity | Config |
| `PORT` | Backend listen port | Config (default 8787) |
| `NODE_ENV` | `production` | Config |
| `TRUST_PROXY` | Boolean for Caddy reverse proxy | Config |
| `CORS_ALLOWED_ORIGINS` | Comma-separated origins | Config |
| `METRICS_BEARER_TOKEN` | Bearer for `/metrics` endpoint | Rotated with redeploy |
| `PUBLIC_BASE_URL` | Public-facing URL | Config |
| `ALERT_WEBHOOK_URL` | Slack/Discord/PagerDuty webhook | Vendor-managed |
| `ALERT_SERVICE_NAME` | Label for alerts | Config |
| `ALERT_ENVIRONMENT` | Label for alerts | Config |
| `DISCOVERY_REGISTRY_ADDRESS` | Public contract address (optional) | Public |
| `DISCLOSURE_LOG_ADDRESS` | Public contract address (optional) | Public |
| `XCM_WRAPPER_ADDRESS` | Public contract address (optional) | Public |

### C. VPS indexer env (`/srv/agent-stack/indexer.env`)

| Name | What | Notes |
|---|---|---|
| `DATABASE_URL` | `postgres://user:password@host/db` | Indexer state store |
| `DATABASE_SCHEMA` | Postgres schema name | Default `ponder` |
| `PONDER_RPC_URL_<chainId>` | Per-chain RPC URL | Falls back to `DWELLER_RPC_URL` |

### D. Local-machine / human-managed

Today: deployer's personal password manager + Ledger + (in some cases)
shell history. Target: same vault structure as the platform (1Password
Business shared `Averray/Operators/<role>` vaults), except for the three
hardware-wallet seeds which stay on hardware by design.

| Role | Secret | Where it lives today | Where it should live |
|---|---|---|---|
| Deployer | One-shot `PRIVATE_KEY` for `deploy_contracts.sh` | Local env / `.env` | 1Password vault item; rotated per deploy |
| Deployer | `OWNER_KEY` for `rotate_pauser.sh` | Local env | 1Password vault; mainnet path uses multisig instead of EOA |
| Operator | `APP_BASIC_AUTH_PASSWORD` | Local password manager | 1Password vault item, rendered by `op inject` |
| Operator | SSH key passphrase | gpg-agent / SSH agent | Same |
| Multisig signer A (hot) | Polkadot.js extension seed | Browser extension + offline backup | Same — **do not move to 1Password** |
| Multisig signer B (warm) | Nova Wallet / SubWallet seed | Mobile wallet + paper backup | Same — **do not move to 1Password** |
| Multisig signer C (cold) | Ledger recovery seed | Cryptosteel / sealed envelope | Same — **do not move to 1Password** |

Rule: **multisig signer seeds never go into a centralized vault**. The
whole point of multisig is independent compromise paths; co-locating the
seeds defeats it.

### E. On-chain identities

Public addresses; the secrets are the *private keys behind them*, which
live in D.

| Role | Address (testnet) | Key location | Notes |
|---|---|---|---|
| Deployer | `0xFd2EAE…6519` | Local one-shot env | Only used during `deploy_contracts.sh`; transferred to multisig at end |
| Owner (mainnet) | TBD multisig | Three signer set in D | 2-of-3 threshold per `MULTISIG_SETUP.md` |
| Owner (testnet) | `0x1f8C…b6F9` | Same multisig signer set | |
| Pauser | `0xFd2EAE…6519` | Local env / hot key (testnet); **multisig-controlled on mainnet** | EOA on testnet, rotated via `rotate_pauser.sh`. **Mainnet**: the pauser must be a separate multisig (or at minimum a separate hardware-protected EOA that is NOT the verifier/arbitrator key). Reusing the verifier key for pause defeats the purpose — a leaked verifier signing capability would otherwise also be able to pause/un-pause arbitrarily. |
| Verifier | `0xFd2EAE…6519` | `SIGNER_PRIVATE_KEY` (current) → AWS KMS (target) | The hottest key |
| Arbitrator | `0xFd2EAE…6519` | `SIGNER_PRIVATE_KEY` (current) → AWS KMS (target) | **Currently the SAME key as verifier — this is an accepted risk on testnet, NOT acceptable for mainnet.** Mainnet must split verifier and arbitrator into two distinct KMS keys (different IAM roles, different alarm thresholds, different on-chain addresses). A compromised verifier key should not also be able to resolve disputes. Track the split as a Phase 5 prerequisite. |

### F. External service tokens (vendor portals)

Revised in v3 per security review: the single `External` vault is
split into **two** vaults so a leaked CI service-account token
cannot read backend-runtime vendor tokens, and vice versa.

| Service | What | Vault | Used by | Vendor portal | Rotation |
|---|---|---|---|---|---|
| Pimlico | Bundler + paymaster URLs, sponsorship policy ID | `Averray/Production/BackendExternal` | Backend runtime | dashboard.pimlico.io | On policy change |
| Sentry | Project DSN | `Averray/Production/BackendExternal` | Backend runtime | sentry.io | Rare (per project lifetime) |
| GitHub | **Fine-grained PAT** for issue ingestion (or GitHub App installation token) — see calendar entry for required scopes | `Averray/Production/CIExternal` | CI / ingestor | github.com/settings/tokens | Per token's `expires_at` (typically 90d) |
| Subscan | API key | `Averray/Production/BackendExternal` | Backend / indexer | subscan.io | Per their cycle |
| Resend (backend) | API key for backend self-report mail | `Averray/Production/BackendExternal` | Backend runtime | resend.com | Periodic |
| Resend (CI) | OPTIONAL: separate API key for CI/deploy notifications | `Averray/Production/CIExternal` | CI | resend.com | Periodic |
| Webhook (alerts) | Slack/Discord/PagerDuty URL | `Averray/Production/BackendExternal` | Backend alerting | Their respective dashboards | Rare |
| Dweller / Polkadot RPC | URL (and any auth token) | `Averray/Production/BackendExternal` | Backend / indexer | Provider portal | Rare |

**GitHub PAT scope reduction**: do NOT use a classic PAT with
`repo`, `read:org`, `workflow`. The issue ingestor needs `Issues:
Read` (and possibly `Issues: Write`) on a single repository.
Generate a **fine-grained PAT** restricted to that one repo with
those minimum permissions. For >1 repo or longer-lived needs, a
GitHub App installation token is preferred over any PAT.

---

## Per-secret runbook (when something breaks)

For each secret class, the canonical mint/rotate/revoke flow.

### `AUTH_JWT_SECRETS` (HMAC for SIWE sessions today; asymmetric KMS-signed target for mainnet)

**Today**: HMAC-SHA256 secret stored in `AUTH_JWT_SECRETS` (comma-
separated list, newest first). A vault leak OR a backend env leak
means anyone can mint admin JWTs. This is one of the four
highest-risk items in this doc.

**Target for mainnet** (see Phase 4b of
[`SECRETS_INTEGRATION_PLAN.md`](SECRETS_INTEGRATION_PLAN.md)):
asymmetric KMS-signed access tokens with opaque refresh tokens.
After that migration, a vault leak no longer allows JWT minting —
only KMS principal compromise does (same protection level as the
signer key).

If the asymmetric migration is deferred, the **minimum hardening
for the HMAC path** is:
- Key ring with `kid` rotation
- Short access-token TTLs (≤15 min)
- Documented two-key rotation window with old-key tolerance period
- Refresh tokens are opaque random values, hashed server-side

**Mint a new HMAC entry**:
```bash
openssl rand -hex 32     # 64-char hex string, ≥32 bytes
```
Add to 1Password as a new field; do **not** delete the old one yet.

**HMAC rotation**:

*Phase A (Day 0)* — add new signer, retain old as tolerated:
1. `NEW_HEX=$(openssl rand -hex 32)`
2. `OLD_HEX=$(op read 'op://prod-backend/auth-jwt-secrets/password' | tr -cd '[:xdigit:]' | head -c 64)`
3. `op item edit auth-jwt-secrets --vault=prod-backend "password=$NEW_HEX,$OLD_HEX"`
4. `gh workflow run deploy-production.yml` — backend now signs with
   `$NEW_HEX`, validates both. Phase 2 PR 2.7d.1's env-content-aware
   force-recreate picks up the new keyring without an SSH touch.
5. Re-mint `ADMIN_JWT` (it's signed with the FIRST entry, so an
   un-minted admin token would be rejected after Phase B):
   ```bash
   NEW_JWT=$(AUTH_JWT_SECRETS="$NEW_HEX,$OLD_HEX" \
     node scripts/ops/mint-admin-jwt.mjs --profile testnet \
     --roles admin,verifier --expires-in-days 30 --quiet)
   op item edit admin-jwt --vault=prod-smoke "password=$NEW_JWT"
   ```

*Phase B (Day 1–2, ≥24h after Phase A)* — drop old signer:

```bash
./scripts/ops/rotate-auth-jwt-secrets-phase-b.sh
```

The script verifies the 2-entry shape, verifies `ADMIN_JWT` is signed
by the NEW entry (refuses to run otherwise — would lock out smoke),
prompts for confirmation, trims the keyring, triggers a deploy, and
verifies `/health` + `ADMIN_JWT` post-flip. See the script header for
the full safety analysis.

**Revoke an issued token**:
- The auth middleware checks `stateStore.isTokenRevoked(jti)`.
- For one-off revocation: `redis-cli SET revoked:<jti> 1 EX <ttl>`.
- For a full rotation, use the rotation flow above.

### `ADMIN_JWT` (long-lived JWT for ops scripts — TRANSITIONAL)

**Transitional**: This long-lived admin JWT exists because the
hosted smoke and ops scripts predate the asymmetric-KMS JWT work.
Phase 4b (`SECRETS_INTEGRATION_PLAN.md`) replaces this with
short-lived JWTs minted per-run from a CI OIDC → KMS path, after
which this entry retires.

**Mint with the script** (current procedure):
```bash
NEW_JWT=$(AUTH_JWT_SECRETS=$(op read "op://prod-backend/auth-jwt-secrets/password") \
  node scripts/ops/mint-admin-jwt.mjs --profile testnet --expires-in-days 30 --quiet)

# Store in 1Password (canonical home, used by Phase 2 PR 2.5 onward):
op item create --vault=prod-smoke --category=password --title=admin-jwt \
  "password=$NEW_JWT" \
  "notes=Long-lived (30d) admin JWT. TRANSITIONAL until Phase 4b."
# OR, during the transition window, also update the GH Actions secret:
printf '%s' "$NEW_JWT" | gh secret set ADMIN_JWT -R averray-agent/agent

unset NEW_JWT
```

Notes:
- `--profile testnet` — the current production system runs against
  Polkadot Hub TestNet, so the mint script reads the verifier wallet
  from `deployments/testnet.json`. After Phase 5 cutover provisions
  `deployments/mainnet.json`, this becomes `--profile mainnet`.
  (Earlier v3 doc drafts said `--profile production`, which doesn't
  match a real profile file — corrected in Phase 2 PR 2.1.)
- The op:// paths use the **flat** vault names (`prod-backend`,
  `prod-smoke`) committed in Phase 1, not the aspirational hierarchical
  `op://Averray/Production/...` scheme from the original plan docs.
- Both the GH Actions secret (`ADMIN_JWT`) and the 1Password item
  (`prod-smoke/admin-jwt`) must agree until PR 2.5 wires the smoke
  workflow to read from 1Password exclusively.

**Rotate**: Mint a new one with the script before the old expires.
Add a [`SECRETS_CALENDAR.yml`](SECRETS_CALENDAR.yml) entry so CI warns
you ~7 days out.

### `SIGNER_PRIVATE_KEY` (backend signer)

**Today** (testnet): plain hex in VPS env. Rotation requires
generating a new keypair, calling `setVerifier(new)` on TreasuryPolicy
via the multisig, and updating env. Heavy.

**Target** (after Phase 3 of
[`SECRETS_MIGRATION.md`](SECRETS_MIGRATION.md)): AWS KMS-managed
secp256k1 key. AWS does **not** support automatic rotation for
asymmetric KMS keys.

> **KMS signer key rotation is an on-chain signer migration event,
> not a routine calendar rotation. IAM/STS credentials rotate
> frequently; the KMS key rotates only through a planned verifier
> update via multisig.**

The migration procedure:
1. Create a new KMS key (same spec, same multi-region setup if
   mainnet)
2. Derive the new EVM address from the new key's public key
3. Multisig signs `setVerifier(newKmsAddress, true)` on TreasuryPolicy
4. Update `KMS_KEY_ID` env via 1Password; redeploy backend
5. Grace period (e.g., 24h): both keys are valid verifiers
6. Multisig signs `setVerifier(oldKmsAddress, false)` to disable
   the old key
7. Schedule deletion of the old KMS key (7–30 day pending period)
8. After deletion period, key is permanently destroyed

The KMS signer key is **explicitly NOT tracked** in
[`SECRETS_CALENDAR.yml`](SECRETS_CALENDAR.yml) because it rotates
on-chain, not on calendar.

IAM access credentials (Roles Anywhere certs, OIDC trust
relationship) DO rotate frequently and are calendar-tracked.

### `VPS_SSH_KEY`

**Mint**: `ssh-keygen -t ed25519 -f ~/.ssh/averray_deploy_<date> -C "averray-deploy-<date>"`.
Add the **public** key to the VPS's `~/.ssh/authorized_keys`. Update
the **private** key in the 1Password `Averray/Production/CI` vault so
GitHub Actions can sync it.

**Rotate**: standard "two keys side-by-side, remove old" pattern. Add
the new pubkey to authorized_keys, swap the GitHub secret, deploy
once, remove old pubkey.

**Revoke**: remove from `authorized_keys` and from GitHub secrets.

### Multisig signer seeds

See [`MULTISIG_SETUP.md`](MULTISIG_SETUP.md) and
[`SIGNER_POLICY.md`](SIGNER_POLICY.md). Seed loss is irrecoverable
without the other seeds; threshold is 2-of-3 so one loss is survivable.
Rotation = generate a new seed in a fresh wallet, replace the old signer
on-chain via a multisig transaction signed by the remaining N-1.

### External vendor tokens (Pimlico, Sentry, etc.)

Each has a vendor-specific UI. The generic flow:
1. Generate the new token in the vendor portal.
2. Update the 1Password entry.
3. Trigger a redeploy.
4. Revoke the old token in the vendor portal.

The [`SECRETS_CALENDAR.yml`](SECRETS_CALENDAR.yml) file tracks expiry
dates so CI can warn you N days before each rotation is due.

---

## Mainnet hardening checklist

When you're ready to launch on mainnet, **every secret in the inventory
above** gets rotated. Use this as the cutover checklist:

- [ ] Generate fresh `AUTH_JWT_SECRETS` (≥32 chars, never derive from testnet)
- [ ] **Create a fresh mainnet AWS KMS asymmetric secp256k1 signer
  key** (`KeySpec=ECC_SECG_P256K1`, `KeyUsage=SIGN_VERIFY`,
  `Origin=AWS_KMS`, multi-region from creation). **Do NOT generate,
  export, paste, or store a raw `SIGNER_PRIVATE_KEY` value anywhere
  for mainnet** — the key material is created inside the HSM and
  never leaves it; only the public key and its derived EVM
  address ever appear outside KMS. Mainnet builds set
  `config.allowLocalKeyFallback = false` so a stray
  `SIGNER_PRIVATE_KEY` env var cannot be loaded as a fallback.
- [ ] Generate fresh `VPS_SSH_KEY`
- [ ] Generate fresh deployer EOA key for the one-shot `deploy_contracts.sh`
- [ ] Set up new multisig signer seeds (separate seeds from testnet — do **not** reuse)
- [ ] Mint mainnet-only API keys for Pimlico, Sentry, Subscan, RPC provider
- [ ] Generate fresh `APP_BASIC_AUTH_PASSWORD` (assuming you keep basic-auth gating)
- [ ] Generate fresh `METRICS_BEARER_TOKEN`
- [ ] Generate fresh `RESEND_API_KEY`
- [ ] Verify zero secrets are shared between testnet and mainnet vaults
- [ ] Deploy contracts with the multisig as the owner from line 1 (don't use the EOA-then-transfer flow)
- [ ] After deploy, archive (don't delete) the testnet 1Password vault for forensics

The full migration plan with phased steps, rollback notes, and
per-phase checks lives in
[`SECRETS_MIGRATION.md`](SECRETS_MIGRATION.md).

---

## Tooling

| Script | Does | When to use |
|---|---|---|
| `scripts/ops/mint-admin-jwt.mjs` | Offline mint of admin JWTs | Rotating `ADMIN_JWT` GitHub secret |
| `scripts/ops/check-secrets-calendar.mjs` | Reads `SECRETS_CALENDAR.yml`, fails CI if any token expires within 7 days | Run on every CI build to catch drift before tokens die in production |
| `scripts/ops/audit-launch-readiness.mjs` | Reads on-chain TreasuryPolicy state | Pre-mainnet check; complements but doesn't overlap with this doc |
| `scripts/ops/fund-signer-usdc-deposit.mjs` | Approve + deposit USDC into AgentAccountCore | Funding flow only; see [`TESTNET_FUND_SIGNER.md`](TESTNET_FUND_SIGNER.md) |
| `scripts/rotate_pauser.sh` | Rotate pauser hot key | Periodic rotation drill |

---

## Related docs

- [`SECRETS_MIGRATION.md`](SECRETS_MIGRATION.md) — phase-by-phase
  migration to 1Password Business + AWS KMS
- [`SECRETS_CALENDAR.yml`](SECRETS_CALENDAR.yml) — declarative source of
  truth for token expiry tracking
- [`MULTISIG_SETUP.md`](MULTISIG_SETUP.md) — multisig provisioning and
  signer separation rules
- [`SIGNER_POLICY.md`](SIGNER_POLICY.md) — signer roles and key-handling
  policy
- [`INCIDENT_RESPONSE.md`](INCIDENT_RESPONSE.md) — what to do when a
  secret is suspected compromised
- [`TESTNET_FUND_SIGNER.md`](TESTNET_FUND_SIGNER.md) — how to fund the
  backend signer with USDC for hosted smoke (separate from secret
  management proper)
