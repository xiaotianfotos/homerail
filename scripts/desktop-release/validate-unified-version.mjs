#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const PUBLIC_PACKAGE_DIRS = [
  ".",
  "homerail_protocol",
  "homerail_plugin_sdk",
  "homerail_manager",
  "homerail_node",
  "homerail_worker",
  "homerail_cli",
  "agent-ui",
];

const NUMERIC_IDENTIFIER = String.raw`(?:0|[1-9][0-9]*)`;
const CORE_VERSION = String.raw`${NUMERIC_IDENTIFIER}\.${NUMERIC_IDENTIFIER}\.${NUMERIC_IDENTIFIER}`;
const STABLE_VERSION = new RegExp(`^${CORE_VERSION}$`);
const PRERELEASE_VERSION = new RegExp(
  `^${CORE_VERSION}-(alpha|beta)(?:\\.${NUMERIC_IDENTIFIER})+$`,
);

export function classifyReleaseVersion(version) {
  if (STABLE_VERSION.test(version)) {
    return {
      version,
      tag: `v${version}`,
      channel: "latest",
      prerelease: false,
    };
  }

  const prerelease = PRERELEASE_VERSION.exec(version);
  if (!prerelease) {
    throw new Error(
      `invalid release version ${JSON.stringify(version)}; expected 0.1.0-alpha.1, 0.1.0-beta.1, or 0.1.0`,
    );
  }

  return {
    version,
    tag: `v${version}`,
    channel: prerelease[1],
    prerelease: true,
  };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function assertVersion(file, actual, expected) {
  if (actual !== expected) {
    throw new Error(`${file} has version ${JSON.stringify(actual)}; expected ${expected}`);
  }
}

function validatePackage(packageDir, expectedVersion, unifiedPackageNames) {
  const packageFile = path.join(packageDir, "package.json");
  if (!fs.existsSync(packageFile)) {
    throw new Error(`missing package manifest: ${packageFile}`);
  }

  const packageJson = readJson(packageFile);
  assertVersion(packageFile, packageJson.version, expectedVersion);

  const lockFile = path.join(packageDir, "package-lock.json");
  if (!fs.existsSync(lockFile)) return;

  const lockJson = readJson(lockFile);
  assertVersion(lockFile, lockJson.version, expectedVersion);
  assertVersion(`${lockFile} packages[""]`, lockJson.packages?.[""]?.version, expectedVersion);
  for (const [lockPath, lockedPackage] of Object.entries(lockJson.packages ?? {})) {
    if (
      lockPath &&
      lockedPackage?.name &&
      unifiedPackageNames.has(lockedPackage.name)
    ) {
      assertVersion(
        `${lockFile} packages[${JSON.stringify(lockPath)}]`,
        lockedPackage.version,
        expectedVersion,
      );
    }
  }
}

export function validateUnifiedVersion({ publicRoot, desktopRoot, version }) {
  const release = classifyReleaseVersion(version);
  const unifiedPackageNames = new Set(
    PUBLIC_PACKAGE_DIRS.map((relativeDir) => {
      const packageFile = path.resolve(publicRoot, relativeDir, "package.json");
      return readJson(packageFile).name;
    }),
  );
  for (const relativeDir of PUBLIC_PACKAGE_DIRS) {
    validatePackage(path.resolve(publicRoot, relativeDir), version, unifiedPackageNames);
  }
  if (desktopRoot) {
    validatePackage(path.resolve(desktopRoot), version, unifiedPackageNames);
  }
  return release;
}

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      throw new Error(`unexpected argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`missing value for ${argument}`);
    }
    result[argument.slice(2)] = value;
    index += 1;
  }
  if (!result["public-root"] || !result.version) {
    throw new Error(
      "usage: validate-unified-version.mjs --public-root <path> [--desktop-root <path>] --version <version>",
    );
  }
  return result;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  const release = validateUnifiedVersion({
    publicRoot: args["public-root"],
    desktopRoot: args["desktop-root"],
    version: args.version,
  });
  process.stdout.write(`${JSON.stringify(release)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
