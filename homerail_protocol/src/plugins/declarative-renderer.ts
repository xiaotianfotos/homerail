import { isSafeGenerativeUiArtifactUri } from "../generative-ui/artifact-uri.js";
import type { HomerailDeclarativeRendererV1 } from "./types.js";
import { validateHomerailDeclarativeRenderer } from "./validation.js";

export type HomerailDeclarativeSectionModel =
  | { id: string; type: "text"; label?: string; text: string; max_lines: number }
  | { id: string; type: "list"; label?: string; items: Array<{ title: string; detail?: string; badge?: string }> }
  | { id: string; type: "metrics"; label?: string; items: Array<{ label: string; value: string }> }
  | { id: string; type: "links"; label?: string; items: Array<{ label: string; uri: string }> };

export interface HomerailDeclarativeRendererModelV1 {
  title: string;
  subtitle?: string;
  empty_message: string;
  sections: HomerailDeclarativeSectionModel[];
}

function pointer(root: unknown, value: string): unknown {
  if (value === "") return root;
  let current = root;
  for (const token of value.slice(1).split("/").map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))) {
    if (!current || typeof current !== "object") return undefined;
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/.test(token)) return undefined;
      current = current[Number(token)];
    } else {
      current = (current as Record<string, unknown>)[token];
    }
  }
  return current;
}

function boundedText(value: unknown, max = 2000): string {
  if (typeof value === "string") return value.trim().slice(0, max);
  if (typeof value === "number" || typeof value === "boolean") return String(value).slice(0, max);
  return "";
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function metric(value: unknown, format: "text" | "number" | "percent", locale?: string): string {
  if (format === "number") return typeof value === "number" && Number.isFinite(value)
    ? new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value)
    : "";
  if (format === "percent") return typeof value === "number" && Number.isFinite(value)
    ? `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value)}%`
    : "";
  return boundedText(value, 200);
}

function safeLink(value: unknown): string {
  const uri = boundedText(value, 2048);
  return uri && isSafeGenerativeUiArtifactUri(uri) ? uri : "";
}

/**
 * Materialize the expression-free Renderer DSL into a bounded view model.
 * This function is the shared implementation used by production surfaces and
 * the PDK preview so their pointer, formatting, and URI behavior cannot drift.
 */
export function buildHomerailDeclarativeRendererModel(
  documentValue: HomerailDeclarativeRendererV1,
  content: Record<string, unknown>,
  options: { locale?: string } = {},
): HomerailDeclarativeRendererModelV1 {
  const validation = validateHomerailDeclarativeRenderer(documentValue);
  if (!validation.valid || !validation.value) {
    throw new Error(`Invalid declarative Renderer: ${JSON.stringify(validation.errors)}`);
  }
  const document = validation.value;
  const title = boundedText(pointer(content, document.title_pointer), 200);
  if (!title) throw new Error("Declarative Renderer title pointer did not resolve to readable text");
  const subtitle = document.subtitle_pointer ? boundedText(pointer(content, document.subtitle_pointer), 2000) : "";
  const sections: HomerailDeclarativeSectionModel[] = [];
  for (const section of document.sections) {
    if (section.type === "text") {
      const text = boundedText(pointer(content, section.pointer), 4000);
      if (text) sections.push({ id: section.id, type: "text", ...(section.label ? { label: section.label } : {}), text, max_lines: section.max_lines ?? 6 });
      continue;
    }
    if (section.type === "list") {
      const source = pointer(content, section.pointer);
      const items = (Array.isArray(source) ? source : []).slice(0, section.max_items ?? 16).flatMap((item) => {
        const itemRoot = record(item) ?? item;
        const itemTitle = boundedText(pointer(itemRoot, section.item_title_pointer), 240);
        if (!itemTitle) return [];
        const detail = section.item_detail_pointer ? boundedText(pointer(itemRoot, section.item_detail_pointer), 500) : "";
        const badge = section.item_badge_pointer ? boundedText(pointer(itemRoot, section.item_badge_pointer), 80) : "";
        return [{ title: itemTitle, ...(detail ? { detail } : {}), ...(badge ? { badge } : {}) }];
      });
      if (items.length) sections.push({ id: section.id, type: "list", ...(section.label ? { label: section.label } : {}), items });
      continue;
    }
    if (section.type === "metrics") {
      const items = section.items.flatMap((item) => {
        const value = metric(pointer(content, item.pointer), item.format, options.locale);
        return value ? [{ label: item.label, value }] : [];
      });
      if (items.length) sections.push({ id: section.id, type: "metrics", ...(section.label ? { label: section.label } : {}), items });
      continue;
    }
    const source = pointer(content, section.pointer);
    const items = (Array.isArray(source) ? source : []).slice(0, section.max_items ?? 8).flatMap((item) => {
      const itemRoot = record(item);
      if (!itemRoot) return [];
      const label = boundedText(pointer(itemRoot, section.item_label_pointer), 200);
      const uri = safeLink(pointer(itemRoot, section.item_uri_pointer));
      return label && uri ? [{ label, uri }] : [];
    });
    if (items.length) sections.push({ id: section.id, type: "links", ...(section.label ? { label: section.label } : {}), items });
  }
  return {
    title,
    ...(subtitle ? { subtitle } : {}),
    empty_message: document.empty_message ?? "No details available.",
    sections,
  };
}
