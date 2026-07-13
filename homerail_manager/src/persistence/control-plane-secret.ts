import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { getDataRoot } from "../config/env.js";

function secretDirectory(): string {
  return path.join(getDataRoot(), "secrets");
}

export function controlPlaneTokenPath(): string {
  return path.join(secretDirectory(), "control-plane.token");
}

function enforcePrivateMode(filePath: string, mode: number): void {
  try {
    fs.chmodSync(filePath, mode);
  } catch {
    // Best effort on platforms that do not support POSIX modes.
  }
}

export function readOrCreateControlPlaneToken(
  generate: () => string = () => crypto.randomBytes(32).toString("base64url"),
): string {
  const dir = secretDirectory();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  enforcePrivateMode(dir, 0o700);
  const filePath = controlPlaneTokenPath();
  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, "utf8").trim();
    if (!existing) throw new Error(`Invalid empty control-plane token at ${filePath}`);
    enforcePrivateMode(filePath, 0o600);
    return existing;
  }

  const token = generate().trim();
  if (!token) throw new Error("Generated control-plane token must not be empty");
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
  enforcePrivateMode(filePath, 0o600);
  return token;
}
