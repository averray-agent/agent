# The Harness lock requires Python 3.12. Copy its runtime from the official
# image pinned by patch release and multi-platform manifest digest; uv is never
# allowed to download an interpreter while repository dependencies have egress.
FROM python:3.12.12-slim-bookworm@sha256:593bd06efe90efa80dc4eee3948be7c0fde4134606dd40d8dd8dbcade98e669c AS witness-python

# Phase-1 materialization image for the Averray Witness. This image is distinct
# from the solver image by design: the Witness never receives worker identity,
# wallet, model, claim, submission, or settlement capabilities.
FROM node:22-bookworm-slim

COPY --from=witness-python /usr/local/ /usr/local/

# Python repositories — including Averray's own runtime kernel — use uv as
# their toolchain entry point. Copy only the two binaries from Astral's
# distroless image, pinned by release and multi-platform manifest digest so the
# security boundary cannot float when a tag moves.
COPY --from=ghcr.io/astral-sh/uv:0.12.5@sha256:e85be844203885286c60ffad8a858d48afb6c5a5c237ca0e67f12e74b8f174b1 /uv /uvx /bin/

# The pinned Harness uses uv_build as its exact PEP 517 backend. Install only
# hashed binary wheels for the supported Linux architectures; project build
# code will use this toolchain later, with network disabled.
COPY uv-build-requirements.txt /opt/witness-toolchain/uv-build-requirements.txt

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
        zsh \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /opt/witness-wheels \
    && python3 -m pip download \
        --dest /opt/witness-wheels \
        --no-deps \
        --only-binary=:all: \
        --require-hashes \
        -r /opt/witness-toolchain/uv-build-requirements.txt

RUN git config --system --add safe.directory '*'

WORKDIR /workspace
USER 65532:65532
