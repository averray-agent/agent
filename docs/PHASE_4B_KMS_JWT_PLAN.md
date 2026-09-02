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

**Important nuance — what KMS does and does not solve.** KMS removes offline signing-key extraction, but it does not make the system credential-less. If an attacker steals the AWS JWT signer credentials from 1Password or from the rendered backend environment, they may still be able to mint ES256 JWTs by calling `kms:Sign` until those AWS credentials are revoked. This is still better than the HMAC model because:

- the KMS private key bytes are non-exportable
- signing activity is visible in AWS logs (CloudTrail + CloudWatch)
- revoking the signer credentials stops future signing
- the stolen material is not a permanent offline JWT-signing secret

So the accurate claim is:

> A vault or backend-env leak no longer gives the attacker permanent offline signing capability. It may still give temporary online signing capability if AWS signer credentials are included in the leak.

For mainnet, this is why static AWS access keys should be replaced with IAM Roles Anywhere (or another temporary-credential flow) before launch. Static keys in `backend.env` are documented residual risk for testnet only (see §13 risk #6).

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

**Implementation footgun: ES256 JWS signatures are not DER in the JWT.** RFC 7518 requires the JWS signature value to be exactly 64 octets: 32-byte big-endian R followed by 32-byte big-endian S. The DER↔raw helper must left-pad R and S to exactly 32 bytes and must strip DER sign-padding bytes where present. Tests in PR 4b.2 must include:

- R requiring left-padding
- S requiring left-padding
- R or S with high bit set in DER, causing a leading `0x00` sign byte
- a normal 64-byte round-trip
- malformed DER rejected
- raw signatures with length other than 64 bytes rejected
- negative ASN.1 INTEGER encodings rejected
- overlong R/S encodings rejected

The sample `Buffer.concat([Buffer.from(r), Buffer.from(s)])` in §5 is only safe if `parseDerEcdsaSignature()` returns fixed-width 32-byte values. This may require enhancements to the existing helper in `mcp-server/src/blockchain/spki.js` — it currently returns the raw bytes from DER which may be shorter (no leading zeros) or longer (with sign-padding byte). The new `jws-ecdsa.js` helper owns the JWS-spec-compliant fixed-width conversion.

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

**Key policy note**: the IAM deny block above is defense-in-depth for the signer principal, but it is **not a substitute** for a tight KMS key policy. The KMS key policy must also ensure the JWT signer principal cannot administer the key, create grants, change key policy, disable the key, schedule deletion, replicate the key, or retarget aliases. The signer principal should only be able to:

- `kms:Sign`
- `kms:GetPublicKey`

…on the one JWT signing key. It must **not** be able to:

- `kms:Verify` (unless explicitly needed; verify happens locally with the public key)
- `kms:CreateGrant`
- `kms:PutKeyPolicy`
- `kms:ScheduleKeyDeletion`
- `kms:DisableKey`
- `kms:ReplicateKey`
- `kms:UpdatePrimaryRegion`
- any operation on the blockchain signer key

**Use the full key ARN in `AWS_JWT_KEY_ID`, not the alias.** Aliases can be retargeted (`UpdateAlias`) to point at a different key — using ARN closes that signer-substitution attack vector. The alias is for human ops convenience only.

**1Password layout**: a new item `aws-jwt-signer-testnet` in `prod-backend`, with fields:
- `access-key-id`
- `secret-access-key`
- `aws-region`
- `kms-key-id` (full ARN — not alias)
- `public-key-pem` (populated once at provisioning, see §4)
- `public-key-fingerprint` (SHA-256 of the SPKI DER bytes, recorded in `deploy/secrets-inventory.md` for drift detection)

These get rendered into `backend.env` at deploy time as:
- `AWS_JWT_ACCESS_KEY_ID`
- `AWS_JWT_SECRET_ACCESS_KEY`
- `AWS_JWT_REGION`
- `AWS_JWT_KEY_ID` (full ARN)
- `JWT_PUBLIC_KEY_PEM`
- `JWT_PUBLIC_KEY_FINGERPRINT`

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

**Public-key consistency requirement (anti-drift).** `JWT_PUBLIC_KEY_PEM` must not be treated as an independent source of truth. At provisioning, on every backend boot, and during every signer verification script run, confirm:

1. `AWS_JWT_KEY_ID` resolves to the intended KMS key ARN (not an alias)
2. `aws kms get-public-key --key-id "$AWS_JWT_KEY_ID"` returns the same public key as `JWT_PUBLIC_KEY_PEM`
3. The SHA-256 fingerprint of the SPKI DER bytes matches `JWT_PUBLIC_KEY_FINGERPRINT` (also rendered into env) and matches the expected fingerprint recorded in `deploy/secrets-inventory.md`
4. The configured `kid` maps to that same fingerprint in the static key-ring allowlist

If the public key in 1Password diverges from KMS `GetPublicKey`, the verify script fails the deploy. If a backend boot detects divergence, it logs `auth.jwt.pubkey_mismatch` and refuses to start (fail-closed).

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
  const header = base64UrlEncode(JSON.stringify({ alg: "ES256", typ: "averray-auth+jwt", kid }));
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
- We don't normalize low-s for JWT ES256 — RFC 7515 does not require it, and most verifiers accept both forms. (Unlike Ethereum's EIP-2 which we do enforce in `KmsSigner` for blockchain txs.) See §11 for the malleability note: never derive identity from the raw JWT string; use `jti`.
- The `kid` claim allows multiple active keys during rotation. Initial value: `"jwt-1"`. **`kid` is only an index into a static in-memory allowlist** loaded from configuration — it must never be used to build a URL, file path, 1Password URI, SQL query, Redis key, or dynamic import path (RFC 8725 §3.4 / §3.5).
- The `iss`/`aud` claims become non-optional in this PR. Existing code emits them; we'll enforce.
- **Explicit `typ`** — using `averray-auth+jwt` (RFC 7515 §4.1.9 "Explicit Typing", reinforced by RFC 8725 §3.11) rather than generic `JWT`. Distinct typed signatures prevent token substitution between contexts. If we later mint other JWT-shaped objects (service capability tokens, password-reset tokens, audit tokens) they MUST use a different `typ`, different validation rules, and ideally a different signing key.

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
  // existing iss/aud/exp/nbf checks stay (see "Claims validation requirements" below)
  return claims;
}
```

The `jwsRawToDer` helper is new in `mcp-server/src/auth/jws-ecdsa.js` — it's the inverse of the DER→raw conversion in the sign path. ~20 lines.

**Public key caching**: read `JWT_PUBLIC_KEY_PEM` once at module load. No per-request cost.

### JOSE header validation requirements

The verifier MUST reject the token unless ALL of the following are true. RFC 8725 ("JSON Web Token Best Current Practices") is the standard reference for these rules:

- Token has exactly three compact-JWS segments (base64url + "." + base64url + "." + base64url)
- Protected header JSON parses successfully
- `alg` is exactly `"ES256"` in KMS mode (`"HS256"` in HMAC mode; both allowed in `both` mode but each verified against the corresponding key)
- `typ` is exactly `"averray-auth+jwt"` (no acceptance of generic `"JWT"`)
- `kid` is present, is a string, and exists in the local key-ring allowlist
- `kid` maps to a key configured for exactly one algorithm: ES256
- No unrecognized `crit` headers are present
- `jku`, `jwk`, `x5u`, `x5c` headers — attacker-controlled key-discovery primitives — are rejected unconditionally (RFC 8725 §3.4)
- `none`, mixed-case variants (`None`, `NONE`), and any algorithm outside the configured mode are rejected **before** any signature operation
- The signature operation uses ONLY the algorithm declared in the configured key-ring entry, NOT the algorithm declared in the JOSE header (defends against algorithm-confusion attacks)

The verifier MUST NEVER use `kid` to build a URL, file path, 1Password URI, SQL query, Redis key, or dynamic import path. `kid` is only an index into a static in-memory allowlist loaded from configuration.

### Claims validation requirements

Every accepted access token MUST validate:

- `iss` equals the configured issuer (e.g., `"averray-backend-testnet"`)
- `aud` equals the configured backend audience (see §12 — resolved to a stable logical name like `"averray-backend"`, NOT a domain)
- `typ` equals `"averray-auth+jwt"`
- `sub` is present, non-empty, and is the canonical wallet/user identifier (lowercased EVM address; canonicalize before authorization decisions)
- `role` is one of the allowed roles in `mcp-server/src/auth/config.js` enum
- `iat`, `nbf`, and `exp` are present and numeric
- `exp - iat <= ACCESS_TOKEN_MAX_TTL_SECONDS` (defense against an attacker convincing the signer to issue overly-long tokens)
- Clock skew is bounded: ±60 seconds for `nbf`/`exp` checks
- `jti` is present, is a UUIDv4-shaped string, and is unique enough for audit/revocation
- Any wallet/address claim is canonicalized (lowercase H160) before authorization decisions

Do NOT derive authorization solely from stale access-token claims during refresh. The refresh endpoint must look up the refresh-token record server-side and re-check the current wallet/role/account status before minting a new access token (see §8).

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
4. (Code) New file: `scripts/ops/verify-jwt-kms-signer.mjs` — analogous to `scripts/ops/verify-kms-signer.mjs`:
   - GetPublicKey ✓
   - Sign with ECDSA_SHA_256 ✓
   - Sign with wrong algo (e.g., `ECDSA_SHA_384`) denied by IAM condition ✓
   - **`JWT_PUBLIC_KEY_PEM` (from env) matches `kms:GetPublicKey` for `AWS_JWT_KEY_ID`** ✓ — drift detection
   - **`JWT_PUBLIC_KEY_FINGERPRINT` (from env) matches SHA-256 of the SPKI DER bytes** ✓
   - Script prints only the public-key fingerprint, never private key material or AWS credentials
5. (Code) New env vars in `deploy/backend.env.template`: `AWS_JWT_ACCESS_KEY_ID`, `AWS_JWT_SECRET_ACCESS_KEY`, `AWS_JWT_REGION`, `AWS_JWT_KEY_ID`, `JWT_PUBLIC_KEY_PEM`, `JWT_PUBLIC_KEY_FINGERPRINT`, all referencing the new 1Password fields. Initially marked as not-yet-required by `validate-env-render.sh` (will become required in PR 4b.6).
6. Update `deploy/secrets-inventory.md` with the new rows (including the public-key fingerprint as the audit-trail anchor for drift detection).

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

A self-contained refresh token (JWT-shaped) is the wrong primitive here because refresh-token security depends on **server-side revocation, rotation, replay detection, and chain invalidation**. A signed asymmetric refresh JWT would not have the HMAC "verifier can forge" problem, but it would still push us toward offline validation and make replay-chain revocation harder than necessary — every node would need to consult the server-side state anyway, so the JWT's offline-verify property is wasted.

So the design uses opaque refresh tokens:
- The client stores only an unguessable random token
- The server stores only a SHA-256 hash of that token plus metadata
- Every refresh rotates the token
- Replay of an already-rotated token revokes the active chain (RFC 9700 model)

Even a database leak doesn't let an attacker mint new tokens — they'd need to find a hash collision (computationally infeasible for SHA-256).

### Rotation semantics

Every successful refresh issues a new access token AND a new refresh token. The old refresh token is marked `replacedBy: <new-hash>` in the state store and **retained only for replay detection, NOT for another successful refresh**.

### Replay behavior — strict, not lenient

If the same refresh-token hash is presented twice (after it has been replaced), the entire chain (this token, its ancestors, its descendants) is **revoked**. The client must re-auth via SIWE.

This catches:
- Attackers who stole the refresh token and the legitimate client refreshing concurrently — both can't both succeed
- Bots replaying captured tokens

**We intentionally choose strict replay handling over retry idempotency.** If the client retries a refresh request after the server rotated the token but before the client received the response, the retry will look like replay and will revoke the chain:

- First valid refresh succeeds and rotates the token
- Any later use of the old token is treated as replay
- The token family is revoked
- The user/operator must re-auth via SIWE

This may cause rare forced re-authentication during network failures, but it preserves the strongest theft-detection semantics. RFC 9700 §4.12.2 endorses this model: reuse of an invalidated refresh token is the signal that triggers revocation of the active grant.

### Refresh endpoint trust rule

The refresh token is the credential for refresh. The expired-or-near-expiry access token is **optional context only** and MUST NOT influence the new access token's claims.

`POST /auth/refresh` MUST:
- Verify the refresh-token cookie against the server-side hash record
- Derive wallet, role, chain, and expiry from the **refresh-token record**, not from the expired access token
- Re-check current account/operator status (role still active? wallet not revoked?) before minting a new access token
- If an access token is provided, verify its signature and use it only as a consistency check (e.g., reject if its `sub` differs from the refresh-token record's `sub`)
- Reject cross-wallet or cross-role mismatches

This prevents a stale or malicious access token from influencing the new access token.

### Storage schema

In Redis under the existing `stateStore` namespace, key `auth:refresh:<hash>` with value `{ wallet, role, issuedAt, expiresAt, replacedBy, revokedAt? }`. TTL set on the Redis key matches `expiresAt` plus the replay-detection window.

**Refresh-token hashing**: a plain SHA-256 hash of a 32-byte random refresh token is acceptable because the token has high entropy and is not human-memorable. For defense-in-depth, we MAY use HMAC-SHA-256 with a server-side `REFRESH_TOKEN_PEPPER` (also a KMS-derived value), but this is not required for brute-force resistance if token generation is correct. Requirements regardless:

- Refresh tokens are generated with CSPRNG only (`crypto.randomBytes(32)`)
- At least 32 random bytes before base64url encoding
- Compare hashes in constant time (`crypto.timingSafeEqual`)
- Never log raw refresh tokens
- Never store raw refresh tokens server-side
- Never return raw refresh tokens in a response body — `Set-Cookie` only

### Cookie / CORS / CSRF requirements

The refresh-token cookie MUST be a **host-only** cookie for `api.averray.com`. Do NOT set `Domain=.averray.com` unless a later frontend integration proves the broader domain is necessary. (Decided in §12.)

Required cookie attributes:

```
HttpOnly
Secure
SameSite=Strict
Path=/auth/refresh
```

Because the refresh endpoint is cookie-authenticated, it MUST also enforce:

- HTTPS only (Caddy terminates TLS; backend rejects non-TLS)
- Strict `CORS_ALLOWED_ORIGINS` allowlist (no wildcards)
- `Origin` and `Host` header validation (reject if `Origin` is not in the allowlist; reject if `Host` ≠ `api.averray.com`)
- No token values in logs
- No refresh token in query string, response body, or `localStorage`

Note that `SameSite=Strict` already blocks cross-site requests, but `app.averray.com` ↔ `api.averray.com` are same-site but cross-origin. Explicit `Origin` validation is required.

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

**Mainnet guardrail (prohibition).** Long-lived ES256 `ADMIN_JWT` is acceptable for **testnet smoke only**. Mainnet MUST NOT rely on a 30-day admin access token. Mainnet smoke MUST use the refresh flow or a purpose-scoped service-token flow with a shorter access-token TTL.

Acceptance criterion before mainnet:
- No 30-day mainnet admin access JWT exists in 1Password
- Smoke/admin automation uses refresh or purpose-scoped capability tokens
- Any stored automation token is scoped to the smallest required endpoint set

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

**ECDSA helper acceptance tests.** `parseDerEcdsaSignature()` and `jwsRawToDer()` must prove (in `kms-jwt-signer.test.js` and `jws-ecdsa.test.js`):

- DER from KMS converts to exactly 64-byte JWS raw format
- Raw 64-byte JWS signature converts back to DER accepted by Node `crypto.verify`
- R/S values with leading zeroes are left-padded to 32 bytes
- DER sign-padding byte `0x00` (when R/S high bit is set) is stripped correctly
- Malformed DER is rejected
- Negative ASN.1 INTEGER encodings are rejected
- Overlong R/S encodings (>32 bytes after sign-padding stripping) are rejected
- Round-trip verifies with `jose` (npm package, dev-only test dependency)
- Round-trip verifies with `jsonwebtoken` (npm package, dev-only test dependency)

The last two tests are the **cross-library validation** — proving any compliant JWS verifier will accept our tokens, not just our own verify path.

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
| KMS signer credentials leak (separate from key material) | Attacker can mint tokens online until credentials are revoked | CloudWatch alarm on sign volume / source IP; revoke credentials; rotate to new credentials; inspect issued-token window via `jti` audit log. Mainnet: replace static keys with IAM Roles Anywhere |
| `kid` points to wrong key (e.g., attacker-supplied header) | Token signed by unintended key is accepted | Static `kid → public key → alg → issuer` allowlist; reject unknown `kid`; never use `kid` as a dynamic lookup primitive |
| 1Password public key diverges from KMS public key | ES256 tokens fail, OR (worse) wrong key is trusted if config is tampered with | `verify-jwt-kms-signer.mjs` compares `JWT_PUBLIC_KEY_PEM` to `kms:GetPublicKey` fingerprint; backend refuses to start on mismatch (§4) |
| Refresh-token replay caused by network retry | Legitimate user forced to re-auth | Documented as accepted UX cost (§8); strict semantics chosen over idempotent retry |
| Redis data loss | All refresh sessions lost; users/operators must re-auth | Accept as fail-closed; document Redis durability/backups if smoother UX becomes required |
| Access-token role becomes stale (operator revoked) | Revoked operator keeps role until access-token expiry | 15-minute TTL bounds the staleness; refresh re-checks current role server-side before minting new token |
| ECDSA signature malleability | Same claims may have more than one valid signature encoding | Do NOT use raw JWT string as identity; use verified `jti` for replay/dedup; optionally reject high-S signatures if compatible with libraries (defer — most clients don't normalize) |

---

## 12. Open questions

### Deferred

1. **Multi-region for mainnet** — same decision as Phase 3's signer key. Defer until the broader Phase 5 mainnet-cutover plan settles.
2. **CloudWatch alarm thresholds for the JWT key** — sign-volume baseline is hard to estimate pre-launch. Plan: enable basic alarms on creation, tune after 30 days of real traffic.

### Resolved

3. **Refresh-token cookie domain → host-only `api.averray.com`**. Cookie attributes: `HttpOnly; Secure; SameSite=Strict; Path=/auth/refresh`. Do not set `Domain=.averray.com` unless a later frontend integration proves the broader scope is necessary.
4. **JWT `aud` → stable logical value `"averray-backend"`**, NOT tied to a mutable domain name. Domains can change; the security boundary is the backend/API service identity, not the DNS label. If future services need their own tokens, give them distinct `aud` values (`"averray-indexer"`, `"averray-smoke"`, etc.).
5. **ADMIN_JWT testnet posture → long-lived ES256 (no refresh flow)**, per §9. Mainnet must use refresh flow or purpose-scoped capability tokens — long-lived admin JWTs prohibited on mainnet.

---

## 13. Risks I want explicit feedback on

Things the design assumes that I'd be happiest to have someone push back on before we start writing code:

1. **ES256 raw `r‖s` format over DER** — RFC 7515 mandates raw, but I want to double-check nothing in our stack (or any client) expects DER. Tested empirically via cross-library verify in PR 4b.2.
2. **Public key in env vs KMS-fetched at boot** — chose env (§4 option A). If the team prefers boot-time fetch with a fail-open verify cache, swap to option B in PR 4b.3.
3. **Refresh-token storage in Redis (`stateStore`)** — we already depend on Redis being durable. If a Redis outage takes auth down, that's a known availability tradeoff. An alternative (Postgres-backed refresh storage) is harder to introduce post-launch.
4. **`JWT_BACKEND=both` for indefinite period** — once we get past PR 4b.6, the `both` mode is a transitional artifact. Plan §7 retires HMAC after 30 days; we should not let `both` be the permanent default.
5. **`alg: none` rejection** — explicit test in PR 4b.4. Pin the rejection at the dispatcher, not just at verify.
6. **Signer credentials still live in runtime env during testnet** — KMS protects the private key material from extraction, but static AWS signer credentials in `backend.env` can still call `kms:Sign` if leaked. This is acceptable as documented residual risk for testnet. For mainnet, replace static keys with IAM Roles Anywhere (or another temporary-credential mechanism), with the migration completed before mainnet cutover (Phase 5 dependency).

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

**Migration milestones**:
- [ ] No code path in `mcp-server/src/auth/**` accepts `alg=HS256` tokens
- [ ] No code path in the repo references `op://prod-backend/auth-jwt-secrets` (the HMAC secret is retired from 1Password)
- [ ] `scripts/ops/mint-admin-jwt.mjs` only mints ES256 tokens
- [ ] `op://prod-smoke/admin-jwt` contains an ES256 token signed by the KMS key
- [ ] The hosted product-proof worker-loop dispatch passes with the new ES256 admin JWT
- [ ] `docs/SECRETS_MIGRATION.md` Phase 4b status table marked ✅ complete
- [ ] CloudWatch shows sign-volume on the JWT key matching the expected per-user-action baseline (no anomalies)
- [ ] The refresh-flow client interceptor is live in the operator app (frontend follow-up — tracked separately)

**Security-invariant enforcement** (these check that the design's safety properties are actually live, not just that the code shipped):
- [ ] `verify-jwt-kms-signer.mjs` confirms `JWT_PUBLIC_KEY_PEM` matches `kms:GetPublicKey` for `AWS_JWT_KEY_ID`
- [ ] Backend boot refuses to start on public-key/KMS fingerprint mismatch
- [ ] JWT verifier uses a static `kid → public key → alg` allowlist; unknown `kid` is rejected
- [ ] JWT verifier rejects `alg=none`, unexpected `alg`, `jku`, `jwk`, `x5u`, `x5c`, and any unrecognized `crit` header
- [ ] JWT verifier requires explicit `typ: "averray-auth+jwt"`, `iss`, `aud: "averray-backend"`, `sub`, `jti`, `iat`, `nbf`, `exp`
- [ ] ES256 helper tests cover DER sign-padding stripping and fixed-width 32-byte R/S conversion
- [ ] Refresh endpoint derives wallet/role from the server-side refresh record, not from an expired access token
- [ ] Refresh-token replay behavior is explicitly strict: reuse after rotation revokes the token family
- [ ] Refresh cookie is host-only on `api.averray.com` with `HttpOnly; Secure; SameSite=Strict; Path=/auth/refresh`

**Mainnet prerequisites** (must be true before mainnet cutover, even if not strictly part of Phase 4b):
- [ ] No mainnet 30-day `ADMIN_JWT` exists in 1Password
- [ ] Mainnet JWT signer does not use long-lived static AWS access keys (IAM Roles Anywhere or equivalent)

When all the above are true, Phase 4b is closed.
