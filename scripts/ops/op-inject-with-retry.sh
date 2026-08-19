#!/usr/bin/env bash

set -euo pipefail
set +x

if [[ "$#" -ne 4 ]]; then
  echo "Usage: op-inject-with-retry.sh <template> <rendered> <stdout-file> <stderr-file>" >&2
  exit 2
fi

template="$1"
rendered="$2"
stdout_file="$3"
stderr_file="$4"
retry_delay="${OP_INJECT_RETRY_DELAY_SEC:-5}"

if [[ ! "$retry_delay" =~ ^[0-9]+$ ]]; then
  echo "op-inject-with-retry.sh: OP_INJECT_RETRY_DELAY_SEC must be a non-negative integer." >&2
  exit 2
fi

run_inject() {
  op inject --in-file "$template" --out-file "$rendered" --force --cache=false \
    >"$stdout_file" 2>"$stderr_file"
}

if run_inject; then
  exit 0
fi

# A 1Password upstream 5xx is transport-level and gets one bounded retry.
# Authentication, reference, and validation errors fail immediately.
if ! grep -Eq '(^|[^0-9])5[0-9]{2}([^0-9]|$)' "$stderr_file"; then
  exit 1
fi

echo "op-inject-with-retry.sh: op inject returned an upstream 5xx; retrying once in ${retry_delay}s." >&2
sleep "$retry_delay"
run_inject
