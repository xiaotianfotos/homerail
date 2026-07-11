# Release Notes pure-data plugin

This example is an end-to-end M4 plugin slice made entirely from package data:

`Manifest -> Skill -> closed JSON Schemas -> direct projection -> declarative Renderer -> fixtures`

It contains no Manager handler, Core kind branch, Vue component, runtime entrypoint, action, workflow, permission, or migration. The package therefore qualifies for the `data_only` execution policy.

The renderer declares both `task` and `result` surfaces and the `phone`, `desktop`, and `tv` devices. The SDK fixture matrix expands each renderer resolution across `loading`, `empty`, `partial`, `success`, `error`, and `stale`. Matching fixture files exercise those semantic states through the same projection and output schema.

The `fixtures/` directory and this README are development inputs. Deterministic `.hrp` output contains only the manifest and its declared runtime references.
