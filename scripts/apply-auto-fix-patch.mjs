#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function git(repository, args, options = {}) {
  const result = spawnSync("git", ["-C", repository, ...args], {
    encoding: options.encoding ?? "utf8",
    input: options.input,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${String(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout;
}

const protectedAutomationPaths = new Set([
  "scripts/auto-fix-checkpoint.mjs",
  "scripts/apply-auto-fix-patch.mjs",
  "scripts/build-auto-fix-pr-body.mjs",
  "scripts/configure-auto-fix-runtime-profile.mjs",
  "scripts/github-token-askpass.sh",
  "scripts/prepare-auto-fix-input.mjs",
  "scripts/publish-auto-fix-pr.sh",
  "scripts/run-auto-fix-stable-runner.sh",
  "scripts/run-stable-dag-runner.sh",
  "scripts/validate-auto-fix-artifacts.mjs",
  "scripts/validate-auto-fix-checkout.sh",
]);

function isSafePath(file) {
  if (typeof file !== "string" || !file || file.includes("\\") || file.includes("\0") || path.posix.isAbsolute(file)) return false;
  const parts = file.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return false;
  const lower = file.toLowerCase();
  if (lower === ".gitmodules" || lower.startsWith(".git/")) return false;
  if (/(^|\/)\.env(?:\.|$)/.test(lower) && !/(^|\/)\.env\.example$/.test(lower)) return false;
  if (lower.startsWith(".github/workflows/")) return false;
  if (protectedAutomationPaths.has(lower)) return false;
  if (/(^|\/)(?:id_rsa|id_ed25519)(?:\.|$)/i.test(file)) return false;
  if (/(^|\/)(?:credentials|secrets?)(?:$|\.(?:json|ya?ml|ini|toml|txt))$/i.test(file)) return false;
  if (/\.(?:pem|key|p8|p12|pfx|jks|keystore|mobileprovision)$/i.test(file)) return false;
  return true;
}

function stagedFiles(repository) {
  const output = git(repository, ["diff", "--cached", "--name-only", "-z"], { encoding: "buffer" });
  return output.toString("utf8").split("\0").filter(Boolean);
}

function stagedModes(repository) {
  const output = git(repository, ["diff", "--cached", "--raw", "-z"], { encoding: "buffer" }).toString("utf8");
  const entries = output.split("\0").filter(Boolean);
  return entries.filter((entry) => entry.startsWith(":")).map((entry) => {
    const [metadata, ...pathParts] = entry.split("\t");
    const fields = metadata.split(" ");
    return { oldMode: fields[0]?.slice(1), newMode: fields[1], path: pathParts.join("\t") };
  });
}

export function applyAutoFixPatch({ repository, publicationPath, patchPath }) {
  const repo = path.resolve(repository);
  invariant(fs.statSync(repo).isDirectory(), "Auto Fix repository is not a directory");
  const publication = JSON.parse(fs.readFileSync(publicationPath, "utf8"));
  const patchText = fs.readFileSync(patchPath, "utf8");
  invariant(Buffer.byteLength(patchText) <= 1_000_000, "Auto Fix patch exceeds one megabyte");
  invariant(patchText === publication.patch, "Auto Fix patch differs from the validated JSON publication");
  invariant(git(repo, ["status", "--porcelain"]).trim() === "", "Auto Fix repository must begin clean");
  invariant(git(repo, ["rev-parse", "HEAD"]).trim().toLowerCase() === publication.revision.toLowerCase(), "Auto Fix repository is not at the published base revision");

  git(repo, ["apply", "--check", "--index", "--whitespace=error-all", patchPath]);
  git(repo, ["apply", "--index", "--whitespace=error-all", patchPath]);

  const files = stagedFiles(repo);
  invariant(files.length > 0 && files.length <= 100, "Auto Fix patch must change 1 through 100 files");
  invariant(files.every(isSafePath), `Auto Fix patch targets a forbidden path: ${files.find((file) => !isSafePath(file))}`);
  const declared = [...publication.files_changed].sort();
  invariant(JSON.stringify([...files].sort()) === JSON.stringify(declared), "Auto Fix patch paths do not match files_changed");
  const unsafeMode = stagedModes(repo).find(({ oldMode, newMode }) => oldMode === "160000" || newMode === "160000" || newMode === "120000");
  invariant(!unsafeMode, `Auto Fix patch creates a symlink or submodule entry: ${unsafeMode?.path ?? "unknown"}`);
  git(repo, ["diff", "--cached", "--check"]);
  return files;
}

function main(argv) {
  invariant(argv.length === 3, "usage: apply-auto-fix-patch.mjs <repository> <auto-fix.json> <auto-fix.patch>");
  applyAutoFixPatch({ repository: argv[0], publicationPath: argv[1], patchPath: argv[2] });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`Rejected Auto Fix patch: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
