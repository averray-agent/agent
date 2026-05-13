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
| `SIGNER_PRIVATE_KEY`  | `op://prod-backend/signer-private-key/password`                       | ✅ yes            | deployer       | TRANSITIONAL. Removed in Phase 3 (KMS migration). The single highest-value runtime secret today.                                                                 |
| `AUTH_JWT_SECRETS`    | `op://prod-backend/auth-jwt-secrets/password`                         | ✅ yes            | deployer       | HMAC for SIWE sessions. Comma-separated list, newest first, supports zero-downtime rotation. Migrates to asymmetric KMS-signed JWTs in Phase 4b.                |
| `RESEND_API_KEY`      | `op://prod-backend-external/resend-api-key/password`                  | ⚠️ no             | operator       | Backend self-report + alert email API key. Rotate at https://resend.com/api-keys.                                                                                |
| `GITHUB_TOKEN`        | `op://prod-backend-external/github-pat-issue-ingestion/password`      | ⚠️ no             | deployer       | GitHub PAT for issue ingestion. **Currently lives in prod-ci-external** (from initial load); MUST be moved to prod-backend-external before PR 2.3 cutover. v3 plan requires this to be a fine-grained PAT scoped to one repo with Issues:Read only. |

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
| `ADMIN_JWT`   | `op://prod-smoke/admin-jwt/credential`      | 2.8        | Long-lived (30d) admin JWT for hosted product-proof smoke. TRANSITIONAL — replaced by short-lived OIDC→KMS-signed JWTs in Phase 4b. PR 2.8a adds parity-check load (non-blocking); PR 2.8b flips active source and deletes legacy `${{ secrets.ADMIN_JWT }}`. |

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
