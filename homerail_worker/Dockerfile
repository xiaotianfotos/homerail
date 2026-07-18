# Build from repo root: docker build -t homerail-worker:latest -f homerail_worker/Dockerfile .
FROM node:22-slim

WORKDIR /app
ENV PATH="/app/node_modules/.bin:${PATH}"

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl git openssh-client \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g npm@11.6.2

# Copy homerail_protocol to /homerail_protocol (parallel to /app) so that
# file:../homerail_protocol in homerail_worker/package.json resolves correctly.
COPY homerail_protocol/package.json homerail_protocol/package-lock.json* /homerail_protocol/
COPY homerail_protocol/src /homerail_protocol/src
COPY homerail_protocol/tsconfig.json /homerail_protocol/
RUN cd /homerail_protocol && npm ci
RUN cd /homerail_protocol && npm run build

# Copy homerail_worker
COPY homerail_worker/package.json homerail_worker/package-lock.json* ./
# --ignore-scripts skips postinstall since homerail_protocol is already built above
RUN npm ci --ignore-scripts
RUN command -v kimi

COPY homerail_worker/tsconfig.json ./
COPY homerail_worker/src ./src
RUN npm run build

RUN mkdir -p /workspace && chown -R node:node /workspace

USER node
WORKDIR /workspace

ENTRYPOINT ["node", "/app/dist/index.js"]
