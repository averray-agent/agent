FROM node:22-bookworm-slim

WORKDIR /app
COPY deploy/mcp-egress-proxy ./deploy/mcp-egress-proxy

USER 65532:65532
ENTRYPOINT ["node", "deploy/mcp-egress-proxy/server.mjs"]
