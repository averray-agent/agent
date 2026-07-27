#!/usr/bin/env bash

set -euo pipefail
set +x

op_ref=${1:-}
prefix_length=${FINGERPRINT_PREFIX_LENGTH:-8}

if [[ "$op_ref" != op://* ]]; then
  echo "Usage: fingerprint-op-secret.sh op://vault/item/field" >&2
  exit 2
fi
if [[ ! "$prefix_length" =~ ^[1-9][0-9]*$ ]] || (( prefix_length > 64 )); then
  echo "FINGERPRINT_PREFIX_LENGTH must be between 1 and 64." >&2
  exit 2
fi

# Command substitution removes trailing newlines from `op read`; printf adds
# none back. Fingerprints therefore represent the exact token consumers send,
# independent of whether a wrapper writes a display newline.
value=$(op read "$op_ref")
if [[ -z "$value" ]]; then
  echo "1Password returned an empty value for $op_ref." >&2
  exit 1
fi

digest=$(printf '%s' "$value" | shasum -a 256 | awk '{print $1}')
printf '%s\n' "${digest:0:prefix_length}"
