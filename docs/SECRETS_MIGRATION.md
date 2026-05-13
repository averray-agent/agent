# Secrets Migration — From "Starter Tier" to Pre-Mainnet Hardened

This doc is the operator's checklist for moving from where we are today
(plain-text env files + GitHub Actions secrets + ad-hoc password
managers) to where we need to be for mainnet (centralized vault for
human-managed secrets + AWS KMS for the hottest cryptographic key).

Read [`SECRETS.md`](SECRETS.md) first for the inventory. Read
[`SECRETS_INTEGRATION_PLAN.md`](SECRETS_INTEGRATION_PLAN.md) for the
security-review-grade design rationale, threat model, and mainnet
sign-off bar.

This doc assumes you're convinced *what* needs to move and just need
the *how*. The phase structure has been revised in response to **two
rounds** of external security review; v2 deltas are flagged
"(revised in v2)" and v3 deltas are flagged "(revised in v3)" in
context. The companion
[`SECRETS_INTEGRATION_PLAN.md`](SECRETS_INTEGRATION_PLAN.md)
revision history at the bottom is the canonical list of substantive
changes.

The migration breaks into **5 phases** that can land independently. Each
phase is mergeable on its own and reversible if something breaks. You
can pause between any of them.

| Phase | What | Time | Reversible? |
|---|---|---|---|
| 1 | 1Password Business setup + secret inventory loaded into vault | ~1 day | Yes — old env files still authoritative |
| 2 | Sync vault → runtime (CI + VPS) | ~1 day | Yes — fall back to GitHub UI / direct env edit |
| 3 | AWS KMS for the backend signer | ~2 days | **Testnet only**: yes — keep `SIGNER_PRIVATE_KEY` env path until cutover. **Mainnet**: no raw-key fallback. Rollback = multisig-controlled signer migration. |
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
- **Each human gets their own named 1Password user account**, NOT a
  shared login. Audit logs must attribute every action to a real
  person. A shared login is incompatible with the
  "named-individual rotation cadence" the calendar assumes, and
  with any future SOC 2 / external-audit posture. The dedicated
  `secrets@averray.com` mailbox is only the ACCOUNT owner address
  used for billing and recovery — it is not a sign-in identity for
  daily use. Day-to-day work is done as
  `pascal@averray.com`, `<second-operator>@averray.com`, etc.,
  each with their own hardware MFA and recovery kit.

### 1b. Create the vault structure

Build these vaults in 1Password. Each is a separate access boundary.
**Revised in v3** to split `External` per-runtime and add dedicated
`Smoke` and `Critical` vaults (1Password's service-account scoping
is whole-vault, not item-level).

```
Averray/
├── Production/
│   ├── Backend           # Runtime backend secrets ONLY:
│   │                     #   AUTH_JWT_SECRETS, RPC URLs, KMS_KEY_ID,
│   │                     #   AWS_REGION, blockchain config
│   ├── BackendExternal   # Vendor keys the backend needs at runtime:
│   │                     #   Pimlico bundler/paymaster, RPC provider
│   │                     #   creds, Sentry DSN, XCM observer auth.
│   │                     #   Splitting from CI-side vendor keys
│   │                     #   prevents one leaked token from reaching
│   │                     #   all vendor accounts.
│   ├── Indexer           # DATABASE_URL, PONDER_RPC_URL_*
│   ├── CI                # Deploy-time creds:
│   │                     #   VPS_SSH_KEY, APP_BASIC_AUTH_PASSWORD_HASH
│   │                     #   (note: the bcrypt HASH only; raw password
│   │                     #   lives in an operator vault)
│   ├── CIExternal        # Vendor keys CI needs at deploy time:
│   │                     #   Resend (alert emails), webhooks
│   ├── Smoke             # Hosted product-proof smoke test secrets:
│   │                     #   admin-jwt only. Dedicated vault because
│   │                     #   1Password doesn't support item-level
│   │                     #   service-account scoping — must be whole
│   │                     #   vault.
│   ├── Critical          # Human-only, NOT readable by any runtime
│   │                     # service account. Holds:
│   │                     #   - OP service-account tokens themselves
│   │                     #   - AWS root account recovery
│   │                     #   - 1Password account recovery kit
│   │                     #   - Roles Anywhere cert metadata (public)
│   │                     #   - Optional Roles Anywhere private-key
│   │                     #     escrow (documented as residual risk)
│   └── Observability     # Optional: dedicated vault for monitoring
│                         # secrets if you want even tighter blast
│                         # radius. Otherwise rolls into BackendExternal.
├── Testnet/              # Mirrors Production/ structure for testnet
│   ├── Backend, BackendExternal, Indexer, CI, CIExternal, Smoke, Critical
├── Multisig/             # Signer ADDRESSES + public-key reference info
│                         # ONLY. Multisig seeds NEVER enter 1Password.
├── Operators/            # Per-operator personal vaults
│   ├── Pascal
│   └── …
└── Archive/              # ONLY revoked / expired / cryptographically
                          # unusable values. Never archive a still-valid
                          # reusable secret. Metadata + dead values for
                          # audit trail.
```

Why each separation matters:
- **Testnet vs Production**: re-using testnet secrets on mainnet is
  the most common pre-launch mistake. Separate vaults make accidental
  cross-contamination structurally impossible.
- **Backend vs BackendExternal**: limits which secrets one leaked
  runtime token can reach. Backend runtime token compromised? Vendor
  keys for CIExternal (Resend, webhooks) are not in scope.
- **Smoke vault**: dedicated so the smoke-test token can be scoped
  there with smallest blast radius. 1Password doesn't allow item-
  level service-account scoping, so the smallest scope IS a vault.
- **Critical**: holds the OP service-account tokens themselves +
  account-recovery material. Human-only by design; no service
  account ever reads Critical. If it did, a service-account
  compromise would yield other service-account tokens — bootstrapped
  privilege escalation.
- **Archive**: ONLY for revoked or expired values. Storing
  still-valid values here defeats the purpose; they're still in
  scope of any vault search and any vault-level access grant.

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

### 1d. Provision **four** scoped service accounts per environment

**Revised in v2 per security review.** A single broadly-scoped service
account is a single point of compromise. Split by runtime so a leaked
token's blast radius is bounded to one vault scope.

Service account access and vault permissions are **effectively
immutable after creation** — design scopes correctly up front rather
than assuming they can be tuned later.

Treat each token as a vault-decryption capability for its scoped
vaults, not as a low-value API token. Per 1Password's own docs,
protection of the token is the customer's responsibility.

#### Production accounts

| Service account | Read access | Used by |
|---|---|---|
| `prod-ci-deploy` | `Averray/Production/CI` + `Averray/Production/CIExternal` | GitHub Actions deploy workflow |
| `prod-vps-backend` | `Averray/Production/Backend` + `Averray/Production/BackendExternal` | Backend VPS `op inject` at deploy time |
| `prod-vps-indexer` | `Averray/Production/Indexer` | Indexer VPS `op inject` at deploy time |
| `prod-smoke-tests` | `Averray/Production/Smoke` (dedicated vault — currently holds only `admin-jwt`) | Hosted product-proof smoke |

#### Testnet equivalents

Mirror the production split with `testnet-*` prefixes, scoped to the
`Averray/Testnet/*` vaults. Testnet tokens MUST NOT have access to
production vaults.

#### Provisioning each token

1. In 1Password admin: **Integrations → Service Accounts → New**
2. Set name (e.g., `prod-ci-deploy`)
3. Vault access: **read-only**, scoped to the single vault listed above
4. Token expiration: set the maximum your account allows (1Password
   exposes `--expires-in` on the CLI; document the cadence in your
   account, ≤90 days target)
5. Save the token in your personal 1Password vault (so the token
   itself never leaves 1Password)
6. Add a calendar reminder in [`SECRETS_CALENDAR.yml`](SECRETS_CALENDAR.yml)
   for token rotation

#### Audit logging

- 1Password Business retains audit events for **365 days** (corrected
  from the earlier "90 days" claim; the Events API exposes the last
  **120 days**).
- Stream the Events API output to a SIEM or log store if you need
  longer retention or proactive alerting.
- Build alerts off **service account usage logs** (item-level access)
  rather than only account-level audit events — those show the
  vaults and items each token reads.

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

## Phase 2 — Create canonical secret render flow and retire hand-managed env files

**Revised in v3 (PR 2.0) per a second external security review.** The
original "Sync vault → runtime" framing understated the actual work: the
production VPS today has hand-edited `/srv/agent-stack/backend.env` and
`indexer.env` files that aren't generated by any script in the repo. The
real Phase 2 win is **creating the missing render control plane**, not
"swapping" something that already exists.

### Phase 2 ships as 6 reviewable PRs

Each PR is independently mergeable, leaves the old path active in parallel
for 24h after each, and is reversible.

| #   | Title                                                            | Risk        | Touches                                                                                              |
| --- | ---------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------- |
| 2.0 | Preflight: templates, inventory, dry-run validator               | zero        | `deploy/*.env.template`, `deploy/secrets-inventory.md`, validators, CI lint, this doc                |
| 2.1 | CI-side: VPS SSH key from 1Password via `load-secrets-action`    | low         | `.github/workflows/deploy-production.yml`                                                            |
| 2.2 | Caddy basic-auth: hash-only, validated, no plaintext in transit  | medium      | `scripts/ops/render-caddyfile.sh`, `deploy/Caddyfile.averray`, deploy workflow                       |
| 2.3 | VPS: atomic, fail-closed render flow (the cutover)               | medium-high | new `scripts/ops/render-vps-env.sh`, `tmpfiles.d/agent-stack.conf`, `deploy-production.sh`, compose  |
| 2.4 | Cleanup AND rotation                                             | low         | deploy workflow, VPS env files, `SECRETS_CALENDAR.yml`                                               |
| 2.5 | Smoke auth secret to 1Password (replaces last `ADMIN_JWT` use)   | low         | `scripts/ops/check-hosted-stack.sh`, deploy workflow, calendar                                       |

### Honest framing of what Phase 2 does and does not solve

**Solves**:
- Hand-edited `/srv/agent-stack/*.env` files (operator drift between notes
  and reality)
- GitHub Actions secrets as the de-facto source of truth (one-off per secret,
  no rotation cadence, no per-environment scoping)
- SSH heredoc as secret transport (production credentials in command strings
  visible in `ps`/journald during the deploy window)

**Does NOT solve**:
- Runtime plaintext exposure. After Phase 2, `SIGNER_PRIVATE_KEY` still lives
  in container env, `docker inspect` output, and `/proc/$pid/environ` for the
  backend process. That's expected: Docker Compose `env_file:` is exactly how
  containerised apps consume env. The render flow is the layer that makes
  Phase 3 (KMS migration) possible by giving us a controlled swap point, but
  Phase 2 alone is a source-of-truth fix, not a runtime-exposure fix.

### PR 2.0 — Preflight: templates, inventory, dry-run validator

**Touches** (this PR):

- `deploy/backend.env.template` and `deploy/indexer.env.template` — the
  rendered runtime env files start here. Secret values are `op://` references;
  config values are literal strings (or `# TODO(operator)` placeholders to
  be filled in during PR 2.3 from the current `/srv/agent-stack/*.env`).
- `deploy/secrets-inventory.md` — authoritative table mapping every secret
  env var to its `op://` path, the service-account token allowed to read it,
  the rotation owner, and whether the validator treats it as
  `critical-nonempty` (render aborts if empty).
- `scripts/ops/validate-env-render.sh` — operator-side validator. Runs `op
  inject` against a template with the operator's local 1Password session,
  validates the rendered output against the inventory, and **deletes the
  rendered file before exit** (atomic / fail-closed pattern from PR 2.3
  pre-flighted here). Never prints rendered content.
- `scripts/ops/check-env-template-structure.mjs` — CI structural check.
  Runs without a 1Password session, validates that every `op://` reference
  has a known vault, a matching inventory row, and respects per-runtime
  service-account scoping.
- `.github/workflows/ci.yml` — new `env-template-structure` job runs the
  structural check on every PR. `permissions: contents: read` enforced.

**Acceptance criteria**:

- [ ] Templates committed; secret lines reference `op://`, config lines
      either literal or commented `# TODO(operator)`
- [ ] `deploy/secrets-inventory.md` has a row for every `op://` reference
      in the templates
- [ ] `node scripts/ops/check-env-template-structure.mjs` exits 0 against
      committed templates
- [ ] `scripts/ops/validate-env-render.sh backend` exits 0 on an operator
      laptop with `op signin` active (manual smoke-test before merge)
- [ ] CI job `env-template-structure` runs on this PR and is green
- [ ] **No production secret value has moved** — runtime is unchanged

### PR 2.1 — CI-side: VPS SSH key from 1Password (`load-secrets-action`)

**Touches**: `.github/workflows/deploy-production.yml`

**Operator setup BEFORE merge** (one-time, in GitHub repo settings):
1. **Settings → Environments → production → Add environment secret**
2. Name: `OP_SERVICE_ACCOUNT_TOKEN_PROD_CI`
3. Value: the `ops_…` token stored in
   `op://prod-critical/op-token-prod-ci-deploy/password` (read it with
   `op read 'op://prod-critical/op-token-prod-ci-deploy/password'`
   and paste — do NOT echo to terminal first).
4. Save. The token is now visible only to workflow jobs that reference
   `environment: production`, behind the existing required-reviewer
   gate.

**Workflow changes in this PR**:

- Add top-level `permissions: contents: read`; elevate per-step only
  when the step needs more (e.g. `id-token: write` for OIDC in Phase 3).
- Add `1password/load-secrets-action@581a835fb51b8e7ec56b71cf2ffddd7e68bb25e0`
  (pinned to v2.0.0's commit SHA) step **scoped to that step only**
  (the OP token is set via step-level `env:`, NOT job-level — per
  1Password's docs, putting the token at job level would expose it to
  every step that follows). Loads `VPS_SSH_KEY_OP` from
  `op://prod-ci/vps-ssh-key/private key`. `continue-on-error: true`
  so a 1Password outage during the validation window does not break
  deploys.
- New parity-check step compares `VPS_SSH_KEY_OP` against the legacy
  `${{ secrets.VPS_SSH_KEY }}` value by writing both to `umask 077`
  `mktemp` files and running `cmp -s`. **Logs only `matches: yes/no`**
  plus byte lengths on mismatch — never a checksum, never a fingerprint,
  never the value itself. On mismatch, posts a workflow `::warning::`
  annotation so it's visible in the PR check summary.
- The existing "Configure SSH" step keeps using `${{ secrets.VPS_SSH_KEY }}`
  (legacy) for the actual SSH write. The OP-loaded value is only used
  for parity comparison.
- PR 2.4 will flip the SSH write to use `$VPS_SSH_KEY_OP` and delete
  the legacy GH Actions secret 24h after the OP path has been proven
  stable.

**Acceptance criteria**:

- [ ] Operator setup step complete: `OP_SERVICE_ACCOUNT_TOKEN_PROD_CI`
      is set as a `production` Environment secret (visible in
      Settings → Environments → production)
- [ ] After merge, a manual `workflow_dispatch` deploy succeeds end-to-end
- [ ] The parity-check step logs `VPS_SSH_KEY_OP matches legacy secret: yes`
- [ ] No checksum, fingerprint, or value of the SSH private key
      appears in the deploy log
- [ ] Production environment approval gate still fires for deploys
- [ ] `permissions: contents: read` is the workflow's default; no
      step elevates without a stated reason
- [ ] `1password/load-secrets-action` is pinned to commit SHA
      `581a835fb51b8e7ec56b71cf2ffddd7e68bb25e0`, not a tag

### PR 2.2 — Caddy basic-auth: hash-only, validated, no plaintext in CI

**Touches**: `scripts/ops/render-caddyfile.sh`,
`scripts/ops/deploy-production.sh`,
`.github/workflows/deploy-production.yml`.

**Honest scope adjustment from the original plan**: the plan said "render
Caddyfile on the VPS via `op inject` — hash never traverses an SSH
heredoc." That requires `op` CLI on the VPS, which is PR 2.3's bootstrap
work. PR 2.2 lands the things that don't depend on the VPS bootstrap:
hardening, hash-only flow in CI, deploy-time validation, removal of raw
password from CI. PR 2.4 will move the render to op-inject-on-VPS after
PR 2.3 provisions the toolchain.

**Operator setup BEFORE merge** (one-time, on your laptop with
`op signin` active):

1. Install `caddy` locally so we can generate the bcrypt hash without
   spinning up a docker container:
   ```bash
   brew install caddy
   ```
2. Generate the bcrypt hash from the raw password in `prod-critical`
   and store the new hash + username together as a single
   `prod-ci/app-basic-auth-hash` item. The raw password never appears
   on a command line or in shell history.
   ```bash
   eval $(op signin)

   set +o history
   RAW=$(op read 'op://prod-critical/app-basic-auth/password')
   USER=$(op read 'op://prod-critical/app-basic-auth/username')

   # caddy hash-password reads stdin when --plaintext is omitted.
   HASH=$(printf '%s' "$RAW" | caddy hash-password --algorithm bcrypt)

   # Sanity-check the hash shape before storing.
   case "$HASH" in
     \$2a\$*|\$2b\$*|\$2y\$*) echo "✓ hash shape ok ($(printf '%s' "$HASH" | wc -c | tr -d ' ') chars)" ;;
     *) echo "✗ hash does not look like bcrypt; abort"; unset RAW USER HASH; return 1 2>/dev/null || exit 1 ;;
   esac

   op item create --vault=prod-ci --category=password --title=app-basic-auth-hash \
     "username=$USER" \
     "credential[concealed]=$HASH" \
     "notes=Bcrypt hash of raw password from prod-critical/app-basic-auth. Used by Caddy basic-auth on app.averray.com. Different bcrypt salt → different hash each generation; do NOT expect this to byte-match any other hash. Regenerate when raw rotates."

   unset RAW USER HASH
   set -o history
   ```
3. **Verify the new hash actually authenticates against the live Caddy**
   before merging. This catches drift between `prod-critical/app-basic-auth`
   and whatever password the legacy GH-secret hash was generated from.
   ```bash
   RAW=$(op read 'op://prod-critical/app-basic-auth/password')
   USER=$(op read 'op://prod-critical/app-basic-auth/username')
   status=$(curl -sS -o /dev/null -w '%{http_code}' -u "$USER:$RAW" https://app.averray.com/)
   echo "auth status: $status (expect 200/3xx, NOT 401)"
   unset RAW USER
   ```
   If this returns 401, the password in `prod-critical/app-basic-auth`
   doesn't match what Caddy currently expects. **DO NOT MERGE** — resolve
   the drift first (likely by updating `prod-critical/app-basic-auth` to
   the password your browser autofill remembers).

**Changes in this PR**:

- `scripts/ops/render-caddyfile.sh`: drops the in-script `render_hash()`
  helper that called `caddy hash-password --plaintext` (the unsafe form
  that put the raw password in `ps` output). Now **requires** the
  precomputed bcrypt hash and **rejects** the deploy outright if
  `APP_BASIC_AUTH_PASSWORD` (raw) is set in the env. Adds a bcrypt
  shape check (`^\$2[aby]\$`) so a typoed hash is caught before render.
- `scripts/ops/deploy-production.sh` `apply_caddy()`: renders to a
  `mktemp` file alongside the target, runs `caddy validate` inside the
  running caddy container against the rendered file (mounted read-only
  via `-v`), and only `mv`s into place after validation passes. A
  failed validate aborts the deploy before touching the live config.
- `.github/workflows/deploy-production.yml`:
  - Removes `APP_BASIC_AUTH_PASSWORD` (raw) from the job-level `env:`
    block and from the SSH heredoc env string. Raw password no longer
    flows through CI at all.
  - Extends the PR 2.1 `load-secrets-action` step to also load
    `APP_BASIC_AUTH_USER_OP` and `APP_BASIC_AUTH_PASSWORD_HASH_OP` from
    `op://prod-ci/app-basic-auth-hash/...` (parity-style, non-blocking).
  - Adds a "Verify OP-loaded Caddy basic-auth values" step that asserts:
    - both OP-loaded values are non-empty
    - the OP-loaded hash starts with `$2a$` / `$2b$` / `$2y$`
    - the legacy GH-secret hash also starts with one of those
    - the OP-loaded username matches the legacy username byte-for-byte
    Mismatches surface as `::warning::` annotations; the deploy still
    uses the legacy GH secret values until PR 2.4 swaps the heredoc.

**Acceptance criteria**:

- [ ] Operator setup complete: `op://prod-ci/app-basic-auth-hash` item
      exists with `username` and `credential` fields
- [ ] Manual auth-check curl with `prod-critical/app-basic-auth` raw
      returns 200/3xx against the live Caddy (proves no drift)
- [ ] After merge, a manual `workflow_dispatch` deploy succeeds end-to-end
- [ ] The parity-check step logs `APP_BASIC_AUTH_USER_OP matches legacy
      secret: yes` (or surfaces a warning if not)
- [ ] `caddy validate` step in `apply_caddy()` passes before reload
- [ ] Unauthenticated request to `https://app.averray.com/` returns 401
      (smoke check at end of deploy)
- [ ] No raw or hashed value appears in deploy logs
- [ ] `APP_BASIC_AUTH_PASSWORD` is no longer referenced anywhere in the
      workflow YAML (verified with `grep`)
- [ ] (Deferred to PR 2.4 / 2.5) authenticated request → 200 — needs a
      smoke-side OP token that can read `prod-critical/app-basic-auth`
      OR a separate `prod-smoke/app-basic-auth` mirror; out of scope for
      this PR.
- [ ] (Deferred to PR 2.4) legacy `APP_BASIC_AUTH_PASSWORD` GH Actions
      secret deleted (24h after this PR ships green deploys)
- [ ] (Deferred to PR 2.4) `op inject` render of Caddyfile on the VPS,
      eliminating the SSH-heredoc transport of the hash entirely

### Lessons from PR 2.1 (folded into future PR procedures)

The PR 2.1 acceptance walked into three pitfalls. Documented here so
future PRs don't repeat them:

1. **`scp` / `ssh` falling back to password auth is a SILENT signal that
   the key isn't authorized.** When loading SSH keys into 1Password,
   always verify with
   `ssh -o BatchMode=yes -o PreferredAuthentications=publickey ...`
   BEFORE treating the local file as canonical. The PR 2.1 loader
   trusted `~/.ssh/averray_deploy` based on filename and pushed an
   unauthorized key into the vault.

2. **`op read | gh secret set` pipes silently overwrite with empty
   stdin if `op read` errors.** `op` writes the error to stderr, exits
   non-zero, and produces no stdout. `gh secret set` then dutifully
   stores an empty value. Always capture into a shell variable first,
   verify non-empty + minimum length, then `printf '%s' "$VAR" | gh
   secret set`. Pattern:
   ```bash
   KEY=$(op read 'op://...')
   key_len=$(printf '%s' "$KEY" | wc -c | tr -d ' ')
   if [ -n "$KEY" ] && [ "$key_len" -gt 100 ]; then
     printf '%s' "$KEY" | gh secret set NAME -R repo
   else
     echo "✗ OP value short/empty — do NOT overwrite GH"
   fi
   unset KEY key_len
   ```

3. **GitHub Actions secrets are write-only.** Once overwritten there's
   no way to read the previous value. Treat them as fire-and-forget
   sinks; the canonical value must live in 1Password. PR 2.1 lost the
   legacy VPS_SSH_KEY because we overwrote it without backup, then
   discovered the local-file source wasn't authorized.

The `ssh -o BatchMode=yes ...` pre-flight should be added to PR 2.4's
runbook before any "swap legacy GH secret to OP-loaded value" step.

### PR 2.3 — VPS bootstrap + atomic render script (foundation, no cutover)

**Honest scope adjustment from the original plan**: the original PR 2.3
section bundled "install op + tokens + tmpfiles + render script +
templates + compose env_file swap" into a single PR. After PR 2.1 and
PR 2.2 each surfaced 1-3 unexpected acceptance bugs ("we removed X
from CI; some other path silently relied on X"), we're splitting the
work:

- **PR 2.3 (this PR)** — lands the bootstrap toolchain + render
  script + helper to fill templates, **WITHOUT changing the deploy
  workflow or docker-compose**. Operator runs the bootstrap on the
  VPS and verifies render parity manually. Zero production risk.
- **PR 2.4 (next)** — wires `render-vps-env.sh` into
  `deploy-production.sh`, flips the compose `env_file:` paths to
  `/run/agent-stack/*.env`, and removes the heredoc transport for
  the secrets `op://prod-ci/*` now covers. This is the actual
  cutover.

**Touches** (this PR):

- new `scripts/ops/render-vps-env.sh` — atomic, fail-closed renderer
  (see §2c below for the design)
- new `scripts/ops/install-op-vps.sh` — idempotent 1Password CLI
  installer for Debian/Ubuntu via the official apt repo + debsig policy
- new `scripts/ops/fill-env-template.mjs` — operator helper that
  takes a SCP'd snapshot of `/srv/agent-stack/*.env` and uses it to
  populate the `# TODO(operator)` lines in
  `deploy/backend.env.template` / `deploy/indexer.env.template`,
  refusing to write any value that looks like a secret (hex private
  key, JWT, API-key prefix, long base64-ish)
- new `deploy/agent-stack.tmpfiles.conf` — `systemd-tmpfiles.d`
  snippet that declares `/run/agent-stack` as `drwx------ root root`
- updates to this doc reflecting the split

**No changes to** `deploy-production.yml`, `deploy-production.sh`,
docker-compose, or any GH Actions secret. Production runtime is
unchanged after this PR merges.

**Operator runbook** (steps in order, on your laptop unless noted):

1. **Install `op` CLI on the VPS** (one-time):
   ```bash
   scp scripts/ops/install-op-vps.sh ubuntu@141.94.121.188:/tmp/
   ssh ubuntu@141.94.121.188 "sudo bash /tmp/install-op-vps.sh && rm /tmp/install-op-vps.sh"
   ```
   Expected: `op --version` prints, no errors.

2. **Drop per-runtime service-account tokens** at
   `/etc/agent-stack/op-{backend,indexer}.env`:
   ```bash
   eval $(op signin)
   BACKEND_TOKEN=$(op read 'op://prod-critical/op-token-prod-vps-backend/credential')
   INDEXER_TOKEN=$(op read 'op://prod-critical/op-token-prod-vps-indexer/credential')

   ssh ubuntu@141.94.121.188 "sudo install -d -m 0755 /etc/agent-stack"
   ssh ubuntu@141.94.121.188 "sudo tee /etc/agent-stack/op-backend.env >/dev/null" <<< "OP_SERVICE_ACCOUNT_TOKEN=$BACKEND_TOKEN"
   ssh ubuntu@141.94.121.188 "sudo tee /etc/agent-stack/op-indexer.env >/dev/null" <<< "OP_SERVICE_ACCOUNT_TOKEN=$INDEXER_TOKEN"
   ssh ubuntu@141.94.121.188 "sudo chmod 0400 /etc/agent-stack/op-*.env && sudo chown root:root /etc/agent-stack/op-*.env"
   unset BACKEND_TOKEN INDEXER_TOKEN
   ```

3. **Install the systemd-tmpfiles snippet**:
   ```bash
   ssh ubuntu@141.94.121.188 "sudo cp /srv/agent-stack/app/deploy/agent-stack.tmpfiles.conf /etc/tmpfiles.d/agent-stack.conf && sudo systemd-tmpfiles --create"
   ssh ubuntu@141.94.121.188 "ls -ld /run/agent-stack"   # expect: drwx------ root root
   ```
   (`/srv/agent-stack/app` is the repo checkout on the VPS; adjust if
   different.)

4. **Verify both tokens can read their scoped vaults** (and ONLY those):
   ```bash
   ssh ubuntu@141.94.121.188 "sudo -E env OP_SERVICE_ACCOUNT_TOKEN=\$(sudo grep -h '^OP_SERVICE_ACCOUNT_TOKEN=' /etc/agent-stack/op-backend.env | cut -d= -f2) op vault list"
   # expect: prod-backend, prod-backend-external (NOT prod-critical, NOT prod-indexer)

   ssh ubuntu@141.94.121.188 "sudo -E env OP_SERVICE_ACCOUNT_TOKEN=\$(sudo grep -h '^OP_SERVICE_ACCOUNT_TOKEN=' /etc/agent-stack/op-indexer.env | cut -d= -f2) op vault list"
   # expect: prod-indexer ONLY
   ```

5. **Fill the `TODO(operator)` lines in the env templates** (on your
   laptop, in this PR's worktree):
   ```bash
   # Pull a copy of each live env file to a local tmpdir
   mkdir -p ~/secrets-tmp && chmod 0700 ~/secrets-tmp
   scp ubuntu@141.94.121.188:/srv/agent-stack/backend.env ~/secrets-tmp/backend.env
   scp ubuntu@141.94.121.188:/srv/agent-stack/indexer.env ~/secrets-tmp/indexer.env

   # Use the helper to fill TODO(operator) lines without touching
   # secret-shaped values:
   node scripts/ops/fill-env-template.mjs \
     --snapshot ~/secrets-tmp/backend.env \
     --template deploy/backend.env.template \
     --out      deploy/backend.env.template.filled

   diff deploy/backend.env.template deploy/backend.env.template.filled
   # If the diff looks right (config values filled, secrets untouched):
   mv deploy/backend.env.template.filled deploy/backend.env.template

   # Repeat for indexer:
   node scripts/ops/fill-env-template.mjs \
     --snapshot ~/secrets-tmp/indexer.env \
     --template deploy/indexer.env.template \
     --out      deploy/indexer.env.template.filled
   diff deploy/indexer.env.template deploy/indexer.env.template.filled
   mv deploy/indexer.env.template.filled deploy/indexer.env.template

   # Validate STRICT (no TODO markers, all op:// refs resolve):
   bash scripts/ops/validate-env-render.sh backend
   bash scripts/ops/validate-env-render.sh indexer
   STRICT=1 bash scripts/ops/validate-env-render.sh backend
   STRICT=1 bash scripts/ops/validate-env-render.sh indexer

   # Shred the local snapshot copies:
   for f in ~/secrets-tmp/*.env; do dd if=/dev/urandom of="$f" bs=4096 count=1 conv=notrunc 2>/dev/null || true; rm -f "$f"; done
   rmdir ~/secrets-tmp

   # Commit the filled templates as part of this PR.
   ```

6. **Run `render-vps-env.sh` manually on the VPS** and verify parity
   against the existing `/srv/agent-stack/*.env`:
   ```bash
   ssh ubuntu@141.94.121.188 "
     cd /srv/agent-stack/app
     sudo bash scripts/ops/render-vps-env.sh \
       deploy/backend.env.template \
       /run/agent-stack/backend.env \
       /etc/agent-stack/op-backend.env

     sudo bash scripts/ops/render-vps-env.sh \
       deploy/indexer.env.template \
       /run/agent-stack/indexer.env \
       /etc/agent-stack/op-indexer.env

     # Parity diff — should be empty (or only sort-order differences):
     echo '── backend diff ──'
     sudo diff <(sort /run/agent-stack/backend.env) <(sort /srv/agent-stack/backend.env) | head -30
     echo '── indexer diff ──'
     sudo diff <(sort /run/agent-stack/indexer.env) <(sort /srv/agent-stack/indexer.env) | head -30
   "
   ```
   Any non-empty diff means the template doesn't match what's live —
   investigate before PR 2.4 flips the cutover.

#### §2c — Render script design

`scripts/ops/render-vps-env.sh` is **atomic** and **fail-closed**:

1. Refuses to write outside `/run/agent-stack` (defense against
   misuse).
2. Verifies the token file is mode `0400`; rejects wider perms.
3. Verifies `op` CLI is installed.
4. Renders to a `mktemp` file in the same directory as the target
   (so the final `mv` is atomic via `rename(2)` on the same fs).
5. `op inject --cache=false` — always hit 1Password, never a stale
   local cache.
6. Greps the rendered file for any unresolved `op://` substring;
   any hit aborts the deploy without touching the live target.
7. Asserts ≥1 `KEY=value` line in the rendered file (sanity check
   against empty templates).
8. `chmod 0400 + chown root:root`, then `mv` into place.
9. Unsets `OP_SERVICE_ACCOUNT_TOKEN` immediately after `op inject`
   to minimize lifetime in the script's process env.
10. Refuses to run if `OP_CONNECT_HOST` or `OP_CONNECT_TOKEN` is
    set — those override `OP_SERVICE_ACCOUNT_TOKEN` per 1Password's
    docs and would create confusing behaviour.

**Failure semantics**:

> The fallback to `/srv/agent-stack/*.env` is **manual only**. If
> render fails, the script exits non-zero and the previous runtime
> env file (if any) is untouched. PR 2.4 will make `deploy-production.sh`
> abort the deploy when render fails — there is NO silent fallback
> to stale env.

**Acceptance criteria for PR 2.3**:

- [ ] `scripts/ops/install-op-vps.sh` runs cleanly on the VPS and
      `op --version` succeeds afterwards
- [ ] `/etc/agent-stack/op-{backend,indexer}.env` exist with mode
      `0400`, owner `root`, content `OP_SERVICE_ACCOUNT_TOKEN=ops_…`
      and nothing else (verified with
      `sudo stat -c '%a %U:%G' /etc/agent-stack/op-*.env` and
      `sudo wc -l /etc/agent-stack/op-*.env`)
- [ ] `/run/agent-stack` exists with mode `0700`, owner root, after
      `systemd-tmpfiles --create`
- [ ] Backend token reads ONLY `prod-backend` + `prod-backend-external`
      (verified with `op vault list`)
- [ ] Indexer token reads ONLY `prod-indexer`
- [ ] Neither token can read `prod-critical` (firebreak verified —
      try `op vault get prod-critical --token <…>`; expect permission
      denied)
- [ ] `STRICT=1 bash scripts/ops/validate-env-render.sh backend`
      passes (templates have no `TODO(operator)` markers remaining)
- [ ] `STRICT=1 bash scripts/ops/validate-env-render.sh indexer`
      passes
- [ ] Manual `render-vps-env.sh` invocation on the VPS produces
      `/run/agent-stack/*.env` that matches `/srv/agent-stack/*.env`
      via sorted diff (zero differences)
- [ ] No production runtime change — backend and indexer still read
      from `/srv/agent-stack/*.env` (compose unchanged)

**Deferred to PR 2.4** (the actual cutover):

- Wire `render-vps-env.sh` into `deploy-production.sh` so each
  deploy renders fresh `/run/agent-stack/*.env` files
- Audit `docker-compose.yml` for `environment:` keys that shadow
  `env_file:` variables
- Flip compose `env_file:` from `/srv/agent-stack/*.env` to
  `/run/agent-stack/*.env`
- Remove the SSH heredoc transport for the secrets that
  `render-vps-env.sh` now provides via `op inject`
- Delete the legacy `/srv/agent-stack/*.env` files after 24h of
  green deploys

### PR 2.3 acceptance result: zero functional drift (the duplicate-keys
finding)

The PR 2.3 operator runbook's step 6 (`render-vps-env.sh` on VPS, diff
`/run/agent-stack/*.env` against `/srv/agent-stack/*.env`) initially
looked alarming — `sort | diff` reported drift on ~17 KEYs including
`GITHUB_INGEST_DRY_RUN`, `GITHUB_INGEST_MIN_SCORE`, several `OSV_INGEST_*`
and `OPEN_DATA_INGEST_*` keys, and notably a `GITHUB_TOKEN` placeholder.

**Root cause**: the live `/srv/agent-stack/backend.env` had **duplicate
`KEY=value` entries**. `sort | diff` listed each occurrence
independently, so a key like `GITHUB_INGEST_DRY_RUN=true` followed later
by `GITHUB_INGEST_DRY_RUN=false` looked like two unrelated differences.
Docker Compose's `env_file:` (and bash `source`) use **last-wins**
semantics for duplicate keys, so the backend has actually been running
with the second occurrence's value all along — which matches the
template's value byte-for-byte.

Verified with `scripts/ops/refresh-env-template.mjs --snapshot
~/secrets-tmp/backend.env --template deploy/backend.env.template`:
"refreshed: 0, in sync: 71" for backend; "refreshed: 0, in sync: 11"
for indexer. The template is already functionally correct.

The duplicates also include a `GITHUB_TOKEN` placeholder line
(`GITHUB_TOKEN=your_real_github_token`) followed by a real PAT
(`GITHUB_TOKEN=github_pat_...`). The real PAT wins (last-defined),
and byte-matches the value stored at
`op://prod-backend-external/github-pat-issue-ingestion/password`.

**Implication for PR 2.4 cutover**: switching from
`/srv/agent-stack/*.env` to `/run/agent-stack/*.env` produces the same
runtime values the backend was already consuming. As a bonus side
effect, the cutover eliminates the duplicate-key spaghetti — the
rendered template has no duplicates by construction.

`scripts/ops/refresh-env-template.mjs` is the tool for future template
↔ live drift reconciliation. It updates literal KEY=value lines from
a snapshot, preserves `op://` references, and refuses to overwrite an
op-reference with a secret-shaped literal from the snapshot.

### PR 2.4 — Wire `render-vps-env.sh` into the deploy (parity check, non-blocking)

**Touches**: `scripts/ops/deploy-production.sh`.

After PR 2.3 surfaced that the live `/srv/agent-stack/*.env` had
duplicate `KEY=value` entries (last-wins semantics quietly producing
the template's values), the cutover is safe. This PR plumbs
`render-vps-env.sh` into `deploy-production.sh` so the render runs at
every deploy as a parity check, BEFORE we flip compose to actually
consume the rendered files (PR 2.5).

**New function in deploy-production.sh**: `render_runtime_envs_parity_check()`

For each runtime (`backend`, `indexer`):

1. Skip cleanly if `render-vps-env.sh`, the `/etc/agent-stack/op-*.env`
   token file, or `/run/agent-stack/` is missing — the deploy continues
   on the legacy path.
2. Invoke `sudo bash render-vps-env.sh <template> /run/agent-stack/X.env
   /etc/agent-stack/op-X.env`. On failure, log a `::warning::` and
   move on (non-blocking).
3. Compare the rendered output to a **last-wins-deduplicated** view of
   the legacy `/srv/agent-stack/X.env`. The dedup is critical: the
   legacy file's known duplicates would otherwise produce noise. An awk
   one-liner stores the LAST value per key, then `diff` against the
   rendered file (which has no duplicates by construction).
4. On mismatch, log the differing KEY NAMES only (never values) as a
   `::warning::` annotation visible in the deploy log.

**Failure semantics**: this entire step is **non-blocking** for the
duration of PR 2.4 / 2.5. The compose `env_file:` still points at
`/srv/agent-stack/*.env`, so a render failure or a parity mismatch is
informational, not breaking. PR 2.5 (compose flip) will make render
failure fail-closed once the runtime depends on it.

**Operator prerequisite**: passwordless sudo for the `ubuntu` user (the
SSH user that runs `deploy-production.sh`). This is already the case on
our VPS — confirmed during PR 2.3 acceptance when manual `sudo bash`
invocations of `render-vps-env.sh` ran without prompting.

**Acceptance criteria**:

- [ ] Manual deploy after merge logs:
      `Phase 2 PR 2.4: rendering runtime env files via op inject (parity check, non-blocking)`
- [ ] For both runtimes, log line:
      `Phase 2 PR 2.4: <runtime> parity OK — /run matches /srv (last-wins dedup)`
- [ ] `/run/agent-stack/backend.env` and `/run/agent-stack/indexer.env`
      exist after the deploy with mode `0400 root:root`
- [ ] No rendered secret values appear in the deploy log (only KEY
      names on mismatch)
- [ ] Backend and indexer containers remain healthy (they continue
      reading from `/srv/agent-stack/*.env` — runtime unchanged)

After 2-3 green parity-check deploys, the next PR (2.5) flips compose.

### PR 2.5 — Compose `env_file:` cutover (the actual switch)

**Touches**: `scripts/ops/deploy-production.sh` (rename function +
fail-closed semantics). Operator edits `docker-compose.yml` on the
VPS (not in repo).

The cutover. After PR 2.4's parity-check has been green for several
deploys (proven: backend and indexer both log "parity OK" with
last-wins dedup + quote-normalize), this PR:

1. Renames `render_runtime_envs_parity_check()` →
   `render_runtime_envs()` and changes the semantics from
   non-blocking-warn to **fail-closed**. Render failure now exits the
   function non-zero, which aborts the deploy before any container
   restart.
2. Operator edits `docker-compose.yml` on the VPS to flip the
   `env_file:` paths from `/srv/agent-stack/{backend,indexer}.env` to
   `/run/agent-stack/{backend,indexer}.env`.
3. Operator triggers a deploy. Backend + indexer containers restart
   and consume `/run/*.env` from here on.

The legacy `/srv/agent-stack/*.env` files stay on disk for 24h as a
manual rollback option (operator edits `env_file:` back to `/srv/`).
PR 2.6 deletes them after that window.

#### Operator runbook (AFTER PR 2.5 lands on main)

Step 1 — back up the live compose file:

```bash
ssh ubuntu@141.94.121.188 'sudo cp /srv/agent-stack/docker-compose.yml /srv/agent-stack/docker-compose.yml.pre-pr2.5'
```

Step 2 — audit the compose file for `environment:` keys that would
shadow `env_file:` values (Compose's `environment:` block wins; a
duplicate there would silently defeat the migration on that variable):

```bash
ssh ubuntu@141.94.121.188 'sudo docker compose -f /srv/agent-stack/docker-compose.yml config 2>/dev/null | head -80'
```

Look for `environment:` blocks under `agent-backend` or `agent-indexer`
that mention any of the keys in our env templates. If found,
investigate before proceeding — those values would not get migrated.

Step 3 — view the current `env_file:` lines so we know exactly what
to change:

```bash
ssh ubuntu@141.94.121.188 'sudo grep -n -B1 -A2 "env_file" /srv/agent-stack/docker-compose.yml'
```

Step 4 — flip the paths. Use `sudo sed -i` with explicit before/after
strings (NOT a regex match) to minimize blast radius:

```bash
ssh ubuntu@141.94.121.188 '
  set -e
  sudo sed -i.bak \
    -e "s|/srv/agent-stack/backend.env|/run/agent-stack/backend.env|g" \
    -e "s|/srv/agent-stack/indexer.env|/run/agent-stack/indexer.env|g" \
    -e "s|- ./backend.env|- /run/agent-stack/backend.env|g" \
    -e "s|- ./indexer.env|- /run/agent-stack/indexer.env|g" \
    /srv/agent-stack/docker-compose.yml
  echo "--- diff against pre-PR-2.5 backup ---"
  sudo diff /srv/agent-stack/docker-compose.yml.pre-pr2.5 /srv/agent-stack/docker-compose.yml
'
```

The diff should show exactly the 2 (or 4, if both relative and
absolute forms exist) `env_file:` lines flipping from `/srv/`-prefixed
to `/run/agent-stack/`-prefixed. If the diff shows anything else,
ROLL BACK with `sudo cp /srv/agent-stack/docker-compose.yml.bak /srv/agent-stack/docker-compose.yml`
and investigate.

Step 5 — trigger a deploy:

```bash
gh workflow run deploy-production.yml -R averray-agent/agent && sleep 5 && gh run watch $(gh run list --workflow=deploy-production.yml --limit 1 --json databaseId -q '.[0].databaseId')
```

Step 6 — verify the backend container is consuming `/run/*.env`:

```bash
ssh ubuntu@141.94.121.188 'sudo docker inspect agent-backend --format "{{range .Config.Env}}{{println .}}{{end}}" | grep -E "^(SIGNER_PRIVATE_KEY|AUTH_JWT_SECRETS|DATABASE_URL|GITHUB_TOKEN)=" | head -5'
```

Verify each line has the value from `/run/agent-stack/backend.env`
(which equals the values the backend has been consuming, just sourced
differently now).

Step 7 — if anything looks wrong, roll back:

```bash
ssh ubuntu@141.94.121.188 'sudo cp /srv/agent-stack/docker-compose.yml.pre-pr2.5 /srv/agent-stack/docker-compose.yml'
gh workflow run deploy-production.yml -R averray-agent/agent
```

The rollback is fast (one cp + one redeploy) because we kept the
legacy `/srv` files on disk untouched. PR 2.6 deletes them after 24h.

**Acceptance criteria**:

- [ ] `docker compose config` on VPS shows no `environment:` overrides
      of `env_file:` keys
- [ ] After cutover deploy, `docker inspect agent-backend` shows env
      values matching `/run/agent-stack/backend.env`
- [ ] Same for `agent-indexer` matching `/run/agent-stack/indexer.env`
- [ ] Backend `/health` returns 200 after the deploy
- [ ] Indexer `/health` returns 200 after the deploy
- [ ] Deploy log shows `Phase 2 PR 2.5: backend parity OK …` (the
      parity check still runs, informational only)
- [ ] Pre-PR-2.5 backup of compose file exists at
      `/srv/agent-stack/docker-compose.yml.pre-pr2.5` for 24h rollback

### PR 2.6 — Retire `/srv` writes + manifest parity CI guard (code-only step)

**Touches**: `scripts/ops/deploy-production.sh`,
`scripts/ops/check-template-matches-manifest.mjs` (new),
`.github/workflows/ci.yml`.

**What lands in this PR:**

- Removes `configure_settlement_env`, `configure_bootstrap_instrumentation_env`,
  `backend_env_requires_deploy`, `upsert_env_values`,
  `upsert_env_values_if_changed`, and `quote_env_value` from
  `scripts/ops/deploy-production.sh`. All ~150 lines of dead-after-PR-2.5
  code that was still writing settlement + instrumentation values to
  `/srv/agent-stack/backend.env` on every deploy in shell-escape format.
- Adds `scripts/ops/check-template-matches-manifest.mjs`. Runs
  `derive-settlement-env.mjs` against `deployments/testnet.json` and asserts
  the 11 derived keys match `deploy/backend.env.template` byte-for-byte.
  Fails CI on drift. Wired into the existing
  `Phase 2 — env template structural lint` job.
- Updates `should_run backend` regex to include
  `deploy/backend.env.template` and `deployments/testnet.json` —
  template-only or manifest-only changes still trigger a backend redeploy
  via the path-based change detection.

**Why now** — the 2026-05-12 outage. After PR 2.5's cutover made
`/run/agent-stack/backend.env` authoritative, the `configure_*_env`
writes to `/srv` were doubly bad: redundant (the template carries the
same values byte-for-byte, verified in this PR's CI guard) and
dangerous (a copy-paste from `/srv` into the template leaked the
shell-escape format `[{\"symbol\":\"USDC\",...}]` which docker
compose's `env_file:` parser takes literally — see PR #249). Removing
the writes closes the format-leak vector permanently.

**What does NOT land here** (deferred to PR 2.7, see below):

- Deleting the legacy `/srv/agent-stack/{backend,indexer}.env` files
  from the VPS. Recommended operator action after 24h of stable deploys
  on PR 2.6:

  ```sh
  ssh ubuntu@141.94.121.188 'sudo rm /srv/agent-stack/backend.env /srv/agent-stack/indexer.env /srv/agent-stack/docker-compose.yml.pre-pr2.5'
  ```

- Deleting GitHub Actions secrets that have been replaced by 1Password
  references.
- Rotating secrets that were leaked via GitHub-Actions / shell-history /
  VPS-backup surfaces.

**Known gap** (not fixed in this PR): `apply_indexer_database_schema`'s
`INDEXER_FRESH_SCHEMA=1` flow writes a new `DATABASE_SCHEMA=` line to
`/srv/agent-stack/indexer.env`, which `/run/agent-stack/indexer.env`
doesn't pick up (the latter is rendered from
`deploy/indexer.env.template`). The flow has been broken for
`/run`-authoritative deploys since PR 2.5 but is rarely exercised
(operators usually pin schema via the workflow input). Tracked for a
follow-up: either teach the function to also rewrite the template via
sed and let CI re-render, or move schema rotation into the deploy
manifest with its own parity guard.

### PR 2.7 — Cleanup of legacy artifacts AND rotation

**Touches**: `.github/workflows/deploy-production.yml`, VPS env files,
`SECRETS_CALENDAR.yml`.

Cleanup (the easy part):

- Delete legacy GitHub Actions secrets: `VPS_SSH_KEY`,
  `APP_BASIC_AUTH_USER`, `APP_BASIC_AUTH_PASSWORD`,
  `APP_BASIC_AUTH_PASSWORD_HASH`, `RESEND_API_KEY`,
  `BOOTSTRAP_SELF_REPORT_*`.
- Delete `/srv/agent-stack/backend.env` and `/srv/agent-stack/indexer.env`
  from the VPS.
- Reboot test: confirm `/run/agent-stack` is recreated by
  `systemd-tmpfiles` and the next deploy renders fresh env files.

Rotation (the part that actually closes the exposure window):

Deletion alone is not enough. The values that lived in GitHub Actions
secrets, SSH heredoc command strings, hand-managed VPS env files, shell
history, and possibly deploy logs / VPS backups must be assumed leaked
to those surfaces and rotated.

| Secret                         | Action in this PR                                                                                                       | Why                                                                                                                                                                                                                       |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VPS_SSH_KEY`                  | **Rotate**: mint new ed25519, add pub to VPS `authorized_keys`, swap the OP item, redeploy once, remove old pub after 24h | Lived in GitHub Actions secrets + SSH heredoc + shell history + possibly VPS backups                                                                                                                                      |
| `APP_BASIC_AUTH_PASSWORD` (raw)| **Rotate** to a high-entropy random value (if not already done in PR 2.2)                                               | Same exposure paths                                                                                                                                                                                                       |
| `RESEND_API_KEY`               | **Rotate** at https://resend.com/api-keys                                                                               | Same                                                                                                                                                                                                                      |
| `BOOTSTRAP_SELF_REPORT_*`      | Confirm still used; if so, treat as config (no rotation); if obsolete, delete                                            | These are email addresses, not secrets — they don't need rotation, just confirmation                                                                                                                                       |
| `AUTH_JWT_SECRETS`             | **Rotate** in a controlled key-ring window (prepend new, redeploy, wait 24–48h for in-flight tokens, remove old, redeploy) | Lived in the hand-managed VPS env file; HMAC compromise = ability to mint any admin JWT                                                                                                                                   |
| `SIGNER_PRIVATE_KEY`           | **NOT rotated here.** Honest framing: the key remains exposed by historical VPS env files until Phase 3. Phase 2 reduces distribution drift but does NOT solve backend signer private-key exposure. | Phase 3's job. Calling it out so the security claim stays honest.                                                                                                                                                          |

**Acceptance criteria**:

- [ ] Legacy GitHub Actions secrets deleted (verified with
      `gh secret list -R averray-agent/agent`)
- [ ] Legacy `/srv/agent-stack/*.env` files deleted (verified with
      `ssh ... ls /srv/agent-stack/*.env`)
- [ ] Rotation completed (or rotation tickets filed with explicit
      deadlines) for every secret in the table above except
      `SIGNER_PRIVATE_KEY`
- [ ] `SECRETS_CALENDAR.yml` updated with the new `expires_at` values
      for any rotated calendar-tracked entry
- [ ] Reboot test green: `/run/agent-stack` recreated; deploy renders
      fresh env files successfully

### PR 2.8 — Smoke auth secret to 1Password

Split into two sub-PRs, mirroring the PR 2.1 → PR 2.4 staging pattern
that worked for the VPS SSH key migration:

#### PR 2.8a — parity-check load (non-blocking)

**Touches**: `.github/workflows/deploy-production.yml`,
`deploy/secrets-inventory.md`.

- Add a new `Load smoke-vault secret from 1Password (parity check, non-blocking)`
  step in `deploy-production.yml`, using the
  `OP_SERVICE_ACCOUNT_TOKEN_PROD_SMOKE` environment secret. Loads
  `ADMIN_JWT_OP` from `op://prod-smoke/admin-jwt/credential`.
- `continue-on-error: true` so a missing/invalid token doesn't break
  the deploy — the legacy `${{ secrets.ADMIN_JWT }}` is still the
  active source.
- Add a parity-check step: byte-for-byte `cmp -s` against the legacy
  GH secret, JWT-shape sanity check, length-only diagnostics on
  mismatch (the value itself never enters the log).
- Add `test -n "$ADMIN_JWT"` to the existing Validate-required-secrets
  step so an empty legacy secret fails the deploy fast instead of
  401'ing later in the smoke check.

**Operator action required to actually populate the OP path:**

  1. In 1Password, create a service account with read access to the
     `prod-smoke` vault (and ONLY that vault). The token-scope
     firebreak claim is that this token can't read `prod-backend`,
     `prod-indexer`, `prod-ci`, or any other vault.
  2. Save the token to the **production GitHub environment** (not the
     repository secrets) as `OP_SERVICE_ACCOUNT_TOKEN_PROD_SMOKE`.

Until step 2 is done, the new load step's `outcome` is `failure` and
the workflow's "Note when 1Password smoke load step failed" annotation
fires. Deploy still succeeds via legacy.

**Acceptance criteria for PR 2.8a:**

- [ ] PR merged; CI green
- [ ] One deploy with the token absent → "Note when…" warning visible
      in workflow output; deploy still succeeds
- [ ] Operator mints token + adds to prod env
- [ ] Next deploy: `load_op_smoke.outcome == success` and parity check
      logs `ADMIN_JWT_OP matches legacy secret: yes`

#### PR 2.8b — flip the active source

**Touches**: `.github/workflows/deploy-production.yml`,
`SECRETS_CALENDAR.yml`.

- Once 2.8a's parity check has been green for a few deploys, swap
  the `printf 'ADMIN_JWT=%q ...' "$ADMIN_JWT"` to `"$ADMIN_JWT_OP"`
  (the variable exported by the smoke-load step).
- Remove `ADMIN_JWT: ${{ secrets.ADMIN_JWT }}` from the job env block.
- Delete the `ADMIN_JWT` repository secret via `gh secret delete`.
- Update `SECRETS_CALENDAR.yml`'s `expires_at` for `ADMIN_JWT` to
  reflect the new mint's 30-day expiry (since we're now reading
  from 1Password, the calendar entry tracks the OP item).

**Token-scope verification** (firebreak proof, do once after operator
adds the token): from a one-shot workflow_dispatch step that uses
`OP_SERVICE_ACCOUNT_TOKEN_PROD_SMOKE`, attempt
`op item get auth-jwt-secrets --vault=prod-backend` and assert it
fails with permission denied. The smoke token must not be able to
read backend, indexer, or CI vaults.

**Acceptance criteria for PR 2.8b:**

- [ ] Smoke run passes with `ADMIN_JWT_OP` (loaded from 1Password) as
      the source
- [ ] `OP_SERVICE_ACCOUNT_TOKEN_PROD_SMOKE` is a distinct token, not
      reused from any other purpose
- [ ] Negative test: smoke token receives permission denied when
      attempting to read `prod-backend` or `prod-ci`
- [ ] `ADMIN_JWT` repository secret deleted (verified with
      `gh secret list -R averray-agent/agent`)
- [ ] Calendar entry's `expires_at` updated to the new mint's 30-day
      expiry

---

## Legacy Phase 2 implementation reference

The section below was written for the v2 plan. It still describes the
correct mechanics (`op inject` + tmpfs + per-runtime tokens), and PRs
2.0–2.5 above implement it. Keep reading for the operational detail.



This is where rotation discipline lives. After this phase, rotating a
secret = update one entry in 1Password, redeploy. No more "did I update
GitHub Actions AND the VPS env file?".

**Honest framing** (revised in v2 per security review): Phase 2 does
**NOT** remove runtime plaintext from the VPS. Once `op inject`
renders `backend.env`, the host has plaintext secrets on disk again.
A VPS root compromise can still read them. The KMS migration in
Phase 3 is what removes the most valuable runtime plaintext (the
signer key). Phase 2 alone gives you single-source-of-truth
discipline and audit logs, not full runtime confidentiality.

To minimize the runtime-plaintext surface during Phase 2, follow the
hardening steps in 2d below (tmpfs, chmod 0400, exclude from
backups).

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

### 2b. Set the runtime-scoped service account tokens

**Use the per-runtime tokens from Phase 1.** Each VPS service reads
from only its scoped token. Two separate env files (per env) — the
backend service should never have access to the indexer token, and
vice versa.

```bash
# on the VPS — backend
echo 'export OP_SERVICE_ACCOUNT_TOKEN="ops_prod-vps-backend_..."' \
  >> /etc/agent-stack/op-backend.env
chmod 600 /etc/agent-stack/op-backend.env
chown root:root /etc/agent-stack/op-backend.env

# on the VPS — indexer
echo 'export OP_SERVICE_ACCOUNT_TOKEN="ops_prod-vps-indexer_..."' \
  >> /etc/agent-stack/op-indexer.env
chmod 600 /etc/agent-stack/op-indexer.env
chown root:root /etc/agent-stack/op-indexer.env
```

The `op` CLI auto-detects `OP_SERVICE_ACCOUNT_TOKEN`. Source the
relevant file before each `op inject` call so each service sees only
its own scoped token.

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
+ PIMLICO_BUNDLER_URL=op://Averray/Production/BackendExternal/pimlico-bundler-url/credential
```

### 2d. Render at deploy time (with hardening)

**Revised in v2.** Render env files to **tmpfs** so they don't persist
on the underlying disk, and lock them down:

```bash
# Ensure tmpfs mount exists (one-time setup; persist via /etc/fstab)
mountpoint -q /run/agent-stack || mount -t tmpfs -o size=8M,mode=0700 tmpfs /run/agent-stack
chmod 0700 /run/agent-stack
chown root:root /run/agent-stack

# Render backend env with the backend-scoped token
(
  source /etc/agent-stack/op-backend.env
  op inject -i /srv/agent-stack/backend.env.template -o /run/agent-stack/backend.env
  chmod 0400 /run/agent-stack/backend.env
  chown root:root /run/agent-stack/backend.env
)

# Render indexer env with the indexer-scoped token (separate subshell so
# the tokens never appear in the same env)
(
  source /etc/agent-stack/op-indexer.env
  op inject -i /srv/agent-stack/indexer.env.template -o /run/agent-stack/indexer.env
  chmod 0400 /run/agent-stack/indexer.env
  chown root:root /run/agent-stack/indexer.env
)

# Update docker-compose service definitions to read from /run/agent-stack/*.env
# (existing: docker compose pull && up)
```

Why the subshells: keeps each service token in a separate process env;
neither shows up in `cat /proc/$pid/environ` for the other render.

Additional hardening:
- **Exclude** `/run/agent-stack/*` and `/srv/agent-stack/*.env*` from
  any backup or snapshot job
- **Disable core dumps** for the backend process (`LimitCORE=0` in
  the systemd unit, or `prlimit --core=0` if managed differently)
- **Drop privileges**: the backend process should start as root only
  to read the env file, then drop to a non-root user immediately
- `journalctl -u agent-stack` should never print env values; if your
  logging library logs config at boot, scrub it

After deploy, the rendered `backend.env` is on tmpfs, never written
to disk. A reboot clears it. A `docker compose up` re-renders it
from 1Password.

**What Phase 2 does NOT remove** (honest framing, revised in v3 per
security review): once Docker Compose reads `backend.env` via
`env_file`, the values live in the container's process environment
and are visible to anyone with root on the host through
`docker inspect <container>` and `cat /proc/$(pgrep -f backend)/environ`.
That is **expected** — not a Phase 2 failure. The signer key
specifically is removed from this surface in **Phase 3** (KMS); the
other runtime secrets (DB URL, API keys, etc.) remain in container
env throughout the platform's life unless the application is
refactored to fetch them dynamically. The Phase 2 verification
checklist below is calibrated against this reality.

### 2e. Convert GitHub Actions secrets (with environment protection)

**Revised in v2.** Wrap the deploy in a GitHub **Environment** with
required reviewers + restricted deployment branches. The CI token
(`OP_SERVICE_ACCOUNT_TOKEN_PROD_CI`) is exposed ONLY to jobs that
reference that protected environment.

```yaml
# .github/workflows/deploy-production.yml
jobs:
  deploy:
    runs-on: ubuntu-latest
    # The "production" environment must be configured in repo settings
    # with: required reviewers, restricted to main branch, prevent self-review
    environment: production
    permissions:
      # Top-level read-only; elevate per step only when needed
      contents: read
      id-token: write  # for OIDC, see Phase 3
    steps:
      - uses: actions/checkout@<commit-sha>   # pin to SHA, not tag
      - uses: 1password/load-secrets-action@<commit-sha>
        env:
          # OP_SERVICE_ACCOUNT_TOKEN_PROD_CI is configured as an
          # ENVIRONMENT secret (not a repo secret), so only this
          # environment-gated job sees it.
          OP_SERVICE_ACCOUNT_TOKEN: ${{ secrets.OP_SERVICE_ACCOUNT_TOKEN_PROD_CI }}
          VPS_SSH_KEY:                  op://Averray/Production/CI/vps-ssh-key/credential
          ADMIN_JWT:                    op://Averray/Production/Smoke/admin-jwt/credential
          APP_BASIC_AUTH_PASSWORD_HASH: op://Averray/Production/CI/app-basic-auth-password-hash/credential
          RESEND_API_KEY:               op://Averray/Production/CI/resend-api-key/credential
```

Configuration steps (in GitHub repo settings):
1. **Settings → Environments → New environment → production**
2. Required reviewers: add at least one human (cannot self-approve)
3. Deployment branches: restrict to `main`
4. Environment secrets: add `OP_SERVICE_ACCOUNT_TOKEN_PROD_CI`
5. Configure same for `testnet` with separate token

Now the GitHub Actions secret store contains exactly the
**environment-gated** OP tokens. Everything else flows from
1Password. A malicious PR cannot reach the production deploy
without a reviewer's explicit approval.

**Action pinning**: pin every third-party action to a commit SHA,
not a version tag. GitHub explicitly recommends this to reduce
supply-chain risk if an action's tag is moved by an attacker who
gains access to the action's repo.

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
- [ ] **Tmpfs check**: `findmnt /run/agent-stack` reports `tmpfs`;
  rendered env files are mode `0400`, owner `root:agent-stack-service`
- [ ] **Backup check**: `/run/agent-stack/*` and any
  `/srv/agent-stack/*.env*` are excluded from every backup /
  snapshot / image-export job (grep the backup config to confirm)
- [ ] **Deploy-log check**: a fresh deploy log contains no rendered
  values (grep the deploy log + `journalctl -u agent-stack` for
  the first 8 chars of one known secret → zero hits)
- [ ] **Acknowledged residual** (not pass/fail): runtime secrets
  remain visible inside the container via `docker inspect` and
  `/proc/$pid/environ`. This is expected; eliminating that surface
  for the signer key is Phase 3's job.

### Rollback

Per-secret: copy the value out of 1Password into the old plain-text
location (GitHub Actions secret or VPS env). Per-phase: revert the
deploy script PR and the workflow changes.

---

## Phase 3 — AWS KMS for the backend signer

This is the big security win. After this phase, the private key for
the backend signer is never on disk, in any vault, or in any backup.
Compromise of the VPS or 1Password vault no longer implies
compromise of the signer.

**Revised in v2** to use temporary credentials (IAM Roles Anywhere
on the VPS, GitHub OIDC for Actions) instead of long-lived IAM
access keys. The reviewer correctly flagged that storing access keys
in 1Password trades disk-stored-key for vault-stored-credential —
better, but still a long-lived credential. IAM Roles Anywhere /
OIDC give us short-lived (≤1h) credentials that rotate
automatically.

### 3a. AWS account + IAM policy

1. Create an AWS account
   - Hardware MFA (YubiKey) on root
   - Use root only for billing + initial IAM setup; never daily
   - Print recovery info offline
2. Create the IAM **role** `averray-signer-prod-role` (not user!) with
   only these permissions on the KMS key. **The Sign statement and
   the GetPublicKey statement must be separate** — `kms:SigningAlgorithm`
   and `kms:MessageType` are condition keys for `Sign`/`Verify` only,
   not `GetPublicKey`. Combining them in one statement implicitly
   denies `GetPublicKey` because the condition keys are absent from
   its request context (revised in v3 per security review):
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Sid": "AllowGetPublicKey",
         "Effect": "Allow",
         "Action": "kms:GetPublicKey",
         "Resource": [
           "arn:aws:kms:<primary-region>:<account>:key/<key-id>",
           "arn:aws:kms:<replica-region>:<account>:key/<key-id>"
         ]
       },
       {
         "Sid": "AllowSignDigestOnly",
         "Effect": "Allow",
         "Action": "kms:Sign",
         "Resource": [
           "arn:aws:kms:<primary-region>:<account>:key/<key-id>",
           "arn:aws:kms:<replica-region>:<account>:key/<key-id>"
         ],
         "Condition": {
           "StringEquals": {
             "kms:SigningAlgorithm": "ECDSA_SHA_256",
             "kms:MessageType":      "DIGEST"
           }
         }
       },
       {
         "Sid": "ExplicitDenyDangerousOpsForSignerRole",
         "Effect": "Deny",
         "Action": [
           "kms:ScheduleKeyDeletion",
           "kms:DisableKey",
           "kms:PutKeyPolicy",
           "kms:CreateGrant",
           "kms:ReplicateKey",
           "kms:UpdatePrimaryRegion"
         ],
         "Resource": [
           "arn:aws:kms:<primary-region>:<account>:key/<key-id>",
           "arn:aws:kms:<replica-region>:<account>:key/<key-id>"
         ]
       }
     ]
   }
   ```

   **Scope of the explicit deny**: it applies to the signer role
   only. It does NOT constrain AWS root or admin principals on this
   account. Admin-path protection requires key-policy constraints
   (on the KMS key itself), SCPs at the organization level,
   permission boundaries, an approval process for IAM admin
   actions, and CloudTrail monitoring — covered in the
   `ExplicitDenyDangerousOps` discussion under "CloudWatch alarms"
   below.

   The condition keys (`kms:SigningAlgorithm`, `kms:MessageType`)
   bind the Sign action to one signing algorithm + digest mode.
   Even with
   the credentials, an attacker cannot ask for a different algorithm
   or sign a raw message instead of a digest.

3. **VPS access**: configure IAM Roles Anywhere
   - Provision a private CA. **Recommended default for our scale: a
     self-managed CA with the CA private key stored in
     `Averray/Production/Critical` (1Password, human-only).** $0
     AWS recurring fees; the operator burden is one weekly cert-
     issuance script. Documented residual risk: a Critical-vault
     compromise = full CA compromise. Acceptable while there is one
     operator and pre-mainnet stakes; revisit at mainnet maturity
     or when adding a second operator.
   - **Cheap upgrade ($25 one-time, $0 recurring)**: hold the CA
     private key on a YubiKey instead of in 1Password. CA key never
     touches disk; cert issuance requires the YubiKey + PIN. Single
     operator availability constraint (only the YubiKey holder can
     issue certs) is fine pre-mainnet.
   - **Managed upgrade ($50/mo)**: AWS Private CA in **short-lived
     certificate mode** (cert validity ≤7 days). Trade $600/year
     for "any on-call operator can issue certs at 3am via the AWS
     console with CloudTrail evidence." Right call once we have 2+
     operators or audit pressure.
   - **General-purpose AWS Private CA (~$400/mo)**: don't bother.
     We never need certs valid longer than 7 days for this use
     case, so paying for that capability is pure overhead.
   - Create a Trust Anchor in IAM referencing the CA
   - Create a Profile referencing `averray-signer-prod-role`
   - **Issue the client cert + key directly on the VPS** (revised in
     v3): generate the cert keypair on the host, submit the CSR to
     the CA, install the issued cert. Do NOT generate the private
     key on a workstation and copy it to the VPS.
   - Store client cert + private key at
     `/etc/agent-stack/roles-anywhere/{cert.pem,key.pem}`,
     mode 0400, owner root.
   - **Do NOT store the client private key in any 1Password vault
     that a service account can read.** That would defeat the
     architecture: `prod-vps-backend` token + Roles Anywhere key =
     AWS temp creds = `kms:Sign` capability. Optional emergency
     escrow only in `Averray/Production/Critical` (human-only,
     never service-readable), documented as explicit residual
     risk.
   - **Roles Anywhere session duration must be enforced** at three
     places, not just policy: (a) the Profile's `durationSeconds`,
     (b) the `CreateSession` request's `durationSeconds`, (c) the
     target IAM role's `MaxSessionDuration`. Set all three to ≤1h.
     For production signer access, prefer 15–30 minutes unless
     operationally painful — sessions cap at 12h by default if
     unconfigured.
   - **Add certificate identity constraints to the trust policy**.
     AWS Roles Anywhere exposes X.509 subject / issuer / SAN
     attributes as source identity and principal tags. Use
     `aws:PrincipalTag/...` or `aws:SourceIdentity` conditions on
     the trust policy so only the expected VPS cert can assume
     this role, not any cert issued by the trust anchor.

4. **GitHub Actions access** (if any workflow needs to call AWS):
   configure GitHub as an OIDC provider in IAM, and **use a
   separate role from the production signer role**. (Revised in v3
   per security review — the previous wording reused
   `averray-signer-prod-role` for OIDC, which would have given any
   workflow that can assume it the same `kms:Sign` capability as
   the backend. That's an unacceptable blast radius for CI.)
   - In IAM: add `token.actions.githubusercontent.com` as an
     identity provider
   - Create `averray-ci-deploy-role` (separate from
     `averray-signer-prod-role`). Default attached permissions
     should NOT include `kms:Sign`. Grant only what the CI job
     actually needs (e.g. read-only ECR, read-only S3 for build
     artifacts). If a workflow legitimately needs the signer's
     public key (e.g. to verify deployment metadata), grant
     **`kms:GetPublicKey`** on the specific key ARN only — not
     `kms:Sign`.
   - Trust policy on `averray-ci-deploy-role` allows
     `sts:AssumeRoleWithWebIdentity` only from
     `repo:<your-org>/<your-repo>:environment:production` (use the
     `environment:` claim, not just `ref:` — a fork PR can't set
     the environment claim).
   - The production signer role
     (`averray-signer-prod-role`) trusts ONLY the Roles Anywhere
     trust anchor + the production VPS cert identity — no GitHub
     OIDC trust on that role.
   - Workflow uses `aws-actions/configure-aws-credentials` with
     `role-to-assume: arn:aws:iam::<acct>:role/averray-ci-deploy-role`
     and `aws-region:`; gets ≤1h credentials per job; no AWS keys
     ever stored in GitHub.

5. **Do NOT store static IAM access keys for the signer principal
   anywhere.** If you must start with static keys during early
   testnet setup, document it as an explicit residual risk with a
   removal date, and move to temporary credentials before mainnet.

### 3b. Create the KMS key (multi-region for mainnet)

**Critical**: AWS does **not** allow converting a single-region key
into a multi-region key later. If you might ever need regional
failover for mainnet, create the mainnet key as multi-region from
day one.

**Testnet** (single region is fine):
```bash
aws kms create-key \
  --description "Averray testnet backend signer (secp256k1)" \
  --key-usage SIGN_VERIFY \
  --key-spec ECC_SECG_P256K1 \
  --region eu-central-1
```

**Mainnet** (multi-region; replicate to a second region for
failover):
```bash
# Create the primary key
aws kms create-key \
  --description "Averray mainnet backend signer (secp256k1, multi-region primary)" \
  --key-usage SIGN_VERIFY \
  --key-spec ECC_SECG_P256K1 \
  --multi-region \
  --region eu-central-1

# Replicate to a second region
aws kms replicate-key \
  --key-id <primary-key-arn> \
  --replica-region us-east-1
```

Multi-region keys share the same key ID and key material across
regions. Each replica is managed independently — same IAM policy,
same CloudTrail trail, same alarms, on every replica.

Save the returned key ARNs. Verify with:
```bash
aws kms describe-key --key-id <key-id> --region <region>
```
Expected: `MultiRegion: true`, `KeySpec: ECC_SECG_P256K1`.

### 3b-1. Enable CloudTrail for KMS events

CloudTrail can be configured to exclude KMS events from a trail.
Verify yours doesn't:
```bash
aws cloudtrail get-event-selectors --trail-name <trail>
```
Look for `ExcludeManagementEventSources` — `kms.amazonaws.com`
should NOT be there.

### 3b-2. Configure CloudWatch alarms

All of these should trigger a notification (SNS → email, Slack,
PagerDuty):
- `kms:ScheduleKeyDeletion` on the signer key
- `kms:DisableKey` on the signer key
- `kms:PutKeyPolicy` on the signer key
- `kms:CreateGrant` on the signer key
- `kms:ReplicateKey` and `kms:UpdatePrimaryRegion` (multi-region)
- Unusual `kms:Sign` volume (e.g., >10× baseline over a 5-minute window)
- Sign requests from unusual source IPs / ASNs
- Any activity by root or admin IAM principals on this key

**Test each alarm with a synthetic event** before going to mainnet.
Untested alarms have a habit of being silently broken.

**How to test safely** (revised in v3 per security review — do
**not** call `DisableKey` / `ScheduleKeyDeletion` / `PutKeyPolicy`
against a live production key just to verify alarms; the cure
becomes worse than the disease):

1. **Preferred**: create a **dedicated non-production test KMS key**
   in the same account/region with the same tag, policy, and
   CloudWatch alarm wiring. Trigger the destructive APIs against
   that key. The alarm rules can be written against either a tag
   selector that covers both, or a duplicate alarm scoped to the
   test key — choose the form that exercises the same notification
   path you rely on in prod.
2. **EventBridge `PutEvents` test events**: most of these alarms
   are CloudTrail-driven EventBridge rules. Use
   `aws events put-events` to inject a synthetic event matching
   the rule pattern (e.g., a `DisableKey` event for the prod key
   ARN). This validates routing → SNS → PagerDuty without ever
   calling the destructive API.
3. **Unusual-`kms:Sign`-volume / source-IP alarms**: drive these
   from synthetic CloudWatch metric data points
   (`aws cloudwatch put-metric-data`) or by running a controlled
   load test against the test key.
4. **Never** call `DisableKey`, `ScheduleKeyDeletion`,
   `PutKeyPolicy`, or `CreateGrant` against the production signer
   key as a test. The blast radius (signing pauses → user
   payouts stall) is the exact failure mode the alarm is supposed
   to warn you about — don't trigger it on purpose.

### 3c. Derive the EVM address

The EVM address is the keccak256 of the public key, last 20 bytes:

```js
import { KMSClient, GetPublicKeyCommand } from "@aws-sdk/client-kms";
import { keccak256 } from "ethers";
import { AsnParser } from "@peculiar/asn1-schema";
import { SubjectPublicKeyInfo } from "@peculiar/asn1-x509";

const kms = new KMSClient({ region: "eu-central-1" });
const { PublicKey } = await kms.send(new GetPublicKeyCommand({ KeyId: "<uuid>" }));

// PublicKey is a DER-encoded SubjectPublicKeyInfo (SPKI).
// Parse the structure properly — DO NOT slice the last 64 bytes;
// SPKI length varies with the algorithm OID + parameter encoding,
// and a fixed-offset slice will silently produce wrong addresses
// for some keys. Parse SPKI, read the BIT STRING contents, then
// strip the leading 0x04 uncompressed-point marker to get the
// 64-byte (x || y) coordinate pair.
const spki = AsnParser.parse(PublicKey, SubjectPublicKeyInfo);
const bitString = new Uint8Array(spki.subjectPublicKey);
if (bitString[0] !== 0x04) {
  throw new Error(
    `Expected uncompressed EC point (0x04 prefix), got 0x${bitString[0].toString(16)}`,
  );
}
const point = bitString.subarray(1); // 64 bytes: x (32) || y (32)
if (point.length !== 64) {
  throw new Error(`Expected 64-byte EC point, got ${point.length}`);
}
const address = "0x" + keccak256(point).slice(-40);
console.log("EVM address:", address);
```

This becomes the new on-chain verifier address. **Revised in v3 per
security review**: the earlier code used `PublicKey.subarray(length - 64)`
which works on the common-case AWS KMS output but is fragile —
if AWS ever changes the SPKI encoding (e.g., different OID
parameters), the slice would silently produce a wrong address.
Use a real DER/ASN.1 parser, not byte-offset arithmetic.

**Pin the parser dependency** to an exact version with a lockfile
entry and (where available) npm provenance attestation enabled —
a malicious DER parser update is a credible supply-chain risk
specifically against this code path.

### 3d. Wire the backend

Add `KMS_KEY_ID` and `AWS_REGION` env vars to `backend.env.template`
(they flow through 1Password). Update
`mcp-server/src/blockchain/gateway.js`:

```js
import { AwsKmsSigner } from "@rumblefishdev/eth-signer-kms";

function createSigner(provider, config) {
  if (config.kmsKeyId) {
    // Backend never holds signer private key bytes locally.
    // It still holds AWS credentials (temporary, via Roles
    // Anywhere or OIDC) capable of REQUESTING signatures.
    return new AwsKmsSigner({
      keyId: config.kmsKeyId,
      region: config.awsRegion ?? "eu-central-1",
    }, provider);
  }
  // Fallback for LOCAL DEVELOPMENT ONLY. Never enabled in any
  // production / staging path — see 3f below for mainnet posture.
  if (config.signerPrivateKey && config.allowLocalKeyFallback) {
    return new Wallet(config.signerPrivateKey, provider);
  }
  throw new Error(
    "No signer configured. Set KMS_KEY_ID for production, or " +
    "ALLOW_LOCAL_KEY_FALLBACK=1 + SIGNER_PRIVATE_KEY for local dev."
  );
}
```

The `AwsKmsSigner` is a drop-in `ethers.Signer`. All call sites
(`escrowContract.connect(signer)`, etc.) work unchanged.

### 3d-1. Non-negotiable KMS adapter tests

Add unit tests (e.g., `mcp-server/src/blockchain/kms-signer.test.js`)
that prove:

1. **Address derivation**: `GetPublicKey` → keccak256 → matches the
   expected EVM address used as the on-chain verifier
2. **Single-message sign + recover**: known digest, sign through
   KMS, parse ECDSA into `r, s`, verify recovery to the expected
   address
3. **Low-s canonicalization**: signatures where `s > secp256k1n / 2`
   are inverted to canonical low-s form. Per EIP-2, Ethereum
   rejects high-s signatures.
4. **Correct recovery id (v)**: signing the same digest multiple
   times, the adapter correctly computes `v` (27 or 28 for
   Ethereum) such that recovery yields the expected address.
5. **Bulk round-trip**: repeat (2)–(4) over ≥1000 distinct messages
   — the high-s case manifests probabilistically.

Don't write your own KMS adapter; pick a vetted one
(`@rumblefishdev/eth-signer-kms` or `ethers-aws-kms-signer`) and
**pin to an exact npm version** with:

- a `package-lock.json` (or pnpm/yarn equivalent) committed to the
  repo so the integrity hash is part of the supply-chain audit
- the package version pinned as `"X.Y.Z"` (no `^` / `~` ranges)
- npm provenance attestations enabled for any first-party package
  that wraps this adapter (`npm publish --provenance`)
- a Renovate/Dependabot rule that **requires manual review** for
  upgrades to any package in the signing path — auto-merging
  patch updates is not acceptable for code that handles signer
  capability

Earlier guidance to "pin to a specific commit SHA" referred to
GitHub Actions workflow steps (where SHA pinning IS the
recommended practice). For npm dependencies, version-pin +
lockfile + provenance is the correct mechanism. SHA-pinning npm
packages via git refs in `package.json` works but bypasses the
registry-level integrity hash and provenance checks, so it's
weaker, not stronger, supply-chain-wise.

### 3d-2. Domain separation for backend-signed messages

Backend-signed payloads MUST include domain-separation fields so a
signed message in one context cannot be replayed in another:
- `chainId` — testnet vs mainnet
- `contractAddress` — TreasuryPolicy or EscrowCore as relevant
- `environment` — "production", "testnet", etc.
- `purpose` — what kind of signature this is ("verifier-approve",
  "verifier-reject", "arbitrator-resolve", etc.)
- `jobId` / `disputeId` — bound to the specific resource
- `nonce` — non-reusable per (subject, purpose) pair
- `expiry` — Unix timestamp; reject after

This is independent of the KMS migration but the migration is the
right time to verify the signed payloads carry these fields. Audit
every `signer.signMessage()` / `signer.signTypedData()` call site
in `mcp-server/src/blockchain/`.

### 3e. Test on testnet first

1. Generate a fresh KMS key in AWS for testnet (single-region OK)
2. Deploy fresh testnet contracts using the KMS-derived address as
   the verifier (multisig signs the `setVerifier` call)
3. Run the full hosted product-proof smoke loop end-to-end with the
   KMS path
4. Confirm (Phase 3 = the **signer key specifically** is gone from
   every surface; other runtime secrets remain in env_file by
   design):
   - `SIGNER_PRIVATE_KEY` is absent from:
     - every env-file template in the repo (`grep -R SIGNER_PRIVATE_KEY
       . --include='*.env*' --include='*.template'` → zero hits)
     - the rendered `/run/agent-stack/backend.env`
     - `docker inspect agent-stack` (container env)
     - `cat /proc/$(pgrep -f backend)/environ | tr '\0' '\n'`
     - process command-line args (`ps -ef | grep backend`)
     - container image layers (`docker history` for any baked-in
       env)
     - `journalctl -u agent-stack` from the last 7 days
     - every 1Password vault (search by item name AND by value
       pattern `0x[a-f0-9]{63,64}`)
     - every operator's password manager / shell history
     - every backup or snapshot
   - CloudTrail shows the `kms:Sign` calls and **no** `Decrypt` /
     `GetParametersForImport` / cross-account export events
   - Revoking the Roles Anywhere profile temporarily breaks signing
     — proves the backend really uses temp creds, not a stashed key
   - The legacy `SIGNER_PRIVATE_KEY` value (testnet) has been
     **rotated and discarded** so it can't be reactivated later

### 3f. Cutover and key rotation

**Testnet cutover**: update the `verifier` field in
`deployments/testnet.json` (via the testnet multisig
`setVerifier(newKmsAddress, true)`), deploy fresh, switch. Keep the
local-dev raw-key fallback (`ALLOW_LOCAL_KEY_FALLBACK=1`) available
for one full deploy cycle for safety. After confirming KMS path
works, **rotate the testnet raw key so the old value is invalid**.

**Mainnet cutover** (Phase 5): the mainnet deploy is the first time
the KMS-managed key signs anything. **No raw-key fallback for
mainnet.** Local-dev fallback is disabled in production builds:
`config.allowLocalKeyFallback = process.env.NODE_ENV !== 'production'`.

**KMS key rotation is an on-chain migration**, not a routine
calendar rotation. AWS does NOT support automatic rotation for
asymmetric KMS keys. The procedure:

1. Create a new KMS key (same spec, same multi-region setup)
2. Derive the new EVM address from the new key's public key
3. Multisig signs `setVerifier(newKmsAddress, true)` on TreasuryPolicy
4. Update `KMS_KEY_ID` env var (via 1Password) to the new key
5. Redeploy backend
6. Grace period (e.g., 24h): both keys are valid verifiers
7. Multisig signs `setVerifier(oldKmsAddress, false)` to disable
   the old key
8. Schedule deletion of the old KMS key (7–30 day pending period)
9. After deletion period, key is permanently destroyed

The signer KMS key is **explicitly NOT tracked in
`SECRETS_CALENDAR.yml`** — see the inline note there.

IAM credentials (Roles Anywhere certs, OIDC trust relationship)
DO rotate frequently. The KMS key itself rotates only via this
multisig-controlled migration.

### Phase 3 done = exit criteria

- [ ] AWS account + IAM **role** (not user) provisioned with minimum
  permissions + condition keys (`kms:SigningAlgorithm`,
  `kms:MessageType`)
- [ ] Explicit deny on dangerous ops (ScheduleKeyDeletion, DisableKey,
  PutKeyPolicy, CreateGrant, ReplicateKey, UpdatePrimaryRegion) for
  the signer role
- [ ] Mainnet KMS key created **multi-region** from day one; testnet
  may be single-region
- [ ] CloudTrail confirmed to include KMS events (not excluded)
- [ ] CloudWatch alarms configured AND **tested with synthetic events**
- [ ] VPS: IAM Roles Anywhere configured with X.509 client cert;
  static IAM access keys for the signer role do not exist
- [ ] GitHub Actions: OIDC configured if AWS access is needed; no
  static AWS credentials in GitHub
- [ ] EVM address derived from KMS public key matches the on-chain
  verifier
- [ ] All KMS adapter tests pass over ≥1000 distinct messages
- [ ] Domain-separation audit complete (every signed payload carries
  chainId, contract, env, purpose, ID, nonce, expiry)
- [ ] Hosted product-proof smoke passes end-to-end on testnet via KMS
- [ ] Process listing on VPS shows no plaintext signer key

### Rollback

**Testnet only**: revert to `SIGNER_PRIVATE_KEY` env path with
`ALLOW_LOCAL_KEY_FALLBACK=1`. Contract-side verifier reset via
multisig.

**Mainnet**: there is no raw-key rollback. Fallback for an emergency
is multisig-controlled signer migration (`setVerifier(temporary, true)`)
or pausing the protocol via the pauser key. Plan and rehearse this
before going live.

---

## Phase 4 — Hardening

**Revised in v2 per security review.** Five additions, each
independent.

### 4a. Pre-commit + push protection + CI secret scanning

Three layers of defense in depth so a secret can't sneak in:

1. **Local pre-commit hook** (catches before push):
   ```bash
   # .githooks/pre-commit
   #!/usr/bin/env bash
   set -e
   if command -v gitleaks >/dev/null 2>&1; then
     gitleaks protect --staged --verbose
   else
     echo "warn: gitleaks not installed locally; relying on CI" >&2
   fi
   ```
   Install via `git config core.hooksPath .githooks` per operator.

2. **GitHub Secret Scanning push protection**:
   - Settings → Security → Secret scanning → Enable push protection
   - Add custom patterns for Averray-specific secret formats
     (signer key shapes, JWT shapes if they have a custom prefix,
     `ops_` 1Password tokens, etc.)
   - This blocks the push at the server side regardless of local hooks

3. **CI gitleaks** (last-resort sweep):
   ```yaml
   # .github/workflows/ci.yml
   - uses: gitleaks/gitleaks-action@<commit-sha>
     env:
       GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
   ```

CI catches what push protection misses; push protection catches
what local hooks miss; local hooks catch the common case before
the secret ever leaves the operator's machine.

### 4b. Asymmetric JWT signing via KMS

**The architectural upgrade**: today `AUTH_JWT_SECRETS` is an HMAC
secret stored in the vault and on every backend instance. A vault
breach OR a backend env breach means an attacker can mint admin
JWTs.

**Target design**:
- KMS-managed asymmetric key (RSA-2048 or ES256) signs access tokens
  at issuance / refresh time
- Backend services verify locally with the **public** key (no access
  to the signing key needed)
- Access tokens carry `kid` (key ID for rotation), `iss`, `aud`,
  `sub`, `role`, `jti`, `iat`, `nbf`, `exp`
- Access TTL: ≤1h (≤15min is better)
- Refresh tokens: **opaque random values** (not signed JWTs),
  stored server-side as hashes, rotated on every use, revoked on
  replay detection

After this change, a vault leak no longer allows JWT minting. Only
a KMS principal compromise does — same protection as the signer
key from Phase 3.

**Implementation outline**:
- New KMS key, separate from the signer key, with the same temporary-
  credential access pattern
- Update `mcp-server/src/auth/jwt.js` to sign via KMS instead of HMAC
- Update `mcp-server/src/auth/middleware.js` to verify with the
  public key (cached locally, refreshed periodically)
- Add `mcp-server/src/auth/refresh.js` with the opaque-token
  exchange endpoint + server-side hash storage
- Update `scripts/ops/mint-admin-jwt.mjs` to call the new path or
  deprecate in favor of the refresh-token flow

**If full migration is too much work pre-mainnet**, the minimum
hardening for the HMAC path is:
- Key ring with `kid` rotation
- Short access-token TTLs (≤15 min)
- Documented two-key rotation window with old-key tolerance period
- Refresh tokens are opaque random values, hashed server-side
- All flagged as residual risk in the sign-off bar

### 4c. GitHub Actions hardening (beyond Phase 2)

Already partially covered in 2e. Additional steps:
- Top-level `permissions: read-all` on every workflow; elevate
  per-job with explicit `permissions:` blocks
- Pin every third-party action to a commit SHA, never a tag
- Avoid `pull_request_target` with secrets unless workflow is
  extremely constrained
- Never inject OP service tokens into build/test jobs — only the
  job that needs them
- Require code review for any workflow file change (branch
  protection rule on `.github/workflows/**`)

### 4d. Calendar-driven CI checks

Already shipped in PR #225: `scripts/ops/check-secrets-calendar.mjs`.
Wire into CI:

```yaml
# .github/workflows/ci.yml
- name: Check secrets calendar
  run: node scripts/ops/check-secrets-calendar.mjs
```

Warns ≥7 days before any tracked token expires; fails CI on past-
expiry. **The KMS signer key is NOT in this calendar** — see the
inline note in `SECRETS_CALENDAR.yml`.

### 4e. Hardware MFA across the admin trust chain

Mainnet baseline (~$50 per operator, one-time):
- 1Password admin account: hardware key (YubiKey) required
- AWS root account: hardware key required
- AWS IAM admin users: hardware key required
- GitHub org admin: hardware key required
- Domain registrar: hardware key required
- VPS provider: hardware key required

TOTP is OK for testnet ops; for mainnet, hardware-key everywhere.
TOTP is phishable; FIDO2 is not.

### Phase 4 done = exit criteria

- [ ] Pre-commit hook, GitHub push protection, and CI gitleaks all
  configured and tested (synthetic bad-commit blocked at each layer)
- [ ] Custom secret patterns added to push protection for Averray-
  specific formats
- [ ] Either: asymmetric KMS-signed JWT path live end-to-end on
  testnet, OR: HMAC hardening path documented as residual with
  named owner and timeline
- [ ] Top-level read-only permissions on all workflows
- [ ] All third-party actions pinned to commit SHA
- [ ] GitHub Environments with required reviewers configured for
  production deploys
- [ ] Calendar check runs on every CI build
- [ ] Hardware MFA on every admin account in the trust chain

---

## Phase 5 — Mainnet cutover

This is the night-of deploy. Treat it as a one-shot ceremony with all
four prior phases already in production for ≥1 week each.

### Pre-flight checklist

The day before:

- [ ] All four prior phases live and stable on testnet for ≥7 days
- [ ] Audit script (`scripts/ops/audit-launch-readiness.mjs`) shows
  zero drift between testnet config and the planned mainnet config
- [ ] All production OP service account tokens rotated within the
  last 30 days
- [ ] AWS KMS key for mainnet created **multi-region from day one**
  (cannot convert later)
- [ ] AWS access via Roles Anywhere (VPS) + OIDC (Actions); **no
  static IAM access keys** for the signer role
- [ ] All CloudWatch alarms tested with synthetic events
- [ ] Multisig signer set established with **fresh seeds** — do not
  reuse testnet seeds
- [ ] All vendor accounts (Pimlico, Sentry, Subscan, RPC provider)
  have separate mainnet API keys minted
- [ ] On-call rotation defined in `INCIDENT_RESPONSE.md` Section 1
  (currently a blank template — fill it in)
- [ ] **Old secrets cleanup**: rotate or revoke any value that ever
  lived in GitHub secrets, local password managers, shell history,
  old VPS env files, CI logs, backups, or test deploys. Assume any
  copy-pasted value is compromised.
- [ ] Incident drills run for: OP token leak, AWS signer credential
  leak, JWT signing key leak, VPS root compromise

### Cutover sequence

1. **Generate fresh secrets**: rotate every secret listed in
   [`SECRETS.md`'s mainnet hardening checklist](SECRETS.md#mainnet-hardening-checklist).
   Each goes into a fresh 1Password item under
   `Averray/Production/<vault>/`. Never reuse a testnet value.
2. **Provision the multisig** on Polkadot.js Apps with three fresh
   signer addresses (Hot, Warm, Cold per `MULTISIG_SETUP.md`). Do
   not reuse testnet seeds.
3. **Deploy contracts** with the multisig as the owner from line 1
   (skip the EOA-then-transfer flow used on testnet — owner is the
   multisig from genesis).
4. **Update `deployments/mainnet.json`** with all addresses.
5. **Update `backend.mainnet.env.template`** to reference the new
   mainnet 1Password items. The KMS key ID, the role ARN, the
   multi-region settings — all from the mainnet vault, never from
   the testnet vault.
6. **Run the smoke** with `product_proof_reward_asset=USDC` against
   mainnet. Confirm 3 consecutive successful runs before opening to
   real users.
7. **Archive** the testnet 1Password vault — read-only, kept for
   forensics. **Do not delete** for at least 90 days.

### Post-cutover verification

- [ ] `audit-launch-readiness.mjs` shows green for mainnet
- [ ] `check-secrets-calendar.mjs` shows zero entries within 7 days
  of expiry
- [ ] Hosted product-proof smoke passes end-to-end 3 consecutive
  runs on mainnet
- [ ] **No raw `SIGNER_PRIVATE_KEY` value exists anywhere** for
  mainnet — env file, container env, `docker inspect` output,
  `/proc/$pid/environ`, process args, logs, backups, 1Password
  vault, or operator machine. (Other runtime secrets — DB URL,
  vendor API keys — remain in `env_file` by design; this check
  is signer-key-specific.)
- [ ] Deploy logs (CI + VPS `journalctl`) contain no rendered
  values from the mainnet vault (grep first 8 chars of one known
  secret → zero hits)
- [ ] Rendered env files on the mainnet VPS are on tmpfs, mode
  0400, excluded from backups
- [ ] On-call rotation is live and first responder has been paged
  with a synthetic test alert successfully
- [ ] All Phase 4 hardening verified active on mainnet (push
  protection, environment gates, hardware MFA, etc.)

---

## Cost summary

| Item | Monthly cost |
|---|---|
| 1Password Business (1 user) | $7.99 |
| 1Password Business (3 users, post second-operator) | $23.97 |
| AWS KMS testnet key (single region) | ~$1.05 (1 key + ~$0.15 per 10k sigs) |
| AWS KMS mainnet key (multi-region: 1 primary + 1 replica = 2 keys total) | ~$2.05 (2 keys × ~$1/mo + signing fees) |
| AWS Roles Anywhere | $0 (no per-request fee) |
| Roles Anywhere CA — **self-managed, key in `Critical` 1Password vault** (recommended) | **$0 recurring** |
| Roles Anywhere CA — **self-managed, key on YubiKey** ($25 one-time per operator) | $0 recurring + one-time $25/op |
| Roles Anywhere CA — AWS Private CA, short-lived certificate mode (≤7d certs) | ~$50/mo — upgrade option once we have 2+ operators or audit pressure |
| Roles Anywhere CA — AWS Private CA, general-purpose mode | ~$400/mo — not needed for our use case |
| AWS CloudTrail (for KMS audit) | $0 (first management trail free) |
| AWS CloudWatch (for KMS alarms) | < $5 |
| **Total at 1 user, testnet, self-managed CA** | **~$9/mo** |
| **Total at 3 users, mainnet, self-managed CA** | **~$26/mo** |
| **Total at 1 user, testnet, AWS Private CA short-lived mode** | ~$59/mo |
| **Total at 3 users, mainnet, AWS Private CA short-lived mode** | ~$76/mo |
| **YubiKey hardware keys** (one-time, for operator MFA — separate from CA-key YubiKey) | ~$50 × number of operators |

The **Roles Anywhere CA decision is the one to think about**, but
v3 (revised) lands on a different default than v2:

- **Self-managed CA, key in `Averray/Production/Critical`** ($0).
  **This is the recommended default at our current scale.** The
  CA's only job is signing a fresh client cert for the VPS once a
  week — a 30-second scripted operation. The CA key sits in
  1Password Critical (human-only, no service account can read it).
  Documented residual risk: a Critical-vault compromise = full CA
  compromise. That's the same trust-chain assumption we already
  make for the 1Password recovery kit and AWS root credentials.
- **Self-managed CA, key on YubiKey** ($25 one-time). One step
  better. The CA key never touches disk; cert issuance requires the
  physical YubiKey + PIN. Only the YubiKey holder can issue certs
  (fine pre-mainnet with one operator).
- **AWS Private CA, short-lived mode** ($50/mo). Worth the $600/year
  when we have 2+ operators who need to issue certs without
  coordinating, or when an external audit wants AWS-managed
  CloudTrail evidence of every CA operation. Not worth it today.
- **AWS Private CA, general-purpose mode** ($400/mo). Skip. We
  never need certs valid longer than 7 days.

**Revised in v3 (this PR)**: the previous wording recommended AWS
Private CA short-lived mode as the default. For a pre-launch
product with one operator, $600/year buys "AWS handles the CA"
convenience that we don't yet need. Self-managed is the honest
default; AWS Private CA short-lived mode stays in the menu as the
upgrade path when scale or audit requirements justify it.

KMS mainnet pricing — to be explicit: a multi-region KMS key with
one replica in a second region is **two billable KMS keys**, not
"two replicas of one key." Each replica is independently priced at
the standard KMS rate (~$1/key/mo for asymmetric secp256k1).

Engineering time for the migration: ~5–7 working days spread over a
few weeks.

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
