FROM node:22-bookworm-slim

WORKDIR /proxy
COPY deploy/witness-docker-proxy/policy.mjs ./policy.mjs
COPY deploy/witness-docker-proxy/server.mjs ./server.mjs

ENV NODE_ENV=production
ENV PORT=2375

EXPOSE 2375
CMD ["node", "server.mjs"]
