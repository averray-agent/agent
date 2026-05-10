# Secrets — Inventory and Storage Strategy

This is the canonical map of every key, password, token, and credential
the Averray platform depends on. Read this first when:

- You need to rotate a secret and want to know which surfaces it touches
- You're onboarding a new operator and they need access
- You're preparing for mainnet (see also
  [`SECRETS_MIGRATION.md`](SECRETS_MIGRATION.md))
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

| Secret class | Where it lives | How runtime gets it |
|---|---|---|
| App secrets (JWT secret, RPC URLs, Pimlico, Sentry, GH PAT, Subscan, webhooks) | 1Password Business → `Averray/Production/Backend` vault | `op inject` renders the env at deploy time; `op://` URI references in templates, no plain-text on disk |
| GitHub Actions secrets (`VPS_SSH_KEY`, `ADMIN_JWT`, `APP_BASIC_AUTH_*`) | 1Password Business → `Averray/Production/CI` vault | Synced via `1password/load-secrets-action@v1` per workflow job |
| Indexer env (DB password, RPC URL) | 1Password Business → `Averray/Production/Indexer` vault | Same pattern as backend |
| Backend signer key | **AWS KMS** secp256k1 key, region pinned, IAM-controlled | ethers.js `AwsKmsSigner` adapter — backend never sees the private key |
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
| `APP_BASIC_AUTH_PASSWORD` | Plain password | Same | Operator | Periodic | Same |
| `APP_BASIC_AUTH_PASSWORD_HASH` | bcrypt/htpasswd hash | Same (preferred over plain) | Operator | Periodic | Same |
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
| Pauser | `0xFd2EAE…6519` | Local env / hot key | EOA today; can be rotated via `rotate_pauser.sh` |
| Verifier | `0xFd2EAE…6519` | `SIGNER_PRIVATE_KEY` (current) → AWS KMS (target) | The hottest key |
| Arbitrator | `0xFd2EAE…6519` | `SIGNER_PRIVATE_KEY` (current) → AWS KMS (target) | Same key as verifier today; consider splitting |

### F. External service tokens (vendor portals)

These are the entries you'll find in 1Password's `Averray/Production/External`
vault. Each has a vendor-side rotation path.

| Service | What | Vendor portal | Rotation |
|---|---|---|---|
| Pimlico | Bundler + paymaster URLs, sponsorship policy ID | dashboard.pimlico.io | On policy change |
| Sentry | Project DSN | sentry.io | Rare (per project lifetime) |
| GitHub | Personal access token | github.com/settings/tokens | Per token's `expires_at` (typically 90d) |
| Subscan | API key | subscan.io | Per their cycle |
| Resend | API key | resend.com | Periodic |
| Webhook (alerts) | Slack/Discord/PagerDuty URL | Their respective dashboards | Rare |
| Dweller / Polkadot RPC | URL (and any auth token) | Provider portal | Rare |

---

## Per-secret runbook (when something breaks)

For each secret class, the canonical mint/rotate/revoke flow.

### `AUTH_JWT_SECRETS` (HMAC for SIWE sessions)

**Mint a new entry**:
```bash
openssl rand -hex 32     # 64-char hex string, ≥32 bytes
```
Add to 1Password as a new field; do **not** delete the old one yet.

**Rotate**:
1. Update the 1Password entry: prepend the new secret, keep the old one.
2. Trigger a redeploy. Backend now signs with new, accepts both.
3. After 24-48h grace period (allows in-flight tokens to expire),
   delete the old secret from the 1Password entry.
4. Trigger a second redeploy. Old tokens now reject.

**Revoke an issued token**:
- The auth middleware checks `stateStore.isTokenRevoked(jti)`.
- For one-off revocation: `redis-cli SET revoked:<jti> 1 EX <ttl>`.
- For a full rotation, use the rotation flow above.

### `ADMIN_JWT` (long-lived JWT for ops scripts)

**Mint with the script**:
```bash
AUTH_JWT_SECRETS=$(op read "op://Averray/Production/Backend/AUTH_JWT_SECRETS") \
  node scripts/ops/mint-admin-jwt.mjs --profile testnet --expires-in-days 30 --quiet \
  | gh secret set ADMIN_JWT
```

**Rotate**: Mint a new one with the script before the old expires.
Add a [`SECRETS_CALENDAR.yml`](SECRETS_CALENDAR.yml) entry so CI warns
you ~7 days out.

### `SIGNER_PRIVATE_KEY` (backend signer)

**Today** (testnet): plain hex in VPS env. Rotation requires generating
a new keypair, redeploying contracts (because the verifier address is
baked into TreasuryPolicy), and updating env. Heavy.

**Target** (after Phase 3 of [`SECRETS_MIGRATION.md`](SECRETS_MIGRATION.md)):
AWS KMS-managed secp256k1 key. Rotation path:
1. Create a new KMS key.
2. Import the new public key as the new verifier on TreasuryPolicy via
   the multisig (`setVerifier(new, true)`).
3. Update `KMS_KEY_ID` in the backend env via 1Password; redeploy.
4. After grace period: `setVerifier(old, false)` and `kms.scheduleKeyDeletion(old)`.

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
- [ ] Generate fresh `SIGNER_PRIVATE_KEY` — **and put it directly in AWS KMS, never on disk**
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
