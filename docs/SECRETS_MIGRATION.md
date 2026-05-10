# Secrets Migration — From "Starter Tier" to Pre-Mainnet Hardened

This doc is the operator's checklist for moving from where we are today
(plain-text env files + GitHub Actions secrets + ad-hoc password
managers) to where we need to be for mainnet (centralized vault for
human-managed secrets + AWS KMS for the hottest cryptographic key).

Read [`SECRETS.md`](SECRETS.md) first for the inventory. This doc
assumes you're convinced *what* needs to move and just need the *how*.

The migration breaks into **5 phases** that can land independently. Each
phase is mergeable on its own and reversible if something breaks. You
can pause between any of them.

| Phase | What | Time | Reversible? |
|---|---|---|---|
| 1 | 1Password Business setup + secret inventory loaded into vault | ~1 day | Yes — old env files still authoritative |
| 2 | Sync vault → runtime (CI + VPS) | ~1 day | Yes — fall back to GitHub UI / direct env edit |
| 3 | AWS KMS for the backend signer | ~2 days | Yes — keep `SIGNER_PRIVATE_KEY` env path until cutover |
| 4 | Hardening (CI secret scanning, short-lived JWTs, expiry alarms) | ~1 day | Yes — purely additive |
| 5 | Mainnet cutover | ~1 day | No — new addresses are fresh; testnet stays as testnet |

---

## Phase 1 — 1Password Business setup

### 1a. Sign up

- Plan: **1Password Business** ($7.99/user/mo). Cheaper than Teams
  Starter for ≤2 users (where you are today), and gives you Watchtower
  + finer-grained vault sharing for the same money.
- Use a dedicated email for the team account (e.g. `secrets@averray.com`),
  not your personal one. This makes future ownership transfers
  painless.

### 1b. Create the vault structure

Build these vaults in 1Password. Each is a separate access boundary.

```
Averray/
├── Production/
│   ├── Backend           # AUTH_JWT_SECRETS, RPC URLs, external API keys
│   ├── Indexer           # DATABASE_URL, PONDER_RPC_URL_*
│   ├── CI                # VPS_SSH_KEY, ADMIN_JWT, APP_BASIC_AUTH_*
│   └── External          # Pimlico, Sentry, Subscan, GitHub PAT, Resend, RPC provider
├── Testnet/              # Mirrors Production/ but for testnet keys
│   ├── Backend
│   ├── Indexer
│   ├── CI
│   └── External
├── Multisig/             # Signer reference info ONLY — never the seeds themselves
│   └── Signer addresses, public keys, SS58 forms
├── Operators/            # Per-operator personal vaults (auto-created by 1Password)
│   ├── Pascal
│   └── …
└── Archive/              # Decommissioned secrets, kept for audit
```

Why split testnet and production: re-using testnet secrets on mainnet
is the most common pre-launch mistake. Separate vaults make accidental
cross-contamination structurally impossible.

### 1c. Migrate secrets

For **every entry** in the inventory in [`SECRETS.md`](SECRETS.md),
create a corresponding 1Password item. Use the **API Credential** item
type — it has fields for the credential value, expiration, and notes.

Suggested naming: `<service>-<purpose>-<env>`, e.g.:
- `pimlico-bundler-url-production`
- `auth-jwt-secrets-production`
- `signer-private-key-testnet` (will be deleted after Phase 3)

Required fields per item:
- The secret value
- Description: 1–2 sentences on what it unlocks
- Expiration date (where applicable; use the [`SECRETS_CALENDAR.yml`](SECRETS_CALENDAR.yml) cadence)
- Tags: `production` / `testnet` / `ci` / `runtime`
- Notes: link back to the inventory section in `SECRETS.md`

### 1d. Provision a service account for runtime sync

This is the read-only credential that GitHub Actions and the VPS use to
fetch secrets without a human signing in.

1. In 1Password admin: **Integrations → Service Accounts → New**
2. Name: `averray-runtime-readonly`
3. Vault access: **read-only** to `Averray/Production/*` and
   `Averray/Testnet/*` (NOT to Multisig or Operators)
4. Save the service account token in your personal 1Password vault as
   `1password-runtime-token-production` — this is itself a secret
5. Set up a calendar reminder to rotate this token every 90 days
   (1Password's max for service accounts)

### Phase 1 done = exit criteria

- [ ] All ~70 secrets from the inventory are in 1Password
- [ ] Each item has its description and tags
- [ ] Service account token is provisioned and stored
- [ ] Migration is **purely additive** — old env files still
  authoritative; no plumbing changes yet
- [ ] You can find any secret in <30 seconds via 1Password search

### Rollback

Trivial: nothing depends on 1Password yet. Delete the vault and walk
away if the team decides to use a different tool.

---

## Phase 2 — Sync vault → runtime

This is where the actual win lives. After this phase, rotating a secret
= update one entry in 1Password, redeploy. No more "did I update GitHub
Actions AND the VPS env file?".

### 2a. Install `op` CLI on the VPS

```bash
# on the VPS, as root or via sudo
curl -sS https://downloads.1password.com/linux/keys/1password.asc \
  | gpg --dearmor --output /usr/share/keyrings/1password-archive-keyring.gpg
echo 'deb [arch=amd64 signed-by=/usr/share/keyrings/1password-archive-keyring.gpg] https://downloads.1password.com/linux/debian/amd64 stable main' \
  | tee /etc/apt/sources.list.d/1password.list
mkdir -p /etc/debsig/policies/AC2D62742012EA22 /usr/share/debsig/keyrings/AC2D62742012EA22
curl -sS https://downloads.1password.com/linux/debian/debsig/1password.pol \
  | tee /etc/debsig/policies/AC2D62742012EA22/1password.pol
curl -sS https://downloads.1password.com/linux/keys/1password.asc \
  | gpg --dearmor --output /usr/share/debsig/keyrings/AC2D62742012EA22/debsig.gpg
apt update && apt install -y 1password-cli
```

Verify: `op --version`.

### 2b. Set the service account token

```bash
# on the VPS
echo 'export OP_SERVICE_ACCOUNT_TOKEN="ops_..."' >> /etc/agent-stack/op.env
chmod 600 /etc/agent-stack/op.env
```

The `op` CLI auto-detects this env var and uses it for all subsequent
commands.

### 2c. Convert `backend.env` to a template

Replace plain-text values with `op://` URI references. Save the result
as `/srv/agent-stack/backend.env.template`.

```diff
# /srv/agent-stack/backend.env (BEFORE — plain text)
- AUTH_JWT_SECRETS=abc123def456...
- SIGNER_PRIVATE_KEY=0x...
- PIMLICO_BUNDLER_URL=https://api.pimlico.io/...

# /srv/agent-stack/backend.env.template (AFTER)
+ AUTH_JWT_SECRETS=op://Averray/Production/Backend/auth-jwt-secrets/credential
+ SIGNER_PRIVATE_KEY=op://Averray/Production/Backend/signer-private-key/credential
+ PIMLICO_BUNDLER_URL=op://Averray/Production/External/pimlico-bundler-url/credential
```

### 2d. Render at deploy time

Add to `scripts/ops/deploy-production.sh`, before the docker compose
restart step:

```bash
# Source the OP service account token
source /etc/agent-stack/op.env

# Render env files
op inject -i /srv/agent-stack/backend.env.template -o /srv/agent-stack/backend.env
op inject -i /srv/agent-stack/indexer.env.template -o /srv/agent-stack/indexer.env
chmod 600 /srv/agent-stack/backend.env /srv/agent-stack/indexer.env

# (existing: docker compose pull && up)
```

After deploy, the rendered `backend.env` looks identical to today.
Difference: it's regenerated from 1Password every deploy. If you change
a secret in 1Password and redeploy, the new value lands automatically.

### 2e. Convert GitHub Actions secrets

Use the official 1Password Action:

```yaml
# .github/workflows/deploy-production.yml
- uses: 1password/load-secrets-action@v1
  env:
    OP_SERVICE_ACCOUNT_TOKEN: ${{ secrets.OP_SERVICE_ACCOUNT_TOKEN }}
    VPS_SSH_KEY: op://Averray/Production/CI/vps-ssh-key/credential
    ADMIN_JWT:    op://Averray/Production/CI/admin-jwt/credential
    APP_BASIC_AUTH_PASSWORD_HASH: op://Averray/Production/CI/app-basic-auth-password-hash/credential
    RESEND_API_KEY:                op://Averray/Production/CI/resend-api-key/credential
```

Now the GitHub Actions secret store contains exactly **one** entry:
`OP_SERVICE_ACCOUNT_TOKEN`. Everything else flows from 1Password.

### 2f. Cutover

1. **Don't delete the old plain-text values yet.** Run a deploy with
   both paths active in parallel for 24h to confirm the rendered files
   match what was there before.
2. Verify with `diff` (compare against an offline backup of the old
   `backend.env`).
3. After 24h of clean deploys, delete the legacy GitHub Actions
   secrets and the plain-text `backend.env` backups. Lock down VPS
   access so only `op inject` writes the env file.

### Phase 2 done = exit criteria

- [ ] `op` CLI installed on VPS, service account token configured
- [ ] `backend.env.template` and `indexer.env.template` exist with
  `op://` references for every secret
- [ ] Deploy script renders env from template
- [ ] GitHub Actions workflows reference only `OP_SERVICE_ACCOUNT_TOKEN`
  + the 1Password load-secrets action
- [ ] Old plain-text secrets are removed from GitHub Actions / VPS
- [ ] Test rotation: change one secret in 1Password → redeploy → new
  value reaches runtime

### Rollback

Per-secret: copy the value out of 1Password into the old plain-text
location (GitHub Actions secret or VPS env). Per-phase: revert the
deploy script PR and the workflow changes.

---

## Phase 3 — AWS KMS for the backend signer

This is the big security win. After this phase, no human, no env file,
no log line, and no backup ever contains the private key for the
backend signer. Compromise of the VPS or 1Password vault no longer
implies compromise of the signer.

### 3a. AWS account + IAM policy

1. Create an AWS account (use root only to set up billing + IAM, then
   never touch root again)
2. Create an IAM user `averray-signer-prod` with **only** these
   permissions:
   - `kms:Sign` on the specific key ARN
   - `kms:GetPublicKey` on the same
3. Generate access key + secret for that IAM user
4. Store the access key + secret as 1Password items
   `aws-kms-signer-access-key-id` and `aws-kms-signer-secret-access-key`
   in `Averray/Production/Backend`

### 3b. Create the KMS key

Via AWS Console (Key Management Service) or CLI:

```bash
aws kms create-key \
  --description "Averray production backend signer (secp256k1)" \
  --key-usage SIGN_VERIFY \
  --customer-master-key-spec ECC_SECG_P256K1 \
  --region eu-central-1
```

Save the returned `KeyId` UUID. The key spec `ECC_SECG_P256K1` is the
Ethereum curve.

### 3c. Derive the EVM address

The EVM address is the keccak256 of the public key, last 20 bytes:

```js
import { KMSClient, GetPublicKeyCommand } from "@aws-sdk/client-kms";
import { keccak256 } from "ethers";
import { secp256k1 } from "@noble/curves/secp256k1";

const kms = new KMSClient({ region: "eu-central-1" });
const { PublicKey } = await kms.send(new GetPublicKeyCommand({ KeyId: "<uuid>" }));
// PublicKey is DER-encoded; extract the 64-byte uncompressed point
const point = PublicKey.subarray(PublicKey.length - 64);
const address = "0x" + keccak256(point).slice(-40);
console.log("EVM address:", address);
```

This becomes the new on-chain verifier address.

### 3d. Wire the backend

Add `KMS_KEY_ID` and `AWS_REGION` env vars to `backend.env.template` (they
flow through 1Password). Update `mcp-server/src/blockchain/gateway.js`:

```js
import { AwsKmsSigner } from "@rumblefishdev/eth-signer-kms";

function createSigner(provider, config) {
  if (config.kmsKeyId) {
    return new AwsKmsSigner({
      keyId: config.kmsKeyId,
      region: config.awsRegion ?? "eu-central-1",
    }, provider);
  }
  // Fallback for testnet / local dev
  if (config.signerPrivateKey) {
    return new Wallet(config.signerPrivateKey, provider);
  }
  throw new Error("No signer configured (KMS_KEY_ID or SIGNER_PRIVATE_KEY required).");
}
```

The `AwsKmsSigner` is a drop-in `ethers.Signer`. All call sites
(`escrowContract.connect(signer)`, etc.) work unchanged.

### 3e. Test on testnet first

1. Generate a fresh KMS key in AWS for testnet
2. Deploy fresh testnet contracts using the KMS-derived address as
   the verifier
3. Run the full hosted product-proof smoke loop end-to-end with the
   KMS path
4. Confirm: `dmesg` / process tree / `cat backend.env` — the
   private key bytes appear nowhere

### 3f. Cutover

For testnet: just update the `verifier` field in
`deployments/testnet.json`, deploy fresh, switch.

For mainnet: this is part of Phase 5 — the mainnet deploy is the
first time the KMS-managed key signs anything.

### Phase 3 done = exit criteria

- [ ] AWS account + IAM user provisioned with minimal-permission policy
- [ ] KMS key created (one for testnet, one for mainnet)
- [ ] EVM address derived and matches what's expected on-chain
- [ ] `AwsKmsSigner` adapter integrated and unit-tested
- [ ] Hosted product-proof smoke passes end-to-end on testnet using the
  KMS path
- [ ] `SIGNER_PRIVATE_KEY` env path retained as fallback for local dev
  but removed from production env

### Rollback

Easy: revert to `SIGNER_PRIVATE_KEY` env path on the backend. The
contract-side verifier address would need to be reset on TreasuryPolicy
via the multisig — irreversible if mainnet deploy already happened, so
test on testnet first.

---

## Phase 4 — Hardening

Three small additions; each <1h.

### 4a. CI secret scanning

Add a `gitleaks` step to the CI workflow:

```yaml
# .github/workflows/ci.yml
- uses: gitleaks/gitleaks-action@v2
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

This fails any PR that accidentally contains a secret pattern (private
keys, JWTs, AWS keys, etc.). One-time setup; ongoing protection.

### 4b. Short-lived JWTs + refresh tokens

Replace the long-lived `ADMIN_JWT` GitHub secret pattern with a refresh
token model:

- The hosted worker loop receives a **refresh token** (long-lived,
  stored in 1Password)
- On each run, it exchanges the refresh token for a **fresh access
  token** (1h lifetime) via a new `/auth/refresh` endpoint
- The access token never sits in env vars long enough to expire
  unattended

Implementation: add `mcp-server/src/auth/refresh.js` with the
exchange endpoint; update `run-hosted-worker-loop.mjs` to call it at
the start of each run.

### 4c. Expiry calendar + CI check

Already in this PR: [`SECRETS_CALENDAR.yml`](SECRETS_CALENDAR.yml) +
`scripts/ops/check-secrets-calendar.mjs`. Wire into the CI workflow:

```yaml
# .github/workflows/ci.yml
- name: Check secrets calendar
  run: node scripts/ops/check-secrets-calendar.mjs
```

This warns 7 days before any tracked token expires. Doesn't fail CI on
warnings (would block legitimate work) but does fail on any token
already past expiry.

### Phase 4 done = exit criteria

- [ ] `gitleaks` runs on every PR
- [ ] Hosted worker loop uses refresh-token exchange instead of
  long-lived `ADMIN_JWT`
- [ ] CI warns 7 days before any tracked token expires
- [ ] No secret has been merged into the repo for at least 14 days
  after `gitleaks` lands (sanity check the scanner is configured right)

---

## Phase 5 — Mainnet cutover

This is the night-of deploy. Treat it as a one-shot ceremony with all
four prior phases already in production for ≥1 week each.

### Pre-flight checklist

The day before:

- [ ] All four prior phases live and stable on testnet for ≥7 days
- [ ] Audit script (`scripts/ops/audit-launch-readiness.mjs`) shows
  zero drift between testnet config and the planned mainnet config
- [ ] `op` service account token rotated within the last 30 days
- [ ] AWS KMS key for mainnet created with separate IAM user from
  testnet
- [ ] Multisig signer set is established with **fresh seeds** —
  do not reuse testnet seeds
- [ ] All vendor accounts (Pimlico, Sentry, Subscan, RPC provider) have
  separate mainnet API keys minted
- [ ] On-call rotation defined in `INCIDENT_RESPONSE.md` Section 1
  (currently a blank template — fill it in)

### Cutover sequence

1. **Generate fresh secrets**: rotate every secret listed in
   [`SECRETS.md`'s mainnet hardening checklist](SECRETS.md#mainnet-hardening-checklist).
   Each goes into a fresh 1Password item under
   `Averray/Production/<vault>/`.
2. **Provision the multisig** on Polkadot.js Apps with the three new
   signer addresses (Hot, Warm, Cold per `MULTISIG_SETUP.md`).
3. **Deploy contracts** with the multisig as the owner from line 1
   (skip the EOA-then-transfer flow used on testnet — owner is the
   multisig from genesis).
4. **Update `deployments/mainnet.json`** with all addresses.
5. **Update `backend.env.template`** to reference the new mainnet
   1Password items (or use a separate `backend.mainnet.env.template`).
6. **Run the smoke** with `product_proof_reward_asset=USDC` against
   mainnet.
7. **Archive** the testnet 1Password vault — read-only, kept for
   forensics. **Do not delete** for at least 90 days.

### Post-cutover verification

- [ ] `audit-launch-readiness.mjs` shows green for mainnet
- [ ] `check-secrets-calendar.mjs` shows zero entries within 7 days of
  expiry
- [ ] Hosted product-proof smoke passes end-to-end three consecutive
  runs
- [ ] No secret appears in any log file or process listing on the
  mainnet VPS (`ps -ef | grep -E '0x[a-f0-9]{60}'` returns nothing)
- [ ] On-call rotation is live and the first responder has been paged
  with a test alert successfully

---

## Cost summary

| Item | Monthly cost |
|---|---|
| 1Password Business (1 user) | $7.99 |
| 1Password Business (3 users) | $23.97 |
| AWS KMS asymmetric key | $1 + $0.15 per 10k signatures (~$1.05/mo at our volume) |
| AWS minimum (free tier covers most ancillary services) | $0 |
| **Total at 1 user, current scale** | **~$9/mo** |
| **Total at 3 users, current scale** | **~$25/mo** |

The cost is rounding error compared to the security improvement. The
real cost is **engineering time for the migration** (~5 working days
spread over a few weeks).

---

## When something goes wrong

Each phase has its own rollback noted above. For incidents:

- **Suspected secret compromise**: see [`INCIDENT_RESPONSE.md`](INCIDENT_RESPONSE.md).
  Per-secret rotation paths are in
  [`SECRETS.md`'s runbook section](SECRETS.md#per-secret-runbook-when-something-breaks).
- **Migration step fails halfway**: roll back that step. Old path is
  still live until you explicitly remove it.
- **Vault locked / 1Password down**: the rendered env files are still
  on the VPS. Don't redeploy until 1Password recovers. If urgent, an
  operator can manually edit the rendered env file as a one-off — but
  the next deploy will overwrite it from the vault.

---

## Related

- [`SECRETS.md`](SECRETS.md) — the inventory + storage strategy
- [`SECRETS_CALENDAR.yml`](SECRETS_CALENDAR.yml) — token expiry tracking
- [`MULTISIG_SETUP.md`](MULTISIG_SETUP.md) — multisig provisioning
- [`SIGNER_POLICY.md`](SIGNER_POLICY.md) — signer roles and key handling
- [`INCIDENT_RESPONSE.md`](INCIDENT_RESPONSE.md) — incident playbook
