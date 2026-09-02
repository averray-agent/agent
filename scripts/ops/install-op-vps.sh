#!/usr/bin/env bash
#
# install-op-vps.sh — idempotent 1Password CLI installer for the
# production VPS (Debian/Ubuntu).
#
# Phase 2 PR 2.3 of the secrets migration. Wire-frame for the runtime
# (`op` CLI) that PR 2.3's render-vps-env.sh depends on. Subsequent
# steps (drop service-account tokens, install tmpfiles.d snippet,
# verify `op vault list`) are documented in SECRETS_MIGRATION.md.
#
# What this script does:
#   1. Verifies it's running as root on an apt-based system.
#   2. Adds 1Password's signing key to /usr/share/keyrings/.
#   3. Adds the 1Password apt source with `signed-by=` referencing
#      the keyring file (NOT the trusted.gpg.d global keyring — per
#      Debian's apt-secure docs, scoped keyrings are the correct
#      practice).
#   4. apt-get update + install 1password-cli.
#   5. Logs the installed version and the key fingerprint for audit.
#
# Idempotency: re-running is safe. The keyring + source files are
# overwritten with the same content; apt is told there are no changes
# to publish; install is a no-op if the package is already current.
#
# Trust chain: the signing key comes from
# https://downloads.1password.com/linux/keys/1password.asc over TLS.
# The integrity guarantee is the HTTPS certificate chain on
# downloads.1password.com — same trust model 1Password's own install
# docs use. If you want stricter, fetch the key once on a trusted
# machine, verify its fingerprint out-of-band, and pin its SHA-256
# in this script.
#
# Usage (on VPS, as root):
#   sudo bash install-op-vps.sh

set -euo pipefail
set +x

fail() { echo "install-op-vps.sh: $*" >&2; exit 1; }
info() { echo "install-op-vps.sh: $*"; }

# ── Pre-flight ─────────────────────────────────────────────────────────────

[ "$(id -u)" -eq 0 ] || fail "must run as root (try: sudo bash install-op-vps.sh)"

if ! command -v apt-get >/dev/null 2>&1; then
  fail "apt-get not found; this script targets Debian/Ubuntu only"
fi

# Identify the distro for the log only — actual apt source is the
# same for Debian and Ubuntu per 1Password's published packages.
. /etc/os-release 2>/dev/null || true
info "host: ${PRETTY_NAME:-unknown} ($(uname -m))"

# ── Signing key ────────────────────────────────────────────────────────────

KEYRING=/usr/share/keyrings/1password-archive-keyring.gpg
SOURCE_LIST=/etc/apt/sources.list.d/1password.list

info "downloading 1Password signing key..."
tmpkey=$(mktemp)
trap 'rm -f "$tmpkey"' EXIT
curl -fsSL --proto '=https' --tlsv1.2 \
  https://downloads.1password.com/linux/keys/1password.asc \
  -o "$tmpkey"

# Dearmor to binary form and install in scoped keyring location.
gpg --dearmor < "$tmpkey" > "$KEYRING"
chmod 0644 "$KEYRING"
chown root:root "$KEYRING"

# Log the key fingerprint for audit. Operators can compare to the
# fingerprint published at 1Password's docs.
info "installed signing key:"
gpg --no-default-keyring --keyring "$KEYRING" --list-keys 2>&1 | sed 's/^/    /'

# ── apt source ─────────────────────────────────────────────────────────────

info "writing apt source to $SOURCE_LIST..."
cat > "$SOURCE_LIST" <<'EOF'
deb [arch=amd64 signed-by=/usr/share/keyrings/1password-archive-keyring.gpg] https://downloads.1password.com/linux/debian/amd64 stable main
EOF
chmod 0644 "$SOURCE_LIST"
chown root:root "$SOURCE_LIST"

# ── Debsig policy (1Password's recommended extra layer) ────────────────────
#
# 1Password also publishes a debsig policy that validates installed
# packages against the same signing key. This is belt-and-suspenders
# beyond the apt-secure check. We install it because the cost is zero
# and the audit trail is cleaner.

mkdir -p /etc/debsig/policies/AC2D62742012EA22
mkdir -p /usr/share/debsig/keyrings/AC2D62742012EA22

if [ ! -f /etc/debsig/policies/AC2D62742012EA22/1password.pol ]; then
  curl -fsSL --proto '=https' --tlsv1.2 \
    https://downloads.1password.com/linux/debian/debsig/1password.pol \
    -o /etc/debsig/policies/AC2D62742012EA22/1password.pol
fi

cp -f "$KEYRING" /usr/share/debsig/keyrings/AC2D62742012EA22/debsig.gpg

# ── Install ────────────────────────────────────────────────────────────────

info "running apt-get update..."
apt-get update -qq

info "installing 1password-cli..."
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq 1password-cli

# ── Verify ─────────────────────────────────────────────────────────────────

if ! command -v op >/dev/null 2>&1; then
  fail "op installed but not in PATH; check /usr/bin/op"
fi

info "installed version: $(op --version)"
info "binary location:   $(command -v op)"

# Cleanup
rm -f "$tmpkey"
trap - EXIT

cat <<'NEXT'

install-op-vps.sh: complete.

Next operator steps (do these manually, see SECRETS_MIGRATION.md Phase 2 PR 2.3):

  1. Create /etc/agent-stack/ directory:
       sudo install -d -m 0755 /etc/agent-stack

  2. Drop the per-runtime service-account tokens. From your laptop with
     an active op signin, scp the values to the VPS:

       # On laptop (one terminal):
       BACKEND_TOKEN=$(op read 'op://prod-critical/op-token-prod-vps-backend/credential')
       INDEXER_TOKEN=$(op read 'op://prod-critical/op-token-prod-vps-indexer/credential')

       # Then scp via a heredoc that writes the file with strict perms:
       ssh ubuntu@<VPS> "sudo tee /etc/agent-stack/op-backend.env > /dev/null" <<< "OP_SERVICE_ACCOUNT_TOKEN=$BACKEND_TOKEN"
       ssh ubuntu@<VPS> "sudo tee /etc/agent-stack/op-indexer.env > /dev/null" <<< "OP_SERVICE_ACCOUNT_TOKEN=$INDEXER_TOKEN"
       ssh ubuntu@<VPS> "sudo chmod 0400 /etc/agent-stack/op-backend.env /etc/agent-stack/op-indexer.env && sudo chown root:root /etc/agent-stack/op-*.env"

       unset BACKEND_TOKEN INDEXER_TOKEN

  3. Install systemd-tmpfiles snippet for /run/agent-stack:
       sudo cp /srv/agent-stack/app/deploy/agent-stack.tmpfiles.conf /etc/tmpfiles.d/agent-stack.conf
       sudo systemd-tmpfiles --create
       ls -ld /run/agent-stack   # expect: drwx------ root root

  4. Verify both tokens work:
       sudo -E env OP_SERVICE_ACCOUNT_TOKEN="$(sudo cat /etc/agent-stack/op-backend.env | cut -d= -f2)" op vault list
       sudo -E env OP_SERVICE_ACCOUNT_TOKEN="$(sudo cat /etc/agent-stack/op-indexer.env | cut -d= -f2)" op vault list

     Backend token should list prod-backend + prod-backend-external.
     Indexer token should list prod-indexer.

  5. Run render-vps-env.sh manually to verify it produces a healthy
     /run/agent-stack/backend.env that matches the live env file:

       sudo /srv/agent-stack/app/scripts/ops/render-vps-env.sh \
         /srv/agent-stack/app/deploy/backend.env.template \
         /run/agent-stack/backend.env \
         /etc/agent-stack/op-backend.env

       sudo diff <(sort /run/agent-stack/backend.env) <(sort /srv/agent-stack/backend.env) | head -50

     Expect: zero diff (or only ordering differences) when the
     template's TODO(operator) lines have been filled in correctly.
NEXT
