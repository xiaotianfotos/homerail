# Build from repo root: docker build -t homerail-worker:latest -f homerail_worker/Dockerfile .
FROM node:22-slim AS secret-guard-build

# Optional public Debian mirror overrides for Worker image builds. Unset
# values keep the base image defaults; the helper rewrites the deb822
# sources stanza by stanza before the first apt-get update.
ARG HOMERAIL_WORKER_BUILD_APT_MIRROR
ARG HOMERAIL_WORKER_BUILD_APT_SECURITY_MIRROR
COPY homerail_worker/scripts/configure-apt-sources.mjs /opt/homerail/scripts/configure-apt-sources.mjs
RUN node /opt/homerail/scripts/configure-apt-sources.mjs

RUN apt-get update \
  && apt-get install -y --no-install-recommends gcc libc6-dev \
  && rm -rf /var/lib/apt/lists/*
COPY homerail_worker/native/codex-secret-guard.c /tmp/codex-secret-guard.c
RUN gcc -O2 -Wall -Wextra -Werror -fPIC -shared \
  -o /homerail-codex-secret-guard.so /tmp/codex-secret-guard.c

FROM node:22-slim AS dsh-runtime-build

# HomeRail's owner-maintained DSH fork is pinned by immutable commit. The
# deploy closure is generated in this stage so the final Worker image does not
# depend on a source checkout or a package registry at runtime.
ARG HOMERAIL_WORKER_BUILD_APT_MIRROR
ARG HOMERAIL_WORKER_BUILD_APT_SECURITY_MIRROR
ARG NPM_CONFIG_REGISTRY
ARG HOMERAIL_DSH_FORK_REPOSITORY=https://github.com/xiaotianfotos/deepseek-harness.git
ARG HOMERAIL_DSH_FORK_COMMIT=dc04fa3dbdcedc512322fff199b5cfef9169ea21
COPY homerail_worker/scripts/configure-apt-sources.mjs /opt/homerail/scripts/configure-apt-sources.mjs
RUN node /opt/homerail/scripts/configure-apt-sources.mjs
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
RUN npm install --global corepack@0.34.0 && corepack enable
RUN git init /src/deepseek-harness \
  && cd /src/deepseek-harness \
  && git remote add origin "${HOMERAIL_DSH_FORK_REPOSITORY}" \
  && git fetch --depth=1 origin "${HOMERAIL_DSH_FORK_COMMIT}" \
  && git checkout --detach FETCH_HEAD \
  && test "$(git rev-parse HEAD)" = "${HOMERAIL_DSH_FORK_COMMIT}"
WORKDIR /src/deepseek-harness
RUN if [ -n "${NPM_CONFIG_REGISTRY:-}" ]; then export COREPACK_NPM_REGISTRY="$NPM_CONFIG_REGISTRY"; fi \
  && corepack pnpm install --frozen-lockfile \
  && corepack pnpm run build:lib:host \
  && corepack pnpm exec tsx scripts/build-exe-for-python-sdk.ts --skip-build --node-only

FROM node:22-slim

# Optional public Debian mirror overrides for Worker image builds. ARG
# declarations are stage-scoped, so they are repeated in this stage.
ARG HOMERAIL_WORKER_BUILD_APT_MIRROR
ARG HOMERAIL_WORKER_BUILD_APT_SECURITY_MIRROR
# Optional public npm registry override. Build-only: Docker exposes the ARG
# to every RUN npm operation in this stage without persisting a runtime ENV.
ARG NPM_CONFIG_REGISTRY

COPY homerail_worker/scripts/configure-apt-sources.mjs /opt/homerail/scripts/configure-apt-sources.mjs
RUN node /opt/homerail/scripts/configure-apt-sources.mjs

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
ENV HOMERAIL_DSH_RUNTIME_COMMAND="/usr/local/bin/node" \
    HOMERAIL_DSH_RUNTIME_ARGS="[\"/opt/deepseek-harness-runtime/node_modules/@deepseek-ai/dsh-sdk-jsonrpc-demo/lib/packaged-bin.js\"]" \
    HOMERAIL_DSH_CORDIS_CONFIG="/app/dsh/homerail.cordis.yml"

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl git openssh-client \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g npm@11.6.2
COPY --from=secret-guard-build /homerail-codex-secret-guard.so /usr/local/lib/homerail-codex-secret-guard.so

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
# npm treats the Claude SDK and Codex native platform payloads as optional, so
# a transient fetch failure can leave a successful install with unusable agent
# backends. Repair only the current Linux architecture at the exact pinned
# versions, without changing the image-owned package lock, then verify them.
RUN codex_arch="$(dpkg --print-architecture)" \
  && case "$codex_arch" in \
    amd64) codex_arch=x64 ;; \
    arm64) codex_arch=arm64 ;; \
    *) echo "Unsupported Codex Worker architecture: $codex_arch" >&2; exit 1 ;; \
  esac \
  && claude_version="$(node -p 'require("./node_modules/@anthropic-ai/claude-agent-sdk/package.json").version')" \
  && claude_platform="@anthropic-ai/claude-agent-sdk-linux-${codex_arch}" \
  && if [ ! -d "node_modules/${claude_platform}" ]; then \
    npm install --no-save --package-lock=false --ignore-scripts \
      "${claude_platform}@${claude_version}"; \
  fi \
  && codex_version="$(node -p 'require("./node_modules/@openai/codex/package.json").version')" \
  && codex_platform="@openai/codex-linux-${codex_arch}" \
  && if [ ! -d "node_modules/${codex_platform}" ]; then \
    npm install --no-save --package-lock=false --ignore-scripts \
      "${codex_platform}@npm:@openai/codex@${codex_version}-linux-${codex_arch}"; \
  fi \
  && test -x "node_modules/${claude_platform}/claude" \
  && command -v codex \
  && codex --version

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
COPY homerail_worker/dsh ./dsh
COPY --from=dsh-runtime-build \
  /src/deepseek-harness/python/sdk-runtime/src/deepseek_harness_runtime/runtime/node \
  /opt/deepseek-harness-runtime
RUN npm run build

# Workspace checkouts can be created with owner-only source modes. Normalize
# only the copied metadata/config files the unprivileged runtime reads; npm and
# the DSH deploy step already materialize their output with public read modes.
RUN chmod a+r \
  /app/package*.json \
  /app/tsconfig.json \
  /app/dsh/homerail.cordis.yml \
  /homerail_protocol/package*.json \
  /homerail_protocol/tsconfig.json \
  && find /opt/homerail-dependency-cache -mindepth 2 -maxdepth 2 -type f \
    \( -name package.json -o -name package-lock.json \) -exec chmod a+r {} + \
  && mkdir -p /workspace \
  && chown -R node:node /workspace

USER node
WORKDIR /workspace

ENTRYPOINT ["env", "LD_PRELOAD=/usr/local/lib/homerail-codex-secret-guard.so", "node", "/app/dist/index.js"]
