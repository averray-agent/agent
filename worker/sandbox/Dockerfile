# Averray worker sandbox image for the harness Docker provider.
#
# The provider starts the container with:
#   docker run -d --network none -v <workspace>:/workspace -w /workspace \
#     averray-worker-sandbox:latest sleep infinity
# and runs every command as:  docker exec --workdir <dir> <id> /bin/sh -lc "<cmd>"
# So the image must supply a POSIX login shell, coreutils `sleep infinity`, git,
# and the job's toolchain. It never needs network — the container is run with
# `--network none`, and the harness rejects the run if the container's
# NetworkMode is anything other than "none".
#
# Build + load locally (providers never pull):
#   docker build -t averray-worker-sandbox:latest worker/sandbox
FROM node:20-bookworm-slim

# git for baseline/status/diff; python3 + pytest so real coding jobs whose
# verify command invokes pytest get a working baseline (the kernel only captures
# no_new_failures baselines for pytest). ca-certificates for completeness.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git \
        ca-certificates \
        python3 \
        python3-pytest \
    && rm -rf /var/lib/apt/lists/*

# The workspace is bind-mounted from the host (owned by the host user) while the
# container runs as root, so git 2.35.2+ would refuse it as "dubious ownership".
# Trust any bind-mounted checkout; this image is a throwaway sandbox, not a
# multi-tenant host.
RUN git config --system --add safe.directory '*'

WORKDIR /workspace
