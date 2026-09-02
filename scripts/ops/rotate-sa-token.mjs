/**
 * rotate-sa-token.mjs
 *
 * Ops helper for audit finding D-01 — collapse the manual surface of rotating a
 * 1Password *service-account* token down to the three irreducibly-human steps
 * (mint in browser → run this with the new token → revoke old in browser).
 * Everything between — pushing the new token into every consumer at the CORRECT
 * scope — is automated and identical every time.
 *
 * WHY a script, and why it can't be 100% (see deploy/secrets-inventory.md
 * §"Service-account token rotation"): minting/revoking the bearer token is a
 * 1Password web-console action (no `op` CLI re-issue), and the prod-critical
 * vault is a firebreak no service account can read — so the token VALUE must
 * come from a human. This script owns the mechanical middle so the consumed
 * scope and secret names are never fat-fingered.
 *
 * THE D-01 FOOTGUN THIS PREVENTS: every consuming workflow pins
 * `environment: production`, and GitHub resolves environment-scoped secrets
 * OVER repo-scoped ones. A rotation that sets the repo-scoped copy is read by
 * nothing — the live env-scoped token stays stale. This script always targets
 * `--env production` and loudly flags a shadowing repo-scoped duplicate (the
 * exact split-brain that made a "completed" rotation silently ineffective).
 *
 * The new token is read from STDIN only — never argv (a process listing or
 * shell history would otherwise leak it). gh receives it on its own stdin too.
 *
 * Usage:
 *   # dry-run (default) — prints the exact plan + shadow check, touches nothing:
 *   node scripts/ops/rotate-sa-token.mjs --token prod-smoke-tests
 *
 *   # apply — pipe the freshly-minted token on stdin:
 *   pbpaste | node scripts/ops/rotate-sa-token.mjs --token prod-smoke-tests --commit
 *
 *   # VPS-backed tokens print the exact remote edit (op-gated SSH — run on a host
 *   # that has VPS access; the command is never auto-executed):
 *   node scripts/ops/rotate-sa-token.mjs --token prod-vps-backend
 */

export const REPO = "averray-agent/agent";

/**
 * Token identity → its consumers. Mirrors deploy/secrets-inventory.md and
 * docs/SECRETS_CALENDAR.yml. `gh-secret` consumers are set at `--env production`
 * because every referencing workflow pins that environment (verified by grep
 * over .github/workflows). `vps-file` consumers live in root-owned env files on
 * the VPS and are emitted as a command, never executed from here.
 */
export const SA_TOKEN_REGISTRY = {
  "prod-ci-deploy": {
    description: "GitHub Actions: deploy + Hermes + hosted CI proofs (reads prod-ci).",
    consumers: [{ kind: "gh-secret", name: "OP_SERVICE_ACCOUNT_TOKEN_PROD_CI", env: "production" }],
  },
  "prod-smoke-tests": {
    description: "Hosted smoke + worker canary + dispute/service-token proofs (reads prod-smoke).",
    consumers: [{ kind: "gh-secret", name: "OP_SERVICE_ACCOUNT_TOKEN_PROD_SMOKE", env: "production" }],
  },
  "prod-backend-canary": {
    description: "Hosted worker canary worker-key load (reads prod-backend canary-worker item).",
    consumers: [{ kind: "gh-secret", name: "OP_SERVICE_ACCOUNT_TOKEN_PROD_BACKEND", env: "production" }],
  },
  "prod-vps-backend": {
    description: "Backend VPS op-run env injection (reads prod-backend).",
    consumers: [{ kind: "vps-file", path: "/etc/agent-stack/op-backend.env", var: "OP_SERVICE_ACCOUNT_TOKEN", service: "agent-stack-env-render" }],
  },
  "prod-vps-indexer": {
    description: "Indexer VPS op-run env injection (reads prod-indexer).",
    consumers: [{ kind: "vps-file", path: "/etc/agent-stack/op-indexer.env", var: "OP_SERVICE_ACCOUNT_TOKEN", service: "agent-stack-env-render" }],
  },
};

/** Resolve a token id to its plan, or throw with the known set. */
export function planRotation(tokenId, registry = SA_TOKEN_REGISTRY) {
  const entry = registry[tokenId];
  if (!entry) {
    throw new Error(`unknown token "${tokenId}". Known: ${Object.keys(registry).join(", ")}`);
  }
  return { tokenId, description: entry.description, consumers: entry.consumers };
}

/** Cheap shape guard so a bad paste fails before it touches every consumer. */
export function validateTokenShape(raw) {
  const token = (raw || "").trim();
  if (!token) return { ok: false, reason: "empty — nothing arrived on stdin" };
  if (/\s/.test(token)) return { ok: false, reason: "contains whitespace — likely a truncated/wrapped paste" };
  if (!token.startsWith("ops_")) return { ok: false, reason: `expected a 1Password service-account token (starts with "ops_"), got "${token.slice(0, 4)}…"` };
  if (token.length < 60) return { ok: false, reason: `suspiciously short (${token.length} chars) for an SA token` };
  return { ok: true, token };
}

/**
 * Args for `gh secret set` — deliberately WITHOUT the value, which gh reads from
 * its stdin. Keeping the token out of argv is the whole point.
 */
export function buildGhSecretSetArgs({ name, env, repo = REPO }) {
  const args = ["secret", "set", name, "--repo", repo];
  if (env) args.push("--env", env);
  return args;
}

/**
 * Classify a same-named secret across scopes. `shadowed` is the D-01 bug: the
 * env-scoped copy wins, so a repo-scoped rotation is silently dead.
 */
export function detectShadow({ name, repoScopeNames = [], envScopeNames = [] }) {
  const inRepo = repoScopeNames.includes(name);
  const inEnv = envScopeNames.includes(name);
  return {
    shadowed: inRepo && inEnv,
    onlyRepo: inRepo && !inEnv,
    onlyEnv: !inRepo && inEnv,
    missing: !inRepo && !inEnv,
  };
}

/**
 * The exact remote one-liner to rotate a VPS env-file token. Emitted, never run
 * (the VPS SSH key is op-gated and the sandbox can't reach it). Token is read
 * from the remote process's stdin; only the single var line is rewritten, the
 * file is replaced atomically at mode 0400 root:root, and the renderer restarts.
 */
export function buildVpsUpdateCommand({ path, var: varName, service }) {
  const remote =
    `set -euo pipefail; umask 077; read -r T; ` +
    `tmp=$(mktemp); ` +
    `{ grep -v '^${varName}=' ${path} 2>/dev/null || true; printf '%s=%s\\n' '${varName}' "$T"; } > "$tmp"; ` +
    `install -m 0400 -o root -g root "$tmp" ${path}; rm -f "$tmp"; ` +
    `systemctl restart ${service}.service`;
  return `printf '%s' '<PASTE_NEW_TOKEN>' | ssh "$AVERRAY_VPS_HOST" sudo bash -c ${JSON.stringify(remote)}`;
}

export function parseArgs(argv) {
  const args = { commit: false, repo: REPO, env: "production", grace: 7 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--token") args.token = argv[++i];
    else if (a === "--commit") args.commit = true;
    else if (a === "--repo") args.repo = argv[++i];
    else if (a === "--env") args.env = argv[++i];
    else if (a === "--grace") args.grace = Number(argv[++i]);
    else if (a === "--help" || a === "-h") args.help = true;
    else throw new Error(`unknown flag: ${a}`);
  }
  return args;
}

const HELP = `rotate-sa-token.mjs — rotate a 1Password service-account token into its consumers.

  --token <id>   one of: ${Object.keys(SA_TOKEN_REGISTRY).join(", ")}
  --commit       apply (default is dry-run: print the plan + shadow check only)
  --repo <slug>  default ${REPO}
  --env <name>   gh-secret scope, default "production" (the consumed scope)
  --grace <days> grace window before revoking the old token (default 7)

  # apply: pipe the freshly-minted token in
  pbpaste | node scripts/ops/rotate-sa-token.mjs --token prod-smoke-tests --commit

See deploy/secrets-inventory.md §"Service-account token rotation".`;

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

async function ghSecretNames({ repo, env }) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const args = ["secret", "list", "--repo", repo];
  if (env) args.push("--env", env);
  try {
    const { stdout } = await run("gh", args);
    return stdout.split("\n").map((l) => l.trim().split(/\s+/)[0]).filter(Boolean);
  } catch {
    return null; // gh unavailable / not authed — shadow check becomes advisory
  }
}

async function setGhSecret({ name, env, repo, token }) {
  const { spawn } = await import("node:child_process");
  const child = spawn("gh", buildGhSecretSetArgs({ name, env, repo }), { stdio: ["pipe", "inherit", "inherit"] });
  child.stdin.write(token);
  child.stdin.end();
  return new Promise((resolve, reject) => {
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`gh secret set ${name} exited ${code}`))));
  });
}

function isoDatePlusDays(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.token) {
    console.log(HELP);
    if (!args.token && !args.help) process.exitCode = 2;
    return;
  }

  const plan = planRotation(args.token);
  console.log(`\nRotate 1Password SA token: ${plan.tokenId}`);
  console.log(`  ${plan.description}`);
  console.log(`  mode: ${args.commit ? "COMMIT (will write)" : "dry-run (prints only — re-run with --commit to apply)"}\n`);

  // Shadow check for every gh-secret consumer — the D-01 footgun.
  const ghConsumers = plan.consumers.filter((c) => c.kind === "gh-secret");
  if (ghConsumers.length) {
    const [repoNames, envNames] = await Promise.all([
      ghSecretNames({ repo: args.repo, env: null }),
      ghSecretNames({ repo: args.repo, env: args.env }),
    ]);
    for (const c of ghConsumers) {
      if (repoNames && envNames) {
        const s = detectShadow({ name: c.name, repoScopeNames: repoNames, envScopeNames: envNames });
        if (s.shadowed) {
          console.log(`  ⚠️  SHADOW: ${c.name} exists at BOTH repo and ${args.env} scope.`);
          console.log(`      Env scope wins, so the repo copy is dead weight and a future-rotation trap.`);
          console.log(`      After this rotation lands at env scope, delete the repo shadow:`);
          console.log(`        gh secret delete ${c.name} --repo ${args.repo}\n`);
        } else if (s.onlyRepo) {
          console.log(`  ⚠️  ${c.name} exists ONLY at repo scope, but consumers pin environment: ${args.env}.`);
          console.log(`      Setting it at --env ${args.env} (below) is what actually takes effect.\n`);
        }
      } else {
        console.log(`  (shadow check skipped — gh list unavailable; proceeding to set at --env ${args.env})\n`);
      }
    }
  }

  let token = "";
  if (args.commit) {
    const raw = await readStdin();
    const v = validateTokenShape(raw);
    if (!v.ok) {
      console.error(`\n✗ refusing to set secrets: token ${v.reason}.`);
      console.error(`  Pipe the freshly-minted token, e.g.:  pbpaste | node scripts/ops/rotate-sa-token.mjs --token ${args.token} --commit`);
      process.exitCode = 1;
      return;
    }
    token = v.token;
  }

  for (const c of plan.consumers) {
    if (c.kind === "gh-secret") {
      console.log(`  → gh-secret  ${c.name}  (--env ${c.env})`);
      if (args.commit) {
        await setGhSecret({ name: c.name, env: c.env, repo: args.repo, token });
        console.log(`    ✓ set at env scope`);
      } else {
        console.log(`    plan: gh ${buildGhSecretSetArgs({ name: c.name, env: c.env, repo: args.repo }).join(" ")}  (value on stdin)`);
      }
    } else if (c.kind === "vps-file") {
      console.log(`  → vps-file   ${c.path}  (var ${c.var})  — emit only; run on a host with VPS SSH access:`);
      console.log(`    ${buildVpsUpdateCommand(c)}`);
      console.log(`    (confirm the env-file format on the host before applying)`);
    }
  }

  // The irreducibly-human tail — printed precisely so nothing is guessed.
  console.log(`\n  Remaining human steps (cannot be scripted — see header):`);
  console.log(`    1. Verify: re-run a consuming workflow and confirm the 1Password load step is green.`);
  console.log(`    2. Revoke the OLD token in the 1Password admin console (after the ~${args.grace}-day grace).`);
  console.log(`    3. Set expires_at: "${isoDatePlusDays(90)}" for op-token-${args.token} in docs/SECRETS_CALENDAR.yml`);
  console.log(`       (reconcile the duplicate D-01 block there first — it currently lists each token twice).\n`);
}

const isCli = process.argv[1] && process.argv[1].endsWith("rotate-sa-token.mjs");
if (isCli) {
  main().catch((err) => {
    console.error(err?.message ?? err);
    process.exit(1);
  });
}
