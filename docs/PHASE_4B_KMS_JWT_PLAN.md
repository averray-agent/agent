# Phase 4b — Asymmetric KMS-Signed JWTs

**Status**: Design doc. No code changes in this PR — captures the full architecture and the 6-PR migration sequence so each subsequent PR has a single source of truth to reference.

**Scope**: Replace HMAC-signed (`HS256`) auth JWTs with AWS KMS-managed asymmetric signing (`ES256`). Backend signs via `kms:Sign`; verifies locally with the cached public key. A vault leak or backend-env leak no longer implies the attacker can mint admin JWTs — the same protection Phase 3 gave the on-chain signer, applied to the auth layer.

**Pre-reading**: `docs/SECRETS_MIGRATION.md` §"Phase 4 — Hardening" §4b, `docs/SECRETS_INTEGRATION_PLAN.md` §6d (existing rationale), `docs/SECRETS.md` §"AUTH_JWT_SECRETS" (current HMAC operator runbook).

---

## 1. Why we're doing this

Today, `AUTH_JWT_SECRETS` is an HMAC secret with three readers:

1. Stored in 1Password at `op://prod-backend/auth-jwt-secrets/password`
2. Rendered into `/run/agent-stack/backend.env` on the VPS at deploy time (tmpfs, mode 0400)
3. Loaded into the backend process at boot, used by `mcp-server/src/auth/jwt.js` to **both sign and verify** JWTs via `crypto.createHmac("sha256", secret)`

The symmetric model has one structural property that bites us in any compromise scenario:

> **Any principal that can verify a token can also forge one.**

Concretely:
- If a 1Password vault leaks (e.g., service-account token compromise) → attacker mints admin JWTs forever
- If a backend container is compromised and the env is exfiltrated → same outcome
- If a backup of the rendered env file leaks → same outcome
- If the secret leaks into a log line (despite our redaction) → same outcome

In Phase 3 we removed `SIGNER_PRIVATE_KEY` and moved on-chain signing to KMS — the key material now lives non-exportably inside AWS KMS. Phase 4b applies the same architectural fix to the auth layer:

> **Only a principal with `kms:Sign` permission on the JWT signing key can mint accepted tokens. Verification needs only the public key, which is — by definition — public.**

A vault leak by itself no longer breaks auth.

---

## 2. Algorithm choice — ES256

AWS KMS supports both `RSASSA_PKCS1_V1_5_SHA_256` (JWT `RS256`) and `ECDSA_SHA_256` on a P-256 EC key (JWT `ES256`). We're choosing **ES256** for the following reasons:

| Property | RS256 | **ES256 (chosen)** |
|---|---|---|
| Token size | ~256 byte signature | ~64 byte signature (4× smaller) |
| Verify speed | RSA (~10× slower than ECDSA) | Fast |
| JWT ecosystem support | Universal | Universal |
| KMS native fit | Exact (signature drops straight into JWS slot) | Needs DER→raw `r‖s` conversion |
| Key-rotation overhead | Identical (new key, new `kid`) | Identical |
| Where used in modern stacks | Older, still common | Modern default (Auth0, AWS Cognito, OAuth 2.1 examples) |

The "DER→raw" extra step is trivial and we already own most of the helpers (see §10).

**KMS key spec**: `ECC_NIST_P256` (this is the NIST P-256 curve, distinct from the `ECC_SECG_P256K1` curve we use for the blockchain signer — see §3).

---

## 3. KMS key provisioning

A new, **separate** KMS key, in the same AWS account as the Phase 3 blockchain signer key. Key separation enforces:

- IAM principals that sign JWTs cannot sign on-chain transactions, and vice versa
- A key compromise of one signer doesn't propagate to the other
- Independent rotation cadences
- Independent CloudWatch alarms (the blockchain key signs ~1 tx/hour; the JWT key signs ~1 tx/user-action, much higher baseline)

| Property | Value |
|---|---|
| AWS account | Same as Phase 3 (`079209845430`) |
| Region | `eu-central-2` (matches the blockchain signer key for proximity to ops) |
| Alias | `alias/averray-jwt-signer-testnet` |
| Key spec | `ECC_NIST_P256` |
| Key usage | `SIGN_VERIFY` |
| Multi-region | Single-region testnet; multi-region for mainnet (decision deferred per `SECRETS_INTEGRATION_PLAN.md` §10) |
| Origin | `AWS_KMS` (managed key material, non-exportable) |
| Deletion window | 30 days (standard) |

**IAM identity**: a new IAM user `averray-jwt-signer-testnet` with sign-only policy, mirroring the existing `averray-signer-testnet`. Static access keys for testnet (same residual-risk note as Phase 3 §3a); IAM Roles Anywhere for mainnet.

**IAM policy** (the new file `deploy/iam-policies/averray-jwt-signer-prod-role.json`):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowGetPublicKey",
      "Effect": "Allow",
      "Action": "kms:GetPublicKey",
      "Resource": "arn:aws:kms:eu-central-2:079209845430:key/<jwt-key-id>"
    },
    {
      "Sid": "AllowSignWithEcdsaSha256",
      "Effect": "Allow",
      "Action": "kms:Sign",
      "Resource": "arn:aws:kms:eu-central-2:079209845430:key/<jwt-key-id>",
      "Condition": {
        "StringEquals": {
          "kms:SigningAlgorithm": "ECDSA_SHA_256",
          "kms:MessageType": "DIGEST"
        }
      }
    },
    {
      "Sid": "DenyKeyMaterialEscape",
      "Effect": "Deny",
      "Action": [
        "kms:ScheduleKeyDeletion",
        "kms:DisableKey",
        "kms:PutKeyPolicy",
        "kms:CreateGrant",
        "kms:ReplicateKey",
        "kms:UpdatePrimaryRegion"
      ],
      "Resource": "*"
    }
  ]
}
```

**1Password layout**: a new item `aws-jwt-signer-testnet` in `prod-backend`, with fields:
- `access-key-id`
- `secret-access-key`
- `aws-region`
- `kms-key-id` (full ARN)

These get rendered into `backend.env` at deploy time as:
- `AWS_JWT_ACCESS_KEY_ID`
- `AWS_JWT_SECRET_ACCESS_KEY`
- `AWS_JWT_REGION`
- `AWS_JWT_KEY_ID`

(Distinct env var names from the blockchain signer's `AWS_ACCESS_KEY_ID` / etc. so the backend can use different credentials for each.)

---

## 4. Public key distribution

The public key is — by definition — public. We have three options for getting it to the backend's verify path:

| Option | Pros | Cons |
|---|---|---|
| **A. Render into env at deploy time** | Zero runtime dependency on KMS; survives full KMS outage for verify; deterministic per-deploy snapshot | Coupled to deploy cadence; key rotation requires a deploy |
| **B. Fetch from KMS at backend boot** | Single source of truth (KMS); rotation = restart, no deploy | Boot-time dependency on KMS availability |
| **C. Bundle in repo as static config** | Simplest of all | Public key in git history makes future rotation noisy |

**Choice: Option A (render into env at deploy time)**. Rationale:

- The public key changes only on key rotation (rare — see §8)
- A KMS outage shouldn't take down auth verification for already-issued tokens
- The deploy-time render fits cleanly into the existing `op inject` flow
- A rotation requires a deploy anyway (env templates, key references, etc.)

**Env var**: `JWT_PUBLIC_KEY_PEM` — PEM-formatted `SubjectPublicKeyInfo`. The render step pulls this from a new 1Password field `op://prod-backend/aws-jwt-signer-testnet/public-key-pem`, populated **once** at provisioning time (PR 4b.3) by running `aws kms get-public-key` and PEM-wrapping the SPKI bytes.

---

## 5. Signing flow

The backend's `mcp-server/src/auth/jwt.js` `signToken(payload, opts)` currently does:

```js
const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
const claims = base64UrlEncode(JSON.stringify({ ...payload, iat, exp, jti }));
const input  = `${header}.${claims}`;
const sig    = base64UrlEncode(createHmac("sha256", secret).update(input).digest());
return `${input}.${sig}`;
```

The KMS-signed equivalent in `mcp-server/src/auth/kms-jwt-signer.js`:

```js
import { createHash } from "node:crypto";
import { KMSClient, SignCommand } from "@aws-sdk/client-kms";
import { parseDerEcdsaSignature } from "../blockchain/spki.js"; // already exists

async function signTokenAsymmetric(payload, { kmsClient, keyId, kid, expiresInSeconds }) {
  const header = base64UrlEncode(JSON.stringify({ alg: "ES256", typ: "JWT", kid }));
  const now = Math.floor(Date.now() / 1000);
  const claims = base64UrlEncode(JSON.stringify({
    ...payload,
    iat: now,
    nbf: now,
    exp: now + expiresInSeconds,
    jti: randomUUID(),
  }));
  const input = `${header}.${claims}`;
  const digest = createHash("sha256").update(input).digest();
  const { Signature } = await kmsClient.send(new SignCommand({
    KeyId: keyId,
    Message: digest,
    MessageType: "DIGEST",
    SigningAlgorithm: "ECDSA_SHA_256",
  }));
  // KMS returns DER-encoded ECDSASigValue; convert to raw r‖s (32+32 bytes).
  const { r, s } = parseDerEcdsaSignature(new Uint8Array(Signature));
  const rawSig = Buffer.concat([Buffer.from(r), Buffer.from(s)]); // 64 bytes
  return `${input}.${base64UrlEncode(rawSig)}`;
}
```

Notes:
- We don't normalize low-s for JWT ES256 — RFC 7515 does not require it, and most verifiers accept both forms. (Unlike Ethereum's EIP-2 which we do enforce in `KmsSigner` for blockchain txs.)
- The `kid` claim allows multiple active keys during rotation. Initial value: `"jwt-1"`.
- The `iss`/`aud` claims become non-optional in this PR. Existing code emits them; we'll enforce.

---

## 6. Verification flow

Currently `verifyToken(token, { secrets })` does an HMAC comparison against each secret in the rotation list.

The KMS-verify path uses **standard ES256 verification with the cached public key** — no KMS API call per verify:

```js
import { createPublicKey, createVerify } from "node:crypto";

const publicKey = createPublicKey({
  key: process.env.JWT_PUBLIC_KEY_PEM,
  format: "pem",
});

function verifyTokenAsymmetric(token) {
  const [headerB64, claimsB64, sigB64] = token.split(".");
  const header = JSON.parse(base64UrlDecode(headerB64));
  if (header.alg !== "ES256" || header.typ !== "JWT") {
    throw new Error("invalid header");
  }
  const rawSig = base64UrlDecode(sigB64);
  if (rawSig.length !== 64) throw new Error("invalid signature length");
  // Convert raw r‖s back to DER for node crypto's verify().
  const derSig = jwsRawToDer(rawSig);
  const v = createVerify("SHA256");
  v.update(`${headerB64}.${claimsB64}`);
  if (!v.verify(publicKey, derSig)) throw new Error("signature mismatch");
  const claims = JSON.parse(base64UrlDecode(claimsB64));
  // existing iss/aud/exp/nbf checks stay
  return claims;
}
```

The `jwsRawToDer` helper is new in `mcp-server/src/auth/jws-ecdsa.js` — it's the inverse of the DER→raw conversion in the sign path. ~20 lines.

**Public key caching**: read `JWT_PUBLIC_KEY_PEM` once at module load. No per-request cost.

---

## 7. Migration sequence — 6 PRs

Each PR is small and reversible. We can pause at any boundary without leaving prod in a broken state.

### PR 4b.1 (this PR) — Design doc

Status: open as the proposal.

### PR 4b.2 — `KmsJwtSigner` adapter + tests

- New file: `mcp-server/src/auth/kms-jwt-signer.js` — implements `signTokenAsymmetric` and `verifyTokenAsymmetric`
- New file: `mcp-server/src/auth/jws-ecdsa.js` — DER↔raw helpers for ECDSA-Sig-Value
- New file: `mcp-server/src/auth/kms-jwt-signer.test.js` — exercises a fake KMS, asserts the produced JWT round-trips through `verifyTokenAsymmetric` and through `jose`/`jsonwebtoken` (cross-library verify, to ensure JWS conformance)
- **Not wired into the live auth path yet.** The existing `jwt.js` and `middleware.js` remain HMAC-only.

### PR 4b.3 — KMS key + IAM provisioning + verification script

Operator-side work, then a small code PR:

1. (Operator) Provision the `alias/averray-jwt-signer-testnet` KMS key. AWS CLI:
   ```
   aws kms create-key --key-spec ECC_NIST_P256 --key-usage SIGN_VERIFY \
     --description "Averray JWT signing key — Phase 4b"
   aws kms create-alias --alias-name alias/averray-jwt-signer-testnet \
     --target-key-id <new-key-id>
   ```
2. (Operator) Create `averray-jwt-signer-testnet` IAM user, attach the policy from `deploy/iam-policies/averray-jwt-signer-prod-role.json`.
3. (Operator) Create 1Password item `op://prod-backend/aws-jwt-signer-testnet` with the four credential fields **plus** `public-key-pem` (run `aws kms get-public-key` once, PEM-wrap, paste).
4. (Code) New file: `scripts/ops/verify-jwt-kms-signer.mjs` — analogous to `scripts/ops/verify-kms-signer.mjs`: GetPublicKey ✓, Sign with ECDSA_SHA_256 ✓, Sign with wrong algo denied by IAM condition ✓.
5. (Code) New env vars in `deploy/backend.env.template`: `AWS_JWT_ACCESS_KEY_ID`, `AWS_JWT_SECRET_ACCESS_KEY`, `AWS_JWT_REGION`, `AWS_JWT_KEY_ID`, `JWT_PUBLIC_KEY_PEM`, all referencing the new 1Password fields. Initially marked as not-yet-required by `validate-env-render.sh` (will become required in PR 4b.6).
6. Update `deploy/secrets-inventory.md` with the new rows.

After this PR, prod has KMS infrastructure but the backend code path is unchanged.

### PR 4b.4 — Backend dual-verify path + `JWT_BACKEND` flag

This is where the auth path gains awareness of the new algorithm — but the **default behavior is unchanged**.

- Refactor `mcp-server/src/auth/jwt.js` to dispatch on the `alg` header claim:
  - `alg === "HS256"` → existing HMAC path (unchanged)
  - `alg === "ES256"` → new asymmetric path
  - Anything else → reject
- Add a `JWT_BACKEND` env config: `hmac` (default), `kms`, or `both`.
  - `hmac`: sign HS256 only; verify HS256 only
  - `kms`: sign ES256 only; verify ES256 only
  - `both`: sign with the configured `JWT_PRIMARY_ALG` (default `hmac`); verify both algorithms during transition
- Update `mcp-server/src/auth/middleware.js`'s `verifyToken` call site to use the new dispatcher.
- New tests cover: same payload under both algorithms verifies correctly; an HS256 token is rejected by `kms`-only mode; an ES256 token is rejected by `hmac`-only mode; an `alg: none` attack is rejected unconditionally.

After this PR, prod is still HMAC-only by default, but the backend is **ready to verify ES256 tokens** as soon as we flip the flag.

### PR 4b.5 — Refresh-token mint endpoint + opaque-token storage

This is the second-largest implementation PR. It introduces the refresh flow that lets us drop the access-token TTL from 30 days to 15 min without making operators re-auth constantly.

- New file: `mcp-server/src/auth/refresh.js` — issues, validates, and rotates opaque refresh tokens.
- Refresh-token shape: 32 cryptographically-random bytes, base64url-encoded. Returned as a `Set-Cookie` (HttpOnly, Secure, SameSite=Strict, scoped to `api.averray.com`).
- Server-side storage: SHA-256 of the token + metadata (wallet, role, issuedAt, expiresAt, replacedBy) in the existing `stateStore` (Redis in prod, in-memory in tests).
- New endpoint: `POST /auth/refresh` — takes the refresh-token cookie + an expired-or-near-expiry access token, returns a fresh access token + a new refresh token (rotated).
- Replay detection: if the same refresh-token hash is presented after rotation, **revoke the entire chain** (set `replacedBy.revokedAt` for every descendant) and require the user to re-auth via SIWE.
- New tests: round-trip rotation, replay-revokes-the-chain, expired-refresh-token-rejected, cross-wallet-refresh-rejected.

After this PR, prod has the refresh endpoint but no client uses it yet — the existing 30-day admin JWT flow keeps working.

### PR 4b.6 — Prod cutover + HMAC retirement plan

The actual flip. Same caution as Phase 3's cutover.

1. Update operator runbook to mint ES256 admin JWTs via `scripts/ops/mint-admin-jwt.mjs --use-kms` (analogous to the funder script's `--use-kms` from PR #384).
2. Flip `JWT_BACKEND=both` in prod env. Backend now verifies both alg families.
3. Smoke-test: mint a new ES256 admin JWT via the KMS path, verify it works against `/auth/session`, `/jobs/preflight`, and the hosted product-proof worker-loop endpoint.
4. After 24-48h of stable operation under `both`: flip `JWT_BACKEND=kms`. Backend now refuses HS256 tokens.
5. Update `op://prod-smoke/admin-jwt` to a freshly-minted ES256 token (the worker-loop will start using it).
6. Document HMAC retirement in `docs/SECRETS_MIGRATION.md` Phase 4b status table.
7. After ~30 days under `kms`-only: delete `op://prod-backend/auth-jwt-secrets`. (HMAC verification code path stays for forensic decoding but no longer accepts tokens.)
8. Optionally, remove the `JWT_BACKEND=hmac` code path entirely in a follow-up PR.

---

## 8. Refresh token design

### Why opaque, not signed

A signed refresh token (JWT-shaped) has the same problem as our current HMAC access token: anyone who can verify it can forge it. By using opaque tokens stored as **hashes** server-side, even a database leak doesn't let an attacker mint new tokens — they'd need to find a hash collision (computationally infeasible for SHA-256).

### Rotation semantics

Every successful refresh issues a new access token AND a new refresh token. The old refresh token is marked `replacedBy: <new-hash>` in the state store but kept for a short replay-detection window (~5 minutes — long enough to catch a client that retried the refresh due to network failure).

### Replay detection

If the same refresh-token hash is presented twice (after it has been replaced), the entire chain (this token, its ancestors, its descendants) is **revoked**. The client must re-auth via SIWE.

This catches:
- Attackers who stole the refresh token and the legitimate client refreshing concurrently — both can't both succeed
- Bots replaying captured tokens

### Storage schema

In Redis under the existing `stateStore` namespace, key `auth:refresh:<hash>` with value `{ wallet, role, issuedAt, expiresAt, replacedBy, revokedAt? }`. TTL set on the Redis key matches `expiresAt` plus the replay-detection window.

### TTLs

| Token | TTL | Notes |
|---|---|---|
| Access (ES256 JWT) | 15 min | Down from 30 days HMAC |
| Refresh (opaque) | 30 days | Sliding — bumps `expiresAt` on every successful rotation |
| Revoked-chain marker | 7 days | Forensic window |

### Client UX

The operator app's existing fetch interceptor (`fetchWithAuth` or similar) needs an "on 401, hit `/auth/refresh`, retry once" wrapper. This is a small frontend change tracked as a follow-up to PR 4b.5; not required for the smoke-test worker-loop which can be updated to use `--use-kms`-minted long-lived tokens during the transition.

---

## 9. `ADMIN_JWT` migration strategy

The hosted product-proof smoke test (`scripts/ops/run-hosted-worker-loop.mjs`) currently uses a 30-day HMAC-signed JWT stored at `op://prod-smoke/admin-jwt/password`. We rotated it today (2026-05-17) when binding it to the new KMS-derived wallet `0x31ad…7ab7F`.

For Phase 4b, the smoke-test JWT has two options:

| Option | Description | Pick |
|---|---|---|
| **A.** Keep long-lived, switch to ES256 | Mint a 30-day ES256 JWT via `mint-admin-jwt.mjs --use-kms`, store in `op://prod-smoke/admin-jwt`. Single field change in PR 4b.6. | ✓ for testnet |
| **B.** Switch to refresh flow | The smoke test acquires a refresh token at first use, rotates on every run. | Mainnet-only |

Choosing **A for testnet, B for mainnet**. This isolates the smoke-test JWT lifecycle from the human-operator JWT lifecycle and keeps the testnet rotation cadence simple.

---

## 10. Reusable helpers

The Phase 3 KMS work shipped helpers we can lean on. The new code paths are smaller as a result.

| Helper | Location | Reuse for 4b |
|---|---|---|
| `parseDerEcdsaSignature(der)` | `mcp-server/src/blockchain/spki.js` | **Direct reuse** — KMS `Sign` returns DER for both secp256k1 and P-256; the parser is curve-agnostic |
| `addressFromUncompressedPoint(point)` | same | Not needed (no EVM address derivation for JWT keys) |
| `parseSecp256k1Spki(der)` | same | **Not** reusable — JWT keys use P-256, not secp256k1. We need a new P-256 SPKI parser (~50 lines, same structure with different OID + curve params). New file: `mcp-server/src/auth/p256-spki.js` |
| `normalizeSignatureS(s32)` | same | Not used for JWS (RFC 7515 doesn't require low-s) |
| KMS client + IAM policy template | `deploy/iam-policies/averray-signer-prod-role.json` | Template for the new JWT IAM policy |
| `verify-kms-signer.mjs` pre-flight | `scripts/ops/verify-kms-signer.mjs` | Template for `verify-jwt-kms-signer.mjs` |

The 4b implementation will be smaller than 3b's because most of the KMS plumbing is already paved.

---

## 11. Failure modes + mitigations

| Failure | Effect | Mitigation |
|---|---|---|
| KMS region outage | Cannot mint NEW tokens; can still verify existing ones (public key in env) | Multi-region KMS for mainnet; testnet accepts the outage window |
| JWT public key in env diverges from KMS reality | All ES256 tokens fail verification | Render script reads `JWT_PUBLIC_KEY_PEM` from same 1Password item used for `kms-key-id`; both updated atomically on rotation |
| AWS credentials for JWT signer leak | Attacker mints arbitrary ES256 tokens until revoked | Same as Phase 3: IAM policy is sign-only on one specific key + algorithm; alarm on >10× baseline sign volume; rotate IAM keys; pre-mainnet, IAM Roles Anywhere |
| KMS Sign API latency spike | Login flow slows | Cache the KMS client; expose a `siwe.signLatencyMs` metric; alarm at p99 > 500ms |
| Forgotten old HMAC tokens still valid during `JWT_BACKEND=both` | Some clients keep working with HMAC for longer than expected | Set short HMAC token TTL during transition (≤7 days); track issuance dates |
| Refresh-token cookie stolen via XSS | Attacker can refresh-mint indefinitely | HttpOnly, Secure, SameSite=Strict cookie; cookie scoped to `api.averray.com`; replay-detection invalidates the chain on first concurrent use |

---

## 12. Open questions

To decide before PR 4b.3 (key provisioning):

1. **Multi-region for mainnet** — same decision as Phase 3's signer key. Defer until the broader Phase 5 mainnet-cutover plan settles.
2. **CloudWatch alarm thresholds for the JWT key** — sign-volume baseline is hard to estimate pre-launch. Plan: enable basic alarms on creation, tune after 30 days of real traffic.
3. **Refresh-token cookie domain** — `api.averray.com` (backend only) vs `.averray.com` (frontend + backend). Picking the narrower scope unless a frontend integration requires the broader one.
4. **JWT `aud` value** — current HMAC code emits `aud: "averray-backend"`. Keep, or switch to the backend's `AUTH_DOMAIN`?
5. **Should ADMIN_JWT for testnet smoke move to refresh flow?** — Plan §9 says no for testnet (keep long-lived ES256). Defer mainnet decision.

---

## 13. Risks I want explicit feedback on

Things the design assumes that I'd be happiest to have someone push back on before we start writing code:

1. **ES256 raw `r‖s` format over DER** — RFC 7515 mandates raw, but I want to double-check nothing in our stack (or any client) expects DER. Tested empirically via cross-library verify in PR 4b.2.
2. **Public key in env vs KMS-fetched at boot** — chose env (§4 option A). If the team prefers boot-time fetch with a fail-open verify cache, swap to option B in PR 4b.3.
3. **Refresh-token storage in Redis (`stateStore`)** — we already depend on Redis being durable. If a Redis outage takes auth down, that's a known availability tradeoff. An alternative (Postgres-backed refresh storage) is harder to introduce post-launch.
4. **`JWT_BACKEND=both` for indefinite period** — once we get past PR 4b.6, the `both` mode is a transitional artifact. Plan §7 retires HMAC after 30 days; we should not let `both` be the permanent default.
5. **`alg: none` rejection** — explicit test in PR 4b.4. Pin the rejection at the dispatcher, not just at verify.

---

## 14. What this doc does NOT cover

- **Phase 4c, 4d, 4e** — handled by separate PRs / operator work.
- **Frontend integration of the refresh flow** — small follow-up to 4b.5, not part of 4b proper.
- **OIDC integration with external IdPs** — explicitly out of scope; the SIWE flow remains the only login path.
- **Service-token capability bundles** — these are short-lived HS256 tokens for the worker-loop and similar; they migrate as part of 4b.6 but their capability model is unchanged.
- **The mainnet decision tree for multi-region KMS / Roles Anywhere CA / hardware MFA** — that's Phase 5.

---

## 15. Acceptance criteria for Phase 4b complete

When all six PRs have landed and prod has been on `JWT_BACKEND=kms` for ≥30 days:

- [ ] No code path in `mcp-server/src/auth/**` accepts `alg=HS256` tokens
- [ ] No code path in the repo references `op://prod-backend/auth-jwt-secrets` (the HMAC secret is retired from 1Password)
- [ ] `scripts/ops/mint-admin-jwt.mjs` only mints ES256 tokens
- [ ] `op://prod-smoke/admin-jwt` contains an ES256 token signed by the KMS key
- [ ] The hosted product-proof worker-loop dispatch passes with the new ES256 admin JWT
- [ ] `docs/SECRETS_MIGRATION.md` Phase 4b status table marked ✅ complete
- [ ] CloudWatch shows sign-volume on the JWT key matching the expected per-user-action baseline (no anomalies)
- [ ] The refresh-flow client interceptor is live in the operator app (frontend follow-up — tracked separately)

When all the above are true, Phase 4b is closed.
