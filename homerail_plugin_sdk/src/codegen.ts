import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import type { PluginSourceSnapshot } from "./project.js";
import { scanPluginSource } from "./project.js";

function isMissing(cause: unknown): boolean {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}

function assertRealDirectory(directory: string, label: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(directory);
  } catch (cause) {
    if (isMissing(cause)) throw new Error(`Codegen output ${label} does not exist: ${directory}`);
    throw cause;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`Codegen output ${label} must not be a symbolic link: ${directory}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Codegen output ${label} must be a directory: ${directory}`);
  }
}

/**
 * Validate every component below the already validated plugin root. Missing
 * components are created one at a time only in write mode so recursive mkdir
 * can never silently traverse an output-side symlink.
 */
function prepareOutputDirectory(root: string, create: boolean): boolean {
  assertRealDirectory(root, "root");
  let cursor = root;
  for (const component of [".homerail", "generated"]) {
    cursor = path.join(cursor, component);
    try {
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink()) {
        throw new Error(`Codegen output parent must not be a symbolic link: ${cursor}`);
      }
      if (!stat.isDirectory()) {
        throw new Error(`Codegen output parent must be a directory: ${cursor}`);
      }
    } catch (cause) {
      if (!isMissing(cause)) throw cause;
      if (!create) return false;
      try {
        fs.mkdirSync(cursor);
      } catch (mkdirCause) {
        // If another writer won the mkdir race, validate what it created. All
        // other failures retain their original diagnostics.
        if (!(mkdirCause instanceof Error && "code" in mkdirCause && mkdirCause.code === "EEXIST")) {
          throw mkdirCause;
        }
      }
      const created = fs.lstatSync(cursor);
      if (created.isSymbolicLink()) {
        throw new Error(`Codegen output parent must not be a symbolic link: ${cursor}`);
      }
      if (!created.isDirectory()) {
        throw new Error(`Codegen output parent must be a directory: ${cursor}`);
      }
    }
  }
  return true;
}

function assertSafeOutputTarget(output: string): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(output);
  } catch (cause) {
    if (isMissing(cause)) return false;
    throw cause;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`Codegen output file must not be a symbolic link: ${output}`);
  }
  if (!stat.isFile()) {
    throw new Error(`Codegen output file must be a regular file: ${output}`);
  }
  return true;
}

function readExistingOutput(output: string, parentsExist: boolean): string | undefined {
  if (!parentsExist || !assertSafeOutputTarget(output)) return undefined;
  let descriptor: number | undefined;
  try {
    // lstat above gives a clear error for an existing symlink; O_NOFOLLOW also
    // closes the replacement race before the read itself.
    descriptor = fs.openSync(output, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile()) {
      throw new Error(`Codegen output file must be a regular file: ${output}`);
    }
    return fs.readFileSync(descriptor, "utf8");
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ELOOP") {
      throw new Error(`Codegen output file must not be a symbolic link: ${output}`);
    }
    throw cause;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function atomicWriteOutput(output: string, content: string): void {
  const directory = path.dirname(output);
  let temporary = "";
  let descriptor: number | undefined;
  let renamed = false;
  try {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      temporary = path.join(
        directory,
        `.${path.basename(output)}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`,
      );
      try {
        descriptor = fs.openSync(temporary, "wx", 0o600);
        break;
      } catch (cause) {
        if (!(cause instanceof Error && "code" in cause && cause.code === "EEXIST")) throw cause;
      }
    }
    if (descriptor === undefined) throw new Error(`Unable to allocate a codegen temporary file in ${directory}`);

    fs.writeFileSync(descriptor, content, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;

    // Re-check immediately before replacement. rename replaces a raced
    // symlink entry rather than following it, so it cannot overwrite its
    // referent; this check still rejects symlinks that are observable here.
    assertSafeOutputTarget(output);
    fs.renameSync(temporary, output);
    renamed = true;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (!renamed && temporary) fs.rmSync(temporary, { force: true });
  }
}

function typeName(value: string): string {
  const result = value.split(/[^A-Za-z0-9]+/).filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`).join("");
  return /^[A-Za-z]/.test(result) ? result : `Schema${result}`;
}

function schemaType(schema: unknown, indent = ""): string {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return "unknown";
  const value = schema as Record<string, unknown>;
  if (Array.isArray(value.enum)) return value.enum.map((item) => JSON.stringify(item)).join(" | ") || "never";
  if (Array.isArray(value.oneOf)) return value.oneOf.map((item) => schemaType(item, indent)).join(" | ");
  if (value.type === "string") return "string";
  if (value.type === "number" || value.type === "integer") return "number";
  if (value.type === "boolean") return "boolean";
  if (value.type === "array") return `Array<${schemaType(value.items, indent)}>`;
  if (value.type === "object") {
    const properties = value.properties && typeof value.properties === "object" && !Array.isArray(value.properties)
      ? value.properties as Record<string, unknown>
      : {};
    const required = new Set(Array.isArray(value.required) ? value.required.filter((item): item is string => typeof item === "string") : []);
    const lines = Object.entries(properties).map(([key, child]) => (
      `${indent}  ${JSON.stringify(key)}${required.has(key) ? "" : "?"}: ${schemaType(child, `${indent}  `)};`
    ));
    return lines.length ? `{\n${lines.join("\n")}\n${indent}}` : "Record<string, never>";
  }
  return "unknown";
}

export function generatedPluginTypes(snapshot: PluginSourceSnapshot): string {
  if (!snapshot.valid) throw new Error("Cannot generate types for an invalid plugin project");
  const schemas = snapshot.manifest.schemas.map((declaration) => {
    const content = snapshot.files.get(declaration.file);
    const schema = content ? JSON.parse(content.toString("utf8")) as unknown : {};
    return `export type ${typeName(declaration.id)} = ${schemaType(schema)};`;
  });
  return [
    "// Generated by `hr plugin codegen`. Do not edit.",
    `export const pluginId = ${JSON.stringify(snapshot.manifest.id)} as const;`,
    `export const pluginVersion = ${JSON.stringify(snapshot.manifest.version)} as const;`,
    `export type PluginKind = ${snapshot.manifest.kinds.map((kind) => JSON.stringify(kind.kind)).join(" | ") || "never"};`,
    `export type PluginTool = ${snapshot.manifest.tools.map((tool) => JSON.stringify(tool.id)).join(" | ") || "never"};`,
    ...schemas,
    "",
  ].join("\n");
}

export function generatePluginTypes(root: string, options: { check?: boolean } = {}): {
  output: string;
  changed: boolean;
} {
  const snapshot = scanPluginSource(root);
  if (!snapshot.valid) throw new Error(`Plugin validation failed: ${JSON.stringify(snapshot.issues)}`);
  const sourceRoot = snapshot.root ?? path.resolve(root);
  const output = path.join(sourceRoot, ".homerail", "generated", "plugin-types.d.ts");
  const content = generatedPluginTypes(snapshot);
  const parentsExist = prepareOutputDirectory(sourceRoot, !options.check);
  const previous = readExistingOutput(output, parentsExist);
  const changed = previous !== content;
  if (options.check) {
    if (changed) throw new Error("Generated plugin types are stale; run `hr plugin codegen`");
  } else if (changed) {
    atomicWriteOutput(output, content);
  }
  return { output, changed };
}
