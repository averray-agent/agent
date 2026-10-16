#!/usr/bin/env bash
set -euo pipefail

# CI must not rely on Docker Hub's anonymous shared-IP quota, nor on any single
# mirror's anonymous quota: ECR Public answered `toomanyrequests: Data limit
# exceeded` for whole days (2026-10-14, 2026-10-16), which retrying the same
# registry cannot outlast. Every source is pinned to ONE shared digest, so a
# fallback can never change the bits under test; the pulled image is tagged as
# a local `averray-ci/` alias that steps run with `--pull=never`.
#
# Usage: pull-ci-image.sh averray-ci/<name>:<tag> <registry/image@sha256:…>...
#
# Each round tries every source once (90 s deadline per pull); at most three
# rounds with 5 s and 15 s backoffs between them. Exhaustion fails the step —
# a skipped proof is not a pass.
usage="usage: pull-ci-image.sh averray-ci/<name>:<tag> <registry/image@sha256:digest>..."
alias_ref=${1:?$usage}
shift
if [[ $# -lt 1 ]]; then echo "$usage" >&2; exit 2; fi
if [[ ! "$alias_ref" =~ ^averray-ci/[a-z0-9][a-z0-9._-]*:[A-Za-z0-9._-]+$ ]]; then
  echo "Local alias must be averray-ci/<name>:<tag>: $alias_ref" >&2
  exit 2
fi

digest=""
for image in "$@"; do
  registry=${image%%/*}
  case "$registry" in
    docker.io|*.docker.io|index.docker.io|registry-1.docker.io) echo "Docker Hub image refused: $image" >&2; exit 2 ;;
  esac
  if [[ "$image" != */* || "$registry" != *.* ]]; then
    echo "Fully qualified non-Docker-Hub image required: $image" >&2
    exit 2
  fi
  if [[ ! "$image" =~ @(sha256:[0-9a-f]{64})$ ]]; then
    echo "Digest-pinned image required (…@sha256:<64 hex>): $image" >&2
    exit 2
  fi
  if [[ -n "$digest" && "${BASH_REMATCH[1]}" != "$digest" ]]; then
    echo "All sources must share one digest: $image is not $digest" >&2
    exit 2
  fi
  digest=${BASH_REMATCH[1]}
done

backoff=(5 15)
for round in 1 2 3; do
  for image in "$@"; do
    if timeout --signal=TERM --kill-after=5s 90s docker pull "$image"; then
      docker tag "$image" "$alias_ref"
      echo "Pulled $digest from ${image%%/*} as $alias_ref"
      exit 0
    fi
    echo "Image pull failed (round $round/3): $image" >&2
  done
  if [[ "$round" != 3 ]]; then sleep "${backoff[round - 1]}"; fi
done
echo "::error::Image pull exhausted three bounded rounds across $# source(s) for $digest" >&2
exit 1
