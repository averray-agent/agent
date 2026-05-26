# Operator Onboarding

This is the first document an operator reads before taking ownership of any
Averray production-adjacent surface. It is intentionally a routing document:
the *executions* live in the runbooks this doc cross-references. The point of
this file is to make sure a new operator knows which runbooks to read in
which order, what access they need to acquire first, and which trust
boundaries they are responsible for.

If you are doing day-1 incident triage, jump to
[`INCIDENT_RESPONSE.md`](./INCIDENT_RESPONSE.md). Come back here when the
incident is closed.

## 1. Who this is for

This doc is for any human who will:

- hold a 2-of-3 multisig signer key for `TreasuryPolicy.owner`
- hold the hot pauser key for `TreasuryPolicy.setPaused`
- take primary or backup on-call for `ops@averray.com`
- run a manual `workflow_dispatch` against the **Deploy Production** workflow
- ship a contract or backend change that affects money-like routes, async
  XCM settlement, discovery manifest publish, or the multisig control plane

It is **not** for end-users of the platform (workers, posters, external
agents). Those have their own onboarding surfaces:
[`AGENT_WALLET_ONBOARDING.md`](./AGENT_WALLET_ONBOARDING.md) and
[`EXTERNAL_AGENT_WALLET_ONBOARDING.md`](./EXTERNAL_AGENT_WALLET_ONBOARDING.md).

## 2. Before you start

Have these in place before you begin reading the runbooks:

- **1Password access.** Confirm you can resolve `op://prod-backend/`,
  `op://prod-backend-external/`, `op://prod-ci/`, and `op://prod-indexer/`
  vault items via `op item get`. See
  [`SECRETS.md`](./SECRETS.md) for the vault map and
  [`SECRETS_MIGRATION.md`](./SECRETS_MIGRATION.md) for the Phase 3 KMS
  cutover history.
- **GitHub repo access** on `averray-agent/agent` with at least Read
  on Actions and Secrets, and Write on the working branch namespace
  (`agent/<task-name>`, `codex/<task-name>`, or `claude/<task-name>` per
  [`AGENTS.md`](../AGENTS.md)).
- **VPS SSH access** for production-adjacent debugging. Production
  deploys go through `.github/workflows/deploy-production.yml`; do not
  SSH into production unless an incident demands it. See
  [`VPS_RUNBOOK.md`](../VPS_RUNBOOK.md).
- **AWS access for the KMS signers** if you are taking signer-rotation
  or credential-rotation duty. The backend uses two distinct KMS keys:
  the blockchain signer (`SIGNER_BACKEND=kms`, Phase 3 cutover
  2026-05-16) and the JWT signer (`JWT_BACKEND=kms`, Phase 4b Stage
  2C-2 cutover 2026-05-21 — verifier refuses HS256, accepts only
  ES256 against the JWT KMS key). Verifying the blockchain signer
  uses `scripts/ops/derive-kms-signer-address.mjs` +
  `scripts/ops/verify-kms-signer.mjs`. Verifying the JWT signer uses
  `scripts/ops/verify-jwt-kms-signer.mjs`.

  Credentials reach the backend container via IAM Roles Anywhere
  (Phase 5a cutover 2026-05-21) — X.509 client certs in
  `/etc/agent-stack/roles-anywhere/` on the VPS exchange for short-
  lived STS sessions via `aws_signing_helper`. Static IAM access keys
  are no longer rendered into `/run/agent-stack/backend.env`. Cert
  rotation cadence is 90 days; see
  [`PHASE_5A_IAM_ROLES_ANYWHERE_PLAN.md`](./PHASE_5A_IAM_ROLES_ANYWHERE_PLAN.md)
  §"Cert TTL: 90 days, rotated on calendar" for the runbook.
- **A clean development checkout.** Multi-agent work uses one worktree
  per task — run `./scripts/ops/start-agent-worktree.sh
  <prefix>/<task-name>` from the primary repo root and never work in
  the primary checkout. See [`AGENTS.md`](../AGENTS.md) for the
  branching rules.

If any of the above is missing, stop and acquire it before continuing.

## 3. Read these first, in this order

1. [`AGENTS.md`](../AGENTS.md) — branching, worktree, PR-shape, and
   deployment rules. The shortest of the documents listed here and the one
   most likely to be misapplied if skimmed.
2. [`THREAT_MODEL.md`](./THREAT_MODEL.md) — the operational risks every
   role inherits. Read every section, not just the ones that look
   relevant — the threats compose.
3. [`PRODUCTION_CHECKLIST.md`](./PRODUCTION_CHECKLIST.md) — the canonical
   list of what production-readiness means. The boxes are the test;
   flipping one requires deployed evidence, not a doc edit.
4. [`MULTISIG_SETUP.md`](./MULTISIG_SETUP.md) — the multisig design and
   rehearsal procedure. If your role touches `TreasuryPolicy.owner`,
   read this end-to-end.
5. [`INCIDENT_RESPONSE.md`](./INCIDENT_RESPONSE.md) — what to do when
   something breaks. §1 lists the on-call routing and ownership; §6 has
   per-symptom playbooks.
6. [`AUDIT_REMEDIATION.md`](./AUDIT_REMEDIATION.md) — the active
   multi-agent remediation board. The packages on this board are the
   tracked work for closing the v1.0.0-rc1 trust-boundary findings.
   Treat it as a coordination contract; only edit your own package's
   status.
7. [`PHASE_5A_IAM_ROLES_ANYWHERE_PLAN.md`](./PHASE_5A_IAM_ROLES_ANYWHERE_PLAN.md)
   — required reading for any operator who will touch backend AWS
   credentials. Covers the trust-anchor + profile + role-trust-policy
   model, cert rotation, and the operator-side AWS setup. The cutover
   landed 2026-05-21; the next operator touchpoint is the ≥30-day
   `Phase 5a-retire` step that deletes the legacy static IAM keys.
8. [`BACKUP_RESTORE_DRILL.md`](./BACKUP_RESTORE_DRILL.md) — the
   restore-drill procedure. The rc1 launch checklist requires one
   completed drill with date / source backup / target documented; if
   you are taking backups duty, this is the prerequisite read.
9. [`OBSERVABILITY_POSTURE.md`](./OBSERVABILITY_POSTURE.md) — the
   Sentry / structured-logging / alert-routing posture. Covers what
   `/health.serviceHealth` means vs the warnings split, where logs
   land, and how the `ALERT_WEBHOOK_URL` smoke wrapper fits.

Architecture context (read once, refer back as needed):

- [`AVERRAY_WORKING_SPEC.md`](./AVERRAY_WORKING_SPEC.md) — the design.
- [`AVERRAY_VERIFICATION_LEDGER.md`](./AVERRAY_VERIFICATION_LEDGER.md) —
  what's empirically verified against Polkadot vs. what's still
  unconfirmed.
- [`FRAMEWORK_AGENT_HANDOFF.md`](./FRAMEWORK_AGENT_HANDOFF.md) — the
  implementation-side handoff that sits between the spec and the live
  code. Mirrors most of the routing here, but from the
  framework-developer angle.

## 4. First-time setup walkthrough

Run these in order. Each step ends with a check you can use to confirm
the setup is wired.

### 4.1 Confirm your 1Password access

```bash
op item get aws-signer-testnet --vault prod-backend --fields kms-key-id
op item get aws-jwt-signer-testnet --vault prod-backend --fields kms-key-id
op item get admin-jwt --vault prod-smoke --fields password >/dev/null
op item get admin-refresh-token --vault prod-smoke --fields password >/dev/null
```

Expected: each call resolves without prompting for a vault unlock.
The two `aws-*-signer-testnet` items resolve KMS key ARNs (non-secret
metadata); the `prod-smoke/admin-jwt` and `prod-smoke/admin-refresh-token`
resolves confirm you have prod-smoke vault scope for hosted-smoke auth. If you see
"permission denied" or "vault not found", your service-account token
is not scoped correctly — see [`SECRETS.md`](./SECRETS.md) §"Vault
scopes" before continuing.

### 4.2 Confirm the env templates render

```bash
./scripts/ops/validate-env-render.sh backend
./scripts/ops/validate-env-render.sh indexer
```

Expected: both exit `0` after resolving every `op://` reference. A
failure here means an upstream 1Password rotation has not been mirrored
into the templates yet — surface in `#ops` before deploying.

### 4.3 Confirm the multisig owner record

```bash
jq '{status, threshold, signatories: [.signatories[].address]}' \
  deployments/testnet-multisig-owner.json
```

Expected: `status: "verified"`, `threshold: 2`, and three SS58
signatory addresses. If you are joining as a new signatory, see
[`MULTISIG_SETUP.md`](./MULTISIG_SETUP.md) §2 to generate your key and
§4 to map it into the EVM-side owner.

### 4.4 Confirm the live signer address

The production backend signs with a KMS-derived EVM address, not a
raw private key (Phase 3 cutover 2026-05-16). To see which address
production is currently signing as:

```bash
node scripts/ops/derive-kms-signer-address.mjs
```

Expected: the same address that `TreasuryPolicy.verifiers` lists as
`true` on chain. If they diverge, the multisig
`setVerifier(address, true)` did not land — surface immediately, do
not deploy.

### 4.5 Confirm hosted health

```bash
./scripts/ops/check-hosted-stack.sh
```

Expected: green across the four public surfaces (`averray.com`,
`api.averray.com`, `index.averray.com`, `app.averray.com`). A red
result here is the day-1 thing to fix before any other work.

### 4.6 Confirm IAM Roles Anywhere is the active credential source

After the Phase 5a cutover (2026-05-21), the backend's KMS clients
authenticate via Roles Anywhere, not static IAM keys. Verify the
runtime credential resolution path from inside the running container:

```bash
sudo docker compose -f /srv/agent-stack/docker-compose.yml exec backend sh -c '
  /usr/local/bin/aws_signing_helper credential-process \
    --certificate /etc/agent-stack/roles-anywhere/jwt-signer-cert.pem \
    --private-key /etc/agent-stack/roles-anywhere/jwt-signer-key.pem \
    --trust-anchor-arn $(grep -oE "trust-anchor/[a-f0-9-]+" /root/.aws/config | tail -1 | xargs -I{} echo "arn:aws:rolesanywhere:eu-central-2:079209845430:{}") \
    --profile-arn $(grep -oE "rolesanywhere:[a-f0-9-]+:profile/[a-f0-9-]+" /root/.aws/config | tail -1 | xargs -I{} echo "arn:aws:{}") \
    --role-arn $(grep -oE "role/averray-jwt-signer-[a-z]+-role" /root/.aws/config | tail -1 | xargs -I{} echo "arn:aws:iam::079209845430:{}") \
    --region eu-central-2 2>&1 | head -c 80
'
```

Expected: the first ~80 chars start with `{"Version":1,"AccessKeyId":"ASIA...` —
the `ASIA` prefix proves it's a Roles Anywhere STS session (vs.
`AKIA` for static IAM users). Anything else means the credential
chain is broken; see [§6 recovery playbooks](#6-recovery-playbooks)
"Backend boot fails with jwt-kms-credential-check error".

### 4.7 Confirm the boot-time JWT KMS credential check is passing

```bash
sudo docker compose -f /srv/agent-stack/docker-compose.yml logs --since 10m backend 2>&1 \
  | grep -E "(jwt-kms-credential-check|bootstrap\.init_failed)"
```

Expected: a single `jwt-kms-credential-check.ok` JSON log line with
`keyUsage: "SIGN_VERIFY"`, `keySpec: "ECC_NIST_P256"`,
`signingAlgorithms: ["ECDSA_SHA_256"]`, and `durationMs` under ~5000.
No `bootstrap.init_failed` lines. If the container hasn't restarted
in the last 10 minutes, widen the `--since` window or trigger a
restart via the deploy workflow.

The boot check exercises the full Roles Anywhere → KMS path. If it
ever fails, see [§6 recovery playbooks](#6-recovery-playbooks).

## Operator key handling — 1Password-only pattern

This is the post-2026-05-25 rule. An admin EOA key was leaked into a session
transcript when a sub-agent's failed `sed` redaction echoed the key to bash
output. The replacement admin key lives at
`op://prod-critical/admin-eoa-testnet/private key`, and operator scripts must
not repeat the old shell pattern.

The rule is simple: ops scripts read keys via `op read` inside the process, or
through an in-process file loader when the backend's own env file is the
explicit input. Do not pass private keys through shell variables, temp files, or
redaction output. `mcp-server/.env.local` remains acceptable only as the
long-lived backend/local-ops boot file it already is; it is not the preferred
source for one-off operational scripts.

Canonical script shape:

- Accept `--env-file mcp-server/.env.local` when the script intentionally reads
  the same dotenv file as the backend/local runtime. Parse with `fs.readFileSync`
  inside Node, derive the address, print only the derived address, then keep the
  bytes inside an `ethers.Wallet`.
- Prefer `--signer-secret-ref 'op://vault/item/field'` for new ops scripts.
  The script itself should run `op read <ref>` via `spawnSync` or `execSync`,
  capture stdout in memory, validate it as a private key, and never echo it.
  `scripts/ops/redeploy-escrowcore.mjs` is the current production example.
- KMS-backed scripts such as `scripts/ops/fund-signer-usdc-deposit.mjs` still
  use the AWS SDK credential chain for KMS (`KMS_KEY_ID`, `AWS_REGION`, IAM
  credentials, or Roles Anywhere). That path signs in KMS and should not be
  replaced by a raw EOA key.

Current repo examples to copy:

| Pattern | Reference |
| --- | --- |
| In-process dotenv key read | `scripts/ops/rotate-admin-lib.mjs`, used by `scripts/ops/rotate-admin-drain.mjs` and `scripts/ops/rotate-admin-swap-env.mjs` |
| 1Password-direct signer secret | `scripts/ops/redeploy-escrowcore.mjs` (`--signer-secret-ref 'op://prod-critical/admin-eoa-testnet/private key'`) |
| KMS signer, no raw private key | `scripts/ops/fund-signer-usdc-deposit.mjs --use-kms` |

If older notes mention `scripts/ops/admin-topup-kms-signer.mjs`, treat that as
historical context from the branch that introduced the pattern; that filename is
not present on current `main`. The current-tree equivalent is the
`rotate-admin-lib.mjs` in-process loader plus the `redeploy-escrowcore.mjs`
1Password-direct loader.

Anti-patterns to avoid:

- `KEY=$(cat keyfile)` — the key can appear in process arguments, shell state,
  debug logs, or `ps` output.
- `sed s/=.*/=<redacted>/g` — redaction substitutions are easy to get wrong.
  The only safe pattern is to never echo the key.
- `PRIVATE_KEY=0x... node script.mjs` — the key lands in shell history and may
  be visible in process listings.
- Writing keys to temp files, even at mode `0600` — a crash between write and
  cleanup leaves a key on disk.

For `op read`-based scripts, fail closed when 1Password is not authenticated.
The operator-facing message should be:

```text
Please run 'eval $(op signin)' first
```

Do not print the 1Password error verbatim if it might include item names or
partial secret context. Print the instruction above, then exit non-zero.

## 5. Day-to-day duties

### 5.1 The deploy ritual

Every backend or frontend change reaches production through
`.github/workflows/deploy-production.yml`. Two trigger paths:

- **Auto** — `workflow_run` after CI completes successfully on `main`.
  This is the normal path. `PRODUCT_PROOF_REQUIRE_WORKER_LOOP=0`; no
  worker-loop is attempted.
- **Manual** — `workflow_dispatch` from the Actions UI. Honors the
  caller's `product_proof_require_worker_loop` input. Read
  [`PRODUCTION_CHECKLIST.md`](./PRODUCTION_CHECKLIST.md) §13 before
  setting that input to `1`; a misconfigured signer balance will fail
  the loop and leave the production lock unfree for the next caller.

After a deploy: confirm `./scripts/ops/check-hosted-stack.sh` is green
and the GitHub Actions summary contains a Hermes post-deploy
verification report.

### 5.2 The smoke ritual

```bash
./scripts/ops/check-hosted-stack-and-alert.sh
```

This is the production-side smoke check. If `ALERT_WEBHOOK_URL` is set,
the failure path delivers to that webhook. Schedule this on an external
cron so a hung deploy gets noticed within minutes, not hours. See
[`PRODUCTION_CHECKLIST.md`](./PRODUCTION_CHECKLIST.md) §5 for the
verification recipes that flip the §5 observability boxes.

### 5.3 The discovery manifest publish

The discovery manifest hash is anchored on-chain via
`DiscoveryRegistry.publish(hash)`. The
`.github/workflows/publish-discovery-manifest.yml` workflow runs after
every production deploy and publishes only if the served manifest hash
differs from the on-chain hash. To trigger manually:

```bash
gh workflow run publish-discovery-manifest.yml \
  -R averray-agent/agent --ref main
```

Expected: `published` or `already_current` in the job log. A failure
here is operationally noisy but not fund-affecting; investigate but do
not panic.

### 5.4 Hosted smoke auth

The hosted product-proof worker loop should use the same short-lived access
token pattern as browser SIWE sessions. Store a refresh cookie once at
`op://prod-smoke/admin-refresh-token/password`, then let
`scripts/ops/get-admin-refresh-token.mjs` exchange it for a fresh access token
via `POST /auth/refresh` at the start of each run.

The refresh route has strict replay semantics and rotates the refresh cookie on
every successful exchange. For scheduled smokes, the helper must write the
rotated cookie back to the same 1Password item; otherwise the next run will
reuse the old cookie and trigger `refresh_replay_detected`.

To seed the new path:

1. Sign in through the normal SIWE operator flow with the admin/verifier wallet.
2. Copy the `refresh_token` cookie value scoped to `/auth/refresh`.
3. Store it in 1Password:

```bash
op item edit admin-refresh-token --vault prod-smoke "password=$REFRESH_TOKEN"
unset REFRESH_TOKEN
```

4. Verify the helper can exchange and rotate it:

```bash
cd /path/to/agent
ADMIN_REFRESH_TOKEN_OP='op://prod-smoke/admin-refresh-token/password' \
  node scripts/ops/get-admin-refresh-token.mjs >/tmp/averray-admin-access.jwt
rm -f /tmp/averray-admin-access.jwt
```

Expected: the command exits `0`, prints one short-lived access JWT to stdout,
and updates `op://prod-smoke/admin-refresh-token/password` with the rotated
refresh cookie. The prod-smoke 1Password service account used by scheduled
smokes therefore needs read/write access to that one item. `--no-write-back` is
only for one-off diagnostics because it leaves the stored refresh cookie stale.

During the soak period, the legacy direct-JWT path remains available. Set
`ADMIN_JWT_OP` to force the old path, or leave the existing `ADMIN_JWT` env var
in place as a rollback fallback. When both `ADMIN_REFRESH_TOKEN_OP` and
`ADMIN_JWT` are present, the worker-loop script uses the refresh-flow path; when
`ADMIN_JWT_OP` is present, it uses the legacy path intentionally. If you want
the helper to use the default 1Password reference without spelling it out, set
`ADMIN_REFRESH_FLOW=1`.

The legacy path uses a 30-day ES256 admin token stored at
`op://prod-smoke/admin-jwt/password`. After Stage 2C-2 (`JWT_BACKEND=kms`),
HS256 tokens are refused — an expired or stale-format admin-JWT will surface as
`curl exit 22` / `HTTP 401` on smoke steps that still depend on `ADMIN_JWT`.
This direct-JWT path is retained for backward compatibility and should be
deprecated after the refresh path has soaked for 30 days.

To rotate (run from your laptop with `op` signed in):

```bash
cd /path/to/agent
export AWS_JWT_REGION=$(op read 'op://prod-backend/aws-jwt-signer-testnet/aws-region')
export AWS_JWT_KEY_ID=$(op read 'op://prod-backend/aws-jwt-signer-testnet/kms-key-id')
export AWS_JWT_ACCESS_KEY_ID=$(op read 'op://prod-backend/aws-jwt-signer-testnet/access-key-id')
export AWS_JWT_SECRET_ACCESS_KEY=$(op read 'op://prod-backend/aws-jwt-signer-testnet/secret-access-key')
export JWT_PUBLIC_KEY_PEM=$(op read 'op://prod-backend/aws-jwt-signer-testnet/public-key-pem')

NEW_JWT=$(node scripts/ops/mint-admin-jwt.mjs --profile testnet --roles admin --expires-in-days 30 --use-kms --quiet)

# Sanity check the new token is ES256 before writing
echo "$NEW_JWT" | awk -F. '{print $1}' | base64 --decode 2>/dev/null
# expect: {"alg":"ES256","typ":"averray-auth+jwt","kid":"jwt-1"}

# Write to 1Password — correct syntax is item-name + --vault flag,
# NOT the op:// URI as the item name (that silently no-ops).
op item edit admin-jwt --vault prod-smoke "password=$NEW_JWT"

# Round-trip verify
op read 'op://prod-smoke/admin-jwt/password' | awk -F. '{print $1}' | base64 --decode 2>/dev/null
# expect: same ES256 header as above

unset NEW_JWT AWS_JWT_REGION AWS_JWT_KEY_ID AWS_JWT_ACCESS_KEY_ID AWS_JWT_SECRET_ACCESS_KEY JWT_PUBLIC_KEY_PEM
```

The static AWS keys in the `export` block above are not used at
deploy time (those went away in Phase 5a Stage 2C-3) — they're
read here from 1Password purely as a local convenience for the
mint script's `--use-kms` mode. The script supports the SDK default
credential chain too if you have AWS profiles configured locally.

Schedule the rotation on a calendar reminder 25 days after each
rotation so you always have ≥5-day headroom before the smoke
starts 401-ing.

### 5.5 The audit-prep posture

External audit is not yet engaged. The audit-firm-facing scope docs are:

- [`AUDIT_PACKAGE.md`](./AUDIT_PACKAGE.md) — v1 contracts + off-chain
  attention points
- [`STRATEGY_ADAPTER_AUDIT_SCOPE.md`](./STRATEGY_ADAPTER_AUDIT_SCOPE.md)
  — separate engagement for the real strategy adapter when it ships

Both docs cite `<pkuriger@averray.com>` (primary) and `<ops@averray.com>`
(escalation) as the audit-firm contact addresses. When you take audit
ownership, confirm those addresses route to you and update if they do
not.

## 6. Recovery playbooks

These exist as separate documents; this section is just the routing
table.

| Scenario | Where to go |
|---|---|
| Pause needed (incident) | `INCIDENT_RESPONSE.md` §3 + `MULTISIG_SETUP.md` §7 |
| Pauser key compromise | `MULTISIG_SETUP.md` §7 (rotate pauser via multisig) |
| Owner-multisig signer lost | `MULTISIG_SETUP.md` §7 (3-of-3 multisig recovery) |
| Backup/restore drill | `BACKUP_RESTORE_DRILL.md` |
| `/content/:hash` 404 after Redis incident | `CONTENT_RECOVERY_RUNBOOK.md` |
| Async XCM request stuck pending | `ASYNC_XCM_STAGING.md` + `NATIVE_XCM_OBSERVER.md` |
| Signer USDC empty (manual deploy fails) | `PRODUCTION_CHECKLIST.md` §13 + `TESTNET_FUND_SIGNER.md` |
| Discovery manifest publish stale | `.github/workflows/publish-discovery-manifest.yml` (manual dispatch) |
| `/health` 502 immediately after a deploy | See "Backend boot failure (`bootstrap.init_failed`)" below |
| Backend boot failure (`bootstrap.init_failed`) | See "Backend boot failure" runbook below |
| Roles Anywhere cert approaching expiry | `PHASE_5A_IAM_ROLES_ANYWHERE_PLAN.md` §"Cert TTL: 90 days, rotated on calendar" |
| Smoke `Checking admin async XCM status` 401 | §5.4 above — rotate `op://prod-smoke/admin-jwt/password` via `mint-admin-jwt.mjs --use-kms` |

### Backend boot failure (`bootstrap.init_failed`)

When the backend container crash-loops at boot, look at the JSON log
line with `msg: "bootstrap.init_failed"`. The `err.name` and the
classifier in `mcp-server/src/auth/credential-check.js` name the
specific failure mode:

| `err.message` contains | Likely cause | Fix |
|---|---|---|
| `credential chain failed to resolve` / `CredentialsProviderError` | Roles Anywhere unreachable from inside the container (mount missing, cert path wrong, `aws_signing_helper` removed, AWS sts/kms endpoints blocked) | Run §4.6's `aws_signing_helper credential-process` from inside the container. If THAT fails too, check `/etc/agent-stack/aws-config` references against `PHASE_5A_IAM_ROLES_ANYWHERE_PLAN.md` §5.3, and `/etc/agent-stack/roles-anywhere/*.pem` against `ls -la` (must be `-r--------` root, sizes ~1.9KB / 3.2KB). |
| `lacks kms:GetPublicKey` | Role policy regressed from the canonical `deploy/iam-policies/averray-jwt-signer-prod-role.json` shape | Re-apply the canonical policy via `aws iam put-role-policy` against the JWT signer role. |
| `is disabled` | The JWT KMS key was disabled in AWS (UI / CLI accident) | `aws kms enable-key --key-id <AWS_JWT_KEY_ID>` from a privileged operator session. |
| `not found by AWS` | `AWS_JWT_KEY_ID` env var points at a deleted key, retargeted alias, or wrong region | Verify against `op item get aws-jwt-signer-testnet --vault prod-backend --fields kms-key-id` and the active `AWS_JWT_REGION`. |
| `does not support ECDSA_SHA_256` | `AWS_JWT_KEY_ID` accidentally points at the blockchain (secp256k1) signer key, an RSA key, or other wrong spec | Confirm `AWS_JWT_KEY_ID` resolves to the **ECC_NIST_P256** key, not the **ECC_SECG_P256K1** blockchain key. |

**Emergency bypass** when the platform must be available NOW and the
correct fix needs more diagnostic time: set `JWT_KMS_CREDENTIAL_CHECK_SKIP: "1"`
in `/srv/agent-stack/docker-compose.yml`'s backend `environment:`
block and restart the backend. The boot check is bypassed; the actual
JWT signing path is unaffected — if Roles Anywhere is genuinely working
at runtime, `/health` returns 200 and you have time to diagnose. Always
remove the skip flag once the underlying issue is fixed; do not ship a
PR that defaults it on.

## 7. What is intentionally out of your hands

These things you should NOT do solo as an operator, even if you have
the access:

- **Mainnet contract deploy.** The contract suite is currently testnet-only.
  Mainnet deploy requires external audit sign-off
  ([`AUDIT_PACKAGE.md`](./AUDIT_PACKAGE.md) §9 deliverable) AND a
  rehearsed multisig rehearsal of [`MULTISIG_SETUP.md`](./MULTISIG_SETUP.md) §5
  end-to-end.
- **Owner-multisig threshold change.** `TreasuryPolicy.owner` is a
  2-of-3 multisig per [`MULTISIG_SETUP.md`](./MULTISIG_SETUP.md) §1.
  Changing the threshold means a multi-day multisig coordination
  effort; do not propose it casually.
- **Direct on-chain mutation outside `EscrowCore` / `AgentAccountCore`
  flows.** The backend signer is KMS-backed for exactly this reason —
  bypass with a raw key only in a documented incident, never as a
  shortcut.
- **IAM Roles Anywhere trust anchors, profiles, or role trust
  policies.** Modifying any of these via the AWS console silently
  breaks the backend's credential chain — the next deploy crash-loops
  with `CredentialsProviderError`. Changes happen through the rehearsed
  flow in
  [`PHASE_5A_IAM_ROLES_ANYWHERE_PLAN.md`](./PHASE_5A_IAM_ROLES_ANYWHERE_PLAN.md)
  §4 (operator AWS setup) — including rotating the CA or re-issuing
  client certs. The `averray-signer-testnet-role` and
  `averray-jwt-signer-testnet-role` IAM role names are baked into
  `/etc/agent-stack/aws-config` and into
  `mcp-server/src/services/aws-credentials.js` `PROFILE_*` constants —
  renaming requires a coordinated code + VPS config + AWS change.
- **JWT KMS key policy or alias.** `AWS_JWT_KEY_ID` is a hard-coded
  full ARN (not an alias) precisely so the signer can't be silently
  re-targeted. Do not modify the key's policy or alias outside the
  rehearsed cutover in
  [`PHASE_4B_KMS_JWT_PLAN.md`](./PHASE_4B_KMS_JWT_PLAN.md). Disabling
  or scheduling deletion of this key takes the backend offline.
- **`deploy/iam-policies/averray-jwt-signer-prod-role.json` shape.**
  Specifically: keep `kms:Sign` (with the `ECDSA_SHA_256` /
  `DIGEST` condition keys) and `kms:GetPublicKey` as **separate**
  statements. Combining them implicitly denies GetPublicKey, which
  breaks both the runtime SPKI drift check and the boot-time
  credential check. The inline comments in the policy file explain
  why.

## 8. Signing off as a new operator

You are operationally ready when:

- [ ] You can resolve every 1Password reference your role requires
- [ ] You have run `./scripts/ops/check-hosted-stack.sh` against the live
  stack and seen a green result
- [ ] You have rehearsed pause + unpause from the pauser key (see
  [`MULTISIG_SETUP.md`](./MULTISIG_SETUP.md) §5)
- [ ] You have rehearsed at least one owner-only admin operation from
  your multisig signer (see [`MULTISIG_SETUP.md`](./MULTISIG_SETUP.md) §5)
- [ ] You have verified IAM Roles Anywhere returns `ASIA`-prefixed
  STS sessions from inside the backend container (§4.6)
- [ ] You have grepped the backend boot log and seen
  `jwt-kms-credential-check.ok` with the expected key metadata (§4.7)
- [ ] You have a calendar reminder set 25 days from the most recent
  `op://prod-smoke/admin-jwt` rotation, so the smoke admin-JWT never
  expires under you (§5.4)
- [ ] You are reachable at the operator alias
  (`ops@averray.com` per [`INCIDENT_RESPONSE.md`](./INCIDENT_RESPONSE.md) §1)
- [ ] You have read this document and the docs it cross-references at
  the top of §3

If any box stays unchecked, you do not have full operator readiness
yet. Reach out to the existing on-call before taking solo ownership of a
production-adjacent action.
