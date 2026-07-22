#!/bin/sh
# Stage 2 (operator-run): the same trusted off-by-one fixture as the Stage 1 live
# smoke, but executed INSIDE a --network none Docker sandbox on the
# averray-worker-sandbox image. This is the isolation the local provider cannot
# give and is mandatory for real (adversarial) bounty jobs.
#
# Run in the terminal where HARNESS_MODEL_API_KEY and HARNESS_MODEL_REF are
# exported (the key is only ever read from the env and passed to the harness).
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
worker_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
image=${HARNESS_ENV_IMAGE:-averray-worker-sandbox:latest}

if ! command -v docker >/dev/null 2>&1; then
  echo "stage 2: docker is required" >&2
  exit 2
fi

# Build + load the sandbox image if it is not already present (providers never
# pull implicitly).
if ! docker image inspect "$image" >/dev/null 2>&1; then
  echo "stage 2: building $image from $worker_root/sandbox ..."
  docker build -t "$image" "$worker_root/sandbox"
fi
echo "sandbox_image=$image"

# Isolation preflight: independently confirm the image under --network none has
# no egress, before trusting the harness to enforce it. dns.lookup must fail.
if docker run --rm --network none "$image" /bin/sh -lc \
    'node -e "require(\"dns\").lookup(\"example.com\",(e)=>process.exit(e?0:1))"'; then
  echo "isolation_preflight=passed (--network none denies egress)"
else
  echo "stage 2: isolation preflight FAILED — image reached the network under --network none" >&2
  exit 1
fi

# Same trusted-fixture smoke, forced onto the isolated docker provider. The
# live-smoke script self-verifies that the run really used the docker provider.
exec env \
  HARNESS_ENV_PROVIDER=docker \
  HARNESS_ENV_IMAGE="$image" \
  sh "$script_dir/live-smoke.sh"
