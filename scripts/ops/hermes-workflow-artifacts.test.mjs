import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

test("Hermes post-deploy verification keeps the full log as a workflow artifact", async () => {
  const workflow = await readFile(join(REPO_ROOT, ".github/workflows/deploy-production.yml"), "utf8");

  assert.match(workflow, /name: Upload Hermes post-deploy log/u);
  // Accept either tag-pinned (@v7) or SHA-pinned with v7 tag comment
  // (e.g., `@<40-char-sha> # v7`). Phase 4c moved this repo to SHA pins
  // for supply-chain hardening; the comment preserves audit traceability.
  assert.match(workflow, /uses: actions\/upload-artifact@(?:v7\b|[a-f0-9]{40} # v7\b)/u);
  assert.match(workflow, /name: hermes-post-deploy-\$\{\{ github\.run_id \}\}/u);
  assert.match(workflow, /path: hermes-post-deploy\.log/u);
  assert.match(workflow, /if-no-files-found: error/u);
  assert.match(workflow, /retention-days: 90/u);
});

test("Hermes PR handoff keeps the full log as a correlation-id artifact", async () => {
  const workflow = await readFile(join(REPO_ROOT, ".github/workflows/hermes-pr-handoff.yml"), "utf8");

  assert.match(workflow, /name: Upload Hermes handoff log/u);
  // Accept either tag-pinned (@v7) or SHA-pinned with v7 tag comment
  // (e.g., `@<40-char-sha> # v7`). Phase 4c moved this repo to SHA pins
  // for supply-chain hardening; the comment preserves audit traceability.
  assert.match(workflow, /uses: actions\/upload-artifact@(?:v7\b|[a-f0-9]{40} # v7\b)/u);
  assert.match(workflow, /name: hermes-handoff-\$\{\{ steps\.pr\.outputs\.correlation_id \}\}/u);
  assert.match(workflow, /path: hermes-handoff\.log/u);
  assert.match(workflow, /if-no-files-found: error/u);
  assert.match(workflow, /retention-days: 90/u);
});

test("Hermes operator self-report runs on schedule and uploads durable evidence", async () => {
  const workflow = await readFile(join(REPO_ROOT, ".github/workflows/hermes-operator-report.yml"), "utf8");

  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /schedule:/u);
  assert.match(workflow, /cron: "17 7 \* \* \*"/u);
  assert.match(workflow, /report_kind:/u);
  assert.match(workflow, /ops_health/u);
  assert.match(workflow, /daily_operator_brief/u);
  assert.match(workflow, /correlation_id="github-operator-report-\$\{\{ matrix\.report_kind \}\}-\$\{GITHUB_RUN_ID\}-\$\{GITHUB_RUN_ATTEMPT\}"/u);
  assert.match(workflow, /averray_handle_operator_command/u);
  assert.match(workflow, /durableEvidenceDestination/u);
  assert.match(workflow, /name: Upload Hermes operator report evidence/u);
  // Accept either tag-pinned (@v7) or SHA-pinned with v7 tag comment
  // (e.g., `@<40-char-sha> # v7`). Phase 4c moved this repo to SHA pins
  // for supply-chain hardening; the comment preserves audit traceability.
  assert.match(workflow, /uses: actions\/upload-artifact@(?:v7\b|[a-f0-9]{40} # v7\b)/u);
  assert.match(workflow, /name: \$\{\{ steps\.select\.outputs\.artifact_name \}\}/u);
  assert.match(workflow, /artifacts\/hermes-operator-\$\{\{ matrix\.report_kind \}\}\.log/u);
  assert.match(workflow, /artifacts\/hermes-operator-\$\{\{ matrix\.report_kind \}\}\.json/u);
  assert.match(workflow, /if-no-files-found: error/u);
  assert.match(workflow, /retention-days: 90/u);
});

test("hosted service-token proof uploads sanitized evidence as a workflow artifact", async () => {
  const workflow = await readFile(join(REPO_ROOT, ".github/workflows/hosted-service-token-proof.yml"), "utf8");

  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /environment: production/u);
  assert.match(workflow, /OP_SERVICE_ACCOUNT_TOKEN_PROD_SMOKE/u);
  assert.match(workflow, /ADMIN_JWT_OP: op:\/\/prod-smoke\/admin-jwt\/password/u);
  assert.match(workflow, /CHECK_SERVICE_TOKEN_PROOF: "1"/u);
  assert.match(workflow, /SERVICE_TOKEN_PROOF_EVIDENCE_FILE: artifacts\/service-token-proof-hosted-\$\{\{ github\.run_id \}\}\.json/u);
  assert.match(workflow, /ADMIN_JWT="\$ADMIN_JWT_OP" \.\/scripts\/ops\/check-hosted-stack\.sh/u);
  // Accept either tag-pinned (@v7) or SHA-pinned with v7 tag comment
  // (e.g., `@<40-char-sha> # v7`). Phase 4c moved this repo to SHA pins
  // for supply-chain hardening; the comment preserves audit traceability.
  assert.match(workflow, /uses: actions\/upload-artifact@(?:v7\b|[a-f0-9]{40} # v7\b)/u);
  assert.match(workflow, /name: hosted-service-token-proof-\$\{\{ github\.run_id \}\}/u);
  assert.match(workflow, /path: \$\{\{ env\.SERVICE_TOKEN_PROOF_EVIDENCE_FILE \}\}/u);
  assert.match(workflow, /if-no-files-found: error/u);
  assert.match(workflow, /retention-days: 90/u);
});

test("hosted external-schema proof uploads sanitized evidence as a workflow artifact", async () => {
  const workflow = await readFile(join(REPO_ROOT, ".github/workflows/hosted-external-schema-proof.yml"), "utf8");

  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /environment: production/u);
  assert.match(workflow, /OP_SERVICE_ACCOUNT_TOKEN_PROD_SMOKE/u);
  // JWT-TTL phase 1: this workflow mints a short-lived admin access token via
  // the refresh flow (dedicated per-consumer item) instead of loading the
  // long-lived static admin JWT — see PR #670 / docs/MAINNET_CREDENTIALS_PLAN.md (F13).
  assert.match(workflow, /uses: 1password\/install-cli-action@[a-f0-9]{40} # v4\.0\.0/u);
  assert.match(workflow, /ADMIN_REFRESH_TOKEN_OP: op:\/\/prod-smoke\/admin-refresh-token-schema-proof\/password/u);
  assert.match(workflow, /node scripts\/ops\/get-admin-refresh-token\.mjs/u);
  assert.doesNotMatch(workflow, /ADMIN_JWT_OP: op:\/\/prod-smoke\/admin-jwt\/password/u);
  assert.match(workflow, /CHECK_EXTERNAL_SCHEMA_PROOF: "1"/u);
  assert.match(workflow, /EXTERNAL_SCHEMA_PROOF_EVIDENCE_FILE: artifacts\/external-schema-proof-hosted-\$\{\{ github\.run_id \}\}\.json/u);
  assert.match(workflow, /EXTERNAL_SCHEMA_PROOF_IDEMPOTENCY_KEY: github-hosted-external-schema-proof-\$\{\{ github\.run_id \}\}/u);
  assert.match(workflow, /ADMIN_JWT="\$ADMIN_ACCESS_TOKEN" \.\/scripts\/ops\/check-hosted-stack\.sh/u);
  assert.match(workflow, /uses: actions\/upload-artifact@(?:v7\b|[a-f0-9]{40} # v7\b)/u);
  assert.match(workflow, /name: hosted-external-schema-proof-\$\{\{ github\.run_id \}\}/u);
  assert.match(workflow, /path: \$\{\{ env\.EXTERNAL_SCHEMA_PROOF_EVIDENCE_FILE \}\}/u);
  assert.match(workflow, /if-no-files-found: error/u);
  assert.match(workflow, /retention-days: 90/u);
});

test("hosted dispute verdict proof requires live confirmation and uploads evidence", async () => {
  const workflow = await readFile(join(REPO_ROOT, ".github/workflows/hosted-dispute-verdict-proof.yml"), "utf8");

  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /environment: production/u);
  assert.match(workflow, /OP_SERVICE_ACCOUNT_TOKEN_PROD_SMOKE/u);
  assert.match(workflow, /ADMIN_JWT_OP: op:\/\/prod-smoke\/admin-jwt\/password/u);
  assert.match(workflow, /CHECK_DISPUTE_VERDICT_PROOF: "1"/u);
  assert.match(workflow, /DISPUTE_PROOF_ID: \$\{\{ inputs\.dispute_id \}\}/u);
  assert.match(workflow, /DISPUTE_PROOF_VERDICT: \$\{\{ inputs\.verdict \}\}/u);
  assert.match(workflow, /DISPUTE_PROOF_RATIONALE: \$\{\{ inputs\.rationale \}\}/u);
  assert.match(workflow, /DISPUTE_PROOF_LIVE: \$\{\{ inputs\.live && '1' \|\| '0' \}\}/u);
  assert.match(workflow, /if \[ "\$DISPUTE_PROOF_LIVE" != "1" \]/u);
  assert.match(workflow, /DISPUTE_PROOF_EVIDENCE_FILE: artifacts\/dispute-verdict-proof-hosted-\$\{\{ github\.run_id \}\}\.json/u);
  assert.match(workflow, /ADMIN_JWT="\$ADMIN_JWT_OP" \.\/scripts\/ops\/check-hosted-stack\.sh/u);
  assert.match(workflow, /uses: actions\/upload-artifact@(?:v7\b|[a-f0-9]{40} # v7\b)/u);
  assert.match(workflow, /name: hosted-dispute-verdict-proof-\$\{\{ github\.run_id \}\}/u);
  assert.match(workflow, /path: \$\{\{ env\.DISPUTE_PROOF_EVIDENCE_FILE \}\}/u);
  assert.match(workflow, /if-no-files-found: error/u);
  assert.match(workflow, /retention-days: 90/u);
});

test("hosted backup readiness proof uploads validated evidence as a workflow artifact", async () => {
  const workflow = await readFile(join(REPO_ROOT, ".github/workflows/hosted-backup-readiness-proof.yml"), "utf8");

  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /environment: production/u);
  assert.match(workflow, /OP_SERVICE_ACCOUNT_TOKEN_PROD_CI/u);
  assert.match(workflow, /VPS_SSH_KEY_OP: op:\/\/prod-ci\/vps-ssh-key\/private key/u);
  assert.match(workflow, /BACKUP_READINESS_EVIDENCE_FILE: artifacts\/backup-readiness-hosted-\$\{\{ github\.run_id \}\}\.json/u);
  assert.match(workflow, /BACKUP_READINESS_VALIDATION_FILE: artifacts\/backup-readiness-validation-hosted-\$\{\{ github\.run_id \}\}\.json/u);
  assert.match(workflow, /\.\/scripts\/ops\/check-backup-readiness\.sh --json --max-age-hours "\$MAX_AGE_HOURS"/u);
  assert.match(workflow, /node scripts\/ops\/check-backup-readiness-evidence\.mjs/u);
  assert.match(workflow, /--max-checked-age-hours "\$EVIDENCE_MAX_CHECKED_AGE_HOURS"/u);
  assert.match(workflow, /uses: actions\/upload-artifact@(?:v7\b|[a-f0-9]{40} # v7\b)/u);
  assert.match(workflow, /name: hosted-backup-readiness-proof-\$\{\{ github\.run_id \}\}/u);
  assert.match(workflow, /path: \|\n\s+\$\{\{ env\.BACKUP_READINESS_EVIDENCE_FILE \}\}\n\s+\$\{\{ env\.BACKUP_READINESS_VALIDATION_FILE \}\}/u);
  assert.match(workflow, /if-no-files-found: error/u);
  assert.match(workflow, /retention-days: 90/u);
});

test("hosted backup snapshot proof creates backups before validating readiness", async () => {
  const workflow = await readFile(join(REPO_ROOT, ".github/workflows/hosted-backup-snapshot-proof.yml"), "utf8");

  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /environment: production/u);
  assert.match(workflow, /OP_SERVICE_ACCOUNT_TOKEN_PROD_CI/u);
  assert.match(workflow, /VPS_SSH_KEY_OP: op:\/\/prod-ci\/vps-ssh-key\/private key/u);
  assert.match(workflow, /BACKUP_SNAPSHOT_LOG_FILE: artifacts\/backup-snapshot-hosted-\$\{\{ github\.run_id \}\}\.log/u);
  assert.match(workflow, /BACKUP_READINESS_EVIDENCE_FILE: artifacts\/backup-readiness-hosted-\$\{\{ github\.run_id \}\}\.json/u);
  assert.match(workflow, /BACKUP_READINESS_VALIDATION_FILE: artifacts\/backup-readiness-validation-hosted-\$\{\{ github\.run_id \}\}\.json/u);
  assert.match(workflow, /\.\/scripts\/ops\/backup-postgres\.sh <\/dev\/null/u);
  assert.match(workflow, /\.\/scripts\/ops\/backup-redis\.sh <\/dev\/null/u);
  assert.doesNotMatch(workflow, /"bash -s" > "\$BACKUP_SNAPSHOT_LOG_FILE" <<'REMOTE'/u);
  assert.match(workflow, /\.\/scripts\/ops\/check-backup-readiness\.sh --json --max-age-hours "\$MAX_AGE_HOURS"/u);
  assert.match(workflow, /node scripts\/ops\/check-backup-readiness-evidence\.mjs/u);
  assert.match(workflow, /--max-checked-age-hours "\$EVIDENCE_MAX_CHECKED_AGE_HOURS"/u);
  assert.match(workflow, /uses: actions\/upload-artifact@(?:v7\b|[a-f0-9]{40} # v7\b)/u);
  assert.match(workflow, /name: hosted-backup-snapshot-proof-\$\{\{ github\.run_id \}\}/u);
  assert.match(workflow, /path: \|\n\s+\$\{\{ env\.BACKUP_SNAPSHOT_LOG_FILE \}\}\n\s+\$\{\{ env\.BACKUP_READINESS_EVIDENCE_FILE \}\}\n\s+\$\{\{ env\.BACKUP_READINESS_VALIDATION_FILE \}\}/u);
  assert.match(workflow, /if-no-files-found: error/u);
  assert.match(workflow, /retention-days: 90/u);
});

test("hosted backup restore drill proof restores selected backups into disposable containers", async () => {
  const workflow = await readFile(join(REPO_ROOT, ".github/workflows/hosted-backup-restore-drill-proof.yml"), "utf8");

  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /environment: production/u);
  assert.match(workflow, /OP_SERVICE_ACCOUNT_TOKEN_PROD_CI/u);
  assert.match(workflow, /VPS_SSH_KEY_OP: op:\/\/prod-ci\/vps-ssh-key\/private key/u);
  assert.match(workflow, /BACKUP_READINESS_EVIDENCE_FILE: artifacts\/backup-readiness-hosted-\$\{\{ github\.run_id \}\}\.json/u);
  assert.match(workflow, /RESTORE_DRILL_EVIDENCE_FILE: artifacts\/restore-drill-hosted-\$\{\{ github\.run_id \}\}\.json/u);
  assert.match(workflow, /RESTORE_DRILL_VALIDATION_FILE: artifacts\/restore-drill-validation-hosted-\$\{\{ github\.run_id \}\}\.json/u);
  assert.match(workflow, /node scripts\/ops\/check-backup-readiness-evidence\.mjs/u);
  assert.match(workflow, /scp -P "\$\{VPS_PORT:-22\}"/u);
  assert.match(workflow, /node scripts\/ops\/run-restore-drill-from-backups\.mjs/u);
  assert.match(workflow, /node scripts\/ops\/check-restore-drill-evidence\.mjs/u);
  assert.match(workflow, /uses: actions\/upload-artifact@(?:v7\b|[a-f0-9]{40} # v7\b)/u);
  assert.match(workflow, /name: hosted-backup-restore-drill-proof-\$\{\{ github\.run_id \}\}/u);
  assert.match(workflow, /path: \|\n\s+\$\{\{ env\.BACKUP_READINESS_EVIDENCE_FILE \}\}\n\s+\$\{\{ env\.RESTORE_DRILL_EVIDENCE_FILE \}\}\n\s+\$\{\{ env\.RESTORE_DRILL_VALIDATION_FILE \}\}/u);
  assert.match(workflow, /if-no-files-found: error/u);
  assert.match(workflow, /retention-days: 90/u);
});
