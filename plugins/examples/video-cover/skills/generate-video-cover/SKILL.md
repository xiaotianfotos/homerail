---
name: generate-video-cover
description: Generate a video cover through the sandboxed GPU runtime and Manager Artifact Broker.
---

# Generate Video Cover

Use only the current qualified Tool for `com.homerail.video-cover:generate_cover`.

Provide a concise visual prompt plus the requested width and height. The Runtime may use GPU authority only when it is present in the exact Tool grant. Every result must be published through a Manager-issued Artifact Broker capability bound to this Tool request. Never ask for, invent, accept, or return a host filesystem path. Treat the returned `artifact:sha256/...` references as passive artifacts.

The deterministic fake GPU entrypoint exists for the M6 acceptance fixture. It produces both a PNG cover and a JSON provenance record without a model download.
