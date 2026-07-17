---
name: topic-outline
description: Create and revise a structured topic outline from an evolving brief, audience, angle, thesis, sections, questions, and sources.
---

# Topic Outline

Use this Skill when the user asks to plan, structure, or revise a content topic. Do not use it for a generic task checklist or for an outline the user did not request.

Call the current Tool catalog entry for `com.homerail.topic-outline:upsert_topic_outline` with the complete current outline. Its harness-safe wire name is supplied by the current turn and must not be guessed. Reuse one stable plugin-owned `id` such as `com.homerail.topic-outline:current` across turns so a revision replaces the same semantic node without colliding with Core or another plugin. A partial outline is valid: record what is known, preserve useful prior fields, and put only unresolved decisions in `questions`.

Keep the shape concise:

- `title` names the topic, not the UI component.
- `brief`, `audience`, `angle`, and `thesis` capture the current editorial direction.
- `outline` contains ordered sections with short points and truthful status.
- `sources` includes only real HTTP(S) references supplied or found through an authorized tool.
- `next_action` states the next useful editorial step.
- `confidence` reflects evidence, not presentation polish.

Use the matching topic-outline Tool only when it is listed for the current turn. Do not substitute a legacy dynamic widget. If the requested outline is not placed on the canvas, tell the user only that visible result and offer to retry.
