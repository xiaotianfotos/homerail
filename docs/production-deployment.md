# Persistent production deployment

`.github/workflows/deploy-production.yml` deploys the latest `main` revision
once per day at 03:30 Asia/Shanghai (19:30 UTC), and also supports an
owner-only manual dispatch for an immediate deployment. Merging a pull request
does not start a second deployment workflow. It runs on a dedicated self-hosted
runner labeled `homerail-deploy`; the live DAG, PR Review, and Auto Fix labels
must stay on separate runners.

Each deployment runner keeps its machine-specific paths and public address in
`~/.config/homerail/production.env` with mode `0600`. The tracked workflow does
not contain hostnames, private addresses, account names, or mount paths. The
runner environment file defines:

- `HOMERAIL_DEPLOY_RUNNER_ROOT` for the dedicated Actions runner;
- `HOMERAIL_PRODUCTION_ROOT` for immutable releases;
- `HOMERAIL_PRODUCTION_HOME` for persistent runtime data;
- `HOMERAIL_PRODUCTION_RESOURCES` for optional external Skills;
- `HOMERAIL_PRODUCTION_PUBLIC_HOST` for the required LAN-facing host or IP;
- optional `HOMERAIL_PRODUCTION_UI_URL` when the default
  `https://<public-host>:19192` address needs overriding;
- optional `HOMERAIL_PRODUCTION_UI_PORT` and
  `HOMERAIL_PRODUCTION_UI_HTTP_PORT` overrides (defaults: `19192` and
  `19193`);
- optional Manager URL/host/port overrides when the default endpoint would
  conflict with another local runtime. By default the deployment discovers
  Docker's `bridge` gateway and binds the Manager only on that interface.
  Linux bridge-network Workers reach the same interface through
  `host.docker.internal`; a loopback-only Manager cannot accept those Worker
  WebSocket registrations, while an all-interface bind would unnecessarily
  expose the Manager port to the LAN. The service enables insecure remote
  WebSockets only for this host-local bridge channel and authenticates Node and
  Worker registrations with separate 0600 tokens under the persistent
  Home. A third 0600 token authorizes Manager Agent, CLI, and trusted
  same-origin UI proxy DAG mutations; ordinary DAG Workers receive neither the
  Node nor mutation credential, and browser clients never receive any token.
  These service tokens are environment variables of trusted processes running
  under the dedicated deployment account; do not share that Unix account with
  untrusted local processes.
  The Manager socket is not bound to a LAN interface. Plaintext bridge
  WebSockets default to disabled and require the operator to set
  `HOMERAIL_PRODUCTION_ALLOW_INSECURE_REMOTE_WS=1` explicitly for an isolated
  trusted Docker bridge. Startup always rejects every Manager host other than
  the discovered Docker bridge gateway. Production currently requires Docker's
  default `bridge` network because provisioned Workers use that network; a
  missing or renamed default bridge fails deployment with an actionable error.

The installation also provides:

- user service: `homerail-production.service`;
- runner service: `homerail-deploy-runner.service` using only the
  `homerail-deploy` custom label;
- a LAN-facing HTTPS UI;
- a dedicated Manager port bound to the Docker bridge interface;

This Manager is also the single durable automation control plane. PR Review and
Auto Fix use separate Actions runner processes so they can execute concurrently,
but both submit to this service and retain their DAG history in its database.
They do not start alternate Managers, allocate dynamic Manager ports, or clone
the production Home. Live DAG compatibility CI remains the only workflow that
may start a transient current-commit runtime.

Machine-local `~/.config/homerail/automation.env` (mode `0600`) supplies the
stable release/Home/Manager paths, the dedicated Actions runner roots, and
private model selectors. These values are intentionally absent from tracked
workflows and GitHub repository variables. `ops/systemd` contains reference
units for the `homerail-pr-review` and `homerail-auto-fix` runners. The standard
operator UI remains HTTPS port `19192`; no automation runner exposes another UI
port.

Each deployment installs dependencies, builds all packages, builds a
revision-tagged Worker image, copies the runnable tree plus its Node.js binary
into a new release directory, and atomically switches `current`. The systemd
user service owns Manager, Node, and the static Agent UI as one cgroup and
restarts after a process or health failure. Deployment waits for both Manager
and HTTPS UI health through its LAN address, requires a connected Docker Node,
and runs the deterministic public two-node DAG through a provisioned Docker
Worker before accepting the release. Deployment rejects loopback-only Manager
binds, loopback-only UI binds, and loopback public addresses.
A failed health check switches `current` back to the prior release and restarts it. The
dedicated Manager port prevents desktop/E2E runtimes from being mistaken for
the production Manager. The newest three releases and their Worker images are
retained; database, model settings, sessions, certificates, and external Skills
remain outside release directories.

The workflow also has a maintainer-only manual dispatch for immediate recovery
or an explicitly selected revision. Scheduled and default manual deployments
resolve `main` at job start. The release switch never changes
`HOMERAIL_PRODUCTION_HOME`; database, settings, sessions, certificates, and
external Skills continue to live in the persistent Home across deployments.
