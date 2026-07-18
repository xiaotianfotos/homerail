import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { DagCredentialProjection } from "homerail-protocol";

export interface MaterializedCredentialProjection {
  env: Record<string, string>;
  broker_refs: Array<Extract<DagCredentialProjection, { mode: "manager_broker" }>>;
  redaction_values: string[];
  cleanup: () => void;
}

export function containsCredentialValue(value: unknown, secrets: readonly string[]): boolean {
  const candidates = secrets.filter(Boolean);
  const seen = new WeakSet<object>();
  const visit = (entry: unknown): boolean => {
    if (typeof entry === "string") return candidates.some((secret) => entry.includes(secret));
    if (typeof entry === "number" || typeof entry === "boolean") return candidates.includes(String(entry));
    if (!entry || typeof entry !== "object") return false;
    if (seen.has(entry)) return false;
    seen.add(entry);
    if (Array.isArray(entry)) return entry.some(visit);
    return Object.entries(entry).some(([key, child]) => visit(key) || visit(child));
  };
  return visit(value);
}

export function redactCredentialValues(value: unknown, secrets: readonly string[]): unknown {
  const candidates = [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length);
  const redactText = (text: string): string => {
    let redacted = text;
    for (const secret of candidates) redacted = redacted.split(secret).join("***");
    return redacted;
  };
  const seen = new WeakMap<object, unknown>();
  const visit = (entry: unknown): unknown => {
    if (typeof entry === "string") return redactText(entry);
    if (!entry || typeof entry !== "object") return entry;
    const cached = seen.get(entry);
    if (cached !== undefined) return cached;
    if (Array.isArray(entry)) {
      const output: unknown[] = [];
      seen.set(entry, output);
      for (const child of entry) output.push(visit(child));
      return output;
    }
    const output: Record<string, unknown> = {};
    seen.set(entry, output);
    for (const [key, child] of Object.entries(entry)) output[redactText(key)] = visit(child);
    return output;
  };
  return visit(value);
}

function credentialTempRoot(): string {
  const sharedMemory = "/dev/shm";
  return process.platform !== "win32" && fs.existsSync(sharedMemory)
    ? sharedMemory
    : os.tmpdir();
}

export function materializeCredentialProjections(
  projections: readonly DagCredentialProjection[],
): MaterializedCredentialProjection {
  const env: Record<string, string> = {};
  const brokerRefs: Array<Extract<DagCredentialProjection, { mode: "manager_broker" }>> = [];
  const redactionValues: string[] = [];
  let directory: string | undefined;
  const ensureDirectory = (): string => {
    if (directory) return directory;
    const parent = path.join(credentialTempRoot(), "homerail-credentials");
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    directory = path.join(parent, randomUUID());
    fs.mkdirSync(directory, { mode: 0o700 });
    return directory;
  };

  try {
    for (const projection of projections) {
      if (projection.mode === "manager_broker") {
        brokerRefs.push(structuredClone(projection));
        continue;
      }
      if (projection.mode === "env") {
        for (const [name, value] of Object.entries(projection.values)) {
          if (Object.prototype.hasOwnProperty.call(env, name)) {
            throw new Error(`Credential env '${name}' is projected more than once`);
          }
          env[name] = value;
          redactionValues.push(value);
        }
        continue;
      }
      const filePath = path.join(ensureDirectory(), projection.filename);
      if (path.dirname(filePath) !== directory || fs.existsSync(filePath)) {
        throw new Error(`Credential file '${projection.filename}' is unsafe or duplicated`);
      }
      fs.writeFileSync(filePath, projection.content, { mode: 0o600, flag: "wx" });
      try {
        fs.chmodSync(filePath, 0o600);
      } catch {
        // Best effort on platforms without POSIX modes.
      }
      env[projection.env] = filePath;
      redactionValues.push(projection.content);
    }
  } catch (cause) {
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
    throw cause;
  }

  const exposedRedactionValues = [...new Set(redactionValues)];
  return {
    env,
    broker_refs: brokerRefs,
    redaction_values: exposedRedactionValues,
    cleanup: () => {
      if (directory) fs.rmSync(directory, { recursive: true, force: true });
      for (const key of Object.keys(env)) delete env[key];
      redactionValues.splice(0);
      exposedRedactionValues.splice(0);
    },
  };
}
