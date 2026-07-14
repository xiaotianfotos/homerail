# Run Workspace Retention

HomeRail keeps successful, failed, and cancelled run workspaces for seven days by default. The policy applies only to per-run directories under `$HOMERAIL_HOME/workspace`; run metadata, events, evidence, sessions, and the reserved `default` workspace are not deleted.

Cleanup runs on the Manager host. The current local Manager and Node topology shares the same `HOMERAIL_HOME`, so those run workspaces are covered. A remote Node that uses an independent data root requires its own node-side retention policy and is outside this cleaner's scope.

## Why

Run workspaces contain useful debugging artifacts, but retaining every checkout and generated file forever causes unbounded disk growth. A time-based policy keeps recent evidence available while making cleanup predictable. Successful and unsuccessful runs have separate values because operators may later choose to retain failed runs longer, although both defaults are seven days.

## Configuration

The Agent settings page exposes **Storage & Retention** under **General**. It can enable or disable scheduled automatic cleanup and set successful and failed/cancelled retention from 0 to 3650 days. Manual preview and cleanup remain available while automatic cleanup is disabled. Settings are written atomically to:

```text
$HOMERAIL_HOME/manager/workspace-retention.json
```

Before that file exists, deployments may seed the initial values with `HOMERAIL_WORKSPACE_CLEANUP_ENABLED`, `HOMERAIL_WORKSPACE_RETENTION_SUCCESS_DAYS`, and `HOMERAIL_WORKSPACE_RETENTION_FAILURE_DAYS`. Saving in the UI creates the persistent file. The scheduler interval defaults to six hours and can be set with `HOMERAIL_WORKSPACE_CLEANUP_INTERVAL_MS`.

## Safety Rules

- Automatic and manual cleanup consider only persisted terminal runs with `completedAt`.
- Runs whose in-memory status is still active, pinned runs, the reserved `default` workspace, and runs with pending worker cleanup are skipped.
- Unknown orphan directories are not scanned or removed.
- A run workspace that is itself a symbolic link is unlinked without following its target. Resolved directories that escape through an intermediate symbolic link are rejected.
- The cleanup API defaults to dry-run. The UI exposes a preview action and requires confirmation before actual deletion.
- Policy updates, cleanup, and pin mutations use the Manager DAG mutation authorization boundary.

## API

- `GET /api/settings/storage-info` returns the effective policy.
- `POST /api/settings/workspace-retention` persists `{ enabled, success_days, failure_days }`.
- `POST /api/dag/workspaces/cleanup` accepts `{ dry_run: true | false }`; omitted means `true`.
- `POST /api/runs/:run_id/workspace-retention` accepts `{ pinned: true | false }`.

Mutation requests require a local connection or a valid `X-Homerail-Dag-Token` when `HOMERAIL_DAG_MUTATION_TOKEN` is configured.
