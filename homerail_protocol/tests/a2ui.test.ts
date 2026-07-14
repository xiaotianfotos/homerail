import { describe, expect, it } from "vitest";
import {
  HOMERAIL_A2UI_CATALOG_ID,
  HOMERAIL_A2UI_MAX_BYTES,
  HOMERAIL_A2UI_PURE_FUNCTIONS,
  HOMERAIL_A2UI_UPSTREAM_COMMIT,
  analyzeHomerailA2uiSurfaceSemantics,
  applyHomerailDirectUiProjection,
  createHomerailA2uiCreateSurfaceMessage,
  homerailA2uiCatalogComponentSchemas,
  homerailA2uiCatalogDefinition,
  homerailA2uiCatalogFunctionSchemas,
  homerailA2uiComponentSchema,
  isSafeGenerativeUiExternalUri,
  validateGenerativeUiNode,
  validateHomerailA2uiCreateSurfaceMessage,
  validateHomerailA2uiSurface,
  type GenerativeUiNodeV1,
  type HomerailA2uiSurfaceV1,
} from "../src/index.js";

function surface(): HomerailA2uiSurfaceV1 {
  return {
    version: "v1.0",
    catalogId: HOMERAIL_A2UI_CATALOG_ID,
    surfaceProperties: { agentDisplayName: "Release agent" },
    components: [
      { id: "root", component: "Column", children: ["title", "metrics", "checks", "step"] },
      {
        id: "title",
        component: "Text",
        text: { call: "formatString", args: { value: "## ${/data/title}" } },
      },
      {
        id: "metrics",
        component: "HrGrid",
        children: ["passed-cell", "blocked-cell"],
        columns: { default: 2, compact: 1 },
        gap: "sm",
      },
      { id: "passed-cell", component: "HrGridItem", child: "passed", span: 1 },
      { id: "blocked-cell", component: "HrGridItem", child: "blocked", span: 1 },
      { id: "passed", component: "HrMetric", label: "Passed", value: { path: "/data/passed" }, tone: "positive" },
      { id: "blocked", component: "HrMetric", label: "Blocked", value: { path: "/data/blocked" }, tone: "warning" },
      {
        id: "checks",
        component: "HrList",
        source: { path: "/data/checks" },
        itemTitlePath: "/label",
        itemDetailPath: "/detail",
        itemStatusPath: "/status",
      },
      {
        id: "step",
        component: "HrStep",
        index: 1,
        label: "Prepare release",
        detail: "Verified sequence",
        tone: "info",
        child: "passed",
      },
    ],
  };
}

function node(a2ui: HomerailA2uiSurfaceV1 = surface()): GenerativeUiNodeV1 {
  return {
    ir_version: 1,
    id: "com.example.views:one",
    kind: "com.example.views/generated",
    kind_version: 1,
    owner: { id: "com.example.views", version: "1.0.0" },
    surface: "result",
    importance: "primary",
    content: {
      data: {
        title: "Release readiness",
        passed: 3,
        blocked: 1,
        checks: [
          { label: "Manager", detail: "583 passed", status: "passed" },
          { label: "Windows", detail: "Pending", status: "blocked" },
        ],
      },
    },
    a2ui,
    fallback: { title: "Release readiness" },
  };
}

function templateSurface(itemCount: number): { a2ui: HomerailA2uiSurfaceV1; content: Record<string, unknown> } {
  return {
    a2ui: {
      version: "v1.0",
      catalogId: HOMERAIL_A2UI_CATALOG_ID,
      components: [
        { id: "root", component: "List", children: { componentId: "row", path: "/items" } },
        { id: "row", component: "Column", children: ["name", "position"] },
        { id: "name", component: "Text", text: { path: "name" } },
        { id: "position", component: "Text", text: { call: "@index", args: { offset: 1 } } },
      ],
    },
    content: {
      items: Array.from({ length: itemCount }, (_, index) => ({ name: `Item ${index}` })),
    },
  };
}

describe("direct A2UI v1.0 protocol", () => {
  it("exports one standard custom Catalog from the runtime component and function schemas", () => {
    const runtimeComponents = homerailA2uiComponentSchema.oneOf.map((schema) => (
      (schema.properties.component as { const: string }).const
    ));
    expect(homerailA2uiCatalogDefinition).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: HOMERAIL_A2UI_CATALOG_ID,
      catalogId: HOMERAIL_A2UI_CATALOG_ID,
      components: homerailA2uiCatalogComponentSchemas,
      functions: homerailA2uiCatalogFunctionSchemas,
    });
    expect(Object.keys(homerailA2uiCatalogComponentSchemas)).toEqual(runtimeComponents);
    expect(Object.keys(homerailA2uiCatalogFunctionSchemas).sort()).toEqual(
      HOMERAIL_A2UI_PURE_FUNCTIONS.filter((name) => name !== "@index").sort(),
    );

    for (const [name, schema] of Object.entries(homerailA2uiCatalogComponentSchemas)) {
      expect(schema).toMatchObject({
        type: "object",
        allOf: expect.any(Array),
        unevaluatedProperties: false,
      });
      const body = (schema.allOf as Array<Record<string, unknown>>).at(-1);
      expect(body?.properties).toMatchObject({ component: { const: name } });
    }
    expect(JSON.stringify(homerailA2uiCatalogDefinition)).not.toContain("homerail-a2ui-dynamic-");
    expect(JSON.stringify(homerailA2uiCatalogDefinition)).not.toContain("homerail-a2ui-data-binding");
  });

  it("pins the upstream contract and validates the direct HomeRail surface", () => {
    expect(HOMERAIL_A2UI_UPSTREAM_COMMIT).toBe("16425ca82061f756e420d2453e066d0c7c0295c1");
    expect(validateHomerailA2uiSurface(surface(), { data_model: node().content })).toMatchObject({
      valid: true,
      errors: [],
    });
    expect(validateGenerativeUiNode(node()).valid).toBe(true);
  });

  it("creates the exact standard v1 createSurface envelope with host-owned id and node content", () => {
    const value = node();
    const message = createHomerailA2uiCreateSurfaceMessage(value);
    expect(message).toEqual({
      version: "v1.0",
      createSurface: {
        surfaceId: value.id,
        catalogId: HOMERAIL_A2UI_CATALOG_ID,
        surfaceProperties: { agentDisplayName: "Release agent" },
        components: value.a2ui?.components,
        dataModel: value.content,
      },
    });
    expect(validateHomerailA2uiCreateSurfaceMessage(message).valid).toBe(true);

    expect(validateHomerailA2uiCreateSurfaceMessage({
      version: "v1.0",
      createSurface: {
        surfaceId: "surface-one",
        catalogId: HOMERAIL_A2UI_CATALOG_ID,
        sendDataModel: false,
      },
    }).valid).toBe(true);
    expect(validateHomerailA2uiCreateSurfaceMessage({ ...message, extra: true }).valid).toBe(false);
    expect(validateHomerailA2uiCreateSurfaceMessage({
      ...message,
      createSurface: { ...message.createSurface, extra: true },
    }).valid).toBe(false);
  });

  it("uses exact standard DataBinding and FunctionCall shapes", () => {
    expect(HOMERAIL_A2UI_PURE_FUNCTIONS).toEqual([
      "@index",
      "and",
      "email",
      "formatCurrency",
      "formatDate",
      "formatNumber",
      "formatString",
      "length",
      "not",
      "numeric",
      "or",
      "pluralize",
      "required",
    ]);

    expect(validateHomerailA2uiSurface({
      version: "v1.0",
      catalogId: HOMERAIL_A2UI_CATALOG_ID,
      components: [{ id: "root", component: "Text", text: { path: "/title" } }],
    }, { data_model: { title: "Bound" } }).valid).toBe(true);

    expect(validateHomerailA2uiSurface({
      version: "v1.0",
      catalogId: HOMERAIL_A2UI_CATALOG_ID,
      components: [{ id: "root", component: "Text", text: { path: "/title", format: "text" } }],
    }).valid).toBe(false);
    expect(validateHomerailA2uiSurface({
      version: "v1.0",
      catalogId: HOMERAIL_A2UI_CATALOG_ID,
      components: [{ id: "root", component: "Text", text: { call: "openUrl", args: { url: "https://example.com" } } }],
    }).valid).toBe(false);
    expect(validateHomerailA2uiSurface({
      version: "v1.0",
      catalogId: HOMERAIL_A2UI_CATALOG_ID,
      components: [{ id: "root", component: "Text", text: { call: "regex", args: { value: "aaaa", pattern: "(a+)+$" } } }],
    }).valid).toBe(false);

    const nestedRegex: HomerailA2uiSurfaceV1 = {
      version: "v1.0",
      catalogId: HOMERAIL_A2UI_CATALOG_ID,
      components: [{
        id: "root",
        component: "HrMetric",
        label: "Unsafe",
        value: [{ call: "regex", args: { value: "aaaa", pattern: "(a+)+$" } }],
      }],
    };
    expect(validateHomerailA2uiSurface(nestedRegex).errors.some((error) => (
      error.keyword === "a2uiPureFunction"
    ))).toBe(true);
  });

  it("narrows literal formatString expressions to pointers and escaped openers", () => {
    const escapedAndAbsolute: HomerailA2uiSurfaceV1 = {
      version: "v1.0",
      catalogId: HOMERAIL_A2UI_CATALOG_ID,
      components: [{
        id: "root",
        component: "Text",
        text: { call: "formatString", args: { value: "Literal \\${name}; bound ${/title}" } },
      }],
    };
    expect(validateHomerailA2uiSurface(escapedAndAbsolute, {
      data_model: { title: "Bound" },
    }).valid).toBe(true);

    const templateRelative = templateSurface(2);
    templateRelative.a2ui.components[2] = {
      id: "name",
      component: "Text",
      text: { call: "formatString", args: { value: "${name} (${/label})" } },
    };
    expect(validateHomerailA2uiSurface(templateRelative.a2ui, {
      data_model: { ...templateRelative.content, label: "item" },
    }).valid).toBe(true);

    const indexInterpolation = structuredClone(templateRelative.a2ui);
    indexInterpolation.components[2] = {
      id: "name",
      component: "Text",
      text: { call: "formatString", args: { value: "${@index}" } },
    };
    expect(validateHomerailA2uiSurface(indexInterpolation, {
      data_model: templateRelative.content,
    }).errors.some((error) => error.keyword === "a2uiFormatStringExpression")).toBe(true);

    for (const value of [
      "${name}",
      "${formatDate(value:${/date}, format:'yyyy')}",
      "${now()}",
      "${/title",
    ]) {
      const invalid = structuredClone(escapedAndAbsolute);
      invalid.components[0] = {
        id: "root",
        component: "Text",
        text: { call: "formatString", args: { value } },
      };
      expect(validateHomerailA2uiSurface(invalid).valid).toBe(false);
    }

    const dangerous = structuredClone(escapedAndAbsolute);
    dangerous.components[0] = {
      id: "root",
      component: "Text",
      text: { call: "formatString", args: { value: "${/__proto__/value}" } },
    };
    expect(validateHomerailA2uiSurface(dangerous).errors.some((error) => (
      error.keyword === "a2uiPointerSegment"
    ))).toBe(true);
  });

  it("validates template-relative bindings and materialized component budgets", () => {
    const valid = templateSurface(20);
    expect(validateHomerailA2uiSurface(valid.a2ui, { data_model: valid.content }).valid).toBe(true);

    const rootRelative = structuredClone(valid.a2ui);
    rootRelative.components = [{ id: "root", component: "Text", text: { path: "name" } }];
    expect(validateHomerailA2uiSurface(rootRelative).errors.some((error) => (
      error.keyword === "a2uiBindingScope"
    ))).toBe(true);

    const indexBinding = templateSurface(1);
    indexBinding.a2ui.components[2] = {
      id: "name",
      component: "Text",
      text: { path: "@index" },
    };
    expect(validateHomerailA2uiSurface(indexBinding.a2ui, {
      data_model: indexBinding.content,
    }).errors.some((error) => error.keyword === "a2uiBindingProfile")).toBe(true);

    const oversizedMaterialization = templateSurface(50);
    expect(validateHomerailA2uiSurface(
      oversizedMaterialization.a2ui,
      { data_model: oversizedMaterialization.content },
    ).errors.some((error) => error.keyword === "maxA2uiMaterializedComponents")).toBe(true);

    const oversizedSource = templateSurface(51);
    expect(validateHomerailA2uiSurface(
      oversizedSource.a2ui,
      { data_model: oversizedSource.content },
    ).errors.some((error) => error.keyword === "maxA2uiSourceItems")).toBe(true);

    const tooManyMaterializedChildren = templateSurface(25);
    expect(validateHomerailA2uiSurface(
      tooManyMaterializedChildren.a2ui,
      { data_model: tooManyMaterializedChildren.content },
    ).errors.some((error) => error.keyword === "maxA2uiDirectChildren")).toBe(true);

    const pendingSource = templateSurface(0);
    expect(validateHomerailA2uiSurface(pendingSource.a2ui, { data_model: {} }).valid).toBe(true);
    expect(validateHomerailA2uiSurface(pendingSource.a2ui, {
      data_model: { items: "not-an-array" },
    }).errors.some((error) => error.keyword === "a2uiSourceType")).toBe(true);
  });

  it("enforces refs, cycles, unreachable components, one root, depth, and direct children", () => {
    const missing = structuredClone(surface());
    missing.components[0] = { id: "root", component: "Column", children: ["missing"] };
    expect(validateHomerailA2uiSurface(missing).errors.some((error) => (
      error.keyword === "a2uiComponentReference"
    ))).toBe(true);

    const cyclic: HomerailA2uiSurfaceV1 = {
      version: "v1.0",
      catalogId: HOMERAIL_A2UI_CATALOG_ID,
      components: [
        { id: "root", component: "Column", children: ["child"] },
        { id: "child", component: "Column", children: ["root"] },
      ],
    };
    expect(validateHomerailA2uiSurface(cyclic).errors.some((error) => (
      error.keyword === "a2uiComponentCycle"
    ))).toBe(true);

    const unreachable = structuredClone(surface());
    unreachable.components.push({ id: "orphan", component: "Text", text: "orphan" });
    expect(validateHomerailA2uiSurface(unreachable).errors.some((error) => (
      error.keyword === "a2uiUnreachableComponent"
    ))).toBe(true);

    const tooManyDeclared: HomerailA2uiSurfaceV1 = {
      version: "v1.0",
      catalogId: HOMERAIL_A2UI_CATALOG_ID,
      components: Array.from({ length: 129 }, (_, index) => ({
        id: index === 0 ? "root" : `orphan-${index}`,
        component: "Text" as const,
        text: "declared",
      })),
    };
    expect(analyzeHomerailA2uiSurfaceSemantics(tooManyDeclared).some((error) => (
      error.keyword === "maxA2uiDeclaredComponents"
    ))).toBe(true);

    expect(validateHomerailA2uiSurface({
      version: "v1.0",
      catalogId: HOMERAIL_A2UI_CATALOG_ID,
      components: [{ id: "not-root", component: "Text", text: "missing root" }],
    }).errors.some((error) => error.keyword === "a2uiRoot")).toBe(true);

    const deepComponents: HomerailA2uiSurfaceV1["components"] = Array.from(
      { length: 9 },
      (_, index) => index === 8
        ? { id: `depth-${index}`, component: "Text" as const, text: "leaf" }
        : { id: index === 0 ? "root" : `depth-${index}`, component: "Column" as const, children: [`depth-${index + 1}`] },
    );
    expect(validateHomerailA2uiSurface({
      version: "v1.0",
      catalogId: HOMERAIL_A2UI_CATALOG_ID,
      components: deepComponents,
    }).errors.some((error) => error.keyword === "maxA2uiDepth")).toBe(true);

    const wide = {
      version: "v1.0" as const,
      catalogId: HOMERAIL_A2UI_CATALOG_ID,
      components: [
        { id: "root", component: "Column" as const, children: Array.from({ length: 25 }, (_, index) => `child-${index}`) },
        ...Array.from({ length: 25 }, (_, index) => ({ id: `child-${index}`, component: "Text" as const, text: "child" })),
      ],
    };
    expect(analyzeHomerailA2uiSurfaceSemantics(wide as HomerailA2uiSurfaceV1)
      .some((error) => error.keyword === "maxA2uiDirectChildren")).toBe(true);
    expect(validateHomerailA2uiSurface(wide).valid).toBe(false);

    const invalidWeight: HomerailA2uiSurfaceV1 = {
      version: "v1.0",
      catalogId: HOMERAIL_A2UI_CATALOG_ID,
      components: [
        { id: "root", component: "Card", child: "weighted" },
        { id: "weighted", component: "Text", text: "Not a flex child", weight: 1 },
      ],
    };
    expect(validateHomerailA2uiSurface(invalidWeight).errors.some((error) => (
      error.keyword === "a2uiWeightParent"
    ))).toBe(true);

    const validWeight = structuredClone(invalidWeight);
    validWeight.components[0] = { id: "root", component: "Row", children: ["weighted"] };
    expect(validateHomerailA2uiSurface(validWeight).valid).toBe(true);
  });

  it("requires DateTimeInput to enable at least one native picker", () => {
    const disabled = {
      version: "v1.0",
      catalogId: HOMERAIL_A2UI_CATALOG_ID,
      components: [{ id: "root", component: "DateTimeInput", value: { path: "/value" } }],
    };
    expect(validateHomerailA2uiSurface(disabled, { data_model: { value: "" } }).valid).toBe(false);
    expect(validateHomerailA2uiSurface({
      ...disabled,
      components: [{ ...disabled.components[0], enableDate: true }],
    }, { data_model: { value: "" } }).valid).toBe(true);
  });

  it("maps event names to node actions and rejects local action calls or responses", () => {
    const interactive: HomerailA2uiSurfaceV1 = {
      version: "v1.0",
      catalogId: HOMERAIL_A2UI_CATALOG_ID,
      components: [
        { id: "root", component: "Button", child: "label", action: { event: { name: "inspect" } } },
        { id: "label", component: "Text", text: "Inspect" },
      ],
    };
    const interactiveNode = node(interactive);
    interactiveNode.actions = [{ id: "inspect", label: "Inspect", intent: "inspect" }];
    expect(validateGenerativeUiNode(interactiveNode).valid).toBe(true);

    const unavailable = structuredClone(interactiveNode);
    unavailable.actions = [{ id: "approve", label: "Approve", intent: "approve" }];
    expect(validateGenerativeUiNode(unavailable).errors.some((error) => (
      error.keyword === "a2uiActionReference"
    ))).toBe(true);

    const response = structuredClone(interactive);
    response.components[0] = {
      id: "root",
      component: "Button",
      child: "label",
      action: { event: { name: "inspect", wantResponse: true } },
    };
    expect(validateHomerailA2uiSurface(response).errors.some((error) => (
      error.keyword === "a2uiWantResponse"
    ))).toBe(true);

    const unsupportedEventFields = structuredClone(interactive);
    unsupportedEventFields.components[0] = {
      id: "root",
      component: "Button",
      child: "label",
      action: {
        event: {
          name: "inspect",
          context: { selected: true },
          responsePath: "/result",
        },
      },
    };
    const unsupportedErrors = validateHomerailA2uiSurface(unsupportedEventFields, {
      action_ids: new Set(["inspect"]),
    }).errors;
    expect(unsupportedErrors.some((error) => error.keyword === "a2uiActionContext")).toBe(true);
    expect(unsupportedErrors.some((error) => error.keyword === "a2uiResponsePath")).toBe(true);

    const emptyResponsePath = structuredClone(interactive);
    emptyResponsePath.components[0] = {
      id: "root",
      component: "Button",
      child: "label",
      action: { event: { name: "inspect", responsePath: "" } },
    };
    expect(validateHomerailA2uiSurface(emptyResponsePath, {
      action_ids: new Set(["inspect"]),
    }).errors.some((error) => error.keyword === "a2uiResponsePath")).toBe(true);

    const local = structuredClone(interactive);
    local.components[0] = {
      id: "root",
      component: "Button",
      child: "label",
      action: { functionCall: { call: "formatString", args: { value: "local" } } },
    };
    expect(validateHomerailA2uiSurface(local).errors.some((error) => (
      error.keyword === "a2uiActionFunctionCall"
    ))).toBe(true);
  });

  it("rejects unsafe static and bound media/artifact URIs", () => {
    for (const component of [
      { id: "root", component: "Image", url: "javascript:alert(1)" },
      { id: "root", component: "Video", url: "file:///etc/passwd" },
      { id: "root", component: "AudioPlayer", url: "//evil.example/audio" },
      { id: "root", component: "HrArtifact", kind: "file", uri: "\\\\evil.example\\share" },
    ]) {
      expect(validateHomerailA2uiSurface({
        version: "v1.0",
        catalogId: HOMERAIL_A2UI_CATALOG_ID,
        components: [component] as HomerailA2uiSurfaceV1["components"],
      }).errors.some((error) => error.keyword === "artifactUri")).toBe(true);
    }

    const bound: HomerailA2uiSurfaceV1 = {
      version: "v1.0",
      catalogId: HOMERAIL_A2UI_CATALOG_ID,
      components: [{ id: "root", component: "HrArtifact", kind: "image", uri: { path: "/url" } }],
    };
    expect(validateHomerailA2uiSurface(bound, { data_model: { url: "javascript:alert(1)" } })
      .errors.some((error) => error.keyword === "artifactUri")).toBe(true);
    expect(validateHomerailA2uiSurface(bound, {
      data_model: { url: "/api/voice-agent/sessions/session-one/artifacts/cover.png" },
    }).valid).toBe(true);
  });

  it("accepts only credential-free HTTP(S) links in HrLink", () => {
    expect(isSafeGenerativeUiExternalUri("https://example.com/report?id=7")).toBe(true);
    expect(isSafeGenerativeUiExternalUri("https://user:pass@example.com/report")).toBe(false);
    expect(isSafeGenerativeUiExternalUri("javascript:alert(1)")).toBe(false);

    const link: HomerailA2uiSurfaceV1 = {
      version: "v1.0",
      catalogId: HOMERAIL_A2UI_CATALOG_ID,
      components: [{
        id: "root",
        component: "HrLink",
        label: { path: "/label" },
        url: { path: "/url" },
        description: "Primary source",
      }],
    };
    expect(validateHomerailA2uiSurface(link, {
      data_model: { label: "Report", url: "https://example.com/report" },
    }).valid).toBe(true);
    expect(validateHomerailA2uiSurface(link, {
      data_model: { label: "Unsafe", url: "file:///etc/passwd" },
    }).errors.some((error) => error.keyword === "externalUri")).toBe(true);
  });

  it("rejects prototype-polluting pointer segments across bindings, templates, sources, and item fields", () => {
    const binding = structuredClone(surface());
    binding.components = [{ id: "root", component: "Text", text: { path: "/__proto__/secret" } }];
    expect(validateHomerailA2uiSurface(binding).errors.some((error) => (
      error.keyword === "a2uiPointerSegment"
    ))).toBe(true);

    const nestedBinding = structuredClone(surface());
    nestedBinding.components = [{
      id: "root",
      component: "HrMetric",
      label: "Unsafe",
      value: [{ path: "/constructor/value" }],
    }];
    expect(validateHomerailA2uiSurface(nestedBinding).errors.some((error) => (
      error.keyword === "a2uiPointerSegment"
    ))).toBe(true);

    const template = templateSurface(1).a2ui;
    (template.components[0] as Extract<typeof template.components[number], { component: "List" }>).children = {
      componentId: "row",
      path: "/constructor/items",
    };
    expect(validateHomerailA2uiSurface(template).errors.some((error) => (
      error.keyword === "a2uiPointerSegment"
    ))).toBe(true);

    const itemPath = surface();
    (itemPath.components[7] as Extract<typeof itemPath.components[number], { component: "HrList" }>).itemTitlePath = "/prototype/name";
    expect(validateHomerailA2uiSurface(itemPath).errors.some((error) => (
      error.keyword === "a2uiPointerSegment"
    ))).toBe(true);
  });

  it("enforces the 64 KiB surface budget and camelCase HomeRail fields", () => {
    const oversized: HomerailA2uiSurfaceV1 = {
      version: "v1.0",
      catalogId: HOMERAIL_A2UI_CATALOG_ID,
      components: [
        {
          id: "root",
          component: "Column",
          children: Array.from({ length: 17 }, (_, index) => `chunk-${index}`),
        },
        ...Array.from({ length: 17 }, (_, index) => ({
          id: `chunk-${index}`,
          component: "Text" as const,
          text: "x".repeat(Math.ceil(HOMERAIL_A2UI_MAX_BYTES / 16)),
        })),
      ],
    };
    expect(validateHomerailA2uiSurface(oversized).errors.some((error) => (
      error.keyword === "maxPayloadBytes"
    ))).toBe(true);

    const snakeCase = structuredClone(surface()) as unknown as Record<string, unknown>;
    const components = snakeCase.components as Array<Record<string, unknown>>;
    components[7].item_title_path = components[7].itemTitlePath;
    delete components[7].itemTitlePath;
    expect(validateHomerailA2uiSurface(snakeCase).valid).toBe(false);
  });

  it("projects A2UI separately from semantic content and host presentation", () => {
    const result = applyHomerailDirectUiProjection({
      plugin: { id: "com.example.views", version: "1.0.0" },
      arguments: {
        id: "com.example.views:one",
        title: "Runtime view",
        surface: "task",
        importance: "critical",
        density: "summary",
        canvas_size: "1x2",
        persistence: "turn",
        content: node().content,
        a2ui: surface(),
      },
      projection: {
        projection_version: 1,
        type: "direct_ui_node",
        kind: "com.example.views/generated",
        kind_version: 1,
        node_id_pointer: "/id",
        content_pointer: "/content",
        a2ui_pointer: "/a2ui",
        surface_pointer: "/surface",
        importance_pointer: "/importance",
        density_pointer: "/density",
        canvas_size_pointer: "/canvas_size",
        persistence_pointer: "/persistence",
        omit_content_fields: [],
        fallback: { title_pointer: "/title" },
        defaults: {
          surface: "result",
          importance: "primary",
          density: "detail",
          canvas_size: "2x2",
          persistence: "session",
        },
      },
    });
    expect(result.node).toMatchObject({
      surface: "task",
      importance: "critical",
      presentation: { density: "summary", canvas_size: "1x2" },
      lifecycle: { persistence: "turn" },
      content: node().content,
      a2ui: surface(),
    });
  });
});
