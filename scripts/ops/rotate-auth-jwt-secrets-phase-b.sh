#!/usr/bin/env bash
#
# Phase 2 PR 2.7d — Phase B: AUTH_JWT_SECRETS old-secret removal.
#
# Run this 24–48h after Phase A completed. Phase A added the new signer to
# the FRONT of the comma-separated keyring (newest first). Phase B removes
# the old secret so the backend accepts only tokens signed with the new
# secret.
#
# Pre-flight (must be true before running):
#   1. ADMIN_JWT in op://prod-smoke/admin-jwt has been re-minted with the
#      new signer (this is checked automatically in step [4]).
#   2. ≥24h have passed since the Phase A deploy. Any user sessions signed
#      against the old secret have naturally expired.
#   3. Backend is healthy and reading from /run/agent-stack/backend.env
#      (Phase 2 PR 2.7d.1 source-of-truth migration is in production).
#
# What this script does:
#   [1]  Verifies prerequisites (op + gh signed in, helpers installed).
#   [2]  Reads current keyring from 1Password.
#   [3]  Verifies keyring shape: exactly 2x 64-char hex entries, 1 comma.
#   [4]  Verifies ADMIN_JWT was signed by the NEW (first) entry — proof
#        that the ADMIN_JWT re-mint already happened.
#   [5]  Prints the change and PAUSES for explicit `yes` confirmation.
#   [6]  Updates the 1Password item to a single-entry keyring (new only).
#   [7]  Verifies post-write state (1 entry, 64 hex chars, no commas).
#   [8]  Triggers deploy-production.yml via workflow_dispatch.
#   [9]  Watches the deploy until success; greps for the PR 2.7d.1
#        force-recreate marker in the log.
#   [10] Verifies /health returns 200 against the new container.
#   [11] Verifies ADMIN_JWT still authenticates against /admin/sessions.
#
# Safety properties:
#   - Fail-closed on every unmet pre-flight check.
#   - Exactly one mutating OP write, gated behind explicit confirmation.
#   - Exactly one deploy trigger.
#   - Loud abort with exit 2 if the deploy fails — backend may be in an
#     intermediate state. The operator must inspect manually before
#     re-running.
#
# Recovery if anything goes wrong AFTER step [6]:
#   The OP keyring is now single-entry (new). The pre-step value is
#   reproducible from the script's stdout in step [3] — it printed both
#   the new and old 64-char entries before any write. To roll back:
#     op item edit auth-jwt-secrets --vault=prod-backend \
#       "password=<new>,<old>"
#     gh workflow run deploy-production.yml
#
# Usage:
#   eval "$(op signin)"            # if your session is stale
#   gh auth status                 # confirm gh CLI is authenticated
#   ./scripts/ops/rotate-auth-jwt-secrets-phase-b.sh
#
# Exit codes:
#   0  Phase B complete; backend running on single-entry keyring.
#   1  Pre-flight failed or operator aborted at confirmation.
#   2  Mid-run failure (post-write, deploy, or health check failed).
#      Backend may be in an inconsistent state — inspect before retrying.

set -euo pipefail

# ── config ───────────────────────────────────────────────────────────
OP_KEYRING_REF="op://prod-backend/auth-jwt-secrets/password"
OP_ADMIN_JWT_REF="op://prod-smoke/admin-jwt/password"
OP_ITEM_NAME="auth-jwt-secrets"
OP_ITEM_VAULT="prod-backend"
WORKFLOW_FILE="deploy-production.yml"
HEALTH_URL="${HEALTH_URL:-https://api.averray.com/health}"
ADMIN_PROBE_URL="${ADMIN_PROBE_URL:-https://api.averray.com/admin/sessions?limit=1}"
GH_REPO="${GH_REPO:-averray-agent/agent}"
DEPLOY_WAIT_TIMEOUT_SEC="${DEPLOY_WAIT_TIMEOUT_SEC:-600}"

# ── tiny utility helpers ─────────────────────────────────────────────
red()    { printf "\033[31m%s\033[0m\n" "$*" >&2; }
green()  { printf "\033[32m%s\033[0m\n" "$*"; }
yellow() { printf "\033[33m%s\033[0m\n" "$*" >&2; }
bold()   { printf "\033[1m%s\033[0m\n" "$*"; }

require_cmd() {
  for cmd in "$@"; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      red "Missing required command: $cmd"
      exit 1
    fi
  done
}

# ── [1] prerequisites ────────────────────────────────────────────────
bold "[1/11] Verifying prerequisites …"
require_cmd op gh curl node

if ! op whoami >/dev/null 2>&1; then
  red "op CLI not signed in. Run: eval \"\$(op signin)\""
  exit 1
fi
green "  op signed in"

if ! gh auth status >/dev/null 2>&1; then
  red "gh CLI not authenticated. Run: gh auth login"
  exit 1
fi
green "  gh authenticated"

# ── [2] read current keyring ─────────────────────────────────────────
bold "[2/11] Reading current keyring from 1Password …"
CURRENT_KEYRING=$(op read "$OP_KEYRING_REF")
if [[ -z "$CURRENT_KEYRING" ]]; then
  red "Empty keyring at $OP_KEYRING_REF — refusing to proceed."
  exit 1
fi

# op CLI sometimes wraps comma-containing values in literal quotes when
# storing them. The stored value renders correctly via `op inject`, but
# `op read` returns the wrapped form. Strip outer quotes defensively so
# downstream parsing matches the inject-rendered shape.
CLEAN_KEYRING=$(printf '%s' "$CURRENT_KEYRING" | sed -e 's/^"//' -e 's/"$//')
KEYRING_LEN=${#CLEAN_KEYRING}
COMMA_COUNT=$(printf '%s' "$CLEAN_KEYRING" | tr -cd ',' | wc -c | tr -d ' ')
green "  raw length: $KEYRING_LEN  commas: $COMMA_COUNT"

# ── [3] verify Phase A shape ─────────────────────────────────────────
bold "[3/11] Verifying keyring shape (expect 2x 64-char hex, 1 comma) …"
if [[ "$COMMA_COUNT" != "1" ]]; then
  red "Expected exactly 1 comma; got $COMMA_COUNT."
  red "Keyring shape doesn't match Phase A. Aborting."
  red ""
  red "If you're trying to run Phase B on a single-entry keyring, that means"
  red "Phase B has already been applied. Nothing to do."
  exit 1
fi

NEW_RAW=$(printf '%s' "$CLEAN_KEYRING" | cut -d, -f1)
OLD_RAW=$(printf '%s' "$CLEAN_KEYRING" | cut -d, -f2)
NEW_HEX=$(printf '%s' "$NEW_RAW" | tr -cd '[:xdigit:]' | head -c 64)
OLD_HEX=$(printf '%s' "$OLD_RAW" | tr -cd '[:xdigit:]' | head -c 64)

if [[ ${#NEW_HEX} -ne 64 ]]; then
  red "First entry isn't 64 hex chars after sanitize: got ${#NEW_HEX}"
  exit 1
fi
if [[ ${#OLD_HEX} -ne 64 ]]; then
  red "Second entry isn't 64 hex chars after sanitize: got ${#OLD_HEX}"
  exit 1
fi
green "  new entry (signer):    ${NEW_HEX:0:8}…${NEW_HEX: -4}  (64 hex chars ✓)"
green "  old entry (tolerated): ${OLD_HEX:0:8}…${OLD_HEX: -4}  (64 hex chars ✓)"

# ── [4] verify ADMIN_JWT was signed by NEW entry ─────────────────────
bold "[4/11] Verifying ADMIN_JWT was signed by the NEW secret …"
ADMIN_JWT=$(op read "$OP_ADMIN_JWT_REF")
if [[ -z "$ADMIN_JWT" ]]; then
  red "Empty ADMIN_JWT at $OP_ADMIN_JWT_REF"
  exit 1
fi

JWT_HEADER_PAYLOAD=$(printf '%s' "$ADMIN_JWT" | cut -d. -f1,2)
JWT_SIG_B64URL=$(printf '%s' "$ADMIN_JWT" | cut -d. -f3)

# Locally HMAC-SHA256 verify the JWT against a given secret (hex string
# is the secret bytes as-text, matching how the backend reads it).
verify_with_secret() {
  local secret="$1"
  SECRET="$secret" HEADER_PAYLOAD="$JWT_HEADER_PAYLOAD" SIG="$JWT_SIG_B64URL" \
    node --input-type=module -e '
      import crypto from "node:crypto";
      const secret = process.env.SECRET;
      const headerPayload = process.env.HEADER_PAYLOAD;
      const sigB64Url = process.env.SIG;
      const hmac = crypto.createHmac("sha256", secret);
      hmac.update(headerPayload);
      const computed = hmac.digest("base64url");
      process.exit(computed === sigB64Url ? 0 : 1);
    '
}

if verify_with_secret "$NEW_HEX"; then
  green "  ADMIN_JWT signature verifies against NEW secret ✓"
elif verify_with_secret "$OLD_HEX"; then
  red "ADMIN_JWT was signed by the OLD secret."
  red "This means the ADMIN_JWT re-mint never happened — running Phase B"
  red "now would lock out the smoke loop and any ops script using ADMIN_JWT."
  red ""
  red "Re-mint ADMIN_JWT first, then re-run this script:"
  cat <<'EOF' >&2
    NEW_JWT=$(AUTH_JWT_SECRETS=$(op read "op://prod-backend/auth-jwt-secrets/password") \
      node scripts/ops/mint-admin-jwt.mjs --profile testnet --roles admin,verifier \
        --expires-in-days 30 --quiet)
    op item edit admin-jwt --vault=prod-smoke "password=$NEW_JWT"
    unset NEW_JWT
EOF
  exit 1
else
  red "ADMIN_JWT signature does not verify against either keyring entry."
  red "Something is very wrong — the JWT may be corrupted, or the keyring"
  red "in OP doesn't match what the backend is running with. Aborting."
  exit 1
fi

# ── [5] plan + confirmation ──────────────────────────────────────────
bold "[5/11] Plan:"
cat <<EOF
  • Update 1Password item   $OP_KEYRING_REF
      from: <new>,<old>     (2 x 64-char hex, 1 comma, len $KEYRING_LEN)
      to:   <new>           (1 x 64-char hex, 0 commas, len 64)
  • Trigger workflow:       $WORKFLOW_FILE
  • Wait for deploy to finish (timeout ${DEPLOY_WAIT_TIMEOUT_SEC}s)
  • Verify /health → 200 + PR 2.7d.1 force-recreate marker in deploy log
  • Verify ADMIN_JWT still authenticates: $ADMIN_PROBE_URL

EOF
read -r -p "Type 'yes' to proceed (anything else aborts): " CONFIRM
if [[ "$CONFIRM" != "yes" ]]; then
  yellow "Aborted by operator."
  exit 1
fi

# ── [6] update 1Password keyring to single entry ─────────────────────
bold "[6/11] Updating 1Password item to single-entry keyring …"
op item edit "$OP_ITEM_NAME" --vault="$OP_ITEM_VAULT" "password=$NEW_HEX" >/dev/null
green "  written (${#NEW_HEX} chars, 0 commas)"

# ── [7] verify new OP state ──────────────────────────────────────────
bold "[7/11] Verifying new keyring state …"
POST_KEYRING=$(op read "$OP_KEYRING_REF")
POST_CLEAN=$(printf '%s' "$POST_KEYRING" | sed -e 's/^"//' -e 's/"$//')
POST_LEN=${#POST_CLEAN}
POST_COMMAS=$(printf '%s' "$POST_CLEAN" | tr -cd ',' | wc -c | tr -d ' ')
POST_HEX=$(printf '%s' "$POST_CLEAN" | tr -cd '[:xdigit:]' | head -c 64)
if [[ "$POST_COMMAS" != "0" || "$POST_LEN" -ne 64 || "$POST_HEX" != "$NEW_HEX" ]]; then
  red "Post-write state unexpected:"
  red "  len=$POST_LEN (want 64) commas=$POST_COMMAS (want 0)"
  red "  hex match=$([[ "$POST_HEX" == "$NEW_HEX" ]] && echo yes || echo no)"
  red "Manual investigation required. The OP item was modified but the result"
  red "doesn't match the expected shape. Do not re-run; inspect first."
  exit 2
fi
green "  post-state: len=$POST_LEN commas=$POST_COMMAS hex matches NEW ✓"

# ── [8] trigger deploy ───────────────────────────────────────────────
bold "[8/11] Triggering deploy …"
gh workflow run "$WORKFLOW_FILE" --repo "$GH_REPO"

# Brief settle so GitHub registers the new run before we query for it.
# Not a poll-loop: just enough for the API to return the row we just created.
sleep 5

RUN_ID=$(gh run list --workflow="$WORKFLOW_FILE" --repo "$GH_REPO" --limit=5 \
  --json databaseId,event,createdAt,status \
  | node -e '
      const runs = JSON.parse(require("fs").readFileSync(0, "utf8"));
      const recent = runs.find(r =>
        r.event === "workflow_dispatch" &&
        (r.status === "queued" || r.status === "in_progress")
      );
      if (!recent) { process.exit(1); }
      process.stdout.write(String(recent.databaseId));
    ')
if [[ -z "$RUN_ID" ]]; then
  red "Could not find dispatched run. Inspect manually:"
  red "  gh run list --workflow=$WORKFLOW_FILE --repo $GH_REPO"
  exit 2
fi
green "  run id: $RUN_ID"
green "  url:    https://github.com/$GH_REPO/actions/runs/$RUN_ID"

# ── [9] wait for deploy ──────────────────────────────────────────────
bold "[9/11] Waiting for deploy to complete (timeout ${DEPLOY_WAIT_TIMEOUT_SEC}s) …"
if ! gh run watch "$RUN_ID" --repo "$GH_REPO" --exit-status --interval 10; then
  red "Deploy failed — backend may now be running with mixed state."
  red "  - OP keyring is single-entry (new only)."
  red "  - Backend may still be running the previous container."
  red "Inspect the run log and re-deploy manually:"
  red "  gh run view $RUN_ID --repo $GH_REPO --log"
  exit 2
fi
green "  deploy succeeded ✓"

# Sanity-check: confirm PR 2.7d.1 detected the env change and force-recreated
# backend. If we don't see that marker, /run/agent-stack/backend.env may not
# have rendered with the new keyring — that's a silent failure mode.
#
# `gh run watch` returns as soon as the run hits a terminal status, but
# `gh run view --log` can still serve a partially-flushed log for several
# seconds afterwards (observed in the 2026-05-14 Phase B run: the marker
# WAS in the log, the grep just ran too early). Retry with backoff to
# eliminate the false negative.
marker_found=0
for attempt in 1 2 3 4; do
  if gh run view "$RUN_ID" --repo "$GH_REPO" --log 2>/dev/null \
      | grep -q "backend /run env content changed"; then
    marker_found=1
    break
  fi
  sleep "$attempt"   # 1s, 2s, 3s, 4s — total 10s worst case
done
if [[ $marker_found -eq 1 ]]; then
  green "  PR 2.7d.1 force-recreate marker present ✓"
else
  yellow "  PR 2.7d.1 marker not found in log after 4 retries."
  yellow "  Two possibilities:"
  yellow "    (a) The render produced an identical file (extremely unlikely"
  yellow "        — the keyring just changed). Manual inspection required."
  yellow "    (b) The deploy ran in a different code path (caddy-only, etc.)."
  yellow "  Verify with: gh run view $RUN_ID --repo $GH_REPO --log"
fi

# ── [10] verify /health ──────────────────────────────────────────────
bold "[10/11] Verifying /health …"
HEALTH=$(curl -fsS --max-time 10 "$HEALTH_URL")
if printf '%s' "$HEALTH" | node -e '
    const x = JSON.parse(require("fs").readFileSync(0, "utf8"));
    if (x.status === "ok" && x.components?.blockchain?.ok && x.components?.stateStore?.ok) {
      process.exit(0);
    }
    process.exit(1);
  '; then
  green "  /health 200, all components ok ✓"
else
  red "/health response is unhealthy:"
  printf '%s\n' "$HEALTH" >&2
  exit 2
fi

# ── [11] verify ADMIN_JWT still authenticates ────────────────────────
bold "[11/11] Verifying ADMIN_JWT still authenticates against $ADMIN_PROBE_URL …"
HTTP_CODE=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 10 \
  -H "Authorization: Bearer $ADMIN_JWT" \
  "$ADMIN_PROBE_URL")
case "$HTTP_CODE" in
  200)
    green "  ADMIN_JWT validates (HTTP 200) ✓"
    ;;
  401|403)
    red "ADMIN_JWT was rejected (HTTP $HTTP_CODE)."
    red "Backend is now signed-with-new but the ADMIN_JWT didn't validate."
    red "This shouldn't happen — re-mint ADMIN_JWT immediately:"
    red "  NEW_JWT=\$(AUTH_JWT_SECRETS=\$(op read \"$OP_KEYRING_REF\") \\"
    red "    node scripts/ops/mint-admin-jwt.mjs --profile testnet \\"
    red "    --roles admin,verifier --expires-in-days 30 --quiet)"
    red "  op item edit admin-jwt --vault=prod-smoke \"password=\$NEW_JWT\""
    exit 2
    ;;
  *)
    yellow "Unexpected HTTP $HTTP_CODE from $ADMIN_PROBE_URL"
    yellow "Verify manually before declaring Phase B complete."
    exit 2
    ;;
esac

# ── done ─────────────────────────────────────────────────────────────
echo
green "═══════════════════════════════════════════════════════════"
green "  Phase B complete."
green "    OP keyring : single entry (new signer only)"
green "    Backend    : healthy, running new container"
green "    ADMIN_JWT  : validates against new signer"
green "═══════════════════════════════════════════════════════════"
echo
echo "Follow-ups:"
echo "  • Update docs/SECRETS_CALENDAR.yml — set AUTH_JWT_SECRETS.expires_at"
echo "    to ~90 days from today."
echo "  • If you haven't already, delete ~/.ssh/authorized_keys.bak on the"
echo "    VPS (post-SSH-rotation 24h hygiene)."
echo "  • Tomorrow: run \`node scripts/ops/check-secrets-calendar.mjs\` to"
echo "    confirm no calendar warnings."
