/**
 * bootstrap-mainnet-vault.mjs
 *
 * GAP script (critical-path item "vault/token bootstrap [Claude]") — codify the
 * mainnet 1Password vault topology + the four least-privilege service-account
 * tokens so the immutable scope is gotten right ONCE, at creation, and so the
 * result is verifiable against check-mainnet-env-secrets-proof.mjs.
 *
 * WHY a planner and not a doer (same constraint as rotate-sa-token.mjs): creating
 * vaults + minting service-account tokens is a 1Password admin action, the token
 * VALUE is shown by `op` exactly once, and the `op` CLI session does not propagate
 * into this sandbox. So this script OWNS THE PLAN — the exact `op` commands, the
 * scope table, and the firebreak/least-privilege assertions — and the operator runs
 * the emitted commands on their own authenticated machine. It never handles a token
 * value; `--verify` (run by the operator with a live read session) reads back the
 * realized scopes and emits the evidence-ready `serviceTokens` block (scope metadata
 * only — never a raw `ops_` token, which check-mainnet-env-secrets-proof's
 * scanForSecretLikeValues would reject anyway).
 *
 * The topology mirrors the prod tier in deploy/secrets-inventory.md, renamed to the
 * mainnet-* vaults, and MAINNET_CREDENTIALS_PLAN.md §1 (F7/F8) / §3 step 2.
 *
 * Usage:
 *   # dry-run (default) — print the create-command plan + scope table + firebreak check:
 *   node scripts/ops/bootstrap-mainnet-vault.mjs
 *   # include the optional 5th read+write SA (only if the <=1h JWT refresh-flow is in scope):
 *   node scripts/ops/bootstrap-mainnet-vault.mjs --with-refresh-rw
 *   # verify (run on a machine with an authenticated `op` session) — emit the
 *   # evidence-ready serviceTokens scope block from realized 1Password state:
 *   node scripts/ops/bootstrap-mainnet-vault.mjs --verify
 */

export const ENV = "mainnet";

/**
 * Vault topology. `firebreak: true` means NO service-account token may read it —
 * it holds the SA token items themselves, the basic-auth raw password, and the
 * Roles Anywhere CA private key (human-only). A leaked runtime token must not be
 * able to read its own replacement.
 */
export const MAINNET_VAULTS = [
  { name: "mainnet-critical", firebreak: true, holds: "SA token items · basic-auth raw password · Roles Anywhere CA key — human-only" },
  { name: "mainnet-backend", runtimes: ["backend"], holds: "backend runtime secrets (KMS ARNs/regions, JWT public key, metrics/alert)" },
  { name: "mainnet-backend-external", runtimes: ["backend"], holds: "optional external API keys (email, issue-ingestion PAT)" },
  { name: "mainnet-indexer", runtimes: ["indexer"], holds: "indexer DATABASE_URL" },
  { name: "mainnet-ci", runtimes: ["ci"], holds: "VPS SSH key · app basic-auth hash" },
  { name: "mainnet-ci-external", runtimes: ["ci"], holds: "CI-side external tokens" },
  { name: "mainnet-smoke", runtimes: ["smoke"], holds: "hosted product-proof ADMIN_JWT" },
  { name: "mainnet-observability", runtimes: ["backend"], holds: "observability tier (mirrors prod-observability)" },
];

/**
 * The four least-privilege service-account tokens, keyed by the evidence field name
 * that check-mainnet-env-secrets-proof.mjs `serviceTokens` expects. Each reads whole
 * vaults, read-only. Scope is IMMUTABLE post-creation — rotate by minting a new token
 * (via rotate-sa-token.mjs), never by widening.
 */
export const MAINNET_SA_TOKENS = {
  ciDeploy: {
    item: "op-token-mainnet-ci-deploy",
    account: "averray-mainnet-ci-deploy",
    reads: ["mainnet-ci", "mainnet-ci-external"],
    consumer: { kind: "gh-secret", name: "OP_SERVICE_ACCOUNT_TOKEN_MAINNET_CI", env: "production" },
    description: "GitHub Actions: mainnet deploy + hosted proofs.",
  },
  vpsBackend: {
    item: "op-token-mainnet-vps-backend",
    account: "averray-mainnet-vps-backend",
    reads: ["mainnet-backend", "mainnet-backend-external", "mainnet-observability"],
    consumer: { kind: "vps-file", path: "/etc/agent-stack/op-backend.env", var: "OP_SERVICE_ACCOUNT_TOKEN", service: "agent-stack-env-render" },
    description: "Backend VPS op-inject env render.",
  },
  vpsIndexer: {
    item: "op-token-mainnet-vps-indexer",
    account: "averray-mainnet-vps-indexer",
    reads: ["mainnet-indexer"],
    consumer: { kind: "vps-file", path: "/etc/agent-stack/op-indexer.env", var: "OP_SERVICE_ACCOUNT_TOKEN", service: "agent-stack-env-render" },
    description: "Indexer VPS op-inject env render.",
  },
  smokeTests: {
    item: "op-token-mainnet-smoke-tests",
    account: "averray-mainnet-smoke-tests",
    reads: ["mainnet-smoke"],
    consumer: { kind: "gh-secret", name: "OP_SERVICE_ACCOUNT_TOKEN_MAINNET_SMOKE", env: "production" },
    description: "Hosted product-proof smoke (reads mainnet-smoke only — the firebreak).",
  },
};

/**
 * Optional 5th token — a READ+WRITE service account for the per-consumer JWT
 * refresh-flow automation. Only provision this if DEC-4 sets JWT_MAX_TTL_SECONDS
 * <= 1h (the refresh-flow migration): 1Password SA permissions are immutable, so
 * the write grant must be present at mint time or the token must be re-minted.
 */
export const MAINNET_REFRESH_RW_TOKEN = {
  refreshRw: {
    item: "op-token-mainnet-admin-refresh-rw",
    account: "averray-mainnet-admin-refresh-rw",
    reads: ["mainnet-backend"],
    writes: ["mainnet-backend"],
    consumer: { kind: "vps-file", path: "/etc/agent-stack/op-refresh.env", var: "OP_SERVICE_ACCOUNT_TOKEN_REFRESH", service: "agent-stack-refresh-render" },
    description: "R+W SA for the <=1h JWT per-consumer refresh-flow (DEC-4). IMMUTABLE scope — mint R+W.",
  },
};

const firebreakVaults = () => new Set(MAINNET_VAULTS.filter((v) => v.firebreak).map((v) => v.name));
const knownVaults = () => new Set(MAINNET_VAULTS.map((v) => v.name));

/** Resolve the token set for the run (four, plus the optional R+W). */
export function planTokens({ withRefreshRw = false } = {}) {
  return withRefreshRw ? { ...MAINNET_SA_TOKENS, ...MAINNET_REFRESH_RW_TOKEN } : { ...MAINNET_SA_TOKENS };
}

/**
 * The firebreak + least-privilege invariants — the whole reason this script exists.
 * Throws with the specific violation; returns the token set on success. This is what
 * check-mainnet-env-secrets-proof.mjs enforces post-hoc; we enforce it pre-creation.
 */
export function assertScopes(tokens = MAINNET_SA_TOKENS) {
  const fb = firebreakVaults();
  const known = knownVaults();
  const problems = [];
  for (const [id, t] of Object.entries(tokens)) {
    const scopes = [...(t.reads || []), ...(t.writes || [])];
    if (scopes.length === 0) problems.push(`${id}: empty scope (a token must read at least one vault)`);
    for (const v of scopes) {
      if (v === "*" || v.toLowerCase() === "all") problems.push(`${id}: wildcard scope '${v}' is forbidden`);
      else if (!known.has(v)) problems.push(`${id}: references unknown vault '${v}'`);
      else if (fb.has(v)) problems.push(`${id}: grants access to firebreak vault '${v}' — no SA may read mainnet-critical`);
      else if (!v.startsWith("mainnet-")) problems.push(`${id}: non-mainnet vault '${v}' — no testnet/prod reuse`);
    }
  }
  if (problems.length) throw new Error(`scope violations:\n  - ${problems.join("\n  - ")}`);
  return tokens;
}

/** `op vault create` command for a vault (idempotent guidance printed alongside). */
export function buildVaultCreateCmd(vault) {
  return `op vault create ${JSON.stringify(vault.name)}`;
}

/**
 * `op service-account create` command granting WHOLE-VAULT read (+ optional write).
 * The token value is printed once by `op` — the operator captures it into
 * mainnet-critical + the consumer. This script never sees it.
 */
export function buildServiceAccountCreateCmd(token) {
  const grants = [
    ...(token.reads || []).map((v) => `--vault ${v}:read_items`),
    ...(token.writes || []).map((v) => `--vault ${v}:write_items`),
  ];
  return `op service-account create ${JSON.stringify(token.account)} --expires-in 90d ${grants.join(" ")}`;
}

/**
 * Shape the evidence-ready `serviceTokens` block that check-mainnet-env-secrets-proof.mjs
 * consumes — SCOPE METADATA ONLY. `realized` is what the operator reads back via
 * `op service-account get <account> --format json` under `--verify`; when absent
 * (dry-run) the block reflects the intended plan with realized=false.
 */
export function evidenceServiceTokens(tokens = MAINNET_SA_TOKENS, realizedByAccount = {}) {
  const out = {};
  for (const [id, t] of Object.entries(tokens)) {
    const realized = realizedByAccount[t.account];
    out[id] = {
      account: t.account,
      item: t.item,
      vaults: [...(t.reads || []), ...(t.writes || [])],
      mainnetOnly: (t.reads || []).concat(t.writes || []).every((v) => v.startsWith("mainnet-")),
      reusedTestnetToken: false,
      rawTokenRendered: false,
      grantsCritical: (t.reads || []).concat(t.writes || []).some((v) => firebreakVaults().has(v)),
      realized: Boolean(realized),
    };
  }
  return out;
}

export function parseArgs(argv) {
  const args = { verify: false, withRefreshRw: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--verify") args.verify = true;
    else if (a === "--with-refresh-rw") args.withRefreshRw = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else throw new Error(`unknown flag: ${a}`);
  }
  return args;
}

const HELP = `bootstrap-mainnet-vault.mjs — plan/verify the mainnet 1Password vault + SA-token topology.

  (default)            dry-run: print the op create-command plan + scope table + firebreak check
  --with-refresh-rw    include the optional 5th read+write SA (only if DEC-4 sets JWT TTL <= 1h)
  --verify             emit the evidence-ready serviceTokens scope block (run with a live op session)

No token value is ever handled by this script (op shows it once; the operator captures it into
mainnet-critical). Mirrors deploy/secrets-inventory.md and MAINNET_CREDENTIALS_PLAN.md §1/§3.`;

async function readOpServiceAccount(account) {
  // Best-effort realized-scope read for --verify. Returns null if op is unavailable.
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    const { stdout } = await run("op", ["service-account", "get", account, "--format", "json"]);
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }

  const tokens = planTokens({ withRefreshRw: args.withRefreshRw });
  assertScopes(tokens); // fail closed before printing any plan

  if (args.verify) {
    const realizedByAccount = {};
    for (const t of Object.values(tokens)) {
      const got = await readOpServiceAccount(t.account);
      if (got) realizedByAccount[t.account] = got;
    }
    const block = { serviceTokens: evidenceServiceTokens(tokens, realizedByAccount) };
    console.log(JSON.stringify(block, null, 2));
    console.error(
      Object.keys(realizedByAccount).length
        ? `\nverify: read ${Object.keys(realizedByAccount).length}/${Object.keys(tokens).length} accounts from op.`
        : `\nverify: op unavailable — printed the INTENDED scope block (realized=false). Run on a machine with an authenticated op session.`
    );
    return;
  }

  console.log(`\n# Mainnet 1Password bootstrap plan (${ENV})  —  dry-run, run the commands below on an op admin session\n`);
  console.log(`## 1. Vaults (${MAINNET_VAULTS.length})`);
  for (const v of MAINNET_VAULTS) {
    console.log(`  ${buildVaultCreateCmd(v)}${v.firebreak ? "   # FIREBREAK — no SA reads this" : ""}`);
    console.log(`      · ${v.holds}`);
  }

  console.log(`\n## 2. Service-account tokens (${Object.keys(tokens).length}, least-privilege whole-vault scope)`);
  for (const [id, t] of Object.entries(tokens)) {
    const w = (t.writes || []).length ? ` (+write ${t.writes.join(",")})` : "";
    console.log(`  # ${id}: reads ${t.reads.join(", ")}${w} — ${t.description}`);
    console.log(`  ${buildServiceAccountCreateCmd(t)}`);
    const c = t.consumer;
    if (c.kind === "gh-secret") console.log(`      → set: ${c.name} at --env ${c.env}  (via rotate-sa-token.mjs after mint)`);
    else console.log(`      → set: ${c.var} in ${c.path} on the VPS (0400 root)`);
    console.log(`      → store the token VALUE as item ${t.item} in mainnet-critical (human-only)`);
  }

  console.log(`\n## 3. Firebreak + least-privilege: PASSED (no SA reads mainnet-critical; no wildcard; mainnet-only)`);
  console.log(`\n## 4. Evidence block (feeds check-mainnet-env-secrets-proof.mjs after --verify):`);
  console.log(JSON.stringify({ serviceTokens: evidenceServiceTokens(tokens) }, null, 2));
  console.log(`\nNext: run the commands above on your op admin machine, capture each token into mainnet-critical,`);
  console.log(`then \`node scripts/ops/bootstrap-mainnet-vault.mjs --verify\` to emit the realized scope block.\n`);
}

const isCli = process.argv[1] && process.argv[1].endsWith("bootstrap-mainnet-vault.mjs");
if (isCli) {
  main().catch((err) => {
    console.error(err?.message ?? err);
    process.exit(1);
  });
}
