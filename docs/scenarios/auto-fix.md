# Auto Fix Scenario

`assets/orchestrations/auto-fix.yaml.template` is a reusable, provider-neutral
issue repair workflow. It demonstrates when a durable multi-actor DAG is more
useful than a single Manager Agent turn: implementation benefits from a second
pass, review roles must remain independent, and the complete decision history
must stay inspectable after the job ends.

## DAG boundary

The DAG receives a bounded issue envelope and an immutable repository revision.
Issue text, comments, paths, and patch content are untrusted evidence. The DAG:

1. deterministically clones the credential-free HTTPS repository at the exact
   revision, then gives the investigator a read-only checkout;
2. creates a focused repair and test plan, then deterministically captures the
   complete worktree as a bounded unified patch;
3. runs correctness, regression, and adversarial reviews independently;
4. performs a second implementation pass using all three reviews and captures
   the complete revised worktree again;
5. repeats the three reviews, requires a two-of-three quorum, and asks a
   separate arbiter for the final decision;
6. lets a publisher write only the human-readable summary, then
   deterministically joins trusted issue metadata, exact patch bytes, and the
   approved review outcome into `auto-fix.json`, `auto-fix.patch`, and
   `auto-fix.md`.

The checkout, two patch collectors, and publication finalizer are fixed command
nodes. Their executables and arguments are declared by the template rather than
selected by a model. Checkout uses a credential-scrubbed Git environment. Each
collector uses a temporary Git index outside `.git`, includes untracked files,
and rejects empty, oversized, binary, symlink/submodule, credential, workflow,
and trusted-adapter changes before review. This also means a model correction
turn never needs to remember or reproduce a large unified diff. The finalizer
copies exact patch and issue fields and rejects local/private/credential text.

Investigation, review, and arbitration Agents mount the checkout read-only.
Review and arbitration roles inspect with `Read`, `Grep`, and `Glob`; they do
not run builds, tests, or Git commands in the shared workspace. Only
implementation and revision Agents may edit it, and the trusted adapter runs
the isolated full CI command once after consensus. There is no GitHub token,
SSH key, push, comment, pull-request mutation, or model-selected host command in
the workflow. The public YAML contains only logical role names. A private
database Runtime Profile binds those roles to operator-selected model settings.

## Trusted GitHub adapter

`.github/workflows/auto-fix.yml` starts only when `xiaotianfotos` adds the exact
`auto-fix` label to a repository Issue. It always checks out the trusted default
branch revision from the event, never Issue or pull-request code. A dedicated
runner labeled `homerail-auto-fix` submits the run to the auto-deployed stable
Manager and retains the run in its normal database and UI.

Before publication, deterministic runner code verifies that all three artifacts
agree byte-for-byte, rejects unsafe paths, binary content, symlinks, submodules,
workflow edits, credentials, local paths, private addresses, and non-noreply
emails. Dependencies are installed from the unmodified trusted base. Only then
is the patch applied in a disposable container and the fixed `npm run ci`
command executed with no network, credentials, Docker socket, host Home, or
GitHub token. A passing candidate is applied again to the clean trusted checkout
and committed as `github-actions[bot]` with its GitHub noreply address.

The adapter creates a Draft PR. A human must inspect it and mark it ready before
normal PR Review and CI run. It never approves or merges a pull request.

## Stable runner configuration

The PR Review and Auto Fix runners are distinct Actions runner processes so the
jobs may run concurrently. Both submit to the one auto-deployed Manager; neither
starts another Manager or copies its database. The local runner environment,
not GitHub repository variables and not this template, supplies:

- `HOMERAIL_STABLE_ROOT`, `HOMERAIL_STABLE_HOME`, and
  `HOMERAIL_STABLE_MANAGER_URL`;
- `HOMERAIL_AUTO_FIX_IMPLEMENTATION_MODEL` for investigation, implementation,
  and revision;
- `HOMERAIL_AUTO_FIX_REVIEW_MODEL` for correctness and regression review;
- `HOMERAIL_AUTO_FIX_ARBITRATION_MODEL` for adversarial review, arbitration,
  and publication;
- `HOMERAIL_AUTO_FIX_RUNNER_ROOT` for the dedicated Actions runner.

Each selector must resolve to one distinct active Anthropic-compatible setting
in the stable Manager database. The profile stored in that database contains
setting IDs only. Provider URLs and keys remain encrypted Manager settings.

The workflow uses its short-lived `GITHUB_TOKEN` only after isolated validation.
No Worker needs an SSH key. Repository settings must allow GitHub Actions to
create pull requests; the workflow grants only `contents`, `issues`, and
`pull-requests` write access and calls no approval or merge API.
