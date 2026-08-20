# Worker build network sources

HomeRail builds exactly one canonical Worker image from
`homerail_worker/Dockerfile`. By default the build uses the Debian
repositories shipped with the base image, npm's default registry, and the
pinned DeepSeek Harness repository on GitHub. Operators whose networks cannot
reach those public endpoints can opt in to validated public mirrors through
four environment variables:

| Variable | Effect |
| --- | --- |
| `HOMERAIL_WORKER_BUILD_APT_MIRROR` | Replaces the Debian main repository URL in non-security deb822 stanzas. |
| `HOMERAIL_WORKER_BUILD_APT_SECURITY_MIRROR` | Replaces the Debian security repository URL in security deb822 stanzas. |
| `HOMERAIL_WORKER_BUILD_NPM_REGISTRY` | Maps to the Docker `NPM_CONFIG_REGISTRY` build argument observed by every npm/pnpm operation and to `COREPACK_NPM_REGISTRY` while Corepack resolves pnpm. It is build-only and is never persisted as a runtime environment variable. |
| `HOMERAIL_WORKER_BUILD_DSH_GIT_REMOTE` | Maps to the Docker `HOMERAIL_DSH_FORK_REPOSITORY` build argument used to fetch the immutable DSH fork commit, allowing an internal read-only Git mirror instead of GitHub. |

The two APT overrides are independent: each one rewrites only its matching
deb822 stanzas, and either can be used alone.

## Entry points

Every supported Worker image build entry point consumes the same contract
with the same environment names, validation, and argument semantics:

- the Manager Worker image build (`DagEnvironmentController.runBuild`),
  resolved by `homerail_manager/src/server/worker-build-network.ts`;
- production deployment, `scripts/deploy-production.sh`;
- the live acceptance runner, `scripts/run-dag-patterns-live-runner.sh`
  (also used by the PR Review and Three-Worker Showcase wrappers).

The operator scripts share `scripts/lib/worker-build-network.sh`, which
assembles a Docker argv array without ever evaluating input. The shell
helper consumes only environment variable names and delegates URL
normalization and validation to the Worker WHATWG URL helper,
`homerail_worker/scripts/configure-apt-sources.mjs --print-env NAME`, so a
source value never appears in argv, captured commands, failures, or logs.
`${NODE_BIN:-node}` selects the Node binary used for that delegation; the
helper resolves it from its own repository-relative location.

## Validation contract

- Unset or whitespace-only values leave the corresponding source unchanged.
- Valid values use `http:` or `https:`, have a hostname, and contain no
  username, password, query, fragment, control characters, or raw
  whitespace.
- Trailing slashes, scheme case, and host case are normalized consistently,
  so semantically identical URLs produce identical build arguments. Default
  ports are elided and bracketed IPv6 hosts are lower-cased by the same
  WHATWG rules.
- Values are plain ASCII and contain no characters that the URL parser would
  percent-encode or rewrite; such inputs fail closed instead of shipping a
  normalized value that differs from what the operator configured.
- Invalid values are rejected before Docker starts. The error names the
  configuration key but never its value.

## Proxy forwarding

Recognized uppercase and lowercase `HTTP_PROXY`, `HTTPS_PROXY`, and
`NO_PROXY` variables are forwarded to Docker as value-less
`--build-arg NAME` entries only when non-empty. HomeRail never declares,
expands, copies, inspects, persists, or logs their values; the existing
Docker client and BuildKit proxy configuration remains authoritative. When
no process proxy variable is forwarded, the Manager reports the proxy mode
as `docker-managed`, which does not claim that no proxy exists in Docker
state.

## Redacted status

Manager build status exposes only a redacted `worker_image.build_network`
summary with modes, never URLs:

- `apt_main`: `default` or `custom`
- `apt_security`: `default` or `custom`
- `npm`: `default` or `custom`
- `dsh_git`: `default` or `custom`
- `proxy`: `environment` or `docker-managed`

No source or proxy URL appears in status, task artifacts, or HomeRail-authored
build log messages.

## Security boundaries

- Source values are deliberately public build metadata and may be visible in
  image build metadata. Credential-bearing values are rejected: no username
  or password, no query or fragment tokens, and no private npm
  authentication in this revision.
- The shared shell helper never uses `eval`; validated input only ever
  reaches Docker argv as array elements.
- A source configuration change invalidates the affected build layers and
  requires a Worker rebuild.

## fnOS integration and base-image pulls

- HomeRail does not choose or ship mirror vendors. Concrete fnOS mirror
  values are owned by the fnOS packaging issue #197 and are injected through
  the fnOS service environment at build time; this contract only defines the
  validated injection surface.
- Pulling the `node:22-slim` base image is not covered by these variables.
  It remains the responsibility of Docker daemon configuration (daemon
  proxy, registry mirrors, and DNS), not of the Worker build contract.
