# Phase-1 materialization image for the Averray Witness. This image is distinct
# from the solver image by design: the Witness never receives worker identity,
# wallet, model, claim, submission, or settlement capabilities.
FROM node:22-bookworm-slim

# Cover the first corpus' Node and Python repositories. Other detected
# toolchains remain typed UNMATERIALIZABLE results until their pinned Witness
# images exist; the host never silently falls back to executing repository code.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        git \
        python3 \
        python3-pip \
        python3-pytest \
        python3-venv \
    && rm -rf /var/lib/apt/lists/*

RUN git config --system --add safe.directory '*'

WORKDIR /workspace
USER 65532:65532
