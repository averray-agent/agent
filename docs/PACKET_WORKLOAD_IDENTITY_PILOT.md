# PACKET — Retire the long-lived CI tokens: a workload-identity pilot on one read-only workflow

**Status:** ready for Codex (code side) and Pascal (console side), 2026-10-07. One drill workflow, then one migrated workflow. No backend, VPS, indexer or contract change.

## Why (verified 2026-10-07)

- Every GitHub workflow that reads 1Password does it with a long-lived service-account token held as a GitHub secret. Nine workflows read the `prod-ci` vault (VPS SSH key) through `OP_SERVICE_ACCOUNT_TOKEN_PROD_CI`; five read `prod-smoke` (admin JWT); the canary reads `prod-backend`; two write refresh tokens into `mainnet-smoke`.
- Two of those accounts expired unnoticed on 2026-10-06 and broke production deploys; the `prod-ci` account in live use **never expires**, which is the opposite failure: valid forever once leaked. The calendar now tracks the mainnet ones (PR #1424), but tracking is a reminder, not a fix.
- 1Password's workload identity ("Credential Broker", **public preview**) lets a GitHub Actions job prove who it is with GitHub's own OIDC token and receive short-lived access. No token to store, expire, rotate or leak. Verified from the action's README: `1password/load-secrets-action` v5 authenticates with three values, `OP_WORKLOAD_ID`, `OP_ENVIRONMENT_ID` and `OP_INTEGRATION_KEY` (the last one is a secret; the first two are plain variables), and requires `permissions: id-token: write`. The console offers the provider under Developer → Agents & workloads → Set up an integration → GitHub Actions, with restrictions by repository, workflow, GitHub environment or branch.
- **The model is different from today's.** Access goes to a 1Password **Environment** (a named set of variables), not to vaults; the action loads every variable in that Environment, and `op://vault/item/field` references are not used. Writes are not part of this path. Consequences:
  - the two refresh-token **writers** (`OP_SERVICE_ACCOUNT_TOKEN_MAINNET_SMOKE`, used by deploy-production and the worker canary) stay on service accounts; their rotation is in the calendar (next: 2026-10-25);
  - the VPS tokens stay as they are (no identity provider on the box);
  - the **readers** can move, and that is where the non-expiring token lives.

## Pilot scope

One drill workflow that proves the broker end to end without touching production, then migrate one real, read-only, dispatch-only workflow: `hosted-observability-proof.yml` (it loads only `op://prod-ci/vps-ssh-key/private key`). Rollout to the other `prod-ci` readers is a follow-up after a week of green runs. Nothing else changes.

## Operator items (Pascal, console; about 15 minutes)

1. **Environment.** Developer → Environments → new Environment named `ci-prod-readonly`. Add one variable, `VPS_SSH_KEY`, holding the same private key as `op://prod-ci/vps-ssh-key/private key`. If the UI lets a variable reference an existing vault item, use the reference; if it only stores a copy, store the copy and tell Claude, because the key then has two homes and `docs/SECRETS_CALENDAR.yml` (`vps-ssh-key`) must say so.
2. **Integration.** Developer → Agents & workloads → Set up an integration → GitHub Actions. Repository `averray-agent/agent`. Restrict it to the workflow `hosted-workload-identity-proof.yml` for the drill (widen to `hosted-observability-proof.yml` at step 3 of the exit condition). Grant it the `ci-prod-readonly` Environment only.
3. **Values.** The console shows a workload ID, the Environment ID and an integration key.
   - `gh variable set OP_WORKLOAD_ID --repo averray-agent/agent` and `gh variable set OP_ENVIRONMENT_ID --repo averray-agent/agent` (plain variables; the command prompts for the value).
   - `gh secret set OP_INTEGRATION_KEY --env production --repo averray-agent/agent` (environment scope, as every production secret; the command prompts; never paste the value in chat).
   - Confirm afterwards with `gh secret list --env production --repo averray-agent/agent` and `gh secret list --repo averray-agent/agent` (the latter must not show a repo-scoped `OP_INTEGRATION_KEY`).
4. Nothing is revoked at this stage.

## Learned from the first two drills (2026-10-08)

- Run 37745935236: broker handshake succeeded ("Authenticated with Workload Identity") — the pilot's core claim is proven: no service-account token anywhere, GitHub's OIDC token exchanged for access. The job then failed because the Environment variable held the literal text `op://prod-ci/vps-ssh-key/private key`: **Environments store dotenv-style literal values and do not resolve `op://` references.**
- Run 37747099823: with the key text pasted into the variable the prefix check passed but `ssh` failed with `Load key: error in libcrypto` — a **multi-line value does not survive the Environment → action → step-output path intact**. Rule for this pilot and every follow-up: multi-line secrets go into an Environment **base64-encoded on one line**, and the workflow decodes them.

PR 1 is therefore amended: the Environment variable is `VPS_SSH_KEY_B64` (single line, `base64` of the private key, produced by `op read 'op://prod-ci/vps-ssh-key/private key' | base64 | tr -d '\n'`); the workflow decodes it with `base64 -d` into the 0600 file, runs the same shape check on the DECODED bytes, and on failure prints only non-secret diagnostics (byte length, line count, whether the first five characters are `-----`). The `vps-ssh-key` calendar entry gains a note that the key now has two homes (the `prod-ci` item and the Environment) and both rotate together.

## Codex items

**PR 1: `hosted-workload-identity-proof.yml` (drill, dispatch-only).**
- Job `permissions: { id-token: write, contents: read }` and nothing else. `environment: production` (so the integration key resolves).
- `1password/load-secrets-action` pinned to the **v5.0.1 commit** `70062d7a876d3eb6334754fa26efd2fbd90c32f2` (resolved from the annotated tag on 2026-10-07; re-resolve and state the commit in the PR) with `env: OP_WORKLOAD_ID: ${{ vars.OP_WORKLOAD_ID }}`, `OP_ENVIRONMENT_ID: ${{ vars.OP_ENVIRONMENT_ID }}`, `OP_INTEGRATION_KEY: ${{ secrets.OP_INTEGRATION_KEY }}`, `export-env: false`, and no `OP_SERVICE_ACCOUNT_TOKEN` anywhere in the file.
- A preflight step fails closed when any of the three values is empty, naming which one.
- After loading: assert `VPS_SSH_KEY` is non-empty and passes the same shape check as the existing "Validate SSH key shape" step in `deploy-production.yml`; write it to a 0600 file; run `ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new ubuntu@<VPS_HOST> 'echo workload-identity-ok'` against `${{ secrets.VPS_HOST }}`. That is the whole proof: the job obtained the key through the broker and the key works. No production state is touched.
- The job summary prints only pass/fail per step. No key material, no IDs.

**PR 2: migrate `hosted-observability-proof.yml`** (after PR 1 is green twice, on different days).
- Replace its `load-secrets-action` block with the broker block from PR 1; add `id-token: write` to that job's permissions; remove `OP_SERVICE_ACCOUNT_TOKEN` from the file.
- Keep the rest of the workflow byte-identical.

**Tests (`scripts/ops/*.test.mjs`, YAML pins; each must go red under the named mutation):**
1. The drill and the migrated workflow contain no `OP_SERVICE_ACCOUNT_TOKEN`. *Mutation: add one.*
2. `id-token: write` appears only in those two workflows' jobs, and every other workflow still has none. *Mutation: add it to deploy-production.yml.*
3. The action is pinned by a 40-hex commit, not a tag. *Mutation: `@v5`.*
4. The preflight refuses when a value is empty (run the step's shell with the three env vars blank; expect exit 1 and the variable name in stderr). *Mutation: drop the check.*
5. The summary step prints no `ssh-` or `BEGIN` strings (pin the summary script). *Mutation: echo the key length and first line.*

**Local checks:** `npm run test:ops`.

## Exit condition

1. Drill workflow green via the broker, on two separate days.
2. `hosted-observability-proof.yml` green via the broker, with the service-account token gone from the file.
3. One week of no failures. Then Pascal widens the integration's restriction to the next reader and Codex migrates the remaining `prod-ci` readers in one PR (`deploy-production.yml` last, because it is the deploy).
4. When no workflow references `OP_SERVICE_ACCOUNT_TOKEN_PROD_CI` any more: delete that GitHub secret, revoke service account `op-token-prod-ci-deploy` (console id `YVBO5I6W…`, the non-expiring one) in the console, and record it in the calendar. That revocation is the point of the exercise.

## Out of scope, with the reason

- The `mainnet-smoke` writers: the broker path is read-only (no vault writes). Their 90-day rotation stays, tracked in the calendar.
- The VPS tokens (`op-backend.env`, `op-indexer.env`): no identity provider on the host.
- `prod-smoke` (admin JWT) and `prod-backend` (canary worker key) readers: the same migration applies, as a follow-up once the pilot has run a week.

## Fallback

The feature is in public preview. If the broker fails during the pilot, nothing is lost: the migrated workflow is dispatch-only and its service-account version is one revert away. If it fails after rollout, re-add `OP_SERVICE_ACCOUNT_TOKEN_PROD_CI` from a freshly minted account (one pipe, see the calendar's mainnet entries for the pattern).
