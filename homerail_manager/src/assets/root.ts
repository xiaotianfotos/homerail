import * as fs from "node:fs";
import * as path from "node:path";
import { getHomerailHome } from "../config/env.js";

export interface AssetRootResolution {
  assetRoot: string;
  repoAssetRoot: string;
  repoRoot: string;
  source: "env" | "homerail_home" | "repo";
}

export function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (
      fs.existsSync(path.join(dir, "assets", "orchestrations")) &&
      fs.existsSync(path.join(dir, "skills"))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export function resolveAssetRoot(): AssetRootResolution {
  const root = repoRoot();
  const repoAssetRoot = path.join(root, "assets");
  const explicit = process.env.HOMERAIL_ASSET_DIR?.trim();
  if (explicit) {
    return {
      assetRoot: path.resolve(explicit),
      repoAssetRoot,
      repoRoot: root,
      source: "env",
    };
  }

  const homeAssetRoot = path.join(getHomerailHome(), "asset");
  if (fs.existsSync(homeAssetRoot)) {
    return {
      assetRoot: homeAssetRoot,
      repoAssetRoot,
      repoRoot: root,
      source: "homerail_home",
    };
  }

  return {
    assetRoot: repoAssetRoot,
    repoAssetRoot,
    repoRoot: root,
    source: "repo",
  };
}

export function getAssetRoot(): string {
  return resolveAssetRoot().assetRoot;
}

export function resolveAssetDirectory(name: string): string {
  const resolution = resolveAssetRoot();
  const configured = path.join(resolution.assetRoot, name);
  if (fs.existsSync(configured)) return configured;
  return path.join(resolution.repoAssetRoot, name);
}
