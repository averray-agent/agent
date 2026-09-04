ARG DEPLOYED_SHA=unknown

# Build the two creation artifacts used by deploy-venue-pair.mjs from the same
# repository snapshot as the backend image. The runtime stage below receives
# only those JSON files; Foundry and the rest of out/ stay out of production.
FROM ghcr.io/foundry-rs/foundry:v1.7.1@sha256:8347b728d5d393dac1c018691b36f506d23b9dcd78341d40ea0fcb11c3a19cdd AS venue-pair-artifacts

USER root
WORKDIR /build

COPY foundry.toml ./foundry.toml
COPY contracts ./contracts
# foundry.toml's forge-std remapping is auto-discovered from this directory and
# is embedded in Solidity metadata even though this pair does not import it.
# Carrying it makes the image build byte-identical to a checkout build.
COPY lib/forge-std ./lib/forge-std

RUN forge build \
  contracts/strategies/HydrationUsdcAdapterV22.sol \
  contracts/strategies/HydrationDepositPoolAdapter.sol \
  --skip test

FROM node:22-bookworm-slim

ARG DEPLOYED_SHA

# ca-certificates: required by the IAM Roles Anywhere `aws_signing_helper`
# binary (mounted at /usr/local/bin/aws_signing_helper by docker-compose
# in Phase 5a). aws_signing_helper is a Go binary that makes HTTPS calls
# to rolesanywhere.<region>.amazonaws.com to exchange the VPS-side client
# cert for STS session credentials. Go's net/http reads CA roots from
# /etc/ssl/certs/ca-certificates.crt (Debian path). node:22-bookworm-slim
# ships without ca-certificates, so without this install the TLS
# handshake fails with `x509: certificate signed by unknown authority`
# even though the cert chain itself is fine — Go just can't find any
# trust anchors to validate against.
#
# Node's own HTTPS works regardless because Node bundles its own CA
# store in the binary, so this install is specifically about supporting
# external tools (currently aws_signing_helper; future: anything else
# mounted in via docker-compose that needs to validate TLS).
#
# --no-install-recommends keeps the image minimal — ca-certificates'
# recommended deps include openssl and gnupg, neither of which the
# backend needs at runtime.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY mcp-server/package*.json ./
RUN npm install --omit=dev

COPY mcp-server/src ./src

# The money-moving venue ceremony must authenticate through the backend
# container's Roles Anywhere profile. Ship only the driver and its read/RPC
# helpers; it remains dry-run by default and exposes no new service surface.
COPY scripts/ops/ceremony-module-loader.mjs ./scripts/ops/ceremony-module-loader.mjs
COPY scripts/ops/ceremony-rpc.mjs ./scripts/ops/ceremony-rpc.mjs
COPY scripts/ops/pool-venue-ceremony.mjs ./scripts/ops/pool-venue-ceremony.mjs
COPY scripts/ops/capture-bank-xcm-v22-staging-quote.mjs ./scripts/ops/capture-bank-xcm-v22-staging-quote.mjs
COPY scripts/ops/pool-venue-dispatch.mjs ./scripts/ops/pool-venue-dispatch.mjs
COPY scripts/ops/deploy-venue-pair.mjs ./scripts/ops/deploy-venue-pair.mjs

# These paths are derived from deploy-venue-pair.mjs CONTRACT_ARTIFACTS and
# held in lockstep by venue-pair-artifacts-image.test.mjs. Do not copy all of
# out/: Ceremony B's set-once binding must use this image's reproducible pair.
COPY --from=venue-pair-artifacts /build/out/HydrationUsdcAdapterV22.sol/HydrationUsdcAdapterV22.json ./out/HydrationUsdcAdapterV22.sol/HydrationUsdcAdapterV22.json
COPY --from=venue-pair-artifacts /build/out/HydrationDepositPoolAdapter.sol/HydrationDepositPoolAdapter.json ./out/HydrationDepositPoolAdapter.sol/HydrationDepositPoolAdapter.json

# Runtime data read from /deployments by code under ./src.
#
# The image layout differs from a repo checkout: ./src sits at the image root,
# so the `../../../deployments/...` that resolves to the repo root locally
# resolves to /deployments here. Everything src reads must be copied EXPLICITLY,
# and this list has now been short twice.
#
#   1. Copying only ./src left transparency's native multisig AccountId32
#      silently unreadable in production while the EVM balance lens still worked.
#   2. The payout-receipt backfill reads deployments/<profile>.json for the
#      legacy escrow address and the deployment blocks that bound its historical
#      log scan. It died on ENOENT the first time it was run in production.
#
# scripts/ops/check-dockerfile-deployments.test.mjs now fails when src reads a
# manifest this list does not carry, so a third time should not happen.
COPY deployments/mainnet-multisig-owner.json /deployments/mainnet-multisig-owner.json
COPY deployments/testnet-multisig-owner.json /deployments/testnet-multisig-owner.json
COPY deployments/mainnet.json /deployments/mainnet.json
COPY deployments/testnet.json /deployments/testnet.json

ENV NODE_ENV=production
ENV PORT=8787
ENV DEPLOYED_SHA=${DEPLOYED_SHA}

EXPOSE 8787

CMD ["npm", "run", "start:http"]
