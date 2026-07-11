# Public DAG Templates

This directory contains public DAG templates. They are not implicit runtime
defaults; pass a template path explicitly or copy a template before editing it.
The YAML `workflow_id` is the stable database identity. AI edits may change the
workflow body, prompts, nodes, and edges, but should keep `workflow_id` unchanged
unless intentionally creating a new workflow/version.

Sync a template into the Manager database before treating it as the effective
runtime instance:

```bash
node homerail_cli/dist/cli.js dag sync assets/orchestrations/public-dev-5node.yaml.template
```

Start with `public-dev-5node.yaml.template` for the release smoke path:

```bash
node homerail_cli/dist/cli.js smoke dag \
  --template assets/orchestrations/public-dev-5node.yaml.template
```

Use `public-two-node.yaml.template` for the smallest topology example:

```bash
node homerail_cli/dist/cli.js run assets/orchestrations/public-two-node.yaml.template \
  --prompt "Draft a short checklist for a backend release"
```

For local topology checks without a live model provider, use the deterministic
profile in the two-node template:

```bash
node homerail_cli/dist/cli.js run assets/orchestrations/public-two-node.yaml.template \
  --profile offline-deterministic \
  --prompt "Draft a short checklist for a backend release"
```

The concrete offline pattern instances exercise the Manager's built-in gateway
semantics without a model provider:

```bash
node homerail_cli/dist/cli.js run assets/orchestrations/pattern-quorum-offline.yaml \
  --profile offline-deterministic --prompt "verify quorum routing"
node homerail_cli/dist/cli.js run assets/orchestrations/pattern-ratchet-exhaustion-offline.yaml \
  --profile offline-deterministic --prompt "verify bounded feedback"
```

Use `hr patterns list` and `hr patterns show <id>` for the abstract catalog;
these files are concrete examples, not the catalog source of truth.

The five-node smoke writes its standard example artifacts to the shared
run-level workspace:

```text
${HOMERAIL_HOME}/workspace/<run_id>/snake-game/index.html
${HOMERAIL_HOME}/workspace/<run_id>/snake-game/TESTS.md
```

Keep public templates free of private hostnames, local filesystem paths, and
operator-specific repository URLs. Configure provider secrets through
`hr model configure --api-key-stdin` or the settings UI so Manager stores them
in the database; plaintext env files are legacy import fallbacks only.
Use `hr run --setting-id <llm_setting_id>` or `hr smoke dag --setting-id
<llm_setting_id>` when a run should use a specific DB setting instead of the
active/default LLM setting.
For reusable runtime mappings, sync a DB-backed profile and then run by
workflow/profile:

```bash
node homerail_cli/dist/cli.js profile sync assets/profiles/example-runtime.profile.yaml.template \
  --workflow public-dev-5node-template
node homerail_cli/dist/cli.js run \
  --workflow public-dev-5node-template \
  --profile example-runtime \
  --prompt "Draft a short checklist"
```

Use `local-harness-cli-deploy-diagnosis.yaml.template` when an agent should start from
a fresh workspace, pull the latest HomeRail source, try the CLI-first deployment
path on an isolated non-default Manager port, and create an issue only when
deployment or coverage is blocked:

```bash
node homerail_cli/dist/cli.js run assets/orchestrations/local-harness-cli-deploy-diagnosis.yaml.template \
  --prompt "source_repo_url=<https repo url> branch=main"
```

Configure a DB LLM setting before running this template with
`hr model configure <provider-id> --model-name <model-id> --anthropic-endpoint <endpoint> --api-key-stdin`.
Inside the diagnosis run, the cloned checkout writes the outer Manager URL
through `homerail config set`, then verifies `runtime status` and `doctor` through
the cloned CLI. The run must execute as a normal Node-provisioned Worker with a
run-scoped workspace; fixed host Workers, Docker socket mounts, and
Docker-in-Docker are outside this test boundary.

## Scorecard Policy

DAG-specific scorecard rules are declared in the template instead of being
hard-coded by Manager. Use `scorecard.profile` as a label, then enable only the
checks that belong to that DAG, for example `handoff_blockers`,
`handoff_header`, `source_issue`, or `quality_gate`.

Scorecard enforcement is intentionally conservative for public templates:

```yaml
scorecard:
  profile: my-profile
  enforcement: advisory  # off | advisory | strict
```

`advisory` is the default. It computes and reports DAG-specific scorecard
findings, but those findings do not gate `eval-run`. Use `strict` only for
templates whose scorecard policy has focused tests. Use `off` when a template
should rely only on CLI inspection and handoff evidence.
