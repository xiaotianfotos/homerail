# HomeRail Generative UI: A2UI Profile

HomeRail uses A2UI v1.0 as the component and data-binding protocol for generated interfaces. It does not maintain a second private UI DSL and does not compile an older format into A2UI.

The implementation is pinned to upstream A2UI commit `16425ca82061f756e420d2453e066d0c7c0295c1`. A2UI is licensed under Apache-2.0. The upstream project is <https://github.com/google/A2UI>.

## Layer Boundaries

HomeRail keeps four separate responsibilities:

1. **Semantic UI IR** owns node identity, semantic kind, lifecycle, status, importance, provenance, fallback content, revisions, and atomic multi-node transactions.
2. **A2UI v1.0** owns the flat component graph, data bindings, pure formatting functions, and user interaction events.
3. **HomeRail Catalog** extends A2UI with the bounded dashboard, graph, and Artifact components required by the product.
4. **Host runtime** owns placement, responsive canvas sizing, focus and motion, Action authorization, Artifact resolution, sandboxing, and persistence.

A2UI does not replace the Semantic UI IR or its transaction log. A committed HomeRail revision becomes visible atomically; the UI never renders a partially applied sequence of A2UI updates.

## Stored Surface Profile

A generated node stores:

- `content`: the authoritative semantic data and A2UI data model;
- `a2ui.version`: `v1.0`;
- `a2ui.catalogId`: `https://homerail.dev/a2ui/catalogs/core/v1`;
- `a2ui.components`: native flat A2UI component definitions;
- optional bounded A2UI `surfaceProperties`.

`homerail-protocol` exports `homerailA2uiCatalogDefinition`, the machine-readable A2UI Catalog Definition for this `catalogId`. It is assembled from the same component and function schemas used by runtime validation; there is no ViewSpec compatibility reader, generated mirror, or conversion step. Catalog consumers can import that value directly when constructing an A2UI prompt or capabilities exchange.

The host owns the runtime `surfaceId` and derives it from the immutable HomeRail node ID. It assembles a standard A2UI `createSurface` message by adding that ID and the node's `content` as `dataModel`. This is envelope assembly, not a source-language conversion.

Keeping `content` authoritative avoids storing two copies of the same data. Updating content does not require rewriting component definitions, and updating presentation does not mutate semantic data.

## HomeRail Catalog

The Catalog reuses safe A2UI Basic components for text, media, rows, columns, lists, cards, tabs, dividers, inputs, and event buttons. It adds explicit HomeRail components where a Basic-only composition would lose product semantics or become unnecessarily large:

- `HrGrid` and `HrGridItem` for bounded responsive layout;
- `HrSection`, `HrDisclosure`, and `HrIf` for grouping and progressive disclosure;
- `HrMetric`, `HrStatusBadge`, and `HrProgress` for glanceable state;
- `HrList` and `HrTable` for dense collections without expanding every row into a component subtree;
- `HrTimeline`, `HrBarChart`, and `HrDag` for visual explanation;
- `HrLink` for explicit, clickable HTTP(S) evidence without enabling Markdown navigation;
- `HrArtifact` for brokered image, HTML, and file previews.

Catalog functions are deterministic and side-effect free. The profile supports `formatString`, `formatNumber`, `formatCurrency`, `formatDate`, `pluralize`, `required`, `length`, `numeric`, `email`, `and`, `or`, `not`, and template-only `@index`. Literal `formatString` values support pointer interpolation only; nested function expressions are rejected. `openUrl` and `regex` are deliberately excluded, as are arbitrary code, inline HTML, CSS, and JavaScript.

`weight` is accepted only when the component is a direct child of `Row` or `Column`. `DateTimeInput` must enable at least one native date or time picker. These are explicit HomeRail Catalog restrictions that prevent ambiguous or ineffective layouts while preserving native A2UI wire shapes.

## Actions And Artifacts

An A2UI event name is only a trigger. It must match an action already declared by the node's authoritative HomeRail Action Registry entry. Non-empty event context, `responsePath`, `wantResponse: true`, and local `functionCall` actions are rejected. Document and node revisions, confirmation, permissions, idempotency, and fixed arguments remain host-owned.

Artifact components carry passive references only. `HrArtifact` previews resolve through the existing broker and HTML sandbox. Basic image, video, and audio components may use validated HTTP(S) media references. `HrLink` is the only Core Catalog component that creates external navigation, and it accepts only credential-free HTTP(S) URLs opened with `noopener`, `noreferrer`, and a no-referrer policy. Executable schemes, credentials, data URLs, network shares, and unsafe local schemes are rejected. A function cannot create a new network or execution capability.

## Runtime Invariants

HomeRail applies stricter snapshot rules in addition to the official A2UI JSON Schema:

- exactly one `root` component;
- unique component IDs and no unreachable hidden components;
- every child and template reference resolves;
- no component-reference cycles;
- maximum graph depth 8;
- maximum 128 declared and materialized components;
- maximum 24 direct children per container;
- maximum 50 items for a template or dense collection source;
- maximum 64 KiB per stored A2UI surface;
- only the pinned HomeRail Catalog ID;
- only registered A2UI functions and action event names;
- safe Artifact URI validation.

If the complete A2UI surface does not fit a bounded Manager Agent canvas-context envelope, the host omits it and marks the omission. It never truncates a component graph into an invalid partial surface.

## Migration Policy

The earlier ViewSpec prototype never shipped, so the native A2UI implementation intentionally has no ViewSpec compatibility reader, converter, feature flag, or dual renderer. Development databases created by prototype revisions are not migrated in place; validation uses an isolated `HOMERAIL_HOME` and creates fresh A2UI documents.

If the upstream v1.0 candidate changes before HomeRail ships, the pinned profile and tests are updated directly. After release, protocol evolution must use explicit Catalog and storage-version boundaries instead of silent field reinterpretation.

## Verification

The acceptance suite covers:

- official A2UI v1.0 envelope conformance;
- HomeRail Catalog schema and semantic budgets;
- data bindings, relative template paths, pure functions, and local form state;
- Action Registry isolation and Artifact sandboxing;
- atomic put, patch, remove, and revision conflict behavior;
- desktop, 1080p, compact mobile, focus, expansion, and reduced-motion rendering;
- real Manager Agent scenarios for research summaries, Palworld visual formulas, and generated image/HTML Artifacts.
