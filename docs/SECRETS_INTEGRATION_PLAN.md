# Secrets Integration Plan — Security Review Document

> **Status**: v3 — incorporates a SECOND external security review
> pass on top of v2. See [Revision history](#revision-history) at
> the bottom.

This is the security-review-grade companion to
[`SECRETS_MIGRATION.md`](SECRETS_MIGRATION.md). Where the migration doc
is a "how-to" for the operator executing the work, this doc is the
"why and where it could go wrong" for the security reviewer signing
off on the design.

If you're reading this to sign off on mainnet, jump to
[Section 11 — Mainnet sign-off bar](#11-mainnet-sign-off-bar).

---

## 1. Scope & honest limitations

**What this is**: a phased plan to move the platform's secrets out of
plain-text env files + ad-hoc password managers into a centralized
vault (1Password Business) + a hardware-backed signer (AWS KMS),
before mainnet launch. The plan is calibrated for "Tier 2.5" maturity
(centralized vault + KMS for hottest keys) — not "Tier 3"
(MPC / threshold signing / fully HSM-only).

**What this is NOT**:
- A full security audit. Contract logic, RPC validation, rate limits,
  supply-chain risk in npm deps — none of that is in scope here.
- A replacement for third-party security review. **For mainnet, get a
  real audit** (Trail of Bits, Halborn, ChainSecurity, OpenZeppelin)
  before launch.
- Compliance documentation.

**My limitations**:
- I'm an AI assistant, not a security professional. Treat
  recommendations as a thoughtful first pass.
- I haven't physically operated 1Password Business or AWS KMS at
  scale. Patterns described are widely used; environment-specific
  gotchas may differ.
- For the highest-risk decisions (key derivation, multisig signer
  separation, IAM policies, JWT signing migration), get a second
  human pair of eyes.

---

## 2. Threat model

### 2a. Adversaries

| Adversary class | Capability | In scope? |
|---|---|---|
| Opportunistic attacker (leaked secrets in public repo, log dump, breach corpus) | Replay leaked secret | ✅ |
| External attacker with VPS network access (RCE pivot) | Read VPS files, exec arbitrary code with backend's privileges | ✅ |
| External attacker with one operator's machine (keylogger, stolen laptop) | Read browser local-storage, password manager auto-fill, shell history | ✅ |
| Compromised CI/CD (malicious workflow change) | Replay any secret available to a job | ✅ |
| Disgruntled insider with deployer access | Generate ADMIN_JWT, exfiltrate to attacker-controlled vault | ⚠️ Partial — single-operator orgs have limited mitigation. Address with second operator before mainnet. |
| State-level adversary / supply chain attack on 1Password or AWS | Subvert vault provider or KMS provider directly | ❌ Out of scope — mitigation is "use providers with strong track records and don't be a high-value target" |
| Quantum cryptanalysis | Break secp256k1 / HMAC-SHA256 | ❌ Out of scope |

### 2b. Assets (in rough order of blast radius)

1. **Multisig signer seeds** — controls TreasuryPolicy ownership.
   Already segregated to 3 humans/devices per `MULTISIG_SETUP.md`.
   **Never enters the centralized vault.**
2. **Backend signer key** (currently `SIGNER_PRIVATE_KEY`, migrating
   to AWS KMS) — signs every verification + arbitration. Compromise
   = forged badges, false dispute outcomes, unauthorized resolutions.
3. **`AUTH_JWT_SECRETS`** (today HMAC HS256, target asymmetric via
   KMS) — signs SIWE sessions. Compromise = forge admin/verifier
   JWTs and bypass the auth layer.
4. **AWS access credentials** for KMS-signer principal — even with
   KMS, the calling identity needs credentials. Migrating these to
   temporary credentials (IAM Roles Anywhere / GitHub OIDC) is the
   second-tier security upgrade after the KMS migration itself.
5. **`VPS_SSH_KEY`** — full code-execution path on production VPS.
6. **`OP_SERVICE_ACCOUNT_TOKEN`**(s) — each one is a vault-decryption
   capability for its scoped vaults. Treat with the seriousness of
   the secrets it can unlock.
7. **External vendor keys** (Pimlico, Sentry, Subscan, RPC provider).
   These can become platform-impacting via availability, rate limits,
   or allowlisted-origin compromise — soften the "not platform-level"
   framing accordingly.
8. **Operator passwords** — basic auth, personal vault items.

### 2c. Trust assumptions

- **AWS** is trusted to keep KMS private bytes inside the HSM.
- **1Password Business** is trusted to not leak vault contents.
  Their E2E encryption design means a server-side breach does NOT
  expose secrets without the user's master password — which 1Password
  themselves do not have.
- **GitHub** is trusted to keep org and environment secrets
  confidential.
- **Operator's local machine** is trusted IFF disk encryption is
  enabled, OS is patched, password manager is locked when not in use,
  and admin access is gated by a hardware key (e.g., YubiKey).
- **Polkadot Hub network** is trusted for transaction integrity
  (consensus-level guarantees).

---

## 3. Current state security posture (Tier 1)

### 3a. Where each secret class lives today

```
┌─────────────────────────────────────────────────────────┐
│ GitHub Actions secrets                                  │
│   VPS_SSH_KEY, ADMIN_JWT, APP_BASIC_AUTH_*, RESEND…     │
│   → managed via GitHub repo settings UI                 │
│   → 9 entries; all injected into deploy workflow        │
└─────────────────────────────────────────────────────────┘
                          │ over SSH at deploy time
                          ▼
┌─────────────────────────────────────────────────────────┐
│ VPS plain-text env files                                │
│   /srv/agent-stack/backend.env (40+ entries)            │
│   /srv/agent-stack/indexer.env (3 entries)              │
│   → readable by root + service user                     │
│   → SIGNER_PRIVATE_KEY in plain text                    │
└─────────────────────────────────────────────────────────┘

Operator machines: deployer PRIVATE_KEY, OWNER_KEY,
APP_BASIC_AUTH_PASSWORD, SSH key passphrase — in personal
password managers (mixed vendors per operator).

Hardware wallets: multisig Hot/Warm/Cold seeds.
```

### 3b. Vulnerabilities in current state

| Vulnerability | Severity | Exploitation |
|---|---|---|
| `SIGNER_PRIVATE_KEY` plain-text on disk | **High** | Any VPS root compromise → `cat backend.env` → forge verifications |
| `AUTH_JWT_SECRETS` HMAC + symmetric | **High** | Vault leak OR env-file leak = anyone can mint admin JWTs |
| No CI secret scanning, no pre-commit hooks | Medium | Accidental commit lands in repo; remediation is "force-push and rotate" |
| Long-lived `ADMIN_JWT` GitHub secret | Medium (UX + audit gap) | Just bit us — token expired, no mint script, smoke blocked |
| No expiry tracking | Medium | Vendor tokens rot silently; ops scripts fail at the worst time |
| GitHub Actions: any admin can read secrets via deploy-time injection | Medium | Compromised workflow change → secrets exfiltrate to attacker-controlled endpoint |

---

## 4. Target state architecture (Tier 2.5)

### 4a. Where each secret class lives after migration

```
┌─────────────────────────────────────────────────────────────────┐
│ 1Password Business                                              │
│   Averray/Production/Backend         ← backend runtime secrets  │
│   Averray/Production/BackendExternal ← vendor tokens used by    │
│                                         backend (Pimlico,       │
│                                         Subscan, RPC, Sentry,   │
│                                         Resend backend key)     │
│   Averray/Production/Indexer         ← indexer-only secrets     │
│   Averray/Production/CI              ← deploy creds (SSH key,   │
│                                         basic-auth HASH)        │
│   Averray/Production/CIExternal      ← vendor tokens used only  │
│                                         in CI (GitHub PAT for   │
│                                         issue ingestion, CI-    │
│                                         scoped Resend key)      │
│   Averray/Production/Smoke           ← admin-jwt + smoke-only   │
│                                         credentials             │
│   Averray/Production/Critical        ← human-only: service-     │
│                                         account tokens, AWS     │
│                                         root, Roles Anywhere    │
│                                         cert metadata, basic-   │
│                                         auth RAW password,      │
│                                         pauser EOA seed         │
│   Averray/Production/Observability   ← OPTIONAL: dashboards     │
│                                         and metrics tokens      │
│   Averray/Testnet/* (same shape, separate vaults)               │
│   Averray/Multisig                   ← signer ADDRESSES only,   │
│                                         never seeds             │
│   Averray/Operators/<name>           ← per-operator personal    │
│   Averray/Archive                    ← REVOKED/EXPIRED ONLY —   │
│                                         retained 90d for        │
│                                         forensics, then deleted │
│                                                                 │
│  Read access via FOUR distinct service accounts                 │
│  (each scoped to its minimum vault set):                        │
│    prod-ci-deploy   → CI + CIExternal                           │
│    prod-vps-backend → Backend + BackendExternal                 │
│    prod-vps-indexer → Indexer                                   │
│    prod-smoke-tests → Smoke                                     │
│  (plus testnet equivalents; NONE can read Critical)             │
└─────────────────────────────────────────────────────────────────┘
            │                          │
            │ op:// URI                │ 1password/load-secrets-action
            ▼                          ▼
┌────────────────────────────┐ ┌──────────────────────────────────┐
│ VPS at deploy              │ │ GitHub Actions workflow runtime  │
│ /etc/agent-stack/op-       │ │   Only OP_*_TOKEN secrets in     │
│   {backend,indexer}.env    │ │   GitHub repo settings.          │
│ Renders env to tmpfs:      │ │   Each job pulls only what it    │
│ /run/agent-stack/*.env     │ │   needs from 1Password.          │
│ chmod 0400 root:root       │ │   Production deploy gated by     │
│ Excluded from backups      │ │   GitHub Environment with        │
└────────────────────────────┘ │   required reviewers.            │
                               └──────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ AWS KMS                                                         │
│   secp256k1 key (asymmetric, SIGN_VERIFY)                       │
│     → multi-region for mainnet (can't convert later!)           │
│   region(s): primary + ≥1 replica                               │
│   IAM access for sign:                                          │
│     → VPS: IAM Roles Anywhere (X.509-based temporary creds)     │
│     → GitHub Actions: GitHub OIDC → assume role                 │
│     → no long-lived IAM access keys for the signer principal    │
│   IAM policy restrictions:                                      │
│     kms:Sign + kms:GetPublicKey only                            │
│     condition: kms:SigningAlgorithm = ECDSA_SHA_256             │
│     condition: kms:MessageType = DIGEST                         │
└─────────────────────────────────────────────────────────────────┘
            │
            │ AwsKmsSigner ethers.js adapter
            ▼
┌─────────────────────────────────┐
│ Backend on VPS                  │
│  - never holds signer private   │
│    key bytes                    │
│  - holds X.509 client cert      │
│    for IAM Roles Anywhere; uses │
│    it to fetch short-lived STS  │
│    credentials                  │
└─────────────────────────────────┘

Hardware wallets — UNCHANGED. Multisig signer seeds NEVER touch
1Password.
```

### 4b. Trust boundaries

| Boundary | What's on each side | Compromise of one means... |
|---|---|---|
| 1Password vault ↔ runtime | Vault stores plain values; runtime fetches via per-runtime scoped service tokens | A scoped token leak = read access to ONE vault scope only (e.g., prod-ci-deploy token leak ≠ access to Backend secrets) |
| AWS KMS ↔ backend | KMS holds private key bytes; backend gets temporary creds via Roles Anywhere | Compromise of running backend = ability to sign for ≤1h until temp creds expire; CANNOT export key |
| GitHub Actions ↔ AWS | GitHub OIDC → AssumeRole. Separate `averray-ci-deploy-role` (NO `kms:Sign`) from `averray-signer-prod-role` (Roles Anywhere only). | Compromise of CI workflow can NOT assume the signer role — the signer role's trust policy doesn't include GitHub OIDC. Workflow-level compromise gets at most CI-scoped permissions (read-only ECR/S3, optionally `kms:GetPublicKey`). Revoke trust relationship in IAM to stop. |
| GitHub Actions ↔ VPS | Production deploy gated by GitHub Environment with required reviewers + restricted branches | Compromised workflow PR cannot deploy without a human approval gate |

### 4c. What attacks this defends against (vs current state)

| Attack | Tier 1 (current) | Tier 2.5 (target) |
|---|---|---|
| VPS root compromise | Reads SIGNER_PRIVATE_KEY directly + every backend env value | Can call kms.sign **while STS creds are valid (≤1h)**; CANNOT export key. Can read CURRENT backend env from tmpfs; restart = re-render from vault (and rotating one OP token kills future reads). CloudTrail surfaces the abuse. |
| GitHub Actions compromised | All 9 GH secrets exposed | Only the OP service-account tokens scoped to CI are exposed. Production deploy still blocked by Environment review. Rotating one OP token = ~minutes. |
| Operator laptop stolen (with disk encryption) | Maybe nothing if 1Password locked; otherwise everything | Same. Operator revokes their 1Password session + rotates affected service tokens. All keys still in vault and KMS. |
| Operator laptop stolen (no disk encryption) | Catastrophic | Catastrophic. **Disk encryption is non-negotiable.** |
| Secret accidentally committed to repo | Visible in commit; manual cleanup; **may already be public** | Pre-commit hook blocks at write time; GitHub push protection blocks at push time; CI gitleaks as last-resort sweep. |
| Vendor token expires unattended | Smoke fails at runtime | Calendar warns ≥7 days out via CI. |
| Insider threat (single operator) | Operator can do anything | Operator can do anything — mitigation is a second operator with separation of duties, **out of scope for this plan but required for mainnet.** |

---

## 5. Phase-by-phase security analysis

### Phase 1 — 1Password Business setup + multiple service accounts

**Goal**: Provision 1Password Business with vault structure +
multiple scoped service accounts. No runtime changes yet.

**What changes**:
- A new SaaS provider holds copies of secrets that already exist on disk.
- Vault structure separates per-environment (testnet vs production) and
  per-runtime (CI vs VPS-backend vs VPS-indexer vs smoke).

**Service account scoping** (the key architectural call):

| Service account | Read access | Used by |
|---|---|---|
| `prod-ci-deploy` | `Averray/Production/CI` + `Averray/Production/CIExternal` | GitHub Actions deploy workflow |
| `prod-vps-backend` | `Averray/Production/Backend` + `Averray/Production/BackendExternal` | Backend VPS at deploy time (`op inject`) |
| `prod-vps-indexer` | `Averray/Production/Indexer` | Indexer VPS at deploy time |
| `prod-smoke-tests` | `Averray/Production/Smoke` (dedicated vault) | Hosted product-proof smoke runs |
| (testnet equivalents) | corresponding `Averray/Testnet/*` | testnet workflows |

**None of these tokens can read `Averray/Production/Critical`** —
the Critical vault holds the service-account tokens themselves,
the AWS root, the Roles Anywhere cert metadata, the basic-auth
RAW password, and the pauser EOA seed. Critical is human-only.
This is the firebreak: a leaked runtime token cannot read its own
replacement, cannot read the next layer of credentials, cannot
escalate.

**Service account access and vault permissions are effectively
immutable after creation** — design scopes correctly up front. If
you need to change a scope, generate a new token with the right
scope and rotate.

**1Password's service-account token is NOT "just an API token"**.
It includes account-unlock material serialized into the token; treat
it as a vault decryption capability for its scoped vaults. Per
1Password's own docs, protection of the token is the customer's
responsibility.

**New attack surfaces**:
- The 1Password account itself (master password + Secret Key + recovery kit).
- Each service account token = scoped vault-decryption capability.

**Specific risks during this phase**:
1. **Master password reuse** → unique-password requirement, recovery
   kit printed and stored offline, hardware MFA (YubiKey, not TOTP) on
   the 1Password admin account.
2. **Token leak in setup** → service tokens go directly into 1Password
   itself for storage; never traverse Slack, email, or other channels.
3. **Over-scoped service accounts** → use the four-token split above.
   If you find yourself wanting one token to read everything, that's a
   sign the architecture is wrong, not that the constraint is wrong.
4. **Cross-environment contamination** → separate vaults per env
   (`Averray/Testnet/*` vs `Averray/Production/*`). Service accounts
   never have access to both.

**Pre-flight checks**:
- [ ] Unique master password (verified against personal password manager strength check)
- [ ] Recovery kit printed and stored offline
- [ ] Hardware MFA (YubiKey) enabled on the 1Password admin account, not just TOTP
- [ ] Disk encryption verified on every device that will use 1Password
- [ ] Vault structure created with the per-env / per-runtime separation

**Post-flight verification**:
- [ ] All ~70 secrets from `SECRETS.md` inventory present
- [ ] Each service account can read ONLY its scoped vault (verify by
  attempting reads on out-of-scope vaults; must fail with permission
  error)
- [ ] Test rotation: change one item, fetch via `op read` with each
  service account, confirm only the in-scope account succeeds
- [ ] Service account usage logs (1Password Events API) are visible
  and tied to a SIEM or log store if longer retention than the
  default 365 days is needed

**Rollback safety**: 100% safe. Nothing depends on 1Password yet.

---

### Phase 2 — Sync vault → runtime (with runtime hardening)

**Goal**: Deploy script reads from 1Password instead of static env
files. CI workflows reference `op://` URIs instead of `${{ secrets.* }}`.

**Honest framing of what changes** (corrected from v1):
- Source-of-truth and manual-distribution problem: **solved**.
- Runtime plaintext: **still present** — once `op inject` renders
  `backend.env`, the VPS has plaintext runtime secrets on disk
  again. A VPS root compromise still reads them.
- KMS migration (Phase 3) is the layer that removes the most valuable
  runtime plaintext (the signer key). Phase 2 alone does not.

**Runtime hardening additions** (new in v2):
- Render env files to **tmpfs** at `/run/agent-stack/*.env` (cleared on reboot)
- `chmod 0400`, `chown root:agent-stack-service`
- Exclude `/run/agent-stack/*` and `/srv/agent-stack/*.env*` from
  backups and snapshots
- Disable core dumps for the backend process (`prlimit --core=0`)
- Backend process drops privileges to a non-root user after reading
  env at startup
- Audit scope after Phase 2 (honest framing): runtime secrets
  **will** appear in the container environment and in
  `docker inspect` / `/proc/$pid/environ` for the backend and
  indexer processes — that's how Docker Compose's `env_file`
  works, and it's expected. The Phase-2 check is therefore
  narrower: confirm that **deploy logs** never print rendered
  values, that the **rendered env files live on tmpfs** with
  mode 0400 (not on a persistent disk), and that
  **`journalctl -u agent-stack`** doesn't echo env values at
  service start. Eliminating the in-container plaintext for the
  **signer key specifically** is Phase 3's job, not Phase 2's.

**New attack surfaces**:
- Each per-runtime service-account token on its target host
- The `op inject` template files (committed) reveal what secrets
  exist and where they're consumed — not the values

**Specific risks**:
1. **Botched render writes secrets to logs** → wrap `op inject` to write
   only to destination, never `echo` rendered content, restrict deploy
   logs to private CI logs only
2. **Service-account token leak from VPS** → token has read-only scope
   to ONE vault. Token has a documented rotation cadence of ≤90 days
   (set this as policy; verify your account's max lifetime). Audit
   logs reviewed weekly. Alert on unusual access patterns via the
   1Password Events API.
3. **GitHub Actions OP_*_TOKEN replay via malicious workflow PR** →
   production environment protection + branch restrictions + required
   reviewers prevent unreviewed workflow changes from running
4. **Race conditions during rotation** → atomic per-template render;
   rotate during deploy windows, not mid-deploy

**Pre-flight checks**:
- [ ] All secrets from Phase 1 are in vault and scoped correctly
- [ ] Each service-account token tested manually with `op read`
- [ ] Old plain-text env files backed up offline before any deploy
  uses the new path
- [ ] Branch protection on workflows (require code review + status
  checks)
- [ ] Backups configured to exclude rendered env paths

**Post-flight verification**:
- [ ] `diff` between old plain-text env and newly rendered env: zero
  unexpected differences
- [ ] Deploy logs contain no secret values (grep for first 8 chars of
  any sensitive value: expect zero hits)
- [ ] Rendered env files live on tmpfs at `/run/agent-stack/*.env`
  (verify with `findmnt /run/agent-stack` → `tmpfs`), mode 0400,
  owned by `root:agent-stack-service`
- [ ] `/run/agent-stack/*` is excluded from every backup / snapshot
  / image-export job (grep the backup config; do a test restore
  and confirm the path is missing)
- [ ] `journalctl -u agent-stack` from a fresh deploy does **not**
  print env values (start-up config dump is scrubbed or
  disabled)
- [ ] **Note (not a pass/fail)**: `docker inspect agent-stack` and
  `cat /proc/$(pgrep -f backend)/environ` **will** show runtime
  secrets after Phase 2 — that's expected behaviour for
  `env_file`-style Compose. The matching Phase-3 verification
  re-checks these and requires `SIGNER_PRIVATE_KEY` (specifically)
  to be absent.
- [ ] Test rotation: change a secret in 1Password → redeploy → new
  value reaches running backend (confirm via `/health` or
  `/admin/status` where exposed)

**Rollback safety**: Per-secret rollback by copying value back to the
old location. Per-phase rollback by reverting deploy script +
workflow PRs.

---

### Phase 3 — KMS for backend signer (with temporary credentials)

**This is the biggest security upgrade in the plan.**

**Goal**: Remove the signer private key from all on-disk and in-vault
locations. Backend signs via KMS API using temporary credentials.

**Sub-phases**:
- **3a**: KMS key creation (asymmetric, secp256k1, multi-region for
  mainnet)
- **3b**: Adapter integration into backend
- **3c**: Replace long-lived IAM access keys with temporary
  credentials via IAM Roles Anywhere (for VPS) + GitHub OIDC (for
  Actions, if needed)
- **3d**: Testnet validation
- **3e**: Mainnet cutover (in Phase 5)

**Multi-region KMS for mainnet** — *create the mainnet key as
multi-region from day one*. AWS does not allow converting a
single-region key to multi-region later. Cost is $1/key/replica/month;
operational complexity is real (failover testing, equivalent policies
per replica, equivalent CloudWatch alarms per replica) but the
inability to add regions later is the real driver. For testnet,
single-region is fine.

**KMS spec**:
- `KeyUsage`: `SIGN_VERIFY`
- `KeySpec`: `ECC_SECG_P256K1`
- Adapter MUST pass already-hashed messages with `MessageType=DIGEST`
  (otherwise KMS hashes the input again and recovery breaks)
- `SigningAlgorithm`: `ECDSA_SHA_256` (the only secp256k1 algo supported)

**IAM policy** (the principal that calls Sign). The policy MUST split
`Sign` and `GetPublicKey` into separate statements — the condition
keys `kms:SigningAlgorithm` and `kms:MessageType` only apply to
`Sign`/`Verify`, and AWS IAM treats absent condition keys in a
request context as "no match" unless `IfExists` is used. A combined
statement implicitly denies `GetPublicKey` (revised in v3):

- Statement 1 — `AllowGetPublicKey`: action `kms:GetPublicKey` on the
  specific key ARN(s). No conditions.
- Statement 2 — `AllowSignDigestOnly`: action `kms:Sign` on the
  specific key ARN(s), with `kms:SigningAlgorithm = ECDSA_SHA_256`
  AND `kms:MessageType = DIGEST` as `StringEquals` conditions.
- Statement 3 — `ExplicitDenyDangerousOpsForSignerRole`: explicit
  `Deny` for `kms:ScheduleKeyDeletion`, `kms:DisableKey`,
  `kms:PutKeyPolicy`, `kms:CreateGrant`, `kms:ReplicateKey`,
  `kms:UpdatePrimaryRegion` on the same ARN(s).

The explicit deny applies to the signer role only. It does NOT
constrain AWS root or admin principals — admin-path protection
requires key-policy constraints, SCPs, permission boundaries, an
approval process, and CloudTrail monitoring. See `SECRETS_MIGRATION.md`
§3a for the full JSON policy.

**Temporary credentials, not long-lived IAM keys** (corrected from v1):
- **VPS**: IAM Roles Anywhere. Provision a private CA (default:
  self-managed CA with the CA private key in
  `Averray/Production/Critical`; see `SECRETS_MIGRATION.md` §3a for
  alternatives and the cost-vs-operator-burden trade-off). Create a
  Trust Anchor in IAM with that CA, create a Profile referencing
  the signer role, issue an X.509 client cert to the VPS. Backend
  uses the cert to call STS and obtain temporary credentials (≤1h
  lifetime). Rotates weekly.
- **GitHub Actions** (if any workflow needs AWS access): configure
  GitHub as an OIDC provider in IAM; AssumeRoleWithWebIdentity from
  the workflow; ≤1h credentials per job.

If you must start with static IAM keys (e.g., during early testnet
setup), make that an explicit residual risk with a removal date.

**Specific risks**:

1. **AWS root account compromise** → use root only for billing and
   initial IAM setup; never log in as root daily; hardware MFA
   (YubiKey) on root; recovery info printed offline.
2. **Roles Anywhere trust anchor compromise** → if the CA private key
   leaks, attacker can mint client certs and impersonate the VPS.
   **Self-managed CA (default at our scale)**: CA private key in
   `Averray/Production/Critical` (human-only, no service account
   readable). Residual risk: a Critical-vault compromise = full CA
   compromise — same blast radius as a 1Password recovery-kit
   leak, accepted. **Upgrade options** when scale or audit
   pressure warrants: CA key on a YubiKey ($25 one-time), or AWS
   Private CA short-lived mode ($50/mo). See
   `SECRETS_MIGRATION.md` §3a cost summary.
3. **CloudTrail KMS event exclusion** → CloudTrail can be configured
   to exclude KMS events from a trail. Verify your trail explicitly
   includes them. Verify in CloudTrail Insights as well.
4. **KMS key deletion** → IAM principal does NOT have
   `kms:ScheduleKeyDeletion`. Alert on the event regardless (admin
   IAM users still have it). Deletion makes the key unusable
   immediately upon scheduling, well before the 7–30 day final
   destruction window — alert pre-emptively.
5. **Multi-region replica drift** → policies, aliases, monitoring,
   and alarms must be replicated to every region. Add to the post-
   flight checklist.
6. **"Dark side of the curve" (high-s)** → Ethereum's Homestead
   changes made `s > secp256k1n/2` invalid. The adapter must
   canonicalize. Don't write your own adapter; pick a vetted one
   (`@rumblefishdev/eth-signer-kms` or `ethers-aws-kms-signer`).
   **Test** with a known-digest sign + recover, not just adopt.
7. **Replay across contracts/environments** → backend-signed messages
   MUST carry domain separation: chain ID, contract address,
   environment label, purpose, job/dispute ID, expiry, nonce. This
   is not KMS-specific but the migration is the right time to make
   sure it's in place.

**Non-negotiable KMS adapter tests**:
- Derive EVM address from `GetPublicKey`; matches expected on-chain verifier
- Sign a known digest through KMS
- Parse the ECDSA signature into r, s
- Canonicalize high-s signatures
- Compute the correct recovery id / v
- Recover and verify the expected signing address
- Repeat over ≥1000 distinct messages (not one) — the low-s case
  manifests probabilistically

**KMS key rotation is NOT routine** (corrected from v1):
> "KMS signer key rotation is an on-chain signer migration event, not
> a routine calendar rotation. IAM/STS credentials rotate frequently;
> the KMS key rotates only through a planned verifier update via
> multisig."

AWS KMS does not support automatic key rotation for asymmetric keys.
Don't put the KMS key in the secrets-calendar with a 90-day rotation
target — that's wrong.

**CloudWatch alarms** (must verify each fires with a synthetic event
before going to mainnet):
- `kms:ScheduleKeyDeletion`
- `kms:DisableKey`
- `kms:PutKeyPolicy`
- `kms:CreateGrant`
- `kms:ReplicateKey` (multi-region)
- `kms:UpdatePrimaryRegion` (multi-region)
- Unusual Sign volume (e.g., >10x baseline)
- Sign requests from unusual source IPs/ASNs
- Any activity by root or admin IAM principals

**Pre-flight checks**:
- [ ] AWS account exists with hardware-MFA on root
- [ ] KMS key created with correct spec (test on testnet first)
- [ ] For mainnet: key is multi-region from day one
- [ ] IAM Roles Anywhere trust anchor configured; client certs issued
- [ ] IAM policy includes both action restrictions AND condition keys
- [ ] CloudTrail confirmed to include KMS events
- [ ] All CloudWatch alarms configured with notification targets

**Post-flight verification**:
- [ ] EVM address derived from KMS public key matches the on-chain
  verifier (cross-checked with `audit-launch-readiness.mjs`)
- [ ] All KMS adapter tests pass over ≥1000 messages
- [ ] Process listing on VPS contains no `0x[a-f0-9]{60}` signer key
  patterns AND no env var with name matching `*PRIVATE*` /
  `*SECRET*` referencing the signer key
- [ ] Synthetic CloudWatch alarm fires — tested via EventBridge
  `PutEvents` for CloudTrail-driven rules, and via a dedicated
  non-production KMS key for destructive-API rules. **Do NOT** call
  `DisableKey` / `ScheduleKeyDeletion` against the live production
  signer key as a test (see `SECRETS_MIGRATION.md` §3b-2 for the
  full safe-test procedure)
- [ ] Hosted product-proof smoke passes end-to-end via KMS signer
- [ ] Revoking the IAM principal's session (or the Roles Anywhere
  trust anchor's profile) breaks signing as expected — proves the
  backend really uses temp creds

**Rollback safety**:
- **Testnet**: keep the `SIGNER_PRIVATE_KEY` env path as a fallback
  for one full deploy cycle. After confirming KMS path works, remove
  the fallback and rotate the testnet key so it's no longer valid.
- **Mainnet**: **NO raw-key fallback**. Fallback is a multisig-
  controlled signer migration (call `setVerifier(newAddress, true)`)
  or a temporary pause via the pauser key. Keeping a valid raw
  private key alive on mainnet undermines the entire migration.

---

### Phase 4 — Hardening

Five additions; each independent.

**4a. Pre-commit + pre-push secret scanning**
- Local pre-commit hook running `gitleaks` (catches before push)
- Enable GitHub **Secret Scanning push protection** with custom
  patterns (catches at push, regardless of local hooks)
- CI `gitleaks` job (catches as last-resort sweep)
- Defense in depth: local catches first, push protection catches if
  hooks are bypassed, CI catches if push protection misses a pattern

**4b. Asymmetric JWT signing via KMS**

This is the architectural upgrade that removes "vault leak = mint
admin JWTs" as a single point of failure. Today `AUTH_JWT_SECRETS`
is an HMAC secret stored in the vault and on every backend instance.
A vault breach OR a backend env breach means an attacker can mint
admin JWTs.

**Target design**:
- KMS-managed asymmetric key (e.g., RSA-2048 or ES256) signs access
  tokens at issuance / refresh time
- Backend services verify locally with the **public** key (does NOT
  need access to the signing key)
- Tokens carry `kid` (key ID for rotation), `iss`, `aud`, `sub`,
  `role`, `jti`, `iat`, `nbf`, `exp`
- Access tokens: short TTL (≤1h)
- Refresh tokens: **opaque random values** (not signed JWTs), stored
  server-side as hashes, rotated on every use, revoked on replay
  detection

After this change, a vault leak no longer allows JWT minting. Only
a KMS principal compromise does — and KMS protection is identical
to the signer-key protection from Phase 3.

If migrating fully to asymmetric JWTs is too much work pre-mainnet,
the minimum hardening for the HMAC path is:
- Key ring with `kid` rotation
- Short access-token TTLs (≤15 min)
- Documented two-key rotation window with old-key tolerance period
- Refresh tokens are opaque random values, hashed server-side

**4c. Calendar-driven CI checks** (already shipped in PR #225)
- `scripts/ops/check-secrets-calendar.mjs` runs on every CI build
- Warns ≥7 days before expiry, fails on past-expiry
- All entries other than KMS signer key (see Phase 3 — that's an
  on-chain migration, not calendar-tracked)

**4d. GitHub Actions hardening**
- Top-level `permissions: read-all` on workflows; elevate per job
- Pin all third-party actions to commit SHA (not tag)
- Avoid `pull_request_target` with secrets unless workflow is
  extremely constrained
- Never inject OP service tokens into build/test jobs
- Require review for workflow file changes (branch protection)
- Use **GitHub Environments** with required reviewers for production
  deploys; `OP_SERVICE_ACCOUNT_TOKEN` only available to jobs that
  reference the protected environment

**4e. Hardware MFA across the admin trust chain**
- 1Password admin account
- AWS root + admin IAM users
- GitHub org admin
- Domain registrar account
- VPS provider account

Treat YubiKey as mainnet baseline, not nice-to-have. ~$50/operator.

**Post-flight verification for Phase 4**:
- [ ] Gitleaks rules tested against a synthetic bad-PR (a secret-shaped string blocks the PR)
- [ ] GitHub push protection enabled and tested
- [ ] Asymmetric JWT flow validated end-to-end on testnet (or, if
  deferred, the HMAC hardening checklist above is complete)
- [ ] Calendar check runs on every CI build
- [ ] All workflow files use SHA-pinned actions
- [ ] Production deploy attempt without reviewer approval is blocked
- [ ] Hardware MFA verified on every admin account in the trust chain

---

### Phase 5 — Mainnet cutover

**The biggest risk: re-using ANY secret between testnet and mainnet.**

**Old secrets cleanup** (new in v2): before cutover, rotate or
revoke any value that ever lived in:
- GitHub Actions secrets
- Local password managers
- Shell history
- Old VPS env files
- CI logs
- Backups
- Test deploys

If a value was ever copy-pasted, assume it's compromised and don't
reuse it on mainnet — even if no leak is known.

**Pre-flight checklist** (the day before):
- [ ] All four prior phases live and stable on testnet for ≥7 days
- [ ] Audit script (`audit-launch-readiness.mjs`) shows zero drift
  between testnet and planned mainnet config
- [ ] OP service account tokens for production rotated within the
  last 30 days
- [ ] AWS KMS key for mainnet created **multi-region from day one**;
  IAM access via Roles Anywhere only (no static keys); separate IAM
  user from testnet
- [ ] Multisig signer set established with **fresh seeds** —
  do not reuse testnet seeds
- [ ] All vendor accounts have separate mainnet API keys
- [ ] On-call rotation defined in `INCIDENT_RESPONSE.md` Section 1
- [ ] Incident drills run for: OP token leak, AWS signer credential
  leak, JWT signing key leak, VPS root compromise

**Cutover sequence** (in `SECRETS_MIGRATION.md`):
1. Generate fresh secrets
2. Provision multisig with fresh signer seeds
3. Deploy contracts with multisig as owner from line 1
4. Update `deployments/mainnet.json`
5. Update env templates to reference mainnet vault items
6. Run smoke
7. Archive testnet vault read-only

**Post-cutover verification**:
- [ ] Audit script green on mainnet
- [ ] Calendar check shows zero entries within 7 days of expiry
- [ ] Hosted product-proof smoke passes 3 consecutive runs on mainnet
- [ ] No secret appears in any log file, process listing, or
  rendered env file checksum
- [ ] On-call rotation tested with a synthetic alert
- [ ] No raw `SIGNER_PRIVATE_KEY` value exists anywhere in any
  mainnet vault, env file, backup, or operator's machine
- [ ] Redacted env/secrets proof validates with
  `node scripts/ops/check-mainnet-env-secrets-proof.mjs --file docs/evidence/mainnet-env-secrets-YYYY-MM-DD.json --max-completed-age-hours 24 --json`

**Rollback safety**: For mainnet, "rollback" = abort before going
live, not unwind after. Once contracts are deployed and the multisig
is set, you live with them. **This is why phases 1–4 must be stable
on testnet first.**

---

## 6. Key risks I want you to scrutinize

These are intentional architectural trade-offs. Validate each:

### 6a. Multiple 1Password service tokens = multiple compromise paths

We split into 4–5 service accounts to reduce blast radius per token.
The trade-off: more tokens to rotate, more audit-log streams to
monitor, more rotation reminders.

**Why I think it's net positive**: Each token leak is bounded to one
vault scope. The audit log shows access per token, making forensics
faster. Rotation of one token doesn't disrupt other runtimes.

**What to verify**:
- 1Password Business audit log retention is 365 days (not 90 as
  earlier drafts claimed)
- Service account usage logs are enabled in your tenant
- Token rotation cadence is operationally feasible — if rotation is
  too painful, operators will drag their feet

### 6b. AWS Roles Anywhere CA private key is now a high-value target

By moving away from long-lived IAM access keys, we introduce a new
single point of compromise: the trust anchor's CA private key. If
that leaks, attacker can mint client certs and impersonate the VPS.

**Why it's net positive even at our pre-launch scale**: Static IAM
access keys are bearer credentials — anyone who sees the string can
use it indefinitely. A Roles Anywhere CA private key is one step
removed: an attacker who steals the CA key still has to (a) mint a
client cert from it, (b) present that cert to AWS STS to get temp
creds, (c) use the temp creds within their 1h lifetime. Each step
leaves CloudTrail evidence on a separate timeline.

**v3-revised default (this PR)**: self-managed CA with the CA
private key in `Averray/Production/Critical` (1Password, human-only).
$0 AWS recurring fees. Documented residual risk: a Critical-vault
compromise = full CA compromise, which is the same risk we already
accept for the 1Password recovery kit and AWS root credentials. The
CA does one thing — sign a fresh weekly client cert — so the
operator burden is a 30-second scripted operation per week.

**Upgrade options when scale or audit pressure warrants**:
- CA private key on a YubiKey ($25 one-time per operator). CA key
  never touches disk; signing requires the physical key + PIN.
- AWS Private CA short-lived certificate mode ($50/mo). AWS-managed
  CA with CloudTrail evidence of every issuance. Right call once
  there are 2+ operators or audit pressure.
- AWS Private CA general-purpose mode ($400/mo). Skip — we never
  need certs valid longer than 7 days.

**What to verify**:
- The CA private key in `Critical` is accessible only via a human
  1Password unlock (no service account has read on Critical)
- The weekly client-cert reissuance script runs successfully
  (calendar entry `aws-roles-anywhere-client-cert` warns 3 days
  before the 7-day cert expires)
- Plan to revisit the choice at: (a) second operator onboarded,
  (b) revenue justifies external audit, or (c) mainnet maturity

### 6c. Multi-region KMS doubles ops complexity

Each region needs its own alarms, IAM policy verification, replica
key health checks. If one region's policy drifts from the other,
some sign calls succeed where others fail mysteriously.

**Why I think it's net positive for mainnet**: A single region
outage on mainnet means user-facing downtime. The cost is small
(~$1/region/month). The operational discipline is forced regardless
by the on-chain consequences.

**What to verify**:
- Test failover at deploy time (kill primary region temporarily,
  confirm backend falls back to replica region)
- Document the failover runbook
- Equivalent policies on every replica

### 6d. The asymmetric JWT migration is non-trivial code

Phase 4b is the largest implementation change in the plan. Backend
code changes, frontend (if any) verifies differently, refresh token
flow needs server-side state for replay detection.

**Why I think it's worth doing for mainnet**: A vault breach
becoming "attacker can mint admin JWTs forever" is a real fork in
the road. With asymmetric JWTs, the same breach requires also
breaching KMS — defense in depth.

**Honest pushback opportunity**: if the engineering cost of
asymmetric JWTs is too high pre-mainnet, accept HMAC + the minimum
hardening (key ring + short TTL + opaque refresh tokens) as a
documented residual risk. Just don't pretend the residual isn't
there.

### 6e. Insider threat with single operator is structurally unmitigated

If you're the only operator, you have all keys to the kingdom in
one human's hands.

**What to do for mainnet**:
- Add a second human with operator privileges, even part-time
- Require 2-of-2 (or 2-of-N) for high-impact operations: deploying
  contract changes, rotating multisig signers, revoking IAM trust
  anchors
- 1Password Business approval workflows: turn them on

This is partially out of scope for a secrets plan (it's an
org-design issue), but it's the **biggest non-technical risk in
this document**.

---

## 7. Things I'm NOT confident about

Areas where I'd defer to a human security expert before mainnet:

1. **Exact cipher choices for the JWT refresh-token flow**. Concept
   is clear; implementation needs review by someone who's done it
   before.
2. **IAM Roles Anywhere CA model choice**. v3 (revised, this PR)
   lands on **self-managed CA with the CA key in
   `Averray/Production/Critical`** as the pre-launch default;
   AWS Private CA short-lived mode ($50/mo) and YubiKey-backed CA
   key ($25 one-time) are documented upgrade paths. Worth a fresh
   review when (a) a second operator joins, (b) revenue justifies
   audit pressure, or (c) at mainnet maturity.
3. **Domain separation for backend-signed messages** — what exactly
   to include (chain ID, contract, environment, purpose, job ID,
   nonce, expiry). Get a contract auditor's input.
4. **CloudWatch alarm thresholds for KMS**. I said ">10x baseline";
   the right numbers depend on your actual traffic.
5. **Whether `gitleaks` rules cover everything**. Custom secret
   patterns may need custom rules.
6. **AWS multi-region failover semantics under partial outage**.
   E.g., what happens if the primary region is degraded but not
   fully down? Test before mainnet.
7. **Whether opaque-hashed refresh tokens are enough** vs. requiring
   client-bound tokens (e.g., DPoP). For our trust model probably
   yes, but worth confirming.

---

## 8. Recommendations BEYOND this plan

| Recommendation | Why | Approximate cost |
|---|---|---|
| Third-party contract audit | This plan covers secrets, not contract logic | $20k–$100k+ |
| Bug bounty program | Catches what audits miss post-deploy | $500–$5000+ in rewards budget |
| Pen test of operator surface | Specifically: can an attacker pivot from one wallet seed to anything else? Can basic-auth on `app.averray.com` be bypassed? | $5k–$15k for 1-week |
| Hardware key for ALL admin accounts (1Password, AWS, GitHub, registrar, VPS provider) | TOTP can be phished; FIDO2 cannot | ~$50/operator |
| Documented incident drills (quarterly) | "Pretend SIGNER_PRIVATE_KEY just leaked. What do you do in the next 60 minutes?" | Free, ~2 hours each |
| SIEM / log aggregation | Audit logs only matter if you can query them. 1Password Events API → SIEM is the standard pattern | Variable |

---

## 9. Verification checklist (for the security reviewer)

Before signing off:

1. Walk through every secret in `SECRETS.md` and identify where it
   lives in target architecture (vault entry + access path).
2. For each phase, identify what stops working if the phase is
   reverted.
3. Confirm the IAM policy for the signer principal doesn't allow
   anything beyond `kms:Sign` + `kms:GetPublicKey` on one specific
   key ARN, with `kms:SigningAlgorithm` and `kms:MessageType`
   conditions.
4. State rotation cadence for each high-risk secret. The KMS signer
   key is **not** in this list — its rotation is an on-chain
   migration.
5. Confirm multisig signer seeds live unchanged (never in 1Password).
6. Articulate threat model assumptions and which assumptions, if
   violated, break the plan.
7. Confirm Phase 2's runtime-plaintext claim is bounded (rendered
   env files DO exist on disk; KMS removes the most valuable one).
8. Confirm Phase 3 mainnet path has NO raw private-key fallback.

---

## 10. Open questions for the operator

These need explicit decisions before phase execution:

1. **Multi-region KMS for mainnet**: yes (recommended) or no?
   Decision must be made before mainnet key creation — cannot
   convert later.
2. **Roles Anywhere CA**: v3-revised default is self-managed CA
   with the CA key in `Averray/Production/Critical` ($0 recurring,
   ~30 sec/week of operator time). Confirm this is acceptable for
   our current risk posture, OR pick an upgrade: YubiKey ($25
   one-time) or AWS Private CA short-lived mode ($50/mo). See
   `SECRETS_MIGRATION.md` §3a cost summary.
3. **Asymmetric JWT migration**: full migration in Phase 4 or
   accept HMAC + hardening as residual risk?
4. **Second operator**: who, when?
5. **Hardware key plan**: which model, who buys/distributes?
6. **External audit/bug-bounty budget**: assigned?
7. **Mainnet date**: locked? If under 30 days, defer or accept
   compressed phases in writing.

---

## 11. Mainnet sign-off bar

Before treating the system as launch-grade, every item below must be
true. Each is a checkbox the security reviewer signs:

- [ ] Separate 1Password service accounts per runtime per environment
- [ ] No long-lived AWS IAM access key for the signer, OR a
  documented temporary exception with a removal date
- [ ] KMS signer tests proving: address derivation, low-s
  canonicalization, recovery id, signature recovery (≥1000 messages)
- [ ] Replay-resistant signed payloads with domain separation (chain
  ID, contract, environment, purpose, ID, nonce, expiry)
- [ ] GitHub production environment protection with required
  reviewers and restricted branches
- [ ] KMS CloudTrail/EventBridge alarms tested with synthetic events
- [ ] Refresh-token flow reviewed with opaque hashed refresh tokens
  and replay detection — OR documented HMAC-with-hardening residual
- [ ] KMS signer key rotation documented as an on-chain migration,
  not routine secret rotation
- [ ] Testnet stable for ≥7 days after all phases live
- [ ] Real incident drill executed for: OP token leak, AWS signer
  credential leak, JWT signing key leak, VPS root compromise
- [ ] No valid raw `SIGNER_PRIVATE_KEY` fallback for mainnet
- [ ] Hardware MFA on every admin account in the trust chain
- [ ] Second operator with separation of duties for high-impact
  operations
- [ ] Third-party contract audit complete

---

## 12. Cost summary

| Item | Monthly cost |
|---|---|
| 1Password Business (1 user) | $7.99 |
| 1Password Business (3 users, post-second-operator) | $23.97 |
| AWS KMS testnet key (single region) | $1 + ~$0.15 per 10k sigs (~$1.05/mo) |
| AWS KMS mainnet key (multi-region: primary + 1 replica = 2 keys) | $2 + ~$0.15 per 10k sigs (~$2.05/mo) |
| Roles Anywhere CA — **self-managed, CA key in `Critical` 1Password vault** (recommended default) | **$0 recurring** |
| AWS Roles Anywhere itself | $0 |
| **Total at 1 user, testnet (recommended config)** | **~$9/mo** |
| **Total at 3 users, mainnet (recommended config)** | **~$26/mo** |
| Upgrade option: CA key on YubiKey ($25 one-time per operator) | $0 recurring |
| Upgrade option: AWS Private CA short-lived mode | ~$50/mo |
| **YubiKey hardware keys for operator MFA** (separate from CA-key YubiKey) | ~$50 × number of operators (one-time) |

**Revised in v3 (this PR)**: the default Roles Anywhere CA model is
now self-managed with the CA private key in
`Averray/Production/Critical` ($0 recurring), not AWS Private CA
($50–$400/mo). AWS Private CA stays in the table as an upgrade
path when scale or audit pressure justifies it.

The real cost is engineering time for the migration (~5–7 working
days spread over a few weeks).

---

## Revision history

**v3** — Second security review pass (this version)

Substantive changes from v2 (all driven by external review):

1. **IAM policy for the signer role split into three statements**
   (Phase 3a). The combined-statement form in v2 would have
   implicitly denied `kms:GetPublicKey` because the
   `kms:SigningAlgorithm` / `kms:MessageType` condition keys only
   apply to Sign/Verify. New shape:
   `AllowGetPublicKey` (no conditions) + `AllowSignDigestOnly`
   (with conditions) + `ExplicitDenyDangerousOpsForSignerRole`
   (covers ScheduleKeyDeletion, DisableKey, PutKeyPolicy,
   CreateGrant, ReplicateKey, UpdatePrimaryRegion).
2. **Roles Anywhere client cert / private key removed from any
   service-account-readable vault** (Phase 3a + SECRETS_CALENDAR).
   Private key is now generated **on the VPS**, never copied
   anywhere; only public cert metadata lives in
   `Averray/Production/Critical` (human-only) for expiry tracking.
   The v2 wording would have allowed a leaked `prod-vps-backend`
   token to retrieve AWS temp creds with `kms:Sign` capability —
   the entire point of the migration.
3. **Vault structure split per-runtime**: added `BackendExternal`,
   `CIExternal`, dedicated `Smoke`, dedicated `Critical`
   (human-only), optional `Observability`. The single `External`
   vault from v2 was too coarse; one leaked CI token could read
   all vendor keys.
4. **Phase 2 "runtime plaintext" verification softened** to match
   reality. Once `env_file` is wired, runtime secrets live in
   container env by design; `docker inspect` / `/proc/$pid/environ`
   will show them. Phase 2 now checks tmpfs + backup exclusion +
   deploy-log scrubbing only. The aggressive
   `SIGNER_PRIVATE_KEY`-must-be-absent-everywhere check is Phase 3's
   exit criterion (where it correctly applies).
5. **ADMIN_JWT runbook** updated: mint with `--profile testnet`
   (the v3 doc draft used `--profile production`, but no
   `deployments/production.json` file exists — production today
   runs against `deployments/testnet.json`; switch to `mainnet`
   only after Phase 5 cutover provisions `deployments/mainnet.json`);
   store the new JWT in 1Password at `op://prod-smoke/admin-jwt`
   AND update the legacy `ADMIN_JWT` GH Actions secret until Phase 2
   PR 2.5 wires the smoke workflow to read from 1Password exclusively;
   uses the **flat** vault naming (`prod-smoke`) committed in Phase 1,
   not the aspirational hierarchical `op://Averray/Production/...`
   scheme. Flagged as transitional until Phase 4b makes the long-lived
   JWT obsolete.
6. **Mainnet KMS wording** corrected — there is no "generate fresh
   SIGNER_PRIVATE_KEY" step on mainnet. KMS key material is created
   inside the HSM (`Origin=AWS_KMS`) and never exists as raw bytes
   anywhere. Mainnet builds set
   `config.allowLocalKeyFallback = false`.
7. **Roles Anywhere session duration tightened**: ≤1h enforced at
   Profile + CreateSession + MaxSessionDuration; production signer
   prefers 15–30 min. Trust policy adds cert identity constraints
   (`aws:PrincipalTag` / `aws:SourceIdentity`) so only the expected
   VPS cert can assume the role.
8. **GitHub OIDC role separated from the production signer role**.
   `averray-ci-deploy-role` (for Actions) has NO `kms:Sign` by
   default; only the Roles-Anywhere-trusting
   `averray-signer-prod-role` does. A compromised workflow cannot
   pivot to signing capability.
9. **Alarm testing procedure rewritten** to not call `DisableKey`
   on production. Use EventBridge `PutEvents` for CloudTrail-driven
   rules, and a dedicated non-production KMS key for destructive-API
   rules.
10. **Cost summary corrected**: multi-region KMS is "primary + 1
    replica = 2 keys total" (not "2 replicas of one key").
    Added ACM-PCA short-lived certificate mode at ~$50/mo as the
    recommended Roles Anywhere CA option.
11. **Roles Anywhere CA default flipped to self-managed** (post-
    review operator decision, this PR). The CA private key lives
    in `Averray/Production/Critical` (1Password, human-only).
    $0 AWS recurring fees instead of $50/mo for AWS Private CA
    short-lived mode. AWS Private CA short-lived mode and
    YubiKey-backed CA key remain documented as upgrade paths for
    when a second operator joins, when revenue justifies audit
    pressure, or at mainnet maturity. Documented residual risk: a
    `Critical`-vault compromise = full CA compromise, same
    blast-radius assumption we already accept for the 1Password
    recovery kit and AWS root credentials.

Smaller v3 edits:
- KMS public-key derivation uses a real DER/ASN.1 SPKI parser
  (`@peculiar/asn1-x509`) instead of byte-offset arithmetic.
- npm dependency pinning clarified: exact version + lockfile +
  provenance, NOT git-SHA pins (which bypass registry integrity).
- GitHub PAT for issue ingestion: require fine-grained PAT (or
  GitHub App installation token) restricted to one repo with
  minimum permissions; classic PATs are out.
- Archive vault explicitly restricted to revoked/expired values
  only.
- Mainnet pauser must be a separate multisig (or hardware-protected
  separate EOA), NOT the verifier key.
- Mainnet verifier and arbitrator must be split into two distinct
  KMS keys; reusing one key for both is testnet-only.
- Named 1Password users (not shared logins); the
  `secrets@averray.com` mailbox is the account-owner address, not
  a daily sign-in identity.
- `APP_BASIC_AUTH_PASSWORD` raw password moves to
  `Averray/Production/Critical` (human-only); only the bcrypt hash
  lives in CI-readable vaults.

---

**v2** — Security review pass

Substantive changes from v1:
1. **Split 1Password service accounts by runtime** (Section 4a, 4b,
   Phase 1). Four accounts per environment instead of one. Each
   scoped to one vault, immutable post-creation.
2. **Corrected 1Password audit-log retention** to 365 days (not 90).
   Events API access is 120 days. Stream to SIEM for longer.
3. **Replaced long-lived AWS IAM access keys with temporary
   credentials** (Phase 3 + 4). IAM Roles Anywhere for VPS,
   GitHub OIDC for Actions. No static keys for the signer
   principal.
4. **Clarified Phase 2's runtime-plaintext claim**. After Phase 2,
   rendered env files DO exist on disk. Added tmpfs / chmod 0400 /
   exclude-from-backups hardening.
5. **Tightened KMS adapter test requirements** to include address
   derivation, low-s canonicalization, recovery id computation, and
   ≥1000-message round-trips. Added domain separation requirement
   for signed payloads.
6. **Reframed KMS key rotation** as an on-chain migration event, not
   a calendar-tracked routine rotation. AWS does not support
   automatic rotation for asymmetric keys.
7. **Strengthened KMS IAM policy** with `kms:SigningAlgorithm` and
   `kms:MessageType` condition keys. Expanded CloudWatch alarm list
   beyond `ScheduleKeyDeletion`.
8. **Multi-region KMS decision moved to design-time**. Can't convert
   single-region to multi-region later — must decide at creation.
9. **Reworked GitHub Actions section** with Environment protection,
   required reviewers, restricted branches, SHA-pinned actions, top-
   level read-only permissions.
10. **Added pre-commit gitleaks and GitHub push protection** alongside
    CI gitleaks. Defense in depth.
11. **AUTH_JWT_SECRETS migration to asymmetric KMS-signed JWTs**
    proposed in Phase 4b, with opaque hashed refresh tokens.
    Alternative: HMAC + kid + short TTL as documented residual.
12. **Removed raw private-key fallback for mainnet**. Testnet only.
    Mainnet fallback = multisig-controlled signer migration.
13. **Corrected 1Password incident note**: 2023 Okta-linked incident,
    not "2022 breach".

Smaller edits:
- Backend never holds *signer private key bytes* (still holds AWS
  credentials, even if temporary)
- GitHub Actions compromise framing: scoped to per-job per-environment
  tokens
- Rate-limit checks added to smoke/load test expectations (1Password
  service account quotas, KMS regional request quotas)
- External vendor keys can become platform-impacting (softened
  framing)
- "Quantum cryptanalysis" replaced with simple "out of scope"
- Added explicit old-secrets-cleanup step (Phase 5)
- Added Section 11 — mainnet sign-off bar, with reviewer-checkable
  items

**v1** — Initial draft (delivered in chat, not committed)
