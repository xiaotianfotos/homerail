---
name: compose-release-notes
description: Create or replace a complete semantic release-notes snapshot.
---

# Compose release notes

Use the current qualified Tool for `dev.homerail.release-notes:publish_release_notes`.

- Reuse a stable plugin-owned id, such as `dev.homerail.release-notes:current`.
- Send the complete current snapshot on every call; the projection replaces rather than patches content.
- Set `lifecycle_state` to exactly one of `loading`, `empty`, `partial`, `success`, `error`, or `stale`.
- Keep `completion_percent` between 0 and 100. Use 100 only when the snapshot is complete.
- Omit unavailable optional fields instead of inventing release details or links.
- Never route around an unavailable qualified Tool with a generic Widget or plugin runtime.

The Tool is a permissionless pure-data projection. It does not run package code, access the network, or invoke a custom UI component.
