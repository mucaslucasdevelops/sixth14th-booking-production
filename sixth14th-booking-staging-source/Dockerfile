FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
COPY server.mjs ./
COPY public ./public
COPY data/settings.json data/reservations.seed.json ./data/
COPY scripts ./scripts

EXPOSE 4173
CMD ["node", "server.mjs"]
