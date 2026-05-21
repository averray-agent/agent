# Phase 5a — IAM Roles Anywhere migration plan

Replace the four static IAM access keys the VPS holds today with
X.509-certificate-based 1-hour STS sessions issued by AWS IAM Roles
Anywhere. **No code changes required in the backend** — the AWS SDK's
default credential provider chain already resolves Roles Anywhere when
`~/.aws/config` carries a `credential_process` directive. This PR adds
the planning doc and the operator-driven runbook; the cutover itself
is operator work on AWS + the VPS.

Referenced as item 5a in
[`PHASE_4E_PLAN.md`](./PHASE_4E_PLAN.md#5--adjacent-mainnet-prep-work).

## 1. Current state — what we're replacing

The VPS today holds two pairs of static IAM access keys:

| 1Password ref | Env vars on VPS | Used by | Risk window |
|---|---|---|---|
| `op://prod-backend/aws-signer-testnet/{access-key-id,secret-access-key}` | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | `KmsSigner` (Phase 3) — calls `kms:Sign` on the **blockchain** key | Indefinite (until manual rotation) |
| `op://prod-backend/aws-jwt-signer-testnet/{access-key-id,secret-access-key}` | `AWS_JWT_ACCESS_KEY_ID`, `AWS_JWT_SECRET_ACCESS_KEY` | `KmsJwtSigner` (Phase 4b) — calls `kms:Sign` on the **JWT** key | Indefinite (until manual rotation) |

Both IAM users have **sign-only policies on a specific key + a
`SigningAlgorithm` condition key**, so the blast radius of either key
leak is bounded to "attacker can sign with that one KMS key until we
rotate." But the **persistence** of the credential is the problem
worth fixing: a static IAM key sitting on a Linux box rendered from
tmpfs at every reboot is, in practice, a credential that lives until
the next manual `aws iam delete-access-key`.

## 2. Target state — Roles Anywhere

IAM Roles Anywhere exchanges an X.509 client certificate for STS
session credentials. The VPS holds the cert + private key (rotatable
on whatever cadence we choose), runs `aws_signing_helper` once per
hour to fetch fresh STS credentials, and the AWS SDK transparently
uses those for `kms:Sign` calls.

### Why this is materially better

- **Bounded credential lifetime.** The STS session is 1 hour by
  default (configurable up to 12). If an attacker exfiltrates the
  session credentials from VPS memory, they expire within an hour.
  A leaked static IAM key persists for years.
- **No persistent secret in env.** The cert is on disk (1Password
  backed), but the credential the AWS SDK actually uses is generated
  fresh from cert+key at each request. There is no `AWS_*_ACCESS_KEY_*`
  env var on the VPS after cutover.
- **Per-request audit trail.** CloudTrail records show the
  `RolesAnywhere:CreateSession` call with the cert serial. A leaked
  static IAM key shows up as just another `kms:Sign` call.
- **Cleaner rotation.** Cert rotation is "issue a new cert, drop it
  in `/etc/agent-stack/`, restart docker." No IAM key creation, no
  `op item edit`, no 1Password sync.

### Why this matters for mainnet

The Phase 5 pre-flight checklist (per
[`SECRETS_MIGRATION.md`](./SECRETS_MIGRATION.md#phase-5--mainnet-cutover))
explicitly says:

> AWS access via Roles Anywhere (VPS) + OIDC (Actions); **no static
> IAM access keys** for the signer role

That's the bar. Static keys are acceptable testnet residual risk
(documented as such), not acceptable mainnet posture.

## 3. Architectural decisions

### Two trust anchors, not one

The existing two-KMS-key architecture (blockchain signer key in one
IAM role, JWT signer key in another) is intentional — key separation
enforces that a JWT signing compromise cannot sign on-chain
transactions and vice versa.

Roles Anywhere preserves this with separate trust anchors / profiles
/ roles:

- **Trust anchor A** → role `averray-signer-testnet` (existing role,
  sign-only on blockchain KMS key)
- **Trust anchor B** → role `averray-jwt-signer-testnet` (existing
  role, sign-only on JWT KMS key)

Each trust anchor points at the same CA, but two profiles let us
issue two distinct client certs — one per role — and the IAM trust
policy on each role only accepts the cert with the matching CN.

If we ever need to revoke just the JWT signer cert (e.g., suspected
JWT KMS key compromise), revoking cert B doesn't touch the
blockchain signing path.

### Self-signed CA, not AWS Private CA

AWS Private CA costs ~$400/month. For a single-VPS deployment with
two issued certs, that's wildly disproportionate.

**Use a self-signed CA**, register its public certificate as the
trust anchor's `sourceData`. The CA's private key lives in 1Password
(`op://prod-critical/roles-anywhere-ca/`) and is only touched when
issuing or rotating client certs — operator-driven, infrequent.

Roles Anywhere treats the trust anchor's CA as authoritative for
client-cert verification; it doesn't care whether the CA itself is
public-AWS-managed or self-signed.

### Cert TTL: 90 days, rotated on calendar

Long enough to avoid weekly operational churn, short enough that a
compromised cert has a bounded lifespan. Tracked in
`docs/SECRETS_CALENDAR.yml` as `aws-roles-anywhere-blockchain-cert`
and `aws-roles-anywhere-jwt-cert`.

### Static-key parallel-soak before retirement

Cutover happens in two phases:

1. **Dual-mode soak**: Roles Anywhere active on the VPS (via
   `credential_process`), static `AWS_*_ACCESS_KEY_*` env vars STILL
   present in the env file. AWS SDK's default chain prefers env vars
   over `credential_process`, so static keys still win — but we've
   proved the Roles Anywhere path can resolve.
2. **Cutover PR**: env-template PR comments out the static keys. SDK
   falls through to `credential_process`. Static IAM keys remain in
   1Password as rollback for the soak period.
3. **Retirement** (≥30d after cutover): delete the IAM static access
   keys from AWS (`aws iam delete-access-key`); delete the 1Password
   fields. CloudTrail confirms zero sign calls from the old static
   keys during the soak.

## 4. Operator runbook — AWS setup

**One-time work. Do in a controlled session, not under deploy pressure.**

### 4.1 Generate the CA

```bash
# On a local secure box, not on the VPS.
mkdir -p ~/averray-roles-anywhere && cd ~/averray-roles-anywhere

# CA private key (4096-bit RSA — Roles Anywhere supports RSA + ECDSA;
# stick with RSA for broadest tool compatibility).
openssl genrsa -out ca-key.pem 4096

# CA public certificate, 10-year validity (CA cert long-lived; client
# certs rotate every 90 days). Subject is informational — IAM Roles
# Anywhere matches on the cert's SerialNumber + CA chain, not the
# subject DN.
openssl req -x509 -new -nodes -key ca-key.pem -sha256 -days 3650 \
  -out ca-cert.pem \
  -subj "/C=CH/O=Averray/CN=averray-roles-anywhere-ca"

# Sanity check.
openssl x509 -in ca-cert.pem -text -noout | head -20
```

### 4.2 Store the CA in 1Password

```bash
op item create \
  --vault prod-critical \
  --category "Secure Note" \
  --title "roles-anywhere-ca" \
  "ca-private-key[file]=ca-key.pem" \
  "ca-public-cert[file]=ca-cert.pem"

# Shred local copies — the CA key only comes back to local disk when
# issuing new client certs.
shred -u ca-key.pem
```

The CA public cert (`ca-cert.pem`) does NOT need to be secret — it
becomes the trust anchor's `sourceData`. Keep it readable for the
next step.

### 4.3 Register trust anchors in AWS

```bash
# Two trust anchors, one per signer role. Both reference the same
# CA — the profile + role separation is what enforces blast-radius
# isolation.
aws rolesanywhere create-trust-anchor \
  --region eu-central-2 \
  --name "averray-signer-testnet-ta" \
  --source "sourceType=CERTIFICATE_BUNDLE,sourceData={x509CertificateData=$(cat ca-cert.pem)}" \
  --enabled

aws rolesanywhere create-trust-anchor \
  --region eu-central-2 \
  --name "averray-jwt-signer-testnet-ta" \
  --source "sourceType=CERTIFICATE_BUNDLE,sourceData={x509CertificateData=$(cat ca-cert.pem)}" \
  --enabled

# Save the returned trust-anchor ARNs — needed in step 4.5.
```

### 4.4 Update IAM role trust policies

Each existing IAM role (`averray-signer-testnet`,
`averray-jwt-signer-testnet`) needs its trust policy updated to allow
`rolesanywhere.amazonaws.com` to call `CreateSession`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "rolesanywhere.amazonaws.com" },
      "Action": [
        "sts:AssumeRole",
        "sts:TagSession",
        "sts:SetSourceIdentity"
      ],
      "Condition": {
        "StringEquals": {
          "aws:PrincipalTag/x509Subject/CN": "averray-signer-vps"
        }
      }
    }
  ]
}
```

Replace `averray-signer-vps` for the JWT role's trust policy with
`averray-jwt-signer-vps`. The `CN` condition is what binds each
trust anchor to its specific client cert — even though both anchors
share the CA, only the cert whose CN matches can assume the role.

Apply:
```bash
aws iam update-assume-role-policy \
  --role-name averray-signer-testnet \
  --policy-document file://signer-trust-policy.json

aws iam update-assume-role-policy \
  --role-name averray-jwt-signer-testnet \
  --policy-document file://jwt-signer-trust-policy.json
```

### 4.5 Create profiles

```bash
aws rolesanywhere create-profile \
  --region eu-central-2 \
  --name "averray-signer-testnet-profile" \
  --role-arns arn:aws:iam::079209845430:role/averray-signer-testnet \
  --enabled \
  --duration-seconds 3600

aws rolesanywhere create-profile \
  --region eu-central-2 \
  --name "averray-jwt-signer-testnet-profile" \
  --role-arns arn:aws:iam::079209845430:role/averray-jwt-signer-testnet \
  --enabled \
  --duration-seconds 3600

# Save the returned profile ARNs — needed for client config in §5.
```

### 4.6 Issue client certificates

```bash
# Restore CA private key locally (TEMPORARILY — shred after).
op read 'op://prod-critical/roles-anywhere-ca/ca-private-key' > ca-key.pem
chmod 0400 ca-key.pem

# Blockchain signer client cert, 90 days.
openssl genrsa -out signer-client-key.pem 4096
openssl req -new -key signer-client-key.pem -out signer-client.csr \
  -subj "/C=CH/O=Averray/CN=averray-signer-vps"
openssl x509 -req -in signer-client.csr -CA ca-cert.pem -CAkey ca-key.pem \
  -CAcreateserial -out signer-client-cert.pem -days 90 -sha256

# JWT signer client cert, 90 days.
openssl genrsa -out jwt-signer-client-key.pem 4096
openssl req -new -key jwt-signer-client-key.pem -out jwt-signer-client.csr \
  -subj "/C=CH/O=Averray/CN=averray-jwt-signer-vps"
openssl x509 -req -in jwt-signer-client.csr -CA ca-cert.pem -CAkey ca-key.pem \
  -CAcreateserial -out jwt-signer-client-cert.pem -days 90 -sha256

# Verify both certs chain to the CA.
openssl verify -CAfile ca-cert.pem signer-client-cert.pem
openssl verify -CAfile ca-cert.pem jwt-signer-client-cert.pem
# Expect: "OK" twice.

# Stash the client cert+key pairs in 1Password.
op item create \
  --vault prod-backend \
  --category "Secure Note" \
  --title "roles-anywhere-signer-cert" \
  "client-cert[file]=signer-client-cert.pem" \
  "client-key[file]=signer-client-key.pem"

op item create \
  --vault prod-backend \
  --category "Secure Note" \
  --title "roles-anywhere-jwt-signer-cert" \
  "client-cert[file]=jwt-signer-client-cert.pem" \
  "client-key[file]=jwt-signer-client-key.pem"

# Shred ALL local copies.
shred -u ca-key.pem ca.srl \
  signer-client-key.pem signer-client.csr signer-client-cert.pem \
  jwt-signer-client-key.pem jwt-signer-client.csr jwt-signer-client-cert.pem
```

## 5. Operator runbook — VPS setup

### 5.1 Install AWS Signing Helper

```bash
# On the VPS, as root.
curl -sSL https://rolesanywhere.amazonaws.com/releases/1.7.0/aws_signing_helper-linux-x86_64-1.7.0.tar.gz \
  -o /tmp/aws_signing_helper.tar.gz
echo "<SHA256-from-rolesanywhere.amazonaws.com/releases/1.7.0/SHA256SUMS>  /tmp/aws_signing_helper.tar.gz" | sha256sum -c
tar -xzf /tmp/aws_signing_helper.tar.gz -C /tmp
install -m 0755 /tmp/aws_signing_helper /usr/local/bin/aws_signing_helper
aws_signing_helper version
# Expect: aws_signing_helper version 1.7.0 (or whatever current).
```

### 5.2 Drop client cert + key

```bash
# Render the cert + key for each signer into /etc/agent-stack/ at
# mode 0400, owned by the same user the backend docker container
# runs as (check docker-compose for the user spec — typically root
# in the container, mapped to ubuntu on the host).
sudo mkdir -p /etc/agent-stack/roles-anywhere
sudo chmod 0700 /etc/agent-stack/roles-anywhere

# Blockchain signer.
sudo op read 'op://prod-backend/roles-anywhere-signer-cert/client-cert' \
  | sudo tee /etc/agent-stack/roles-anywhere/signer-cert.pem > /dev/null
sudo op read 'op://prod-backend/roles-anywhere-signer-cert/client-key' \
  | sudo tee /etc/agent-stack/roles-anywhere/signer-key.pem > /dev/null
sudo chmod 0400 /etc/agent-stack/roles-anywhere/signer-{cert,key}.pem

# JWT signer.
sudo op read 'op://prod-backend/roles-anywhere-jwt-signer-cert/client-cert' \
  | sudo tee /etc/agent-stack/roles-anywhere/jwt-signer-cert.pem > /dev/null
sudo op read 'op://prod-backend/roles-anywhere-jwt-signer-cert/client-key' \
  | sudo tee /etc/agent-stack/roles-anywhere/jwt-signer-key.pem > /dev/null
sudo chmod 0400 /etc/agent-stack/roles-anywhere/jwt-signer-{cert,key}.pem
```

### 5.3 Configure AWS profiles for `credential_process`

The backend Docker container needs an `~/.aws/config` that points at
`aws_signing_helper`. Mount a host-side config into the container.

Create `/etc/agent-stack/aws-config`:

```ini
[profile averray-signer]
credential_process = /usr/local/bin/aws_signing_helper credential-process \
  --certificate /etc/agent-stack/roles-anywhere/signer-cert.pem \
  --private-key /etc/agent-stack/roles-anywhere/signer-key.pem \
  --trust-anchor-arn arn:aws:rolesanywhere:eu-central-2:079209845430:trust-anchor/<TA-A-UUID> \
  --profile-arn arn:aws:rolesanywhere:eu-central-2:079209845430:profile/<PROFILE-A-UUID> \
  --role-arn arn:aws:iam::079209845430:role/averray-signer-testnet \
  --region eu-central-2

[profile averray-jwt-signer]
credential_process = /usr/local/bin/aws_signing_helper credential-process \
  --certificate /etc/agent-stack/roles-anywhere/jwt-signer-cert.pem \
  --private-key /etc/agent-stack/roles-anywhere/jwt-signer-key.pem \
  --trust-anchor-arn arn:aws:rolesanywhere:eu-central-2:079209845430:trust-anchor/<TA-B-UUID> \
  --profile-arn arn:aws:rolesanywhere:eu-central-2:079209845430:profile/<PROFILE-B-UUID> \
  --role-arn arn:aws:iam::079209845430:role/averray-jwt-signer-testnet \
  --region eu-central-2
```

Substitute the trust-anchor and profile UUIDs from §4.3 and §4.5.

### 5.4 Test from the host shell

```bash
# Should print a JSON blob with Version, AccessKeyId (starting with
# "ASIA" — STS prefix, distinct from "AKIA" static-key prefix),
# SecretAccessKey, SessionToken, and Expiration ~1h from now.
AWS_CONFIG_FILE=/etc/agent-stack/aws-config \
  AWS_PROFILE=averray-signer \
  aws sts get-caller-identity --region eu-central-2

AWS_CONFIG_FILE=/etc/agent-stack/aws-config \
  AWS_PROFILE=averray-jwt-signer \
  aws sts get-caller-identity --region eu-central-2

# Test KMS access end-to-end.
AWS_CONFIG_FILE=/etc/agent-stack/aws-config \
  AWS_PROFILE=averray-jwt-signer \
  aws kms describe-key \
  --key-id $(op read 'op://prod-backend/aws-jwt-signer-testnet/kms-key-id') \
  --region eu-central-2
# Expect: KeyMetadata with KeyUsage=SIGN_VERIFY and KeySpec=ECC_NIST_P256.
```

If both `sts get-caller-identity` calls return ASIA-prefixed credentials,
the Roles Anywhere path works. **At this point static IAM keys are
still in use** — we haven't told the backend to switch yet.

### 5.5 Mount into the backend container

**The "open implementation question" called out in v1 of this doc is
RESOLVED.** Both signers now accept an optional `credentialsProvider`
constructor option that the lazy KMSClient passes to its `credentials`
field when set. The plumbing lives in a single small helper:

- `mcp-server/src/services/aws-credentials.js` — exports
  `buildKmsCredentialsProvider({ profile })`. Reads
  `AWS_USE_ROLES_ANYWHERE` env var; returns `fromIni({ profile })` when
  the flag is `"true"`, returns `null` otherwise. Profile constants
  `PROFILE_BLOCKCHAIN_SIGNER` and `PROFILE_JWT_SIGNER` are exported and
  match the section names in `/etc/agent-stack/aws-config` (§5.3).
- `mcp-server/src/auth/jwt.js` `getKmsSigner` — builds the JWT-side
  provider and passes it to `KmsJwtSigner`.
- `mcp-server/src/blockchain/gateway.js` `createSigner` — builds the
  blockchain-side provider and passes it to `KmsSigner`.

Both `KmsJwtSigner` and `KmsSigner` constructors take the optional
`credentialsProvider` and pass it through to `new KMSClient({...})`
only when set. When unset (`AWS_USE_ROLES_ANYWHERE` not `"true"`), the
KMSClient gets no explicit credentials and falls through to the SDK's
default chain — preserving pre-5a behavior.

**Why a flag instead of always-on**: the backend hasn't been deployed
with the docker-compose mounts yet. The first deploy of this code
ships with the flag default-off, so it's a pure no-op. The operator
flips the flag and adds the mounts in a single controlled change.

#### Docker-compose mounts (operator step, on the VPS)

Edit `/srv/agent-stack/docker-compose.yml`, add to the backend service:

```yaml
services:
  agent-backend:
    volumes:
      - /etc/agent-stack/aws-config:/root/.aws/config:ro
      - /etc/agent-stack/roles-anywhere:/etc/agent-stack/roles-anywhere:ro
      - /usr/local/bin/aws_signing_helper:/usr/local/bin/aws_signing_helper:ro
    environment:
      AWS_USE_ROLES_ANYWHERE: "true"
      AWS_CONFIG_FILE: /root/.aws/config
```

Three read-only mounts:
- `aws-config` → `~/.aws/config` (SDK reads it via `AWS_CONFIG_FILE`)
- `roles-anywhere/` cert+key dir at the exact path referenced by
  `credential_process` directives in `aws-config`
- `aws_signing_helper` binary at the exact path referenced by
  `credential_process` directives

The `AWS_USE_ROLES_ANYWHERE=true` env activates the code path added
in this PR. The static `AWS_*_ACCESS_KEY_*` env vars remain in the
rendered `/run/agent-stack/backend.env` during the soak — both paths
are wired but only Roles Anywhere is reached because each signer's
KMSClient gets an explicit `credentials` field that wins over default
chain lookups.

## 6. Migration phases

### Phase 5a-prep (this PR)

- This planning doc.
- Boot-time credential validation in
  `mcp-server/src/auth/credential-check.js` (separate commit) — a
  `kms:DescribeKey` call against the JWT KMS key at backend boot, so a
  misconfigured credential chain fails the boot loudly rather than the
  first SIWE request.
- New 1Password inventory rows in `deploy/secrets-inventory.md` for
  the future client certs (status: deferred until 5a-cutover).

### Phase 5a-cutover-code (this PR's follow-up; ships the dispatcher wiring)

- Adds `mcp-server/src/services/aws-credentials.js` (the flag-gated
  `fromIni` provider builder).
- Both signers (`KmsJwtSigner`, `KmsSigner`) accept an optional
  `credentialsProvider` constructor option, lazy KMSClient passes it
  through to `new KMSClient({ credentials })` when non-null.
- Both signer factories (`getKmsSigner` in jwt.js, `createSigner` in
  gateway.js) call `buildKmsCredentialsProvider` to populate the option.
- Flag (`AWS_USE_ROLES_ANYWHERE`) default-off — zero runtime change at
  merge. Operator flips on the VPS post-deploy.

### Phase 5a-cutover-flip (operator-led, on the VPS)

After §4 (AWS) + §5 (VPS cert install + aws-config) + §5.5 (docker-
compose mounts) are all in place:

1. Set `AWS_USE_ROLES_ANYWHERE=true` in the rendered `/run/agent-stack/backend.env`.
   Either via a small env-template PR (preferred; tracked in git) or by
   adding the flag directly to the docker-compose `environment:` block
   so it's set at container start regardless of the env file.
2. Restart the backend container: `docker compose -f /srv/agent-stack/docker-compose.yml up -d --force-recreate agent-backend`.
3. Verify from inside the running container:
   ```bash
   sudo docker compose -f /srv/agent-stack/docker-compose.yml exec agent-backend \
     node -e "import('@aws-sdk/client-sts').then(({STSClient,GetCallerIdentityCommand})=>new STSClient({region:'eu-central-2',credentials:require('@aws-sdk/credential-provider-ini').fromIni({profile:'averray-jwt-signer'})}).send(new GetCallerIdentityCommand({}))).then(r=>console.log(r.Arn))"
   ```
   Expected `Arn`:
   `arn:aws:sts::079209845430:assumed-role/averray-jwt-signer-testnet-role/<session-id>`
   The `assumed-role` (not `user`) prefix is the proof Roles Anywhere
   is in use.
4. Watch the backend logs + CloudWatch metrics. SIWE should keep
   working (signs ES256 via Roles Anywhere now), and the backend's
   boot-time JWT-KMS credential validation (added in #444) should
   print `jwt-kms-credential-check.ok` with the same key metadata.

### Phase 5a-cutover-retire-static-env (Stage 2C-3, this PR)

After the cutover-flip has been clean for ≥ 24h:
- Remove the four `AWS_*_ACCESS_KEY_*` op:// refs from
  `deploy/backend.env.template`. (Removed rather than commented-out
  because `scripts/ops/check-env-template-structure.mjs` rejects
  commented `op://` substrings — `op inject` scans the whole file and
  fails any literal `op://` outside a valid `KEY=op://...` assignment.)
- Update `secrets-inventory.md` to strikethrough the four rows and mark
  them retired from the template; the 1Password items stay for now —
  IAM keys remain in AWS for rollback.

### Phase 5a-retire (≥30 days after 5a-cutover)

- `aws iam delete-access-key` for both static-keyed IAM users.
- `op item delete` the access-key / secret-access-key 1Password fields.
- Update `secrets-inventory.md` to mark the static-key rows as
  **deleted**.
- Update `docs/SECRETS_CALENDAR.yml` to drop the static-key rotation
  entries and add the cert rotation entries (90-day cadence).

## 7. Risks + mitigations

| Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|
| `aws_signing_helper` binary download is tampered | Low | High | Verify SHA256 against `rolesanywhere.amazonaws.com/releases/<v>/SHA256SUMS` before install (in §5.1). |
| CA private key compromised | Low | Catastrophic | CA key stored only in 1Password, shredded after each use, kept off the VPS entirely. |
| Client cert expires unnoticed → backend can't sign | Medium | Medium | 90-day rotation cadence tracked in `SECRETS_CALENDAR.yml`. Boot-time credential validation (this PR) surfaces "credentials expired" failures at next deploy / restart. |
| Operator botches AWS-side IAM trust policy → backend boots but `kms:Sign` fails | Low | Medium | Boot-time credential validation calls `kms:DescribeKey` which fails the boot loudly with a clear error. |
| AWS Roles Anywhere regional outage | Low | High | Same regional-outage failure mode as Phase 3/4b KMS itself. Mainnet posture should add multi-region trust anchors. |
| Profile-per-signer mounting clash inside container | Medium (open question §5.5) | Low | Resolved by `fromIni({ profile })` in code per signer. |

## 8. Decision points before execution

1. **Confirm Phase 5a-cutover timing**: only meaningful after
   Phase 4b Stage 2C-3 is at least 30 days old (i.e., HMAC retirement
   stable). Both cutovers are mainnet-prep, but doing them in series
   reduces concurrent-risk.
2. **CA storage decision**: 1Password `prod-critical` vault (recommended)
   vs hardware security module. For a testnet/early-mainnet posture,
   1Password is fine. Mainnet-scale should evaluate HSM.
3. **Cert rotation cadence**: 90 days assumed. Confirm against
   `SECRETS_CALENDAR.yml` rhythm — if everything else rotates quarterly,
   align here.
4. **Profile-per-signer pattern**: §5.5 recommends `fromIni({profile})`
   in code. Alternative: keep static keys *and* Roles Anywhere both
   wired and use SDK-level credential precedence. Recommend the
   simpler explicit-profile path.
5. **VPS access for operator during cutover**: the operator needs
   sudo on the VPS to drop the cert into `/etc/agent-stack/`. Confirm
   SSH access path (the fail2ban issue from yesterday should stay
   resolved; OVH console as fallback).

## 9. What this doc does NOT cover

- AWS Account-level hardening (consolidated billing, organizations,
  service control policies). Out of scope; that's its own Phase 5
  pre-flight item.
- GitHub Actions → AWS OIDC. The CI workflows that deploy to the VPS
  use SSH + service-account tokens, not AWS credentials directly. No
  CI-side AWS auth surface to migrate today. When CI starts calling
  AWS directly (e.g., for an artifact bucket), that uses OIDC, not
  Roles Anywhere — different mechanism, different doc.
- HSM-backed CA. The Phase 5a target is "remove static IAM keys from
  the VPS"; HSM-backed CA storage is a marginal additional
  improvement for mainnet-scale.

## 10. Recommended next actions

If you accept this plan:

1. **Today**: review + merge this doc PR.
2. **Operator (~2 hours over 1-2 days)**: complete §4 (AWS setup)
   in a focused session. Save trust-anchor + profile ARNs.
3. **Operator (~1 hour)**: complete §5 on the VPS during a low-traffic
   window. Validate with `aws sts get-caller-identity` from inside
   the backend container.
4. **Code PR (~30 min)**: ship the `fromIni({ profile })` change in
   both signer modules. Zero behavior change while static keys are
   still in env.
5. **Cutover PR (~30 min)**: comment out the four static-key op://
   refs in `backend.env.template`. Deploy. Validate `aws sts
   get-caller-identity` inside the container returns `assumed-role`,
   not `user`. Watch CloudTrail for `kms:Sign` calls under the
   assumed-role principal.
6. **+30 days**: retire static IAM keys per §6 Phase 5a-retire.

Total wall-clock: ~1 week from this doc landing to static-key-free
backend signing. Total static-key retirement timeline: ~6 weeks
(cutover + 30-day soak).
