# Secrets inventory — Phase 2 mapping

This is the **authoritative mapping** from every secret-class variable used at
runtime to:

1. Where it lives in 1Password (`op://vault/item/field`)
2. Which 1Password service-account token is allowed to read it
3. Who owns rotation
4. Whether `scripts/ops/validate-env-render.sh` treats it as "critical-nonempty"
   (i.e., render is aborted if the value resolves to an empty string)

If you add a new secret to `deploy/backend.env.template` or
`deploy/indexer.env.template`, **also add a row here**. The structural CI check
(`scripts/ops/check-env-template-structure.mjs`) refuses to merge a PR that
references an `op://` path with no matching row in this file.

Non-secret config variables (RPC URLs, contract addresses, feature flags,
LOG_LEVEL, etc.) are intentionally **not** in this table. They live as
literals in the env templates and are managed via normal code review, not
via 1Password.

## Service-account tokens (recap)

These are minted in the 1Password admin UI and stored as items in the
`prod-critical` vault. Each token's vault scope is effectively immutable
post-creation — rotate by minting a new token, not by widening scope.

| Token (item name in `prod-critical`)    | Reads (whole-vault, read-only)                                  | Used by                                                  |
| --------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------- |
| `op-token-prod-ci-deploy`               | `prod-ci`, `prod-ci-external`                                   | GitHub Actions deploy workflow (PR 2.1+)                 |
| `op-token-prod-vps-backend`             | `prod-backend`, `prod-backend-external`                         | Backend VPS at deploy time (PR 2.3+)                     |
| `op-token-prod-vps-indexer`             | `prod-indexer`                                                  | Indexer VPS at deploy time (PR 2.3+)                     |
| `op-token-prod-smoke-tests`             | `prod-smoke`                                                    | Hosted product-proof smoke (PR 2.5+)                     |

**No token reads `prod-critical`.** Critical holds the service-account tokens
themselves plus the basic-auth raw password, Roles Anywhere CA private key,
and other human-only material. This is the firebreak: a leaked runtime token
cannot read its own replacement, cannot escalate.

## Backend runtime secrets

Read by the `op-token-prod-vps-backend` service-account token. Rendered into
`/run/agent-stack/backend.env` (tmpfs, mode 0400) by `op inject`.

| Env var               | `op://` path                                                          | Critical-nonempty | Rotation owner | Notes                                                                                                                                                            |
| --------------------- | --------------------------------------------------------------------- | :---------------: | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ~~`SIGNER_PRIVATE_KEY`~~  | ~~`op://prod-backend/signer-private-key/password`~~                       | n/a               | deployer       | **RETIRED 2026-05-16** in the Phase 3 cutover. Backend now signs via AWS KMS — see `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `KMS_KEY_ID` rows below + `SIGNER_BACKEND=kms` literal in `backend.env.template`. OP item retained for ~30 days as rollback target, then retired. Verifier on-chain authorization revoked 2026-05-17 (block ≈8,956,633) — the OP item is now safely deletable; even if leaked, signatures from the recovered address would be rejected by `TreasuryPolicy.verify()` because `verifiers[0xFd2EAE…6519] == false`. |
| `AUTH_JWT_SECRETS`    | `op://prod-backend/auth-jwt-secrets/password`                         | ✅ yes            | deployer       | HMAC for SIWE sessions. Comma-separated list, newest first, supports zero-downtime rotation. Migrates to asymmetric KMS-signed JWTs in Phase 4b.                |
| `RESEND_API_KEY`      | `op://prod-backend-external/resend-api-key/password`                  | ⚠️ no             | operator       | Optional branded self-report + alert email API key. Hermes/operator reporting is the launch proof channel. Rotate at https://resend.com/api-keys if enabled.     |
| `GITHUB_TOKEN`        | `op://prod-backend-external/github-pat-issue-ingestion/password`      | ⚠️ no             | deployer       | GitHub PAT for issue ingestion. **Currently lives in prod-ci-external** (from initial load); MUST be moved to prod-backend-external before PR 2.3 cutover. v3 plan requires this to be a fine-grained PAT scoped to one repo with Issues:Read only. |
| `AWS_ACCESS_KEY_ID`     | `op://prod-backend/aws-signer-testnet/access-key-id`        | ✅ yes            | deployer       | Phase 3 testnet path — active since 2026-05-16 cutover. Static IAM user `averray-signer-testnet` with KMS sign-only permissions on `arn:aws:kms:eu-central-2:079209845430:key/ff1927f1-3b5b-4e65-bec5-dfbe9fbff203`. Replace with Roles Anywhere temp credentials before mainnet (residual risk documented in `docs/SECRETS_MIGRATION.md` §3a). |
| `AWS_SECRET_ACCESS_KEY` | `op://prod-backend/aws-signer-testnet/secret-access-key`    | ✅ yes            | deployer       | Pair to `AWS_ACCESS_KEY_ID` above. Same OP item; rotate together via `aws iam create-access-key` + `aws iam delete-access-key`. Marked password-typed in 1Password (display masked). |
| `KMS_KEY_ID`            | `op://prod-backend/aws-signer-testnet/kms-key-id`           | ✅ yes            | deployer       | Full ARN of the KMS asymmetric key the `KmsSigner` (`mcp-server/src/blockchain/kms-signer.js`) calls. **Not a secret strictly** — ARNs are non-confidential — but stored in OP for centralized rotation. |
| `AWS_REGION`            | `op://prod-backend/aws-signer-testnet/aws-region`           | ✅ yes            | deployer       | Region the KMS key lives in (`eu-central-2` for testnet). Used by the AWS SDK's KMSClient. |
| `AWS_JWT_ACCESS_KEY_ID` | `op://prod-backend/aws-jwt-signer-testnet/access-key-id`    | ✅ yes            | deployer       | Phase 4b JWT signer (ES256) — IAM access key for the `averray-jwt-signer-testnet` user. Sign-only policy on the JWT KMS key (`<JWT_KEY_ID>` — distinct from the blockchain signer key on the AWS_ACCESS_KEY_ID row). Active under `JWT_BACKEND` ∈ {kms, both}; inert under `JWT_BACKEND=hmac`. Provisioned per `docs/SECRETS_MIGRATION.md` §"PR 4b.3 operator runbook". Critical-nonempty flipped ✅ in PR 4b.6 — every prod deploy now fails closed if this fails to render. |
| `AWS_JWT_SECRET_ACCESS_KEY` | `op://prod-backend/aws-jwt-signer-testnet/secret-access-key` | ✅ yes        | deployer       | Pair to `AWS_JWT_ACCESS_KEY_ID`. Same OP item; rotate together. |
| `AWS_JWT_REGION`        | `op://prod-backend/aws-jwt-signer-testnet/aws-region`       | ✅ yes            | deployer       | Region the JWT KMS key lives in (`eu-central-2` for testnet, matches the Phase 3 blockchain signer region for ops convenience; the KEYS themselves are distinct). |
| `AWS_JWT_KEY_ID`        | `op://prod-backend/aws-jwt-signer-testnet/kms-key-id`       | ✅ yes            | deployer       | **Full KMS key ARN, not alias.** Per `docs/PHASE_4B_KMS_JWT_PLAN.md` §3 — alias retargeting (`kms:UpdateAlias`) would allow a signer-substitution attack; ARN closes that vector. The alias `alias/averray-jwt-signer-testnet` exists only for human ops convenience. |
| `JWT_PUBLIC_KEY_PEM`    | `op://prod-backend/aws-jwt-signer-testnet/public-key-pem`   | ⚠️ no (deferred — multi-line PEM hotfix) | deployer | PEM-wrapped SPKI of the JWT KMS public key. Cached locally for verify — no per-request KMS call (`docs/PHASE_4B_KMS_JWT_PLAN.md` §4 option A). Drift-checked at boot (PR 4b.4+) and by `scripts/ops/verify-jwt-kms-signer.mjs` against `kms:GetPublicKey` for `AWS_JWT_KEY_ID`. **Currently commented out in `deploy/backend.env.template`** — docker-compose's `env_file` parser doesn't support multi-line values, so the raw PEM trips line-by-line VAR=VALUE parsing on the first base64 body line. Tracked as a follow-up: store a single-line base64-wrapped variant and decode at boot. Critical-nonempty stays ⚠️ no until the wrapper ships and the template line is re-uncommented. |
| `JWT_PUBLIC_KEY_FINGERPRINT` | `op://prod-backend/aws-jwt-signer-testnet/public-key-fingerprint` | ✅ yes  | deployer       | SHA-256 of the SPKI DER bytes (format: `sha256:<64-hex>`). Audit-trail anchor for detecting drift between the env-rendered `JWT_PUBLIC_KEY_PEM` and the actual KMS key. If this row's value differs from `shasum -a 256` of `aws kms get-public-key --key-id $AWS_JWT_KEY_ID --output text --query PublicKey \| base64 -d`, **the env is lying about what key signs your tokens** — fail-closed and re-provision per `docs/SECRETS_MIGRATION.md` §"PR 4b.3 operator runbook". |

## Indexer runtime secrets

Read by the `op-token-prod-vps-indexer` service-account token. Rendered into
`/run/agent-stack/indexer.env` (tmpfs, mode 0400) by `op inject`.

| Env var          | `op://` path                                  | Critical-nonempty | Rotation owner | Notes                                                                                                                |
| ---------------- | --------------------------------------------- | :---------------: | -------------- | -------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`   | `op://prod-indexer/database-url/password`     | ✅ yes            | deployer       | Postgres connection string for Ponder. DB user password embedded in URL. Rotate by changing Postgres password first. |

## CI-side secrets (GitHub Actions runtime)

Loaded by `1password/load-secrets-action` using the `op-token-prod-ci-deploy`
service-account token. These never touch the VPS env files — they're only
needed inside GitHub Actions runners.

| Env var                          | `op://` path                                                              | Used in PR | Notes                                                                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `VPS_SSH_KEY`                    | `op://prod-ci/vps-ssh-key/private key`                                    | 2.1        | ED25519 private key. The op item also stores host/user/port as fields. **Rotated 2026-05-12 during PR 2.1 acceptance** (legacy GH-secret value was lost when an intermediate step overwrote it; recovered by minting a fresh key and installing via password SSH). |
| `APP_BASIC_AUTH_USER`            | `op://prod-ci/app-basic-auth-hash/username`                               | 2.2        | Basic-auth username for Caddy on app.averray.com. Not strictly a secret but lives with the hash for atomic rotation.                  |
| `APP_BASIC_AUTH_PASSWORD_HASH`   | `op://prod-ci/app-basic-auth-hash/credential`                             | 2.2        | bcrypt hash injected into Caddyfile. **Raw password lives only in `op://prod-critical/app-basic-auth/password`** (human-only). Different bcrypt salt each generation, so this hash will NOT byte-match any other hash of the same password. Item created during PR 2.2 operator setup. |

## Smoke-test secrets

Loaded by `1password/load-secrets-action` using the `op-token-prod-smoke-tests`
token. This token reads ONLY `prod-smoke` — explicitly cannot read backend or
CI vaults (the firebreak).

| Env var       | `op://` path                                | Used in PR | Notes                                                                                                                                            |
| ------------- | ------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ADMIN_JWT`   | `op://prod-smoke/admin-jwt/password`      | 2.8        | Long-lived (30d) admin JWT for hosted product-proof smoke. TRANSITIONAL — replaced by short-lived OIDC→KMS-signed JWTs in Phase 4b. PR 2.8a adds parity-check load (non-blocking); PR 2.8b flips active source and deletes legacy `${{ secrets.ADMIN_JWT }}`. |

## Items in 1Password NOT loaded into any runtime template

These exist in 1Password for human use, audit, or future phases. They are
not consumed by any current render flow and intentionally have no row above.

| Item                                     | Vault           | Purpose                                                                                                                                |
| ---------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `app-basic-auth` (raw password + user)   | `prod-critical` | Operator browser login to app.averray.com. RAW password — human-only. CI uses the HASH from prod-ci, not this raw value.               |
| `op-token-prod-ci-deploy`                | `prod-critical` | The CI service-account token itself.                                                                                                   |
| `op-token-prod-vps-backend`              | `prod-critical` | The backend VPS service-account token itself.                                                                                          |
| `op-token-prod-vps-indexer`              | `prod-critical` | The indexer VPS service-account token itself.                                                                                          |
| `op-token-prod-smoke-tests`              | `prod-critical` | The smoke service-account token itself.                                                                                                |

## Risk-accepted Dependabot alerts

"Risk-accepted" here means: the vulnerable code path exists in our `package-lock.json`, but our own source code does not reach the exploitable surface. Each alert below has been audited against the specific advisory text — not waived on a generic "we don't use it" basis. We are tracking these alerts as **dismissed-with-justification** rather than force-bumping past `ponder@0.16.6`'s hard pins (`drizzle-orm: 0.41.0` exact, `kysely: ^0.26.3`), because doing so would put ponder's own internal code on untested transitive versions with no newer stable ponder release to fall back to (`ponder@1.0.0` is a major-version rewrite). Each row's "Why not exploitable" is **specific to that alert's vulnerable surface**, and the Verification subsection below gives the exact greps a future auditor must re-run before assuming the assessment still holds.

| Alert # | Package       | Severity | Advisory                                                                       | Why not exploitable                                                                                                                                                                                                                                                                                                                                                                                       | Reviewed                | Re-evaluate when                                                                                                                                                  |
| ------- | ------------- | -------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #28     | `drizzle-orm` | high     | `drizzle-orm` < 0.45.2 — SQL injection via improperly escaped SQL identifiers. | The advisory requires user-controlled data to flow into a function that accepts an SQL **identifier** (e.g., `sql.identifier(userInput)` or `sql.raw(userInput)`). Our drizzle surface is exactly two files in `indexer/src/api/`: `xcm-outcome-publisher.ts` uses only the tagged `sql\`...\`` template with `${value}` interpolations (bound as parameters, not identifiers — table/column names are literal strings in the template), and `xcm-outcomes.ts` only uses the typed query builder helpers `and / asc / eq / gt / inArray / or` against `schema.xcmRequest.<column>` (static schema objects, not user-controllable strings). No call site passes user input to an identifier-accepting API. | 2026-05-16 by pkuriger | ponder publishes a stable >0.16.6 with newer drizzle/kysely pins, or our usage patterns change to include user-controlled SQL identifiers / kysely usage. |
| #25     | `kysely`      | high     | `kysely` >= 0.26.0, <= 0.28.11 — SQL injection via unsanitized JSON path keys. | The advisory requires user-controlled data to be passed as a **JSON path key** on kysely's query builder. We have **zero direct `kysely` imports** in our codebase (see Verification grep below) — kysely is only present transitively, used internally by ponder for its own table/migration management. Ponder's internal kysely calls do not accept end-user input as JSON path keys. We never instantiate a kysely `QueryBuilder` ourselves, so the vulnerable JSON-path API is unreachable from our source. | 2026-05-16 by pkuriger | ponder publishes a stable >0.16.6 with newer drizzle/kysely pins, or our usage patterns change to include user-controlled SQL identifiers / kysely usage. |
| #26     | `kysely`      | high     | `kysely` <= 0.28.13 — MySQL SQL injection via insufficient backslash escaping. | The advisory is **MySQL-specific** and requires using kysely with a MySQL dialect against user-controlled string values that exploit the backslash-escape gap. Our stack uses **Postgres only** (see `DATABASE_URL` row above — Postgres connection string for ponder), and we have no direct kysely imports anyway, so neither the MySQL dialect nor any user-input path through kysely is wired up. | 2026-05-16 by pkuriger | ponder publishes a stable >0.16.6 with newer drizzle/kysely pins, or our usage patterns change to include user-controlled SQL identifiers / kysely usage. |
| #52     | `kysely`      | high     | `kysely` >= 0.26.0, < 0.28.17 — JSON-path traversal via unsanitized path-leg metacharacters. | The advisory requires user-controlled data to be passed as a **JSON path leg** (the parts between `->`/`->>` operators) on kysely's query builder. Same surface analysis as #25: zero direct kysely imports in our code, so no call site of ours passes anything to a kysely JSON-path-leg API. Ponder's internal kysely usage is for its own static schema/migration plumbing and does not surface user input as path legs. | 2026-05-16 by pkuriger | ponder publishes a stable >0.16.6 with newer drizzle/kysely pins, or our usage patterns change to include user-controlled SQL identifiers / kysely usage. |

### Verification

Before assuming the per-alert assessment above still holds, a future auditor MUST re-run these two greps from the repo root and confirm the assertions:

```sh
# Assertion: zero direct kysely imports. Required result: NO matches (exit 1).
grep -rE "from ['\"]kysely" --include='*.ts' --include='*.tsx' --include='*.js' --include='*.mjs' . --exclude-dir=node_modules

# Assertion: drizzle-orm usage is bounded to indexer/src/api/xcm-outcome-publisher.ts
# (tagged sql template with parameter-bound ${value} interpolations only) and
# indexer/src/api/xcm-outcomes.ts (typed builder helpers against static schema.xcmRequest.<col>).
# Required action: audit any NEW files that appear here for unsafe identifier
# interpolation — specifically sql.identifier(userInput), sql.raw(userInput), or
# user-controlled strings appearing outside ${...} in a sql`` template.
grep -rE "from ['\"]drizzle-orm" --include='*.ts' --include='*.tsx' --include='*.js' --include='*.mjs' . --exclude-dir=node_modules
```

If either grep's result diverges from the above, **re-do the per-alert audit** before relying on the dismissals. The alerts themselves are dismissed via the GitHub Dependabot API with reason `tolerable_risk` and a link to this section.
