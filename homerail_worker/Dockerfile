# Build from repo root: docker build -t homerail-worker:latest -f homerail_worker/Dockerfile .
# APT mirror override for regions where deb.debian.org is slow/blocked
# (e.g. China). Override at build time: --build-arg APT_MIRROR=mirrors.aliyun.com
ARG APT_MIRROR=mirrors.aliyun.com
FROM node:22-slim AS secret-guard-build
ARG APT_MIRROR

RUN sed -i "s|deb.debian.org|${APT_MIRROR}|g; s|security.debian.org|${APT_MIRROR}|g" \
      /etc/apt/sources.list.d/debian.sources 2>/dev/null || \
    sed -i "s|deb.debian.org|${APT_MIRROR}|g; s|security.debian.org|${APT_MIRROR}|g" \
      /etc/apt/sources.list 2>/dev/null || true
RUN apt-get update \
  && apt-get install -y --no-install-recommends gcc libc6-dev \
  && rm -rf /var/lib/apt/lists/*
COPY homerail_worker/native/codex-secret-guard.c /tmp/codex-secret-guard.c
RUN gcc -O2 -Wall -Wextra -Werror -fPIC -shared \
  -o /homerail-codex-secret-guard.so /tmp/codex-secret-guard.c

FROM node:22-slim
ARG APT_MIRROR

WORKDIR /app
ENV PATH="/app/node_modules/.bin:${PATH}"
ENV HOMERAIL_CODEX_PROC_GUARD="/usr/local/lib/homerail-codex-secret-guard.so"
ARG HOMERAIL_WORKER_VERSION
ARG HOMERAIL_WORKER_PROTOCOL_VERSION
ARG HOMERAIL_WORKER_SOURCE_FINGERPRINT=unknown
ARG HOMERAIL_WORKER_IMAGE_REVISION=unknown
ENV HOMERAIL_WORKER_VERSION="${HOMERAIL_WORKER_VERSION}" \
    HOMERAIL_WORKER_PROTOCOL_VERSION="${HOMERAIL_WORKER_PROTOCOL_VERSION}" \
    HOMERAIL_WORKER_SOURCE_FINGERPRINT="${HOMERAIL_WORKER_SOURCE_FINGERPRINT}" \
    HOMERAIL_WORKER_IMAGE_REVISION="${HOMERAIL_WORKER_IMAGE_REVISION}"

RUN sed -i "s|deb.debian.org|${APT_MIRROR}|g; s|security.debian.org|${APT_MIRROR}|g" \
      /etc/apt/sources.list.d/debian.sources 2>/dev/null || \
    sed -i "s|deb.debian.org|${APT_MIRROR}|g; s|security.debian.org|${APT_MIRROR}|g" \
      /etc/apt/sources.list 2>/dev/null || true
RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl git openssh-client \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g npm@11.6.2 --registry=https://registry.npmmirror.com
COPY --from=secret-guard-build /homerail-codex-secret-guard.so /usr/local/lib/homerail-codex-secret-guard.so

# Copy homerail_protocol to /homerail_protocol (parallel to /app) so that
# file:../homerail_protocol in homerail_worker/package.json resolves correctly.
# Use a fast npm registry mirror (override at build time: --build-arg NPM_REGISTRY)
ARG NPM_REGISTRY=https://registry.npmmirror.com
RUN npm config set registry ${NPM_REGISTRY}
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
RUN command -v codex && codex --version

# Auto Fix coding Workers run without network access. Keep a trusted dependency
# cache in the image for the HomeRail packages exercised by implementation and
# validation. Worker projects it only when the dependency-relevant normalized
# package.json + package-lock.json metadata matches these image-owned copies.
RUN mkdir -p /opt/homerail-dependency-cache \
  && ln -s /homerail_protocol /opt/homerail-dependency-cache/homerail_protocol \
  && ln -s /app /opt/homerail-dependency-cache/homerail_worker
COPY homerail_plugin_sdk/package.json homerail_plugin_sdk/package-lock.json* /opt/homerail-dependency-cache/homerail_plugin_sdk/
RUN cd /opt/homerail-dependency-cache/homerail_plugin_sdk && npm ci
COPY homerail_manager/package.json homerail_manager/package-lock.json* /opt/homerail-dependency-cache/homerail_manager/
RUN cd /opt/homerail-dependency-cache/homerail_manager && npm ci
COPY homerail_node/package.json homerail_node/package-lock.json* /opt/homerail-dependency-cache/homerail_node/
RUN cd /opt/homerail-dependency-cache/homerail_node && npm ci
COPY homerail_cli/package.json homerail_cli/package-lock.json* /opt/homerail-dependency-cache/homerail_cli/
RUN cd /opt/homerail-dependency-cache/homerail_cli && npm ci
COPY agent-ui/package.json agent-ui/package-lock.json* /opt/homerail-dependency-cache/agent-ui/
RUN cd /opt/homerail-dependency-cache/agent-ui && npm ci --ignore-scripts

COPY homerail_worker/tsconfig.json ./
COPY homerail_worker/src ./src
RUN npm run build

RUN mkdir -p /workspace && chown -R node:node /workspace

USER node
WORKDIR /workspace

ENTRYPOINT ["env", "LD_PRELOAD=/usr/local/lib/homerail-codex-secret-guard.so", "node", "/app/dist/index.js"]
