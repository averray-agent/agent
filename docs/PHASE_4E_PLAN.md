# Phase 4e — Hardware MFA across the admin trust chain + adjacent mainnet-prep

Mainnet-blocking. Not testnet-blocking. The current testnet runs fine
on TOTP everywhere — the existing `SECRETS_MIGRATION.md` §4e is a
six-bullet sketch. This doc audits the actual state of each account,
proposes a concrete enrollment sequence, and identifies two adjacent
work items (IAM Roles Anywhere + multi-region KMS) that show up
together with Phase 4e in the Phase 5 pre-flight checklist.

**Scope of this doc: a plan, not code.** Phase 4e is mostly operator
work (purchase YubiKeys, enroll them on each account, document
recovery). Approval gate before any execution.

---

## 1. Why Phase 4e exists

TOTP (Google Authenticator, Authy, 1Password's built-in OTP) is
phishable. A convincing fake-domain phishing page that prompts for
both password + TOTP code captures both, and the attacker has ~30
seconds to use the code before it rotates. Hardware-bound FIDO2 /
WebAuthn keys are bound to the actual origin in the TLS handshake —
they refuse to respond on a wrong-origin page. That's the
phishing-resistance property mainnet needs.

The 4e bullets in `SECRETS_MIGRATION.md` cover six accounts where a
takeover gives an attacker meaningful blast radius:

| # | Account | Blast radius on takeover | Today's state |
|---|---|---|---|
| 1 | 1Password admin (org) | Read every prod-backend / prod-indexer / prod-ci / prod-smoke secret. Sign new service-account tokens. | Unknown — needs operator audit |
| 2 | AWS root | Delete the JWT KMS key + the blockchain signer KMS key. Disable CloudTrail. | Unknown — needs operator audit |
| 3 | AWS IAM admin users | Create new IAM users with KMS sign on either key. | Unknown |
| 4 | GitHub org admin | Push to main (bypassing branch protection if admin-bypass is on), publish a malicious deploy, exfiltrate `OP_SERVICE_ACCOUNT_TOKEN` from Actions secrets. | Org-level 2FA enforcement **NOT enabled** (confirmed via API today) |
| 5 | Domain registrar (averray.com) | DNS redirect → impersonate api.averray.com → SIWE replay attack | Unknown |
| 6 | VPS provider (OVH) | Reimage the host, dump tmpfs (`/run/agent-stack/*.env`), extract live secrets, reset SSH keys | Unknown |

The "unknown" rows are the operator's homework — the actual current
MFA setting on each account isn't readable via API for most providers.

## 2. Procurement

**Recommended: YubiKey 5 NFC × 2 per operator.** Two-key minimum is
the load-bearing detail — if a single key is lost, you're locked out
of accounts that aren't recoverable via support (1Password without
recovery codes, AWS without root-account-recovery, etc.).

| Hardware option | Notes |
|---|---|
| **YubiKey 5 NFC** (~$50) | Recommended. USB-A + NFC; works with iPhone over NFC for 1Password mobile + AWS Console. Supports FIDO2, U2F, OTP, PIV. |
| YubiKey 5C NFC (~$55) | USB-C variant. Same protocols. Pick if your laptop is USB-C-only. |
| YubiKey 5C Nano (~$60) | USB-C, semi-permanent install. Convenient for daily driver but loses NFC. Buy alongside the 5 NFC, not as a replacement. |
| Google Titan / Feitian | Cheaper alternatives. Less robust ecosystem support. Skip. |

**Total cost for a single operator: ~$100 (2 × YubiKey 5 NFC).**
Negligible compared to the cost of a successful phishing attack on
the trust chain.

Order from yubico.com directly — Amazon has counterfeits.

## 3. Enrollment sequence

Order matters. Enroll in this sequence to avoid lockout cascades:

### Stage 1 — Bedrock accounts (do these first)

1. **1Password admin account**
   - Why first: 1Password is the recovery anchor for every other
     account that stores backup codes / recovery secrets.
   - Path: 1Password.com → Account → Two-Factor Authentication →
     Set up Security Key.
   - Add BOTH YubiKeys with descriptive names ("YK1-primary",
     "YK2-backup-safe").
   - Generate a recovery code, store in 1Password itself (chicken-
     and-egg fine since the recovery code only matters if you lose
     both keys + your password — a separate access path).
   - Optionally: print the recovery code, store in a fire-proof safe.

2. **AWS root account**
   - Sign in to https://aws.amazon.com → root user.
   - IAM → Security credentials → Multi-factor authentication →
     Assign MFA device → Security key.
   - Add both YubiKeys.
   - **Critical**: do NOT remove the existing TOTP until both
     YubiKeys are confirmed working. AWS allows multiple MFA devices
     concurrently.
   - Save root account recovery procedure (phone number + email
     access) somewhere recoverable. AWS root account recovery
     without MFA requires phone + email + billing info.

### Stage 2 — Operational accounts

3. **GitHub org admin (averray-agent)**
   - GitHub → Settings → Password and authentication → Two-factor
     authentication → Add security key.
   - Add both YubiKeys.
   - **Then, separately**: enable org-wide 2FA requirement:
     ```bash
     gh api -X PATCH orgs/averray-agent -F two_factor_requirement_enabled=true
     ```
     Currently `false` (confirmed today via API). Note: enabling
     this will REMOVE any org members who don't have 2FA on their
     personal accounts. Audit members first:
     ```bash
     gh api orgs/averray-agent/members --jq '.[].login'
     ```
   - For service-account-style tokens (Hermes etc.), GitHub allows
     specific bypass — confirm none of those break.

4. **AWS IAM admin users**
   - Same flow as root, but per IAM user.
   - Run: `aws iam list-users --query 'Users[].UserName'` to list
     admins. Only enroll users with admin-tier policies.
   - Existing IAM users for the blockchain + JWT signers
     (`averray-signer-testnet`, `averray-jwt-signer-testnet`) do NOT
     need MFA — they're programmatic, not human-driven.

### Stage 3 — Externals

5. **Domain registrar** (averray.com — whoever it's with)
   - Login → security settings → enable hardware key.
   - Most registrars (Namecheap, Cloudflare Registrar, Gandi) support
     FIDO2.
   - **If your registrar doesn't support FIDO2**: switch registrars
     pre-mainnet. The domain is the highest-blast-radius takeover.

6. **VPS provider (OVH)**
   - OVH Manager → Personal account → Security → 2FA → Security key.
   - OVH supports FIDO2 as of 2024.
   - **Also**: enable IP whitelist on SSH if you haven't (separate
     hardening; OVH's Reverse-DNS-locked rules can replace fail2ban).

## 4. Recovery procedure

For each account, document:
- **Primary key serial number** (`ykman info` reads it)
- **Backup key serial number**
- **Recovery code location** (1Password item, fire-proof safe, or both)
- **Provider-side recovery path** (support ticket flow, phone
  verification, etc.)

Store this as a 1Password item: `op://prod-critical/yubikey-recovery-runbook/notes`.

**Test the backup key before considering enrollment complete.** Sign
out of each account, sign back in using the BACKUP key, confirm it
works, sign out, sign back in with PRIMARY. If backup doesn't work,
the enrollment is broken — fix before storing the keys.

## 5. Adjacent mainnet-prep work

Two items are mentioned in Phase 5 pre-flight that show up together
with 4e and are worth scoping here:

### 5a — IAM Roles Anywhere for static AWS credentials

**Current state**: the VPS holds two long-lived static IAM credentials:

| Variable | What signs with it | Risk |
|---|---|---|
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | `KmsSigner` calls `kms:Sign` on the **blockchain** key (Phase 3) | If the VPS is compromised, attacker can sign arbitrary blockchain transactions until rotated |
| `AWS_JWT_ACCESS_KEY_ID` / `AWS_JWT_SECRET_ACCESS_KEY` | `KmsJwtSigner` calls `kms:Sign` on the **JWT** key (Phase 4b) | If the VPS is compromised, attacker can mint admin JWTs |

Both are IAM access keys with sign-only policies on a specific KMS
key + SigningAlgorithm condition. The blast radius is bounded but the
*persistence* is "indefinite, until manual rotation".

**Mainnet target**: replace both with **IAM Roles Anywhere**, which
exchanges an X.509 client certificate for temporary STS credentials
(1-hour TTL). The VPS holds the cert + private key (rotatable, much
shorter-lived than IAM static keys), exchanges them at boot for
session credentials, the SDK refreshes automatically.

Implementation scope (separate PR series, not part of 4e):
- One-time AWS setup: create CA, configure Trust Anchor, create
  Profile, attach the existing IAM role
- VPS setup: install AWS Signing Helper, issue client cert from the
  CA, store cert+key under `/etc/agent-stack/`
- Backend code: the AWS SDK Node client auto-handles credential
  refresh — no code change in `KmsSigner` / `KmsJwtSigner` themselves
- Env template: replace the four `AWS_*_ACCESS_KEY_*` env vars with
  Roles Anywhere config (`AWS_ROLE_ARN`, `AWS_PROFILE_ARN`,
  `AWS_TRUST_ANCHOR_ARN`, plus the cert + key paths)

Estimated effort: 1-2 days, mostly AWS Console / `aws iam` work.
Code change is small.

### 5b — Multi-region KMS for the JWT key

**Current state**: the JWT KMS key is single-region in `eu-central-2`
(Zurich). The blockchain signer key is also single-region there.
Phase 5 pre-flight says **mainnet KMS keys must be multi-region from
day one** (cannot convert later).

**Why mainnet needs this**: a regional outage in `eu-central-2`
without a multi-region replica means:
- The backend cannot mint NEW JWTs (sign endpoint down)
- Existing tokens continue to verify (PEM is cached locally)
- The blockchain signer cannot sign NEW transactions (treasury
  operations frozen)

For testnet, accepting the outage window is fine. For mainnet, it's
not.

Implementation scope:
- Create a NEW KMS key with `MultiRegion: true` (cannot retrofit the
  existing single-region key)
- Replicate to a second region (e.g., `eu-west-1` or `us-east-1`)
- Update env vars on the VPS to reference the new key ARN
- Add region failover logic to the KMS client (SDK supports retries
  but explicit failover is more reliable)
- Decommission the single-region key after the new path is stable

This is a Phase 5 task by definition (mainnet key generation moment).
Don't pre-create the mainnet key — the existing testnet key stays as
testnet.

### 5c — 30-day mainnet ADMIN_JWT prohibition

From `docs/PHASE_4B_KMS_JWT_PLAN.md` §9:
> Mainnet MUST NOT rely on a 30-day admin access token. Mainnet smoke
> MUST use the refresh flow or a purpose-scoped service-token flow
> with a shorter access-token TTL.

Implementation:
- Switch `scripts/ops/run-hosted-worker-loop.mjs` from `ADMIN_JWT` to
  the refresh-flow (issue a refresh cookie at start, rotate every 15
  minutes).
- OR: switch to a purpose-scoped service token via
  `/admin/service-tokens` with a TTL ≤ 1 hour.

Estimated effort: 1 day. Code change in the worker loop client.

## 6. Risk register

| Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|
| Operator loses both YubiKeys before recovery codes are stored | Low | Very high (account lockout) | Two-key rule + tested recovery procedure before considering enrollment complete |
| Domain registrar doesn't support FIDO2 | Medium | Very high (account is the DNS root of trust) | Switch registrars pre-mainnet if needed |
| GitHub org-2FA enforcement kicks out a member with TOTP-only | Medium | Low (member adds 2FA, rejoins) | Audit members + send pre-announcement before flipping the org-wide flag |
| AWS root recovery procedure fails (phone/email no longer accessible) | Low | Catastrophic (account loss) | Maintain a current phone + email on the root account; test the recovery flow annually |
| Phishing-resistant flow isn't actually exercised | Medium | Low (the protection isn't lost, just unvalidated) | One quarterly drill: sign out, sign back in, confirm hardware key prompt appears |

## 7. Decision points before execution

1. **One operator or two?** Currently this looks like a one-operator
   org. If a second operator joins, they need their own pair of
   YubiKeys + their own enrollment on each shared account. Plan for
   2× the procurement cost.

2. **Hardware key model**: confirm YubiKey 5 NFC × 2 vs alternatives.
   No strong reason to deviate.

3. **Timing**: enroll BEFORE mainnet generation moment, not after.
   Enrolling under prod pressure is how lockouts happen.

4. **Domain registrar**: confirm which one Averray uses + whether it
   supports FIDO2. If not, identify the migration target (Cloudflare
   Registrar is the standard recommendation) and budget the migration
   into the schedule.

5. **GitHub org-2FA enforcement**: confirm member list is small and
   all current members already have personal 2FA before flipping.

6. **IAM Roles Anywhere (5a)**: do this BEFORE mainnet or accept it
   as residual risk in the launch sign-off bar? Recommend: do it
   before. The implementation is small (~1-2 days) and removes a
   persistent credential from the VPS — a meaningful improvement.

7. **Multi-region KMS (5b)**: this is the actual mainnet keygen
   moment — must be `MultiRegion: true` at creation time. Don't
   pre-create.

## 8. What this doc does NOT cover

- The Phase 5 pre-flight checklist as a whole (`SECRETS_MIGRATION.md`
  §"Phase 5 — Mainnet cutover"). Phase 4e is one input to that
  checklist; the rest is its own coordination problem.
- Multisig signer hardware. The 2-of-3 multisig signers should ALSO
  use hardware wallets, but that's a Phase 5 concern (multisig
  generation is the mainnet ceremony itself) not Phase 4e.
- Operator app SIWE wallet hardware. Per Phase 4b design, the operator
  app expects a wallet extension (MetaMask, Rabby) which has its own
  threat model. Hardware-backed wallets (Ledger via WalletConnect)
  raise the bar; not strictly required.

## 9. Recommended next actions

If you want to proceed on Phase 4e:

1. Order 2 × YubiKey 5 NFC (or 5C NFC if you're USB-C-only) from
   yubico.com. ~2-3 day shipping.
2. While they ship: audit existing MFA state on each of the 6
   accounts. Build the "today's state" row of the table in section 1
   with actual data.
3. Confirm domain registrar + FIDO2 support.
4. Audit `averray-agent` org members + announce planned 2FA-required
   flip date.
5. When keys arrive: follow the Stage 1 → 2 → 3 enrollment sequence
   in section 3.

Total wall-clock: ~1 week from "order keys" to "all six accounts
hardware-MFA'd, recovery tested".

For the adjacent items:
- **5a (IAM Roles Anywhere)**: schedule as a small standalone work
  package, ~2 days. Can run in parallel with Phase 4e enrollment.
- **5b (Multi-region KMS)**: deferred to Phase 5 mainnet keygen.
- **5c (Worker-loop refresh-flow)**: small standalone PR, ~1 day. Can
  also run in parallel.
