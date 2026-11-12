FROM node:24.22.1-alpine

# Refresh the OS trust store as well as Node's bundled certificates.
RUN apk add --upgrade --no-cache ca-certificates && update-ca-certificates

WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
RUN npm install --omit=dev

COPY server.mjs ./
COPY public ./public
COPY data/settings.json data/reservations.seed.json ./data/
COPY scripts ./scripts

EXPOSE 4173
CMD ["node", "server.mjs"]
