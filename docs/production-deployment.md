# Persistent production deployment

`.github/workflows/deploy-production.yml` deploys the exact `main` revision only
after the repository's `CI` workflow succeeds for a `push` event. It runs on a
dedicated self-hosted runner labeled `homerail-deploy`; the live DAG and PR
review labels must stay on separate runners.

Each deployment runner keeps its machine-specific paths and public address in
`~/.config/homerail/production.env` with mode `0600`. The tracked workflow does
not contain hostnames, private addresses, account names, or mount paths. The
runner environment file defines:

- `HOMERAIL_DEPLOY_RUNNER_ROOT` for the dedicated Actions runner;
- `HOMERAIL_PRODUCTION_ROOT` for immutable releases;
- `HOMERAIL_PRODUCTION_HOME` for persistent runtime data;
- `HOMERAIL_PRODUCTION_RESOURCES` for optional external Skills;
- `HOMERAIL_PRODUCTION_UI_URL` and `HOMERAIL_PRODUCTION_PUBLIC_HOST` for the
  LAN-facing UI;
- optional Manager URL/host/port overrides when the default loopback endpoint
  would conflict with another local runtime.

The installation also provides:

- user service: `homerail-production.service`;
- runner service: `homerail-deploy-runner.service` using only the
  `homerail-deploy` custom label;
- a LAN-facing HTTPS UI;
- a dedicated loopback Manager health endpoint.

Each deployment installs dependencies, builds all packages, builds a
revision-tagged Worker image, copies the runnable tree plus its Node.js binary
into a new release directory, and atomically switches `current`. The systemd
user service owns Manager, Node, and the static Agent UI as one cgroup and
restarts after a process or health failure. Deployment waits for both Manager
and HTTPS UI health, and requires a connected Docker Node. A failed health
check switches `current` back to the prior release and restarts it. The
dedicated Manager port prevents desktop/E2E runtimes from being mistaken for
the production Manager. The newest three releases and their Worker images are
retained; database, model settings, sessions, certificates, and external Skills
remain outside release directories.

The workflow also has a maintainer-only manual dispatch for recovery. Normal
operation should use the CI-success trigger so unvalidated commits are never
promoted automatically.
