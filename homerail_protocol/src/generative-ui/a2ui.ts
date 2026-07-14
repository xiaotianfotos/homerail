import {
  isSafeGenerativeUiArtifactUri,
  isSafeGenerativeUiExternalUri,
} from "./artifact-uri.js";

/** Exact upstream revision used to define the HomeRail A2UI v1.0 catalog. */
export const HOMERAIL_A2UI_UPSTREAM_COMMIT = "16425ca82061f756e420d2453e066d0c7c0295c1" as const;
export const HOMERAIL_A2UI_VERSION = "v1.0" as const;
export const HOMERAIL_A2UI_CATALOG_ID = "https://homerail.dev/a2ui/catalogs/core/v1" as const;
export const HOMERAIL_A2UI_MAX_BYTES = 64 * 1024;
export const HOMERAIL_A2UI_MAX_DEPTH = 8;
export const HOMERAIL_A2UI_MAX_COMPONENTS = 128;
export const HOMERAIL_A2UI_MAX_DIRECT_CHILDREN = 24;
export const HOMERAIL_A2UI_MAX_SOURCE_ITEMS = 50;

export type A2uiVersionV1 = typeof HOMERAIL_A2UI_VERSION;

export interface A2uiDataBindingV1 {
  path: string;
}

/**
 * Deterministic functions exposed by the HomeRail profile. `openUrl` and
 * `regex` are deliberately absent. Literal `formatString` interpolation is
 * further narrowed by semantic validation to pointers and escaped `${`.
 */
export const HOMERAIL_A2UI_PURE_FUNCTIONS = [
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
] as const;
export type A2uiPureFunctionNameV1 = (typeof HOMERAIL_A2UI_PURE_FUNCTIONS)[number];

/** Standard A2UI FunctionCall shape, restricted to HomeRail's pure catalog. */
export interface A2uiFunctionCallV1 {
  call: A2uiPureFunctionNameV1;
  args?: Record<string, unknown>;
}

export type A2uiDynamicValueV1 =
  | string
  | number
  | boolean
  | unknown[]
  | A2uiDataBindingV1
  | A2uiFunctionCallV1;
export type A2uiDynamicStringV1 = string | A2uiDataBindingV1 | A2uiFunctionCallV1;
export type A2uiDynamicNumberV1 = number | A2uiDataBindingV1 | A2uiFunctionCallV1;
export type A2uiDynamicBooleanV1 = boolean | A2uiDataBindingV1 | A2uiFunctionCallV1;
export type A2uiDynamicStringListV1 = string[] | A2uiDataBindingV1 | A2uiFunctionCallV1;

export type A2uiChildListV1 =
  | string[]
  | {
      componentId: string;
      path: string;
    };

export interface A2uiAccessibilityAttributesV1 {
  label?: A2uiDynamicStringV1;
  description?: A2uiDynamicStringV1;
}

export interface A2uiComponentCommonV1 {
  id: string;
  accessibility?: A2uiAccessibilityAttributesV1;
}

export interface A2uiCheckRuleV1 {
  condition: A2uiDynamicBooleanV1;
  message: string;
}

export type A2uiActionV1 =
  | {
      event: {
        name: string;
        context?: Record<string, A2uiDynamicValueV1>;
        wantResponse?: boolean;
        responsePath?: string;
      };
    }
  | { functionCall: A2uiFunctionCallV1 };

interface A2uiWeightedComponentV1 extends A2uiComponentCommonV1 {
  weight?: number;
}

interface A2uiCheckableComponentV1 {
  checks?: A2uiCheckRuleV1[];
}

export type A2uiIconNameV1 =
  | "accountCircle" | "add" | "arrowBack" | "arrowForward" | "attachFile"
  | "calendarToday" | "call" | "camera" | "check" | "close" | "delete"
  | "download" | "edit" | "event" | "error" | "fastForward" | "favorite"
  | "favoriteOff" | "folder" | "help" | "home" | "info" | "locationOn"
  | "lock" | "lockOpen" | "mail" | "menu" | "moreVert" | "moreHoriz"
  | "notificationsOff" | "notifications" | "pause" | "payment" | "person"
  | "phone" | "photo" | "play" | "print" | "refresh" | "rewind" | "search"
  | "send" | "settings" | "share" | "shoppingCart" | "skipNext" | "skipPrevious"
  | "star" | "starHalf" | "starOff" | "stop" | "upload" | "visibility"
  | "visibilityOff" | "volumeDown" | "volumeMute" | "volumeOff" | "volumeUp"
  | "warning";

export interface A2uiTextComponentV1 extends A2uiWeightedComponentV1 {
  component: "Text";
  text: A2uiDynamicStringV1;
  variant?: "caption" | "body";
}

export interface A2uiImageComponentV1 extends A2uiWeightedComponentV1 {
  component: "Image";
  url: A2uiDynamicStringV1;
  description?: A2uiDynamicStringV1;
  fit?: "contain" | "cover" | "fill" | "none" | "scaleDown";
  variant?: "icon" | "avatar" | "smallFeature" | "mediumFeature" | "largeFeature" | "header";
}

export interface A2uiIconComponentV1 extends A2uiWeightedComponentV1 {
  component: "Icon";
  name: A2uiIconNameV1 | A2uiDataBindingV1;
}

export interface A2uiVideoComponentV1 extends A2uiWeightedComponentV1 {
  component: "Video";
  url: A2uiDynamicStringV1;
  posterUrl?: A2uiDynamicStringV1;
}

export interface A2uiAudioPlayerComponentV1 extends A2uiWeightedComponentV1 {
  component: "AudioPlayer";
  url: A2uiDynamicStringV1;
  description?: A2uiDynamicStringV1;
}

export interface A2uiRowComponentV1 extends A2uiWeightedComponentV1 {
  component: "Row";
  children: A2uiChildListV1;
  justify?: "center" | "end" | "spaceAround" | "spaceBetween" | "spaceEvenly" | "start" | "stretch";
  align?: "start" | "center" | "end" | "stretch";
}

export interface A2uiColumnComponentV1 extends A2uiWeightedComponentV1 {
  component: "Column";
  children: A2uiChildListV1;
  justify?: "start" | "center" | "end" | "spaceBetween" | "spaceAround" | "spaceEvenly" | "stretch";
  align?: "start" | "center" | "end" | "stretch";
}

export interface A2uiListComponentV1 extends A2uiWeightedComponentV1 {
  component: "List";
  children: A2uiChildListV1;
  direction?: "vertical" | "horizontal";
  align?: "start" | "center" | "end" | "stretch";
}

export interface A2uiCardComponentV1 extends A2uiWeightedComponentV1 {
  component: "Card";
  child: string;
}

export interface A2uiTabsComponentV1 extends A2uiWeightedComponentV1 {
  component: "Tabs";
  tabs: Array<{ title: A2uiDynamicStringV1; child: string }>;
}

export interface A2uiModalComponentV1 extends A2uiWeightedComponentV1 {
  component: "Modal";
  trigger: string;
  content: string;
}

export interface A2uiDividerComponentV1 extends A2uiWeightedComponentV1 {
  component: "Divider";
  axis?: "horizontal" | "vertical";
}

export interface A2uiButtonComponentV1 extends A2uiWeightedComponentV1, A2uiCheckableComponentV1 {
  component: "Button";
  child: string;
  variant?: "default" | "primary" | "borderless";
  action: A2uiActionV1;
}

export interface A2uiTextFieldComponentV1 extends A2uiWeightedComponentV1, A2uiCheckableComponentV1 {
  component: "TextField";
  label: A2uiDynamicStringV1;
  value?: A2uiDynamicStringV1;
  placeholder?: A2uiDynamicStringV1;
  variant?: "longText" | "number" | "shortText" | "obscured";
}

export interface A2uiCheckBoxComponentV1 extends A2uiWeightedComponentV1, A2uiCheckableComponentV1 {
  component: "CheckBox";
  label: A2uiDynamicStringV1;
  value: A2uiDynamicBooleanV1;
}

export interface A2uiChoicePickerComponentV1 extends A2uiWeightedComponentV1, A2uiCheckableComponentV1 {
  component: "ChoicePicker";
  label?: A2uiDynamicStringV1;
  variant?: "multipleSelection" | "mutuallyExclusive";
  options: Array<{ label: A2uiDynamicStringV1; value: string }>;
  value: A2uiDynamicStringListV1;
  displayStyle?: "checkbox" | "chips";
  filterable?: boolean;
}

export interface A2uiSliderComponentV1 extends A2uiWeightedComponentV1, A2uiCheckableComponentV1 {
  component: "Slider";
  label?: A2uiDynamicStringV1;
  min?: number;
  max: number;
  value: A2uiDynamicNumberV1;
  steps?: number;
}

export interface A2uiDateTimeInputComponentV1 extends A2uiWeightedComponentV1, A2uiCheckableComponentV1 {
  component: "DateTimeInput";
  value: A2uiDynamicStringV1;
  enableDate?: boolean;
  enableTime?: boolean;
  min?: A2uiDynamicStringV1;
  max?: A2uiDynamicStringV1;
  label?: A2uiDynamicStringV1;
}

export type HomerailA2uiGapV1 = "none" | "xs" | "sm" | "md" | "lg";
export type HomerailA2uiAlignV1 = "start" | "center" | "end" | "stretch";
export type HomerailA2uiToneNameV1 = "neutral" | "info" | "positive" | "warning" | "critical";
export type HomerailA2uiToneV1 = HomerailA2uiToneNameV1 | A2uiDataBindingV1 | A2uiFunctionCallV1;
export type HomerailA2uiFormatV1 = "text" | "number" | "percent" | "datetime" | "duration" | "status" | "tone";

export interface HomerailA2uiGridComponentV1 extends A2uiComponentCommonV1 {
  component: "HrGrid";
  children: A2uiChildListV1;
  columns: { default: 1 | 2 | 3; compact: 1 | 2 | 3 };
  gap?: HomerailA2uiGapV1;
  align?: HomerailA2uiAlignV1;
}

export interface HomerailA2uiGridItemComponentV1 extends A2uiComponentCommonV1 {
  component: "HrGridItem";
  child: string;
  span: 1 | 2 | 3;
}

export interface HomerailA2uiSectionComponentV1 extends A2uiComponentCommonV1 {
  component: "HrSection";
  title?: A2uiDynamicStringV1;
  children: A2uiChildListV1;
  tone?: HomerailA2uiToneV1;
}

export interface HomerailA2uiMetricComponentV1 extends A2uiComponentCommonV1 {
  component: "HrMetric";
  label: A2uiDynamicStringV1;
  value: A2uiDynamicValueV1;
  unit?: A2uiDynamicStringV1;
  tone?: HomerailA2uiToneV1;
}

export interface HomerailA2uiStatusBadgeComponentV1 extends A2uiComponentCommonV1 {
  component: "HrStatusBadge";
  text: A2uiDynamicStringV1;
  tone?: HomerailA2uiToneV1;
}

export interface HomerailA2uiProgressComponentV1 extends A2uiComponentCommonV1 {
  component: "HrProgress";
  label?: A2uiDynamicStringV1;
  value: A2uiDynamicNumberV1;
  tone?: HomerailA2uiToneV1;
}

export interface HomerailA2uiStepComponentV1 extends A2uiComponentCommonV1 {
  component: "HrStep";
  index: A2uiDynamicValueV1;
  label: A2uiDynamicStringV1;
  detail?: A2uiDynamicStringV1;
  tone?: HomerailA2uiToneV1;
  child: string;
}

interface HomerailA2uiSourceComponentV1 extends A2uiComponentCommonV1 {
  source: A2uiDataBindingV1;
  maxItems?: number;
}

export interface HomerailA2uiListComponentV1 extends HomerailA2uiSourceComponentV1 {
  component: "HrList";
  itemTitlePath: string;
  itemDetailPath?: string;
  itemBadgePath?: string;
  itemStatusPath?: string;
}

export interface HomerailA2uiTimelineComponentV1 extends HomerailA2uiSourceComponentV1 {
  component: "HrTimeline";
  itemTitlePath: string;
  itemDetailPath?: string;
  itemTimePath?: string;
  itemStatusPath?: string;
}

export interface HomerailA2uiBarChartComponentV1 extends HomerailA2uiSourceComponentV1 {
  component: "HrBarChart";
  itemLabelPath: string;
  itemValuePath: string;
  itemTonePath?: string;
}

export interface HomerailA2uiDagComponentV1 extends HomerailA2uiSourceComponentV1 {
  component: "HrDag";
  itemIdPath: string;
  itemLabelPath: string;
  itemDetailPath?: string;
  itemStatusPath?: string;
  itemProgressPath?: string;
  itemDependsOnPath: string;
}

export interface HomerailA2uiTableComponentV1 extends HomerailA2uiSourceComponentV1 {
  component: "HrTable";
  columns: Array<{
    id: string;
    label: string;
    path: string;
    format?: HomerailA2uiFormatV1;
  }>;
}

export interface HomerailA2uiDisclosureComponentV1 extends A2uiComponentCommonV1 {
  component: "HrDisclosure";
  title: A2uiDynamicStringV1;
  children: A2uiChildListV1;
  open?: A2uiDynamicBooleanV1;
}

export interface HomerailA2uiLinkComponentV1 extends A2uiComponentCommonV1 {
  component: "HrLink";
  label: A2uiDynamicStringV1;
  url: A2uiDynamicStringV1;
  description?: A2uiDynamicStringV1;
}

export interface HomerailA2uiArtifactComponentV1 extends A2uiComponentCommonV1 {
  component: "HrArtifact";
  kind: "image" | "html" | "file";
  uri: A2uiDynamicStringV1;
  title?: A2uiDynamicStringV1;
  description?: A2uiDynamicStringV1;
  alt?: A2uiDynamicStringV1;
  layout?: "fluid" | "portrait";
}

export interface HomerailA2uiIfComponentV1 extends A2uiComponentCommonV1 {
  component: "HrIf";
  condition: A2uiDynamicBooleanV1;
  children: A2uiChildListV1;
}

export type A2uiBasicComponentV1 =
  | A2uiTextComponentV1
  | A2uiImageComponentV1
  | A2uiIconComponentV1
  | A2uiVideoComponentV1
  | A2uiAudioPlayerComponentV1
  | A2uiRowComponentV1
  | A2uiColumnComponentV1
  | A2uiListComponentV1
  | A2uiCardComponentV1
  | A2uiTabsComponentV1
  | A2uiModalComponentV1
  | A2uiDividerComponentV1
  | A2uiButtonComponentV1
  | A2uiTextFieldComponentV1
  | A2uiCheckBoxComponentV1
  | A2uiChoicePickerComponentV1
  | A2uiSliderComponentV1
  | A2uiDateTimeInputComponentV1;

export type HomerailA2uiCatalogComponentV1 =
  | HomerailA2uiGridComponentV1
  | HomerailA2uiGridItemComponentV1
  | HomerailA2uiSectionComponentV1
  | HomerailA2uiMetricComponentV1
  | HomerailA2uiStatusBadgeComponentV1
  | HomerailA2uiProgressComponentV1
  | HomerailA2uiStepComponentV1
  | HomerailA2uiListComponentV1
  | HomerailA2uiTableComponentV1
  | HomerailA2uiTimelineComponentV1
  | HomerailA2uiBarChartComponentV1
  | HomerailA2uiDagComponentV1
  | HomerailA2uiDisclosureComponentV1
  | HomerailA2uiLinkComponentV1
  | HomerailA2uiArtifactComponentV1
  | HomerailA2uiIfComponentV1;

export type A2uiComponentV1 = A2uiBasicComponentV1 | HomerailA2uiCatalogComponentV1;

export interface HomerailA2uiSurfacePropertiesV1 {
  iconUrl?: string;
  agentDisplayName?: string;
}

export interface HomerailA2uiSurfaceV1 {
  version: A2uiVersionV1;
  catalogId: typeof HOMERAIL_A2UI_CATALOG_ID;
  components: A2uiComponentV1[];
  surfaceProperties?: HomerailA2uiSurfacePropertiesV1;
}

/** Exact standard v1.0 createSurface envelope, before HomeRail narrows it. */
export interface A2uiCreateSurfaceMessageV1 {
  version: A2uiVersionV1;
  createSurface: {
    surfaceId: string;
    catalogId: string;
    surfaceProperties?: HomerailA2uiSurfacePropertiesV1;
    sendDataModel?: boolean;
    components?: A2uiComponentV1[];
    dataModel?: Record<string, unknown>;
  };
}

/** Standard A2UI v1.0 createSurface message specialized to a direct HomeRail surface. */
export interface HomerailA2uiCreateSurfaceMessageV1 extends A2uiCreateSurfaceMessageV1 {
  createSurface: {
    surfaceId: string;
    catalogId: typeof HOMERAIL_A2UI_CATALOG_ID;
    surfaceProperties?: HomerailA2uiSurfacePropertiesV1;
    components: A2uiComponentV1[];
    dataModel: Record<string, unknown>;
  };
}

export interface HomerailA2uiSemanticIssueV1 {
  path: string;
  message: string;
  keyword: string;
}

export interface HomerailA2uiSemanticOptionsV1 {
  action_ids?: ReadonlySet<string>;
  /** Patch validation defers this one cross-field check until the reducer has the stored actions. */
  defer_action_references?: boolean;
  data_model?: Record<string, unknown>;
  path?: string;
}

interface ComponentEdge {
  id: string;
  path: string;
  template: boolean;
  sourcePath?: string;
}

interface EvaluationScope {
  inTemplate: boolean;
  value?: unknown;
}

const SOURCE_COMPONENTS = new Set<A2uiComponentV1["component"]>([
  "HrList",
  "HrTable",
  "HrTimeline",
  "HrBarChart",
  "HrDag",
]);
const PURE_FUNCTIONS = new Set<string>(HOMERAIL_A2UI_PURE_FUNCTIONS);
const A2UI_ABSOLUTE_POINTER = /^(?:\/(?:[^~/]|~[01])*)+$/;
const A2UI_RELATIVE_POINTER = /^(?:[^~/]|~[01])+(?:\/(?:[^~/]|~[01])*)*$/;
const A2UI_UNSUPPORTED_FORMAT_EXPRESSION = /[()'"`,]/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isDataBinding(value: unknown): value is A2uiDataBindingV1 {
  return isRecord(value) && typeof value.path === "string" && Object.keys(value).length === 1;
}

function isFunctionCall(value: unknown): value is A2uiFunctionCallV1 {
  return isRecord(value) && typeof value.call === "string";
}

function isChildTemplate(value: A2uiChildListV1): value is Exclude<A2uiChildListV1, string[]> {
  return !Array.isArray(value);
}

function pointer(root: unknown, path: string): unknown {
  if (path === "") return root;
  let current = root;
  for (const encoded of path.slice(1).split("/")) {
    const token = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/.test(token)) return undefined;
      current = current[Number(token)];
      continue;
    }
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, token)) return undefined;
    current = current[token];
  }
  return current;
}

function resolvePath(dataModel: Record<string, unknown>, path: string, scope: EvaluationScope): unknown {
  if (path.startsWith("/")) return pointer(dataModel, path);
  const root = scope.inTemplate ? scope.value : dataModel;
  return pointer(root, path ? `/${path}` : "");
}

function dangerousPointerSegment(path: string): string | undefined {
  const normalized = path.startsWith("/") ? path.slice(1) : path;
  for (const encoded of normalized.split("/")) {
    const segment = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
    if (segment === "__proto__" || segment === "prototype" || segment === "constructor") {
      return segment;
    }
  }
  return undefined;
}

function childEdges(component: A2uiComponentV1, index: number): ComponentEdge[] {
  const base = `/components/${index}`;
  const childList = (children: A2uiChildListV1): ComponentEdge[] => {
    if (isChildTemplate(children)) {
      return [{
        id: children.componentId,
        path: `${base}/children/componentId`,
        template: true,
        sourcePath: children.path,
      }];
    }
    return children.map((id, childIndex) => ({
      id,
      path: `${base}/children/${childIndex}`,
      template: false,
    }));
  };

  switch (component.component) {
    case "Row":
    case "Column":
    case "List":
    case "HrGrid":
    case "HrSection":
    case "HrDisclosure":
    case "HrIf":
      return childList(component.children);
    case "Card":
    case "Button":
    case "HrGridItem":
    case "HrStep":
      return [{ id: component.child, path: `${base}/child`, template: false }];
    case "Tabs":
      return component.tabs.map((tab, tabIndex) => ({
        id: tab.child,
        path: `${base}/tabs/${tabIndex}/child`,
        template: false,
      }));
    case "Modal":
      return [
        { id: component.trigger, path: `${base}/trigger`, template: false },
        { id: component.content, path: `${base}/content`, template: false },
      ];
    default:
      return [];
  }
}

function componentChecks(component: A2uiComponentV1): A2uiCheckRuleV1[] {
  return "checks" in component ? component.checks ?? [] : [];
}

/**
 * Performs HomeRail semantic checks that JSON Schema cannot express: graph
 * integrity, materialization budgets, binding scope, Actions and URI safety.
 */
export function analyzeHomerailA2uiSurfaceSemantics(
  surface: HomerailA2uiSurfaceV1,
  options: HomerailA2uiSemanticOptionsV1 = {},
): HomerailA2uiSemanticIssueV1[] {
  const prefix = options.path ?? "";
  const issues: HomerailA2uiSemanticIssueV1[] = [];
  const issueKeys = new Set<string>();
  const issue = (path: string, message: string, keyword: string): void => {
    const key = `${path}\0${message}\0${keyword}`;
    if (issueKeys.has(key)) return;
    issueKeys.add(key);
    issues.push({ path: `${prefix}${path}`, message, keyword });
  };

  if (surface.catalogId !== HOMERAIL_A2UI_CATALOG_ID) {
    issue("/catalogId", `catalogId must be ${HOMERAIL_A2UI_CATALOG_ID}`, "a2uiCatalogId");
  }
  if (surface.components.length > HOMERAIL_A2UI_MAX_COMPONENTS) {
    issue(
      "/components",
      `declared component count exceeds ${HOMERAIL_A2UI_MAX_COMPONENTS}`,
      "maxA2uiDeclaredComponents",
    );
  }
  if (surface.surfaceProperties?.iconUrl && !isSafeGenerativeUiArtifactUri(surface.surfaceProperties.iconUrl)) {
    issue("/surfaceProperties/iconUrl", "must be a passive safe artifact URI", "artifactUri");
  }

  const components = new Map<string, { component: A2uiComponentV1; index: number }>();
  let rootCount = 0;
  surface.components.forEach((component, index) => {
    if (component.id === "root") rootCount += 1;
    if (components.has(component.id)) {
      issue(`/components/${index}/id`, `duplicate component id: ${component.id}`, "uniqueA2uiComponentId");
      return;
    }
    components.set(component.id, { component, index });
  });
  if (rootCount !== 1) {
    issue("/components", "surface must declare exactly one component with id root", "a2uiRoot");
  }

  const adjacency = new Map<string, ComponentEdge[]>();
  const parents = new Map<string, Array<{ component: A2uiComponentV1; edge: ComponentEdge }>>();
  for (const [id, entry] of components) {
    const edges = childEdges(entry.component, entry.index);
    adjacency.set(id, edges);
    const directChildren = edges.filter((edge) => !edge.template).length;
    if (directChildren > HOMERAIL_A2UI_MAX_DIRECT_CHILDREN) {
      issue(
        `/components/${entry.index}`,
        `direct child count exceeds ${HOMERAIL_A2UI_MAX_DIRECT_CHILDREN}`,
        "maxA2uiDirectChildren",
      );
    }
    for (const edge of edges) {
      const existingParents = parents.get(edge.id) ?? [];
      existingParents.push({ component: entry.component, edge });
      parents.set(edge.id, existingParents);
      if (!components.has(edge.id)) {
        issue(edge.path, `component reference does not exist: ${edge.id}`, "a2uiComponentReference");
      }
      if (edge.sourcePath) {
        const dangerous = dangerousPointerSegment(edge.sourcePath);
        if (dangerous) {
          issue(
            edge.path.replace(/componentId$/, "path"),
            `pointer segment is forbidden: ${dangerous}`,
            "a2uiPointerSegment",
          );
        }
      }
    }
  }

  for (const [id, entry] of components) {
    if (!("weight" in entry.component) || entry.component.weight === undefined) continue;
    const componentParents = parents.get(id) ?? [];
    if (componentParents.length === 0 || componentParents.some(({ component, edge }) => (
      edge.template || (component.component !== "Row" && component.component !== "Column")
    ))) {
      issue(
        `/components/${entry.index}/weight`,
        "weight is only valid on a direct child of Row or Column",
        "a2uiWeightParent",
      );
    }
  }

  const colors = new Map<string, 0 | 1 | 2>();
  const detectCycle = (id: string): void => {
    colors.set(id, 1);
    for (const edge of adjacency.get(id) ?? []) {
      if (!components.has(edge.id)) continue;
      const color = colors.get(edge.id) ?? 0;
      if (color === 1) {
        issue(edge.path, `component cycle references ${edge.id}`, "a2uiComponentCycle");
      } else if (color === 0) {
        detectCycle(edge.id);
      }
    }
    colors.set(id, 2);
  };
  for (const id of components.keys()) {
    if ((colors.get(id) ?? 0) === 0) detectCycle(id);
  }

  const reachable = new Set<string>();
  const markReachable = (id: string): void => {
    if (reachable.has(id) || !components.has(id)) return;
    reachable.add(id);
    for (const edge of adjacency.get(id) ?? []) markReachable(edge.id);
  };
  if (components.has("root")) markReachable("root");
  for (const [id, entry] of components) {
    if (!reachable.has(id)) {
      issue(`/components/${entry.index}/id`, `component is unreachable from root: ${id}`, "a2uiUnreachableComponent");
    }
  }

  const greatestDepth = new Map<string, number>();
  const checkDepth = (id: string, depth: number, ancestors: ReadonlySet<string>): void => {
    if (!components.has(id)) return;
    if (depth > HOMERAIL_A2UI_MAX_DEPTH) {
      const index = components.get(id)?.index ?? 0;
      issue(
        `/components/${index}`,
        `component depth exceeds ${HOMERAIL_A2UI_MAX_DEPTH}`,
        "maxA2uiDepth",
      );
      return;
    }
    if ((greatestDepth.get(id) ?? 0) >= depth) return;
    greatestDepth.set(id, depth);
    if (ancestors.has(id)) return;
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(id);
    for (const edge of adjacency.get(id) ?? []) checkDepth(edge.id, depth + 1, nextAncestors);
  };
  if (components.has("root")) checkDepth("root", 1, new Set());

  const validateFormatStringLiteral = (
    template: string,
    path: string,
    scope: EvaluationScope,
  ): void => {
    let cursor = 0;
    while (cursor < template.length) {
      const opening = template.indexOf("${", cursor);
      if (opening < 0) return;
      const closing = template.indexOf("}", opening + 2);
      const expressionSource = closing < 0 ? "" : template.slice(opening + 2, closing);
      if (closing < 0 || !expressionSource || expressionSource.includes("{")) {
        issue(path, "formatString contains a malformed or nested expression", "a2uiFormatStringExpression");
        return;
      }

      if (opening === 0 || template[opening - 1] !== "\\") {
        const expression = expressionSource.trim();
        const absolute = expression.startsWith("/");
        const pointerIsValid = expression !== "@index"
          && !A2UI_UNSUPPORTED_FORMAT_EXPRESSION.test(expression)
          && (absolute
            ? A2UI_ABSOLUTE_POINTER.test(expression)
            : A2UI_RELATIVE_POINTER.test(expression));
        if (!pointerIsValid) {
          issue(
            path,
            "formatString expressions must be JSON Pointers; nested functions and other expressions are not supported",
            "a2uiFormatStringExpression",
          );
        } else {
          if (!absolute && !scope.inTemplate) {
            issue(
              path,
              "relative formatString pointers are only valid inside a template",
              "a2uiFormatStringScope",
            );
          }
          const dangerous = dangerousPointerSegment(expression);
          if (dangerous) {
            issue(path, `pointer segment is forbidden: ${dangerous}`, "a2uiPointerSegment");
          }
        }
      }
      cursor = closing + 1;
    }
  };

  const validateDynamic = (
    value: unknown,
    path: string,
    scope: EvaluationScope,
  ): void => {
    if (isRecord(value) && typeof value.path === "string") {
      if (!isDataBinding(value)) {
        issue(path, "DataBinding must contain only the standard path field", "a2uiDynamicValueShape");
      }
      if (value.path === "@index") {
        issue(path, "@index must use the standard FunctionCall shape", "a2uiBindingProfile");
      }
      const dangerous = dangerousPointerSegment(value.path);
      if (dangerous) {
        issue(`${path}/path`, `pointer segment is forbidden: ${dangerous}`, "a2uiPointerSegment");
      }
      if (!value.path.startsWith("/") && !scope.inTemplate) {
        issue(path, "relative data bindings are only valid inside a template", "a2uiBindingScope");
      }
      return;
    }
    if (isFunctionCall(value)) {
      if (!PURE_FUNCTIONS.has(value.call)) {
        issue(`${path}/call`, `function is not in the pure HomeRail catalog: ${value.call}`, "a2uiPureFunction");
      }
      if (value.call === "@index" && !scope.inTemplate) {
        issue(`${path}/call`, "@index is only valid inside a template", "a2uiTemplateFunctionScope");
      }
      if (value.call === "formatString" && isRecord(value.args) && typeof value.args.value === "string") {
        validateFormatStringLiteral(value.args.value, `${path}/args/value`, scope);
      }
      if (isRecord(value.args)) {
        for (const [name, argument] of Object.entries(value.args)) {
          validateDynamic(argument, `${path}/args/${name}`, scope);
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => validateDynamic(item, `${path}/${index}`, scope));
    }
  };

  const validateChecks = (component: A2uiComponentV1, index: number, scope: EvaluationScope): void => {
    componentChecks(component).forEach((check, checkIndex) => {
      validateDynamic(check.condition, `/components/${index}/checks/${checkIndex}/condition`, scope);
    });
  };

  const validateAction = (action: A2uiActionV1, index: number, scope: EvaluationScope): void => {
    const path = `/components/${index}/action`;
    if ("functionCall" in action) {
      validateDynamic(action.functionCall, `${path}/functionCall`, scope);
      issue(path, "action.functionCall is not allowed; dispatch a host-mediated event", "a2uiActionFunctionCall");
      return;
    }
    if (action.event.wantResponse === true) {
      issue(`${path}/event/wantResponse`, "wantResponse=true is not supported", "a2uiWantResponse");
    }
    if (Object.prototype.hasOwnProperty.call(action.event, "responsePath")) {
      issue(
        `${path}/event/responsePath`,
        "responsePath is not supported by the HomeRail host",
        "a2uiResponsePath",
      );
      const dangerous = dangerousPointerSegment(action.event.responsePath ?? "");
      if (dangerous) {
        issue(
          `${path}/event/responsePath`,
          `pointer segment is forbidden: ${dangerous}`,
          "a2uiPointerSegment",
        );
      }
    }
    if (!options.defer_action_references && !options.action_ids?.has(action.event.name)) {
      issue(
        `${path}/event/name`,
        `event does not map to a node action: ${action.event.name}`,
        "a2uiActionReference",
      );
    }
    if (Object.keys(action.event.context ?? {}).length > 0) {
      issue(
        `${path}/event/context`,
        "non-empty event.context is not supported by the HomeRail host",
        "a2uiActionContext",
      );
    }
    for (const [name, value] of Object.entries(action.event.context ?? {})) {
      validateDynamic(value, `${path}/event/context/${name}`, scope);
    }
  };

  const validateComponentDynamics = (
    component: A2uiComponentV1,
    index: number,
    scope: EvaluationScope,
  ): void => {
    const base = `/components/${index}`;
    validateDynamic(component.accessibility?.label, `${base}/accessibility/label`, scope);
    validateDynamic(component.accessibility?.description, `${base}/accessibility/description`, scope);
    validateChecks(component, index, scope);
    for (const [name, value] of Object.entries(component)) {
      if (/^item[A-Z].*Path$/.test(name) && typeof value === "string") {
        const dangerous = dangerousPointerSegment(value);
        if (dangerous) {
          issue(`${base}/${name}`, `pointer segment is forbidden: ${dangerous}`, "a2uiPointerSegment");
        }
      }
    }
    if (component.component === "HrTable") {
      component.columns.forEach((column, columnIndex) => {
        const dangerous = dangerousPointerSegment(column.path);
        if (dangerous) {
          issue(
            `${base}/columns/${columnIndex}/path`,
            `pointer segment is forbidden: ${dangerous}`,
            "a2uiPointerSegment",
          );
        }
      });
    }
    switch (component.component) {
      case "Text": validateDynamic(component.text, `${base}/text`, scope); break;
      case "Image":
        validateDynamic(component.url, `${base}/url`, scope);
        validateDynamic(component.description, `${base}/description`, scope);
        break;
      case "Icon": validateDynamic(component.name, `${base}/name`, scope); break;
      case "Video":
        validateDynamic(component.url, `${base}/url`, scope);
        validateDynamic(component.posterUrl, `${base}/posterUrl`, scope);
        break;
      case "AudioPlayer":
        validateDynamic(component.url, `${base}/url`, scope);
        validateDynamic(component.description, `${base}/description`, scope);
        break;
      case "Tabs":
        component.tabs.forEach((tab, tabIndex) => validateDynamic(tab.title, `${base}/tabs/${tabIndex}/title`, scope));
        break;
      case "Button": validateAction(component.action, index, scope); break;
      case "TextField":
        validateDynamic(component.label, `${base}/label`, scope);
        validateDynamic(component.value, `${base}/value`, scope);
        validateDynamic(component.placeholder, `${base}/placeholder`, scope);
        break;
      case "CheckBox":
        validateDynamic(component.label, `${base}/label`, scope);
        validateDynamic(component.value, `${base}/value`, scope);
        break;
      case "ChoicePicker":
        validateDynamic(component.label, `${base}/label`, scope);
        validateDynamic(component.value, `${base}/value`, scope);
        component.options.forEach((option, optionIndex) => {
          validateDynamic(option.label, `${base}/options/${optionIndex}/label`, scope);
        });
        break;
      case "Slider":
        validateDynamic(component.label, `${base}/label`, scope);
        validateDynamic(component.value, `${base}/value`, scope);
        break;
      case "DateTimeInput":
        validateDynamic(component.value, `${base}/value`, scope);
        validateDynamic(component.min, `${base}/min`, scope);
        validateDynamic(component.max, `${base}/max`, scope);
        validateDynamic(component.label, `${base}/label`, scope);
        break;
      case "HrSection":
        validateDynamic(component.title, `${base}/title`, scope);
        validateDynamic(component.tone, `${base}/tone`, scope);
        break;
      case "HrMetric":
        validateDynamic(component.label, `${base}/label`, scope);
        validateDynamic(component.value, `${base}/value`, scope);
        validateDynamic(component.unit, `${base}/unit`, scope);
        validateDynamic(component.tone, `${base}/tone`, scope);
        break;
      case "HrStatusBadge":
        validateDynamic(component.text, `${base}/text`, scope);
        validateDynamic(component.tone, `${base}/tone`, scope);
        break;
      case "HrProgress":
        validateDynamic(component.label, `${base}/label`, scope);
        validateDynamic(component.value, `${base}/value`, scope);
        validateDynamic(component.tone, `${base}/tone`, scope);
        break;
      case "HrStep":
        validateDynamic(component.index, `${base}/index`, scope);
        validateDynamic(component.label, `${base}/label`, scope);
        validateDynamic(component.detail, `${base}/detail`, scope);
        validateDynamic(component.tone, `${base}/tone`, scope);
        break;
      case "HrList":
      case "HrTable":
      case "HrTimeline":
      case "HrBarChart":
      case "HrDag":
        validateDynamic(component.source, `${base}/source`, scope);
        break;
      case "HrDisclosure":
        validateDynamic(component.title, `${base}/title`, scope);
        validateDynamic(component.open, `${base}/open`, scope);
        break;
      case "HrLink":
        validateDynamic(component.label, `${base}/label`, scope);
        validateDynamic(component.url, `${base}/url`, scope);
        validateDynamic(component.description, `${base}/description`, scope);
        break;
      case "HrArtifact":
        validateDynamic(component.uri, `${base}/uri`, scope);
        validateDynamic(component.title, `${base}/title`, scope);
        validateDynamic(component.description, `${base}/description`, scope);
        validateDynamic(component.alt, `${base}/alt`, scope);
        break;
      case "HrIf": validateDynamic(component.condition, `${base}/condition`, scope); break;
      default: break;
    }
  };

  const dynamicStates = new Set<string>();
  const checkDynamicGraph = (id: string, scope: EvaluationScope): void => {
    const entry = components.get(id);
    if (!entry) return;
    const state = `${id}\0${scope.inTemplate ? "template" : "root"}`;
    if (dynamicStates.has(state)) return;
    dynamicStates.add(state);
    validateComponentDynamics(entry.component, entry.index, scope);
    for (const edge of adjacency.get(id) ?? []) {
      checkDynamicGraph(edge.id, { inTemplate: scope.inTemplate || edge.template });
    }
  };
  if (components.has("root")) checkDynamicGraph("root", { inTemplate: false });

  const hasStructuralGraphError = issues.some((entry) => [
    "a2uiComponentReference",
    "a2uiComponentCycle",
    "a2uiRoot",
  ].includes(entry.keyword));
  if (!hasStructuralGraphError && components.has("root")) {
    let materialized = 0;
    let materializedExceeded = false;
    const count = (amount: number, path: string): boolean => {
      materialized += amount;
      if (materialized <= HOMERAIL_A2UI_MAX_COMPONENTS) return true;
      if (!materializedExceeded) {
        materializedExceeded = true;
        issue(
          path,
          `materialized component count exceeds ${HOMERAIL_A2UI_MAX_COMPONENTS}`,
          "maxA2uiMaterializedComponents",
        );
      }
      return false;
    };
    const sourceItems = (sourcePath: string, path: string, scope: EvaluationScope): unknown[] | undefined => {
      if (!options.data_model) return undefined;
      if (!sourcePath.startsWith("/") && !scope.inTemplate) {
        issue(path, "relative source paths are only valid inside a template", "a2uiBindingScope");
        return [];
      }
      const source = resolvePath(options.data_model, sourcePath, scope);
      // A2UI bindings may be populated by a later data-model update. A missing
      // value materializes as an empty collection; an explicit non-array is a
      // contract error.
      if (source === undefined) return [];
      if (!Array.isArray(source)) {
        issue(path, "source path must resolve to an array", "a2uiSourceType");
        return [];
      }
      if (source.length > HOMERAIL_A2UI_MAX_SOURCE_ITEMS) {
        issue(
          path,
          `source exceeds ${HOMERAIL_A2UI_MAX_SOURCE_ITEMS} items`,
          "maxA2uiSourceItems",
        );
      }
      return source.slice(0, HOMERAIL_A2UI_MAX_SOURCE_ITEMS);
    };
    const validateArtifact = (
      value: A2uiDynamicStringV1 | undefined,
      path: string,
      scope: EvaluationScope,
    ): void => {
      if (value === undefined) return;
      if (typeof value === "string") {
        if (!isSafeGenerativeUiArtifactUri(value)) {
          issue(path, "must resolve to a passive safe artifact URI", "artifactUri");
        }
        return;
      }
      if (isFunctionCall(value)) {
        issue(path, "function-computed artifact URIs are not allowed", "artifactUri");
        return;
      }
      if (!options.data_model) return;
      const resolved = resolvePath(options.data_model, value.path, scope);
      if (isFunctionCall(resolved) || !isSafeGenerativeUiArtifactUri(resolved)) {
        issue(path, "must resolve to a passive safe artifact URI", "artifactUri");
      }
    };
    const validateExternalLink = (
      value: A2uiDynamicStringV1,
      path: string,
      scope: EvaluationScope,
    ): void => {
      if (typeof value === "string") {
        if (!isSafeGenerativeUiExternalUri(value)) {
          issue(path, "must resolve to a safe HTTP(S) URL", "externalUri");
        }
        return;
      }
      if (isFunctionCall(value)) {
        issue(path, "function-computed external URLs are not allowed", "externalUri");
        return;
      }
      if (!options.data_model) return;
      const resolved = resolvePath(options.data_model, value.path, scope);
      if (isFunctionCall(resolved) || !isSafeGenerativeUiExternalUri(resolved)) {
        issue(path, "must resolve to a safe HTTP(S) URL", "externalUri");
      }
    };
    const materialize = (id: string, scope: EvaluationScope): void => {
      const entry = components.get(id);
      if (!entry || !count(1, `/components/${entry?.index ?? 0}`)) return;
      const component = entry.component;
      const base = `/components/${entry.index}`;
      if (component.component === "Image") validateArtifact(component.url, `${base}/url`, scope);
      if (component.component === "Video") {
        validateArtifact(component.url, `${base}/url`, scope);
        validateArtifact(component.posterUrl, `${base}/posterUrl`, scope);
      }
      if (component.component === "AudioPlayer") validateArtifact(component.url, `${base}/url`, scope);
      if (component.component === "HrLink") validateExternalLink(component.url, `${base}/url`, scope);
      if (component.component === "HrArtifact") validateArtifact(component.uri, `${base}/uri`, scope);

      if (SOURCE_COMPONENTS.has(component.component) && "source" in component) {
        const items = sourceItems(component.source.path, `${base}/source/path`, scope);
        if (items) count(Math.min(items.length, component.maxItems ?? HOMERAIL_A2UI_MAX_SOURCE_ITEMS), base);
      }
      for (const edge of adjacency.get(id) ?? []) {
        if (materializedExceeded) return;
        if (edge.template) {
          const items = sourceItems(edge.sourcePath ?? "", edge.path.replace(/componentId$/, "path"), scope);
          if (items === undefined) {
            materialize(edge.id, { inTemplate: true });
          } else {
            if (items.length > HOMERAIL_A2UI_MAX_DIRECT_CHILDREN) {
              issue(
                base,
                `materialized direct child count exceeds ${HOMERAIL_A2UI_MAX_DIRECT_CHILDREN}`,
                "maxA2uiDirectChildren",
              );
            }
            for (const item of items) {
              materialize(edge.id, { inTemplate: true, value: item });
              if (materializedExceeded) return;
            }
          }
        } else {
          materialize(edge.id, scope);
        }
      }
    };
    materialize("root", { inTemplate: false });
  }

  return issues;
}

/**
 * Wraps a validated node presentation and semantic content in the exact A2UI
 * v1.0 createSurface envelope. The host, never the agent, supplies surfaceId.
 */
export function createHomerailA2uiCreateSurfaceMessage(input: {
  id: string;
  content: Record<string, unknown>;
  a2ui: HomerailA2uiSurfaceV1;
}): HomerailA2uiCreateSurfaceMessageV1 {
  return {
    version: HOMERAIL_A2UI_VERSION,
    createSurface: {
      surfaceId: input.id,
      catalogId: HOMERAIL_A2UI_CATALOG_ID,
      ...(input.a2ui.surfaceProperties
        ? { surfaceProperties: structuredClone(input.a2ui.surfaceProperties) }
        : {}),
      components: structuredClone(input.a2ui.components),
      dataModel: structuredClone(input.content),
    },
  };
}
