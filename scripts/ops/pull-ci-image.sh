#!/usr/bin/env bash
set -euo pipefail

# CI must not rely on Docker Hub's anonymous shared-IP quota. The timeout is
# per attempt; at most three pulls plus two five-second backoffs are allowed.
image=${1:?usage: pull-ci-image.sh registry/image:tag}
registry=${image%%/*}
case "$registry" in
  docker.io|*.docker.io|index.docker.io|registry-1.docker.io) echo "Docker Hub image refused: $image" >&2; exit 2 ;;
esac
if [[ "$image" != */* || "$registry" != *.* ]]; then
  echo "Fully qualified non-Docker-Hub image required: $image" >&2
  exit 2
fi

for attempt in 1 2 3; do
  if timeout --signal=TERM --kill-after=5s 90s docker pull "$image"; then
    exit 0
  fi
  echo "Image pull failed ($attempt/3): $image" >&2
  if [[ "$attempt" != 3 ]]; then sleep 5; fi
done
echo "::error::Image pull exhausted three bounded attempts: $image" >&2
exit 1
