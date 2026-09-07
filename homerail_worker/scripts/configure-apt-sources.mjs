/**
 * HomeRail Worker image build helper.
 *
 * Rewrites the deb822 sources file used by the Worker image (the Debian
 * bookworm layout ships /etc/apt/sources.list.d/debian.sources) stanza by
 * stanza so image builds can opt into public Debian mirrors:
 *
 *   HOMERAIL_WORKER_BUILD_APT_MIRROR          -> stanzas with non-security suites
 *   HOMERAIL_WORKER_BUILD_APT_SECURITY_MIRROR -> stanzas with security suites
 *
 * The two overrides are independent: configuring one never touches the other
 * stanza. Unset or whitespace-only values leave the file completely
 * untouched, preserving the base image's current Debian defaults. When an
 * override is requested, missing or malformed deb822 input fails the build
 * instead of silently keeping another source.
 *
 * The script is image-owned build tooling. It is part of the Worker source
 * fingerprint and runs before `apt-get update` in every Dockerfile stage.
 *
 * The helper also exposes an environment-name-only CLI mode used by
 * scripts/lib/worker-build-network.sh:
 *
 *   configure-apt-sources.mjs --print-env NAME
 *
 * It reads only the environment variable NAME, reuses the WHATWG URL
 * validation above, and prints the normalized public URL. The URL value
 * itself never appears in argv.
 */

import * as fs from "node:fs";
import { pathToFileURL } from "node:url";

export const DEFAULT_DEB822_SOURCES_PATH = "/etc/apt/sources.list.d/debian.sources";
export const APT_MAIN_MIRROR_ENV = "HOMERAIL_WORKER_BUILD_APT_MIRROR";
export const APT_SECURITY_MIRROR_ENV = "HOMERAIL_WORKER_BUILD_APT_SECURITY_MIRROR";

const FIELD_LINE_PATTERN = /^([A-Za-z0-9][A-Za-z0-9_-]*):(?:[ \t]+(.*))?$/;
const SECURITY_SUITE_PATTERN = /-security$/;

export function normalizeMirrorValue(rawValue) {
  if (typeof rawValue !== "string") return undefined;
  const trimmed = rawValue.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function validateMirrorUrl(rawValue, key) {
  // Public source URLs are plain ASCII. Reject control characters, raw
  // whitespace, and non-ASCII input up front because URL parsing silently
  // strips or rewrites some of it.
  // eslint-disable-next-line no-control-regex
  if (/[^\u0021-\u007e]/.test(rawValue)) {
    throw new Error(`${key} must not contain control characters, whitespace, or non-ASCII characters.`);
  }
  // Fail closed on characters the WHATWG URL parser would percent-encode or
  // rewrite (a backslash becomes a path separator in special schemes), so the
  // normalized output never silently differs from the operator's input.
  if (/["$()%<>`^{}|\\]/.test(rawValue)) {
    throw new Error(`${key} must not contain unsupported URL characters.`);
  }
  // WHATWG parsing silently drops an empty userinfo marker, so inspect the
  // raw authority before parsing while still allowing `@` in the URL path.
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(rawValue)) {
    throw new Error(`${key} must not embed credentials.`);
  }
  let parsed;
  try {
    parsed = new URL(rawValue);
  } catch {
    throw new Error(`${key} must be a valid http: or https: URL.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${key} must use http: or https:.`);
  }
  if (!parsed.hostname) {
    throw new Error(`${key} must include a hostname.`);
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error(`${key} must not embed credentials.`);
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new Error(`${key} must not include a query or fragment.`);
  }
  // Preserve bracketed IPv6 hosts while rejecting brackets in mirror paths,
  // whose normalization behavior can vary between Node releases.
  if (/[\[\]]/.test(parsed.pathname)) {
    throw new Error(`${key} must not contain path characters that require URL encoding.`);
  }
  return parsed.toString().replace(/\/+$/, "");
}

export const PRINT_ENV_FLAG = "--print-env";
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function normalizedEnvSource(name, env) {
  if (typeof name !== "string" || !ENV_NAME_PATTERN.test(name)) {
    throw new Error("environment variable name must match [A-Za-z_][A-Za-z0-9_]*.");
  }
  const value = normalizeMirrorValue(env[name]);
  if (value === undefined) return undefined;
  return validateMirrorUrl(value, name);
}

export function parseDeb822Sources(content) {
  const text = String(content).replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const blocks = [];
  let stanza = null;
  let lastField = null;

  const closeStanza = () => {
    stanza = null;
    lastField = null;
  };

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === "") {
      closeStanza();
      blocks.push({ kind: "prose", lines: [line] });
      return;
    }
    if (trimmed.startsWith("#")) {
      if (stanza) {
        // Only a blank line delimits active deb822 stanzas. Comments inside
        // an active stanza are preserved exactly; they clear the
        // continuation-field context so ambiguous continuation lines fail
        // closed instead of attaching to the wrong field.
        stanza.lines.push(line);
        lastField = null;
      } else {
        // Comments before any stanza stay prose.
        blocks.push({ kind: "prose", lines: [line] });
      }
      return;
    }
    if (line.startsWith(" ") || line.startsWith("\t")) {
      if (!stanza || !lastField) {
        throw new Error(
          `Malformed deb822 sources: line ${index + 1} is a continuation line without a field.`,
        );
      }
      stanza.lines.push(line);
      lastField.continuationIndexes.push(stanza.lines.length - 1);
      lastField.valueParts.push(trimmed);
      return;
    }
    const match = FIELD_LINE_PATTERN.exec(line);
    if (!match) {
      throw new Error(`Malformed deb822 sources: line ${index + 1} is not a valid deb822 field.`);
    }
    if (!stanza) {
      stanza = { kind: "stanza", lines: [], fields: new Map() };
      blocks.push(stanza);
    }
    const name = match[1];
    if (stanza.fields.has(name)) {
      throw new Error(`Malformed deb822 sources: line ${index + 1} duplicates field "${name}".`);
    }
    stanza.lines.push(line);
    lastField = {
      name,
      lineIndex: stanza.lines.length - 1,
      valueParts: [(match[2] ?? "").trimEnd()],
      continuationIndexes: [],
    };
    stanza.fields.set(name, lastField);
  });
  closeStanza();

  const stanzas = blocks.filter((block) => block.kind === "stanza");
  if (stanzas.length === 0) {
    throw new Error("Malformed deb822 sources: no deb822 stanzas found.");
  }
  for (const candidate of stanzas) {
    for (const required of ["Types", "URIs", "Suites"]) {
      const field = candidate.fields.get(required);
      const value = field ? field.valueParts.join(" ").trim() : "";
      if (value === "") {
        throw new Error(`Malformed deb822 sources: stanza is missing a usable ${required} field.`);
      }
    }
  }
  return { blocks, stanzas, endsWithNewline: text.endsWith("\n") };
}

export function isSecurityStanza(stanza) {
  const suites = stanza.fields.get("Suites");
  return suites.valueParts
    .join(" ")
    .split(/\s+/)
    .filter(Boolean)
    .some((suite) => SECURITY_SUITE_PATTERN.test(suite));
}

export function applyDeb822SourceOverrides(content, overrides = {}) {
  const mainMirror = normalizeMirrorValue(overrides.mainMirror);
  const securityMirror = normalizeMirrorValue(overrides.securityMirror);
  if (mainMirror === undefined && securityMirror === undefined) {
    return { output: String(content), changed: false };
  }
  const validatedMain = mainMirror === undefined
    ? undefined
    : validateMirrorUrl(mainMirror, APT_MAIN_MIRROR_ENV);
  const validatedSecurity = securityMirror === undefined
    ? undefined
    : validateMirrorUrl(securityMirror, APT_SECURITY_MIRROR_ENV);

  const { blocks, endsWithNewline } = parseDeb822Sources(content);
  let changed = false;
  let matchedMain = false;
  let matchedSecurity = false;
  for (const block of blocks) {
    if (block.kind !== "stanza") continue;
    const security = isSecurityStanza(block);
    const target = security ? validatedSecurity : validatedMain;
    if (target === undefined) continue;
    if (security) {
      matchedSecurity = true;
    } else {
      matchedMain = true;
    }
    const uris = block.fields.get("URIs");
    const replacement = `URIs: ${target}`;
    if (block.lines[uris.lineIndex] === replacement && uris.continuationIndexes.length === 0) {
      continue;
    }
    block.lines[uris.lineIndex] = replacement;
    for (const continuationIndex of [...uris.continuationIndexes].sort((left, right) => right - left)) {
      block.lines.splice(continuationIndex, 1);
    }
    changed = true;
  }
  if (validatedMain !== undefined && !matchedMain) {
    throw new Error(
      `Malformed deb822 sources: no non-security stanza is available for ${APT_MAIN_MIRROR_ENV}.`,
    );
  }
  if (validatedSecurity !== undefined && !matchedSecurity) {
    throw new Error(
      `Malformed deb822 sources: no security stanza is available for ${APT_SECURITY_MIRROR_ENV}.`,
    );
  }
  const output = blocks.map((block) => block.lines.join("\n")).join("\n") + (endsWithNewline ? "\n" : "");
  return { output, changed };
}

export function runCli(options = {}) {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const readFile = options.readFile ?? ((sourcesPath) => fs.readFileSync(sourcesPath, "utf8"));
  const writeFile = options.writeFile ?? ((sourcesPath, output) => {
    fs.writeFileSync(sourcesPath, output, "utf8");
  });
  const fail = options.fail ?? ((message) => process.stderr.write(`${message}\n`));
  const print = options.print ?? ((line) => process.stdout.write(`${line}\n`));

  if (argv[0] === PRINT_ENV_FLAG) {
    if (argv.length !== 2) {
      fail(`usage: configure-apt-sources.mjs ${PRINT_ENV_FLAG} ENVIRONMENT_VARIABLE_NAME`);
      return 1;
    }
    let normalized;
    try {
      normalized = normalizedEnvSource(argv[1], env);
    } catch (error) {
      fail(`HomeRail Worker build source override failed: ${error.message}`);
      return 1;
    }
    if (normalized !== undefined) {
      print(normalized);
    }
    return 0;
  }

  const sourcesPath = argv[0] || DEFAULT_DEB822_SOURCES_PATH;
  const mainMirror = normalizeMirrorValue(env[APT_MAIN_MIRROR_ENV]);
  const securityMirror = normalizeMirrorValue(env[APT_SECURITY_MIRROR_ENV]);
  if (mainMirror === undefined && securityMirror === undefined) {
    return 0;
  }

  let content;
  try {
    content = readFile(sourcesPath);
  } catch (error) {
    fail(
      `HomeRail Worker APT source override failed: unable to read deb822 sources at ${sourcesPath}. `
      + "Refusing to build against unknown Debian sources when an override is requested.",
    );
    return 1;
  }

  let result;
  try {
    result = applyDeb822SourceOverrides(content, { mainMirror, securityMirror });
  } catch (error) {
    fail(`HomeRail Worker APT source override failed: ${error.message}`);
    return 1;
  }

  if (result.changed) {
    writeFile(sourcesPath, result.output);
  }
  return 0;
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  process.exit(runCli());
}
