#!/usr/bin/env bash
# Fail before container replacement when the dedicated badge-receipt Roles
# Anywhere identity has not been installed at the paths consumed by compose.
set -euo pipefail

if [[ $# -ne 4 ]]; then
  echo "Usage: $0 <profile-declaration> <mounted-aws-config> <certificate> <private-key>" >&2
  exit 2
fi

profile_declaration=$1
aws_config=$2
certificate=$3
private_key=$4
profile_name=averray-badge-receipt-signer
expected_owner_mode=${PREFLIGHT_EXPECTED_OWNER_MODE:-"0:0 400"}

privileged() {
  if [[ "${PREFLIGHT_NO_SUDO:-0}" == "1" ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

fail() {
  echo "ERROR: badge receipt signer preflight: $*" >&2
  exit 1
}

[[ -f "$profile_declaration" ]] || fail "repo declaration missing: $profile_declaration"
privileged test -f "$aws_config" || fail "mounted aws-config missing: $aws_config"

while IFS= read -r line || [[ -n "$line" ]]; do
  [[ -z "$line" || "$line" == \#* ]] && continue
  if ! privileged grep -Fqx -- "$line" "$aws_config"; then
    fail "required profile $profile_name missing or divergent in mounted aws-config $aws_config (expected exact line from $profile_declaration: $line)"
  fi
done < "$profile_declaration"

for credential_file in "$certificate" "$private_key"; do
  privileged test -s "$credential_file" \
    || fail "required credential file missing or empty at consumer path: $credential_file"
  if metadata=$(privileged stat -c '%u:%g %a' "$credential_file" 2>/dev/null); then
    : # GNU stat on the production VPS.
  else
    metadata=$(privileged stat -f '%u:%g %Lp' "$credential_file")
  fi
  [[ "$metadata" == "$expected_owner_mode" ]] \
    || fail "credential file $credential_file must be root:root mode 0400; found $metadata"
done

echo "Badge receipt signer preflight passed: profile $profile_name and both consumer-path credentials are installed."
