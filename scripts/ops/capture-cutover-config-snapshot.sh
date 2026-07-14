#!/usr/bin/env bash

set -euo pipefail

STACK_ROOT=${STACK_ROOT:-/srv/agent-stack}
RUNTIME_ROOT=${RUNTIME_ROOT:-/run/agent-stack}
CONFIG_ROOT=${CONFIG_ROOT:-/etc/agent-stack}
BACKUP_DIR=${BACKUP_DIR:-"$STACK_ROOT/backups/cutover"}
WORK_ROOT=${WORK_ROOT:-/dev/shm}
OPENSSL_BIN=${OPENSSL_BIN:-openssl}
KDF_ITERATIONS=${KDF_ITERATIONS:-600000}
TIMESTAMP=${TIMESTAMP:-$(date -u +"%Y%m%d-%H%M%S")}
HOST_LABEL=${HOST_LABEL:-$(hostname -s)}

usage() {
  cat <<'EOF'
Usage: capture-cutover-config-snapshot.sh

Reads one encryption passphrase from stdin and writes an AES-256-CBC/PBKDF2
archive containing the live testnet compose/Caddy configuration, runtime envs,
1Password service-token envs, AWS shared config, and Roles Anywhere material.

The passphrase must be at least 32 characters and should be piped directly from
a human-only secret store. It is held only in a mode-0600 file under WORK_ROOT
(default /dev/shm), then removed. No plaintext snapshot is written to disk.
EOF
}

if [[ "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ "$#" -ne 0 ]]; then
  usage >&2
  exit 2
fi

if ! [[ "$KDF_ITERATIONS" =~ ^[0-9]+$ ]] || (( KDF_ITERATIONS < 100000 )); then
  echo "KDF_ITERATIONS must be an integer >= 100000" >&2
  exit 2
fi

passphrase=""
IFS= read -r passphrase || true
if (( ${#passphrase} < 32 )); then
  echo "Snapshot passphrase must be at least 32 characters" >&2
  exit 1
fi

required_paths=(
  "$STACK_ROOT/docker-compose.yml"
  "$STACK_ROOT/Caddyfile"
  "$RUNTIME_ROOT/backend.env"
  "$RUNTIME_ROOT/indexer.env"
  "$CONFIG_ROOT/op-backend.env"
  "$CONFIG_ROOT/op-indexer.env"
  "$CONFIG_ROOT/aws-config"
  "$CONFIG_ROOT/roles-anywhere"
)

for path in "${required_paths[@]}"; do
  if [[ ! -e "$path" ]]; then
    echo "Required cutover snapshot path is missing: $path" >&2
    exit 1
  fi
done

snapshot_paths=()
add_snapshot_path() {
  local candidate="$1"
  local existing
  [[ -e "$candidate" ]] || return 0
  for existing in "${snapshot_paths[@]-}"; do
    [[ "$existing" == "$candidate" ]] && return 0
  done
  snapshot_paths+=("$candidate")
}

for path in "${required_paths[@]}"; do
  add_snapshot_path "$path"
done

shopt -s nullglob
for path in "$STACK_ROOT"/.env "$STACK_ROOT"/*.env "$RUNTIME_ROOT"/*.env "$CONFIG_ROOT"/*.env; do
  add_snapshot_path "$path"
done
shopt -u nullglob

mkdir -p "$BACKUP_DIR" "$WORK_ROOT"
chmod 0700 "$BACKUP_DIR"
umask 077

passphrase_file=$(mktemp "$WORK_ROOT/averray-cutover-passphrase.XXXXXX")
manifest_dir=$(mktemp -d "$WORK_ROOT/averray-cutover-manifest.XXXXXX")
restore_dir=$(mktemp -d "$WORK_ROOT/averray-cutover-restore.XXXXXX")
archive="$BACKUP_DIR/testnet-config-${TIMESTAMP}.tar.gz.aes256"
archive_tmp="${archive}.tmp.$$"

cleanup() {
  passphrase=""
  rm -f "$passphrase_file" "$archive_tmp"
  rm -rf "$manifest_dir" "$restore_dir"
}
trap cleanup EXIT INT TERM

printf '%s' "$passphrase" > "$passphrase_file"
chmod 0600 "$passphrase_file"
passphrase=""

manifest="$manifest_dir/cutover-snapshot-manifest.txt"
{
  printf 'schema=cutover-testnet-config-v1\n'
  printf 'captured_at=%s\n' "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  printf 'host=%s\n' "$HOST_LABEL"
  printf 'encrypted=true\n'
  printf 'cipher=aes-256-cbc\n'
  printf 'kdf=pbkdf2-sha256\n'
  printf 'kdf_iterations=%s\n' "$KDF_ITERATIONS"
  printf 'paths:\n'
  for path in "${snapshot_paths[@]}"; do
    printf '  /%s\n' "${path#/}"
  done
} > "$manifest"

relative_paths=()
for path in "${snapshot_paths[@]}"; do
  relative_paths+=("${path#/}")
done

tar -C / -czf - "${relative_paths[@]}" -C "$manifest_dir" cutover-snapshot-manifest.txt \
  | "$OPENSSL_BIN" enc -aes-256-cbc -salt -pbkdf2 -md sha256 \
      -iter "$KDF_ITERATIONS" -pass "file:$passphrase_file" -out "$archive_tmp"

"$OPENSSL_BIN" enc -d -aes-256-cbc -pbkdf2 -md sha256 \
  -iter "$KDF_ITERATIONS" -pass "file:$passphrase_file" -in "$archive_tmp" \
  | tar -xzf - -C "$restore_dir"

for path in "${snapshot_paths[@]}"; do
  restored="$restore_dir/${path#/}"
  if [[ -d "$path" ]]; then
    diff -qr "$path" "$restored" >/dev/null
  elif ! cmp -s "$path" "$restored"; then
    echo "Restored snapshot does not match live source: $path" >&2
    exit 1
  fi
done

mv "$archive_tmp" "$archive"
chmod 0600 "$archive"

if command -v sha256sum >/dev/null 2>&1; then
  archive_sha=$(sha256sum "$archive" | awk '{print $1}')
else
  archive_sha=$(shasum -a 256 "$archive" | awk '{print $1}')
fi

printf 'snapshot=%s\n' "$archive"
printf 'sha256=%s\n' "$archive_sha"
printf 'integrity=verified\n'
printf 'restore_check=verified\n'
