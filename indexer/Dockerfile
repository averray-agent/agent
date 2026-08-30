FROM node:22-bookworm-slim

WORKDIR /app

COPY indexer/package*.json ./
RUN npm ci --omit=dev

COPY indexer ./

ENV NODE_ENV=production
ENV PORT=42069

EXPOSE 42069

CMD ["npm", "run", "start"]
