# Three-Worker Game Copilot

`assets/orchestrations/three-worker-game-copilot.yaml.template` is a concrete
acceptance scenario for the durable Actor, supervision, live Surface, and
branch-intervention capabilities introduced by Epic #36. It is not a new
Runtime primitive and it does not add game-specific routing to Manager or the
general DAG Skills.

## Start With One Request

The caller explicitly selects the reusable workflow and supplies one ordinary
request. In Manager chat, that can remain one sentence:

> Start the public `three-worker-game-copilot` workflow in supervised mode with
> my configured profile, and plan a relaxed two-hour co-op session for four friends.

The same explicit selection is available through CLI:

```bash
hr run assets/orchestrations/three-worker-game-copilot.yaml.template \
  --prompt "Plan a relaxed two-hour co-op session for four friends"
```

That request starts three provider-neutral logical Actors concurrently:

- `goal_scout` owns the desired outcome and constraints;
- `systems_guide` owns mechanics, dependencies, tradeoffs, and risks;
- `session_coach` owns the practical play sequence and checkpoints.

The workflow itself contains the reusable role contracts. Manager does not
inspect game-planning language and silently substitute this asset. Products can
offer it through an explicit shortcut, catalog selection, or their own generic
workflow-discovery layer without changing the Runtime.

## Observable Lifecycle

Each Actor reports evidence-bearing progress and findings through the generic
activity plane. Manager projects each Actor onto one stable 1x2 A2UI Surface,
consumes redacted milestone digests, and keeps the three identities distinct.
The three branches fan in through an `all` join, then the run enters `waiting`
at an `await_command` boundary instead of completing or holding a Worker
forever.

A follow-up command addresses one or more logical Actors by id:

```bash
hr dag send-command <run-id> --expected-round <round-id> \
  --actor systems_guide \
  --payload '{"focus":"prefer the lower-risk route"}'
```

Only selected branches run again. Sibling reports and Surfaces remain intact.
The logical Actor id, session, checkpoint, and Surface id survive physical
Worker release. A later command reacquires an executor and resumes the same
logical Actor with a new lease generation.

## Deterministic Verification

The normal test suite checks the asset without a model:

```bash
npm --prefix homerail_manager test -- \
  tests/three-worker-showcase-asset.test.ts \
  tests/dag-live-surface-projector.test.ts
node --test scripts/three-worker-showcase-contracts.test.mjs
```

These tests prove the strict WorkflowSpec contract, three-way initial
dispatch, fan-in, waiting boundary, branch-local continuation, stable Surface
identity, and report validation. They do not claim model quality.

## Real-Model Acceptance

`.github/workflows/three-worker-showcase.yml` is manual-only. It runs the
checked-out revision in an isolated `HOMERAIL_HOME` on the self-hosted live
runner and uses the runner's configured model endpoint. It deliberately does
not run for every pull request or encode credentials in the repository.

The acceptance has two process phases:

1. Use one Manager message to start the explicitly named workflow, observe three
   overlapping physical Workers and three independent 1x2 Surfaces, focus one
   Surface, retry only one active branch, and prove the other two are byte
   unchanged. Manager then atomically continues all three Actors, waits for the
   next fan-in, reads the milestone digest, and produces a synthesis.
2. Wait until at least one physical Worker is released and cleaned up, restart
   only Manager on the same isolated home and port, recover byte-identical
   Surfaces, and continue all three Actors through the same Manager session.
   The released Actor must be physically reprovisioned, every command must be
   acknowledged, and Manager must produce a new final synthesis.

Run the same adapter directly on a configured live runner with:

```bash
npm run validate:three-worker-showcase-runner
```

The report is written to
`artifacts/three-worker-showcase/acceptance.json`. It contains only public run,
Actor, Surface, event, lease-state, model, timing, Manager-control, restart, and
assertion evidence. It
must not contain endpoint credentials, mutation tokens, private configuration,
or physical Worker identifiers.

Production keeps the public five-minute Worker idle TTL and seven-day retained
run/Actor state. The acceptance adapter shortens the same public idle-TTL
setting to 15 seconds so release and cold resume can be observed without a
Showcase-only Runtime path. The workflow has no total expiry; callers complete
it explicitly when no further round is needed.
