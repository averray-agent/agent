FROM node:22-bookworm-slim

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

ENV NODE_ENV=production
ENV PORT=8787

EXPOSE 8787

CMD ["npm", "run", "start:http"]
