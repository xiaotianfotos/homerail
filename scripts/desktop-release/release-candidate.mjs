#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { classifyReleaseVersion } from "./validate-unified-version.mjs";

function parseArguments(argv) {
  const command = argv[0];
  const result = { command };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (!argument.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(
        "usage: release-candidate.mjs <create|verify> --candidate-dir <path> [release metadata]",
      );
    }
    result[argument.slice(2)] = value;
    index += 1;
  }
  if (!["create", "verify"].includes(command) || !result["candidate-dir"]) {
    throw new Error(
      "usage: release-candidate.mjs <create|verify> --candidate-dir <path> [release metadata]",
    );
  }
  return result;
}

function sha256(file) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

function listFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`candidate must not contain symlinks: ${absolute}`);
      }
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.isFile()) {
        files.push(path.relative(root, absolute).split(path.sep).join("/"));
      } else {
        throw new Error(`unsupported candidate entry: ${absolute}`);
      }
    }
  };
  visit(root);
  return files.sort();
}

function assertExactList(actual, expected, description) {
  const actualSorted = [...actual].sort();
  const expectedSorted = [...expected].sort();
  if (JSON.stringify(actualSorted) !== JSON.stringify(expectedSorted)) {
    throw new Error(
      `${description} mismatch: expected ${JSON.stringify(expectedSorted)}, got ${JSON.stringify(actualSorted)}`,
    );
  }
}

function expectedMetadata(channel) {
  if (channel === "latest") {
    return {
      windows: ["latest.yml", "alpha.yml", "beta.yml"],
      macos: ["latest-mac.yml", "alpha-mac.yml", "beta-mac.yml"],
    };
  }
  return {
    windows: [`${channel}.yml`],
    macos: [`${channel}-mac.yml`],
  };
}

function validateAssetBoundary(candidateDir, channel) {
  const assetsDir = path.join(candidateDir, "release-assets");
  const files = listFiles(assetsDir);
  const metadata = expectedMetadata(channel);
  const required = {
    windowsInstaller: false,
    windowsMetadata: false,
    macDmg: false,
    macZip: false,
    macMetadata: false,
  };

  for (const relative of files) {
    const [platform, ...rest] = relative.split("/");
    const name = rest.join("/");
    if (!["windows", "macos"].includes(platform) || !name || name.includes("/")) {
      throw new Error(`unexpected candidate asset path: ${relative}`);
    }

    if (platform === "windows") {
      const isMetadata = metadata.windows.includes(name);
      const allowed =
        name.endsWith(".exe") ||
        name.endsWith(".blockmap") ||
        isMetadata ||
        name === "SHA256SUMS-windows.txt";
      if (!allowed) throw new Error(`unexpected Windows release asset: ${name}`);
      if (name.endsWith(".exe")) required.windowsInstaller = true;
      if (isMetadata) required.windowsMetadata = true;
    } else {
      const isMetadata = metadata.macos.includes(name);
      const allowed =
        name.endsWith(".dmg") ||
        name.endsWith(".zip") ||
        name.endsWith(".blockmap") ||
        isMetadata ||
        name === "SHA256SUMS-macos.txt";
      if (!allowed) throw new Error(`unexpected macOS release asset: ${name}`);
      if (name.endsWith(".dmg")) required.macDmg = true;
      if (name.endsWith(".zip")) required.macZip = true;
      if (isMetadata) required.macMetadata = true;
    }
  }

  const fileSet = new Set(files);
  for (const [platform, names] of Object.entries(metadata)) {
    for (const name of names) {
      if (!fileSet.has(`${platform}/${name}`)) {
        throw new Error(`candidate is missing required update metadata: ${platform}/${name}`);
      }
    }
  }
  for (const [name, present] of Object.entries(required)) {
    if (!present) throw new Error(`candidate is missing required asset: ${name}`);
  }
  return files;
}

function readMetadataVersion(file) {
  const content = fs.readFileSync(file, "utf8");
  const match = /^version:\s*["']?([^"'#\s]+)["']?\s*$/m.exec(content);
  if (!match) throw new Error(`cannot find a version field in ${file}`);
  return match[1];
}

function validateUpdateMetadata(candidateDir, channel, version) {
  const metadata = expectedMetadata(channel);
  for (const [platform, names] of Object.entries(metadata)) {
    const files = names.map((name) =>
      path.join(candidateDir, "release-assets", platform, name),
    );
    for (const file of files) {
      const metadataVersion = readMetadataVersion(file);
      if (metadataVersion !== version) {
        throw new Error(
          `${file} describes version ${JSON.stringify(metadataVersion)}; expected ${version}`,
        );
      }
    }
    if (channel === "latest") {
      const canonicalHash = sha256(files[0]);
      for (const alias of files.slice(1)) {
        if (sha256(alias) !== canonicalHash) {
          throw new Error(`${alias} must be byte-identical to ${files[0]}`);
        }
      }
    }
  }
}

function validatePlatformChecksums(candidateDir, platform, sidecarName) {
  const platformDir = path.join(candidateDir, "release-assets", platform);
  const sidecar = path.join(platformDir, sidecarName);
  const lines = fs.readFileSync(sidecar, "utf8").trim().split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) throw new Error(`${sidecar} is empty`);

  const covered = new Set();
  for (const line of lines) {
    const match = /^([a-f0-9]{64})  ([^/\\]+)$/.exec(line);
    if (!match) throw new Error(`invalid checksum line in ${sidecar}: ${line}`);
    const [, expected, name] = match;
    if (covered.has(name)) {
      throw new Error(`duplicate checksum entry in ${sidecar}: ${name}`);
    }
    const file = path.join(platformDir, name);
    if (!fs.existsSync(file)) throw new Error(`${sidecar} references missing asset ${name}`);
    if (sha256(file) !== expected) throw new Error(`checksum mismatch for ${file}`);
    covered.add(name);
  }

  const expectedAssets = fs
    .readdirSync(platformDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== sidecarName)
    .map((entry) => entry.name);
  assertExactList(covered, expectedAssets, `${sidecar} coverage`);
}

function validateRequiredMetadata(args) {
  for (const name of [
    "version",
    "tag",
    "channel",
    "source-commit",
    "desktop-commit",
    "run-id",
  ]) {
    if (!args[name]) throw new Error(`missing --${name}`);
  }
  const release = classifyReleaseVersion(args.version);
  if (args.tag !== release.tag) {
    throw new Error(`tag ${args.tag} does not match version ${args.version}`);
  }
  if (args.channel !== release.channel) {
    throw new Error(
      `version ${args.version} belongs to the ${release.channel} channel, not ${args.channel}`,
    );
  }
  for (const name of ["source-commit", "desktop-commit"]) {
    if (!/^[a-f0-9]{40}$/.test(args[name])) {
      throw new Error(`--${name} must be a full 40-character commit SHA`);
    }
  }
  if (!/^[1-9][0-9]*$/.test(args["run-id"])) {
    throw new Error("--run-id must be a positive integer");
  }
}

function validateCreateBoundary(candidateDir) {
  const entries = fs.readdirSync(candidateDir, { withFileTypes: true });
  if (
    entries.length !== 1 ||
    entries[0].name !== "release-assets" ||
    !entries[0].isDirectory() ||
    entries[0].isSymbolicLink()
  ) {
    throw new Error("candidate create directory must contain only release-assets");
  }
}

function writeCandidate(args) {
  validateRequiredMetadata(args);
  const candidateDir = path.resolve(args["candidate-dir"]);
  validateCreateBoundary(candidateDir);
  const assetFiles = validateAssetBoundary(candidateDir, args.channel);
  validateUpdateMetadata(candidateDir, args.channel, args.version);
  validatePlatformChecksums(candidateDir, "windows", "SHA256SUMS-windows.txt");
  validatePlatformChecksums(candidateDir, "macos", "SHA256SUMS-macos.txt");

  const artifacts = assetFiles.map((relative) => {
    const file = path.join(candidateDir, "release-assets", relative);
    return {
      path: `release-assets/${relative}`,
      bytes: fs.statSync(file).size,
      sha256: sha256(file),
    };
  });
  const manifest = {
    schema_version: 1,
    version: args.version,
    tag: args.tag,
    channel: args.channel,
    prerelease: args.channel !== "latest",
    source_commit: args["source-commit"],
    desktop_commit: args["desktop-commit"],
    candidate_run_id: Number(args["run-id"]),
    created_at: new Date().toISOString(),
    artifacts,
  };
  fs.writeFileSync(
    path.join(candidateDir, "release-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  const phase = manifest.prerelease ? `${args.channel} prerelease` : "stable release";
  fs.writeFileSync(
    path.join(candidateDir, "release-notes.md"),
    [
      `# HomeRail ${args.version}`,
      "",
      `This is a signed HomeRail Desktop ${phase}.`,
      "",
      `- HomeRail commit: \`${args["source-commit"]}\``,
      `- Desktop commit: \`${args["desktop-commit"]}\``,
      `- Candidate workflow run: \`${args["run-id"]}\``,
      "",
      "The candidate passed build-time signature, notarization, package, and checksum verification.",
      "Public announcement remains a separate decision after installed-update testing.",
      "",
    ].join("\n"),
  );

  const checksumFiles = [
    ...artifacts.map((artifact) => artifact.path),
    "release-manifest.json",
    "release-notes.md",
  ].sort();
  const checksums = checksumFiles
    .map((relative) => `${sha256(path.join(candidateDir, relative))}  ${relative}`)
    .join("\n");
  fs.writeFileSync(path.join(candidateDir, "SHA256SUMS.txt"), `${checksums}\n`);
  return manifest;
}

function readManifest(candidateDir) {
  return JSON.parse(fs.readFileSync(path.join(candidateDir, "release-manifest.json"), "utf8"));
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("release manifest must be an object");
  }
  assertExactList(
    Object.keys(manifest),
    [
      "schema_version",
      "version",
      "tag",
      "channel",
      "prerelease",
      "source_commit",
      "desktop_commit",
      "candidate_run_id",
      "created_at",
      "artifacts",
    ],
    "release manifest fields",
  );
  if (manifest.schema_version !== 1) {
    throw new Error(`unsupported release manifest schema: ${manifest.schema_version}`);
  }

  const release = classifyReleaseVersion(manifest.version);
  if (
    manifest.tag !== release.tag ||
    manifest.channel !== release.channel ||
    manifest.prerelease !== release.prerelease
  ) {
    throw new Error("release manifest version, tag, channel, and prerelease fields disagree");
  }
  for (const [name, value] of [
    ["source_commit", manifest.source_commit],
    ["desktop_commit", manifest.desktop_commit],
  ]) {
    if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) {
      throw new Error(`release manifest ${name} must be a full commit SHA`);
    }
  }
  if (!Number.isSafeInteger(manifest.candidate_run_id) || manifest.candidate_run_id <= 0) {
    throw new Error("release manifest candidate_run_id must be a positive integer");
  }
  if (
    typeof manifest.created_at !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(manifest.created_at) ||
    Number.isNaN(Date.parse(manifest.created_at))
  ) {
    throw new Error("release manifest created_at must be an ISO-8601 UTC timestamp");
  }
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
    throw new Error("release manifest artifacts must be a non-empty array");
  }

  const paths = new Set();
  for (const artifact of manifest.artifacts) {
    if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
      throw new Error("release manifest artifact must be an object");
    }
    assertExactList(
      Object.keys(artifact),
      ["path", "bytes", "sha256"],
      "release manifest artifact fields",
    );
    if (
      typeof artifact.path !== "string" ||
      !/^release-assets\/(?:windows|macos)\/[^/\\]+$/.test(artifact.path)
    ) {
      throw new Error(`unsafe release manifest artifact path: ${artifact.path}`);
    }
    if (paths.has(artifact.path)) {
      throw new Error(`duplicate release manifest artifact: ${artifact.path}`);
    }
    paths.add(artifact.path);
    if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0) {
      throw new Error(`invalid release manifest size for ${artifact.path}`);
    }
    if (typeof artifact.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(artifact.sha256)) {
      throw new Error(`invalid release manifest checksum for ${artifact.path}`);
    }
  }
}

function verifyGlobalChecksums(candidateDir, expectedFiles) {
  const sidecar = path.join(candidateDir, "SHA256SUMS.txt");
  const lines = fs.readFileSync(sidecar, "utf8").trim().split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) throw new Error(`${sidecar} is empty`);
  const covered = new Set();
  for (const line of lines) {
    const match = /^([a-f0-9]{64})  ([^\0]+)$/.exec(line);
    if (!match) throw new Error(`invalid checksum line in ${sidecar}: ${line}`);
    const [, expected, relative] = match;
    if (
      relative.startsWith("/") ||
      relative.includes("\\") ||
      relative.split("/").includes("..")
    ) {
      throw new Error(`unsafe checksum path in ${sidecar}: ${relative}`);
    }
    if (covered.has(relative)) {
      throw new Error(`duplicate checksum entry in ${sidecar}: ${relative}`);
    }
    const file = path.join(candidateDir, relative);
    if (!fs.existsSync(file)) throw new Error(`${sidecar} references missing file ${relative}`);
    if (sha256(file) !== expected) throw new Error(`checksum mismatch for ${file}`);
    covered.add(relative);
  }
  assertExactList(covered, expectedFiles, `${sidecar} coverage`);
}

function verifyCandidate(args) {
  const candidateDir = path.resolve(args["candidate-dir"]);
  const manifest = readManifest(candidateDir);
  validateManifest(manifest);
  if (args.version && manifest.version !== args.version) {
    throw new Error(`candidate version ${manifest.version} does not match ${args.version}`);
  }
  if (args["run-id"] && manifest.candidate_run_id !== Number(args["run-id"])) {
    throw new Error(
      `candidate run ${manifest.candidate_run_id} does not match ${args["run-id"]}`,
    );
  }
  const assetFiles = validateAssetBoundary(candidateDir, manifest.channel);
  validateUpdateMetadata(candidateDir, manifest.channel, manifest.version);
  validatePlatformChecksums(candidateDir, "windows", "SHA256SUMS-windows.txt");
  validatePlatformChecksums(candidateDir, "macos", "SHA256SUMS-macos.txt");
  const manifestPaths = manifest.artifacts.map((artifact) => artifact.path).sort();
  const actualPaths = assetFiles.map((relative) => `release-assets/${relative}`).sort();
  assertExactList(manifestPaths, actualPaths, "release manifest asset list");
  for (const artifact of manifest.artifacts) {
    const file = path.join(candidateDir, artifact.path);
    if (fs.statSync(file).size !== artifact.bytes || sha256(file) !== artifact.sha256) {
      throw new Error(`release manifest mismatch for ${artifact.path}`);
    }
  }
  const checksummedFiles = [
    ...actualPaths,
    "release-manifest.json",
    "release-notes.md",
  ].sort();
  assertExactList(
    listFiles(candidateDir),
    [...checksummedFiles, "SHA256SUMS.txt"],
    "candidate file boundary",
  );
  verifyGlobalChecksums(candidateDir, checksummedFiles);
  return manifest;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  const result = args.command === "create" ? writeCandidate(args) : verifyCandidate(args);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
