#!/usr/bin/env bash
set -euo pipefail

# Body arrives on stdin. Delivery responses and credentials stay out of logs.
if [[ -z "${PHONE_PUSH_URL:-}" ]]; then
  echo "phone push not configured or undeliverable" >&2
  exit 1
fi

if [[ $# -ne 4 || ! "$2" =~ ^[1-5]$ ]]; then
  echo "Usage: phone-push.sh <title> <priority 1-5> <tags> <click-url>" >&2
  exit 2
fi
for header in "$@"; do
  if [[ "$header" == *$'\n'* || "$header" == *$'\r'* ]]; then
    echo "invalid phone push header" >&2
    exit 2
  fi
done

if ! curl --fail --silent --show-error --connect-timeout 10 --max-time 20 \
  --output /dev/null --header "Title: $1" --header "Priority: $2" \
  --header "Tags: $3" --header "Click: $4" --data-binary @- \
  --url "$PHONE_PUSH_URL" 2>/dev/null; then
  echo "phone push not configured or undeliverable" >&2
  exit 1
fi
