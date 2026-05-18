#!/usr/bin/env node

/**
 * Offline mint of an admin / verifier JWT for the Averray backend.
 *
 * Closes a gap that bit us in early ops: when the `ADMIN_JWT` GitHub
 * Actions secret (or any other long-lived ops token) expires, the
 * only previously-documented mint path was the operator app's SIWE
 * sign-in flow followed by manual local-storage extraction. That
 * flow is fine for human operators but breaks any time the deployer
 * wants to refresh tokens consumed by automation (e.g.
 * scripts/ops/run-hosted-worker-loop.mjs).
 *
 * Two signing backends:
 *
 *   1. HMAC (default) — signs HS256 with `AUTH_JWT_SECRETS[0]`. Works
 *      against backends running `JWT_BACKEND` ∈ {hmac, both}. This is
 *      the path used before the Phase 4b cutover.
 *
 *   2. KMS (`--use-kms`) — signs ES256 via the JWT KMS key
 *      (`AWS_JWT_KEY_ID`). Works against backends running `JWT_BACKEND`
 *      ∈ {kms, both}. Use this path after the Phase 4b.6 cutover; the
 *      produced token verifies against the public key cached in
 *      `JWT_PUBLIC_KEY_PEM`. Requires the operator's AWS credentials
 *      to have `kms:Sign` on the JWT key (the same IAM user the
 *      backend uses, or a human operator with equivalent grants).
 *
 * Required env (treat as sensitive — source from a vault or
 * password manager, never paste literals into shell history):
 *
 *   HMAC mode (default):
 *     AUTH_JWT_SECRETS    — comma-separated list of HS256 secrets.
 *                           Signs with the first (newest) entry.
 *     AUTH_JWT_SECRET     — legacy single-secret fallback.
 *
 *   KMS mode (`--use-kms`):
 *     AWS_JWT_REGION              — eu-central-2 for testnet.
 *     AWS_JWT_KEY_ID              — full KMS key ARN (NOT alias).
 *     AWS_JWT_ACCESS_KEY_ID       — IAM access key (or use the SDK's
 *     AWS_JWT_SECRET_ACCESS_KEY     default-credential-provider chain).
 *     JWT_PUBLIC_KEY_PEM          — PEM-wrapped SPKI of the KMS public
 *                                   key. Embedded as a claim-shape
 *                                   sanity-check; the backend re-reads
 *                                   it from env at verify time.
 *     JWT_KID                     — Optional, default "jwt-1".
 *     JWT_EXPECTED_ISSUER         — Optional, default
 *                                   "averray-backend-testnet".
 *     JWT_EXPECTED_AUDIENCE       — Optional, default "averray-backend".
 *
 * Usage:
 *   # HMAC (legacy):
 *   AUTH_JWT_SECRETS=$(op read 'op://prod-backend/auth-jwt-secrets/password') \
 *     node scripts/ops/mint-admin-jwt.mjs --profile testnet --expires-in-days 30
 *
 *   # KMS (post-PR-4b.6):
 *   export AWS_JWT_REGION=$(op read 'op://prod-backend/aws-jwt-signer-testnet/aws-region')
 *   export AWS_JWT_KEY_ID=$(op read 'op://prod-backend/aws-jwt-signer-testnet/kms-key-id')
 *   export AWS_JWT_ACCESS_KEY_ID=$(op read 'op://prod-backend/aws-jwt-signer-testnet/access-key-id')
 *   export AWS_JWT_SECRET_ACCESS_KEY=$(op read 'op://prod-backend/aws-jwt-signer-testnet/secret-access-key')
 *   export JWT_PUBLIC_KEY_PEM=$(op read 'op://prod-backend/aws-jwt-signer-testnet/public-key-pem')
 *   node scripts/ops/mint-admin-jwt.mjs --profile testnet \
 *     --expires-in-days 30 --use-kms
 *
 * Common workflow (hosted product-proof smoke):
 *   ... | xargs -I {} gh secret set ADMIN_JWT --body '{}'
 *   # or  | op item edit "op://prod-smoke/admin-jwt" "password=$(cat -)"
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { signToken } from "../../mcp-server/src/auth/jwt.js";
import { KmsJwtSigner } from "../../mcp-server/src/auth/kms-jwt-signer.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

function parseArgs(argv) {
  const args = {
    wallet: undefined,
    profile: undefined,
    roles: ["admin"],
    expiresInDays: 30,
    quiet: false,
    useKms: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--wallet") args.wallet = argv[++i];
    else if (flag === "--profile") args.profile = argv[++i];
    else if (flag === "--roles") args.roles = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (flag === "--expires-in-days") args.expiresInDays = Number(argv[++i]);
    else if (flag === "--quiet" || flag === "-q") args.quiet = true;
    else if (flag === "--use-kms") args.useKms = true;
    else if (flag === "--help" || flag === "-h") args.help = true;
  }
  return args;
}

function printUsage() {
  console.log(
    [
      "Usage: node scripts/ops/mint-admin-jwt.mjs [options]",
      "",
      "Options:",
      "  --wallet <0x…>          Subject wallet to sign for. Defaults to deployments/<profile>.json#verifier when --profile is given.",
      "  --profile <name>        Read default wallet from deployments/<name>.json (e.g. testnet, mainnet).",
      "  --roles <a,b,c>         Comma-separated role list. Default: admin.",
      "                          With --use-kms only the first role is used (ES256 JWTs carry one `role` claim).",
      "  --expires-in-days <n>   Token lifetime in days. Default: 30.",
      "  --use-kms               Sign ES256 via the JWT KMS key (post-PR 4b.6).",
      "                          Without it: HS256 via AUTH_JWT_SECRETS (legacy path).",
      "  --quiet, -q             Print only the JWT (no decoded claims summary).",
      "",
      "Required env (HMAC mode, default):",
      "  AUTH_JWT_SECRETS        Comma-separated HS256 secrets. First entry is the signing key.",
      "  AUTH_JWT_SECRET         Legacy single-secret fallback (only used if AUTH_JWT_SECRETS unset).",
      "",
      "Required env (--use-kms):",
      "  AWS_JWT_REGION          eu-central-2 for testnet.",
      "  AWS_JWT_KEY_ID          Full KMS key ARN (NOT alias).",
      "  AWS_JWT_ACCESS_KEY_ID   IAM access key (or use SDK default-credential chain).",
      "  AWS_JWT_SECRET_ACCESS_KEY",
      "  JWT_PUBLIC_KEY_PEM      PEM-wrapped SPKI of the JWT KMS public key.",
      "  JWT_KID                 Optional, default 'jwt-1'.",
      "  JWT_EXPECTED_ISSUER     Optional, default 'averray-backend-testnet'.",
      "  JWT_EXPECTED_AUDIENCE   Optional, default 'averray-backend'.",
      "",
      "Output:",
      "  When --quiet: stdout is just the JWT (suitable for piping to `gh secret set`, etc.).",
      "  Otherwise: a short summary block + the JWT on the last line."
    ].join("\n")
  );
}

async function loadDefaultWallet(profile) {
  if (!profile) return undefined;
  try {
    const raw = await readFile(resolve(repoRoot, "deployments", `${profile}.json`), "utf8");
    const data = JSON.parse(raw);
    return data.verifier ?? data.deployer ?? undefined;
  } catch (error) {
    throw new Error(`Could not read deployments/${profile}.json: ${error.message}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const wallet = args.wallet ?? (await loadDefaultWallet(args.profile));
  if (!wallet || !/^0x[a-fA-F0-9]{40}$/u.test(wallet)) {
    console.error("--wallet (or --profile that resolves to one) is required and must be a 0x-prefixed 40-char hex address.");
    printUsage();
    process.exitCode = 1;
    return;
  }

  if (!Number.isFinite(args.expiresInDays) || args.expiresInDays <= 0 || args.expiresInDays > 365 * 2) {
    console.error("--expires-in-days must be between 1 and 730 (~2 years).");
    process.exitCode = 1;
    return;
  }
  if (!Array.isArray(args.roles) || args.roles.length === 0) {
    console.error("--roles must be a non-empty comma-separated list (e.g. admin,verifier).");
    process.exitCode = 1;
    return;
  }

  const expiresInSeconds = Math.floor(args.expiresInDays * 24 * 60 * 60);

  if (args.useKms) {
    await mintViaKms({ wallet, roles: args.roles, expiresInSeconds, expiresInDays: args.expiresInDays, quiet: args.quiet });
    return;
  }

  const secretsRaw = String(process.env.AUTH_JWT_SECRETS ?? process.env.AUTH_JWT_SECRET ?? "").trim();
  if (!secretsRaw) {
    console.error("AUTH_JWT_SECRETS env (or legacy AUTH_JWT_SECRET) is required for HMAC mode.");
    console.error("Source it from your vault — never paste the secret as a shell literal:");
    console.error('  AUTH_JWT_SECRETS=$(op read "op://prod-backend/auth-jwt-secrets/password")');
    console.error("");
    console.error("Or use --use-kms to sign via the JWT KMS key (post-PR-4b.6).");
    process.exitCode = 1;
    return;
  }
  const secrets = secretsRaw.split(",").map((s) => s.trim()).filter(Boolean);
  if (secrets.length === 0) {
    console.error("AUTH_JWT_SECRETS resolved to an empty list after splitting on commas.");
    process.exitCode = 1;
    return;
  }
  // Sign with the first (newest) secret, mirroring auth/middleware.js
  // verification order. Old tokens issued by previous secrets remain
  // valid until those entries are dropped from the live backend's
  // AUTH_JWT_SECRETS list.
  const signingSecret = secrets[0];
  if (signingSecret.length < 32) {
    console.error(`The first AUTH_JWT_SECRETS entry is ${signingSecret.length} chars long; auth/config.js requires ≥ 32 chars in strict mode. Ensure the env matches the live backend.`);
    process.exitCode = 1;
    return;
  }

  const { token, claims } = signToken(
    {
      sub: wallet.toLowerCase(),
      roles: args.roles,
      // No explicit scopes — admin/verifier roles already grant the
      // capabilities ops scripts need. If you need finer-grained
      // scopes for a service token, add them via a fork of this
      // script or thread `--scopes` through the CLI parser.
    },
    { secret: signingSecret, expiresInSeconds }
  );

  if (args.quiet) {
    console.log(token);
    return;
  }

  const expiresAt = new Date(claims.exp * 1000).toISOString();
  const issuedAt = new Date(claims.iat * 1000).toISOString();
  console.error("# admin-jwt mint (HMAC / HS256)");
  console.error(`subject:        ${claims.sub}`);
  console.error(`roles:          ${claims.roles?.join(", ") ?? "(none)"}`);
  console.error(`jti:            ${claims.jti}`);
  console.error(`issued:         ${issuedAt}`);
  console.error(`expires:        ${expiresAt}  (${args.expiresInDays} days from now)`);
  console.error(`signed with:    HS256, secret index 0 of ${secrets.length} configured secret${secrets.length === 1 ? "" : "s"}`);
  console.error("");
  console.error("# JWT (this line below is the token; paste it into ADMIN_JWT or pipe to `gh secret set`):");
  console.log(token);
}

/**
 * Sign an ES256 admin JWT via the JWT KMS key (PR 4b.6 path).
 *
 * The KmsJwtSigner produces a single-role token; if multiple roles
 * were requested we use the first one and warn. (Multi-role tokens
 * remain a property of the legacy HS256 path until the backend's
 * ES256 verify accepts `roles: []`; this is fine for testnet smoke
 * which only needs `admin`.)
 */
async function mintViaKms({ wallet, roles, expiresInSeconds, expiresInDays, quiet }) {
  const region = (process.env.AWS_JWT_REGION ?? "").trim();
  const keyId = (process.env.AWS_JWT_KEY_ID ?? "").trim();
  const publicKeyPem = process.env.JWT_PUBLIC_KEY_PEM ?? "";
  const missing = [];
  if (!region) missing.push("AWS_JWT_REGION");
  if (!keyId) missing.push("AWS_JWT_KEY_ID");
  if (!publicKeyPem) missing.push("JWT_PUBLIC_KEY_PEM");
  if (missing.length > 0) {
    console.error(`--use-kms requires the following env vars: ${missing.join(", ")}`);
    console.error("Source them from prod-backend/aws-jwt-signer-testnet (run --help for the full op-read snippet).");
    process.exitCode = 1;
    return;
  }
  if (keyId.startsWith("alias/")) {
    console.error(`AWS_JWT_KEY_ID must be the full KMS key ARN, not an alias ("${keyId}").`);
    console.error("Per docs/PHASE_4B_KMS_JWT_PLAN.md §3 — aliases can be retargeted.");
    process.exitCode = 1;
    return;
  }

  const kid = (process.env.JWT_KID ?? "jwt-1").trim() || "jwt-1";
  const expectedIssuer = (process.env.JWT_EXPECTED_ISSUER ?? "averray-backend-testnet").trim();
  const expectedAudience = (process.env.JWT_EXPECTED_AUDIENCE ?? "averray-backend").trim();

  if (roles.length > 1) {
    console.error(`# warning: --use-kms signs a single-role ES256 JWT (got --roles ${roles.join(",")}). Using "${roles[0]}".`);
  }
  const role = roles[0];

  // Construct an explicit KMSClient so the AWS SDK reads the
  // AWS_JWT_*-prefixed credentials this script's env contract uses.
  // Without this, the SDK would fall back to its default credential
  // chain (unprefixed AWS_ACCESS_KEY_ID / shared config / EC2 IMDS),
  // which doesn't see the AWS_JWT_ACCESS_KEY_ID we read from
  // 1Password. If those prefixed creds aren't set (e.g., running under
  // IAM Roles Anywhere or an EC2 instance profile), we still pass
  // through to the default chain by leaving `credentials` unset.
  const accessKeyId = process.env.AWS_JWT_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_JWT_SECRET_ACCESS_KEY;
  const kmsClientOpts = { region };
  if (accessKeyId && secretAccessKey) {
    kmsClientOpts.credentials = { accessKeyId, secretAccessKey };
  }
  const { KMSClient } = await import("@aws-sdk/client-kms");
  const kmsClient = new KMSClient(kmsClientOpts);

  const signer = new KmsJwtSigner({
    kmsClient,
    region,
    keyId,
    kid,
    publicKeyPem,
    expectedIssuer,
    expectedAudience,
    expectedRoles: [role],
    // Allow the full admin TTL (up to 30 days for testnet smoke). The
    // backend's verifier caps via JWT_MAX_TTL_SECONDS — the env template
    // sets that to 2592000 (30d) to match.
    maxTtlSeconds: Math.max(expiresInSeconds, 60),
  });

  const token = await signer.signAsync(
    { sub: wallet.toLowerCase() },
    {
      issuer: expectedIssuer,
      audience: expectedAudience,
      subject: wallet.toLowerCase(),
      role,
      expiresInSeconds,
    },
  );

  if (quiet) {
    console.log(token);
    return;
  }

  // Decode claims for the human-readable summary. No verify call —
  // we just signed it, and the operator can sanity-check by piping the
  // output through `scripts/ops/verify-jwt-kms-signer.mjs --token <…>`.
  const [, claimsB64] = token.split(".");
  const claims = JSON.parse(Buffer.from(claimsB64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  const expiresAt = new Date(claims.exp * 1000).toISOString();
  const issuedAt = new Date(claims.iat * 1000).toISOString();
  console.error("# admin-jwt mint (KMS / ES256)");
  console.error(`subject:        ${claims.sub}`);
  console.error(`role:           ${claims.role}`);
  console.error(`iss / aud:      ${claims.iss} / ${claims.aud}`);
  console.error(`kid:            ${kid}`);
  console.error(`jti:            ${claims.jti}`);
  console.error(`issued:         ${issuedAt}`);
  console.error(`expires:        ${expiresAt}  (${expiresInDays} days from now)`);
  console.error(`signed with:    ES256 via KMS ${keyId}`);
  console.error("");
  console.error("# JWT (this line below is the token; paste it into ADMIN_JWT or pipe to `gh secret set`):");
  console.log(token);
}

main().catch((error) => {
  console.error(`mint-admin-jwt failed: ${error?.stack ?? error?.message ?? error}`);
  process.exitCode = 1;
});
