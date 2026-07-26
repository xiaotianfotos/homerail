import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  classifyReleaseVersion,
  validateUnifiedVersion,
} from "./desktop-release/validate-unified-version.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const candidateWorkflow = fs
  .readFileSync(
    path.join(repoRoot, ".github", "workflows", "desktop-release-candidate.yml"),
    "utf8",
  )
  .replace(/\r\n/g, "\n");
const publishWorkflow = fs
  .readFileSync(
    path.join(repoRoot, ".github", "workflows", "desktop-release-publish.yml"),
    "utf8",
  )
  .replace(/\r\n/g, "\n");
const releaseDocs = fs.readFileSync(
  path.join(repoRoot, "docs", "desktop-release.md"),
  "utf8",
);
const currentPublicVersion = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
).version;

test("release versions follow the unified Codex-style SemVer train", () => {
  assert.deepEqual(classifyReleaseVersion("0.1.0-alpha.1"), {
    version: "0.1.0-alpha.1",
    tag: "v0.1.0-alpha.1",
    channel: "alpha",
    prerelease: true,
  });
  assert.equal(classifyReleaseVersion("0.1.0-alpha.3.1").channel, "alpha");
  assert.equal(classifyReleaseVersion("0.1.0-beta.1").channel, "beta");
  assert.equal(classifyReleaseVersion("0.1.0").channel, "latest");
  for (const invalid of [
    "desktop-v0.1.0-alpha.1",
    "rust-v0.1.0-alpha.1",
    "v0.1.0-alpha.1",
    "0.1.0-alpha",
    "0.1.0-alpha.01",
  ]) {
    assert.throws(() => classifyReleaseVersion(invalid), /invalid release version/);
  }
});

test("current public packages satisfy the unified version contract", () => {
  assert.doesNotThrow(() =>
    validateUnifiedVersion({ publicRoot: repoRoot, version: currentPublicVersion }),
  );
});

test("unified version validation checks Desktop package metadata", () => {
  const desktopRoot = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-desktop-version-"));
  const packageFile = path.join(desktopRoot, "package.json");
  const packageName = "homerail-desktop";
  const version = currentPublicVersion;
  try {
    fs.writeFileSync(
      packageFile,
      `${JSON.stringify({ name: packageName, version }, null, 2)}\n`,
    );
    fs.writeFileSync(
      path.join(desktopRoot, "package-lock.json"),
      `${JSON.stringify({
        name: packageName,
        version,
        lockfileVersion: 3,
        packages: {
          "": { name: packageName, version },
        },
      }, null, 2)}\n`,
    );

    assert.doesNotThrow(() =>
      validateUnifiedVersion({
        publicRoot: repoRoot,
        desktopRoot,
        version,
      }),
    );

    fs.writeFileSync(
      packageFile,
      `${JSON.stringify({ name: packageName, version: "0.0.0" }, null, 2)}\n`,
    );
    assert.throws(
      () =>
        validateUnifiedVersion({
          publicRoot: repoRoot,
          desktopRoot,
          version,
        }),
      /package\.json has version "0\.0\.0"; expected 0\.1\.0/,
    );
  } finally {
    fs.rmSync(desktopRoot, { recursive: true, force: true });
  }
});

test("unified version validation catches stale local-package lock snapshots", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-unified-version-"));
  const packageDirs = [
    ".",
    "homerail_protocol",
    "homerail_plugin_sdk",
    "homerail_manager",
    "homerail_node",
    "homerail_worker",
    "homerail_cli",
    "agent-ui",
  ];
  try {
    for (const relativeDir of packageDirs) {
      const source = JSON.parse(
        fs.readFileSync(path.join(repoRoot, relativeDir, "package.json"), "utf8"),
      );
      const targetDir = path.resolve(fixtureRoot, relativeDir);
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(
        path.join(targetDir, "package.json"),
        `${JSON.stringify({ name: source.name, version: "0.1.0-alpha.1" }, null, 2)}\n`,
      );
      fs.writeFileSync(
        path.join(targetDir, "package-lock.json"),
        `${JSON.stringify({
          name: source.name,
          version: "0.1.0-alpha.1",
          lockfileVersion: 3,
          packages: {
            "": { name: source.name, version: "0.1.0-alpha.1" },
          },
        }, null, 2)}\n`,
      );
    }

    const cliLockFile = path.join(fixtureRoot, "homerail_cli", "package-lock.json");
    const cliLock = JSON.parse(fs.readFileSync(cliLockFile, "utf8"));
    cliLock.packages["../homerail_protocol"] = {
      name: "homerail-protocol",
      version: "0.1.0",
    };
    fs.writeFileSync(cliLockFile, `${JSON.stringify(cliLock, null, 2)}\n`);

    assert.throws(
      () =>
        validateUnifiedVersion({
          publicRoot: fixtureRoot,
          version: "0.1.0-alpha.1",
        }),
      /packages\["\.\.\/homerail_protocol"\].*expected 0\.1\.0-alpha\.1/,
    );
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("candidate build is manual, owner-only, main-only, and creates no public release", () => {
  assert.match(candidateWorkflow, /workflow_dispatch:/);
  assert.doesNotMatch(candidateWorkflow, /^\s{2}(?:push|pull_request|schedule):/m);
  assert.match(
    candidateWorkflow,
    /github\.actor == 'xiaotianfotos' && github\.ref == 'refs\/heads\/main'/,
  );
  assert.match(candidateWorkflow, /desktop_sha must be a full lowercase 40-character commit SHA/);
  assert.match(candidateWorkflow, /validate-unified-version\.mjs/);
  assert.match(
    candidateWorkflow,
    /--desktop-root desktop\n\s+--version "\$\{\{ needs\.prepare\.outputs\.version \}\}"/,
  );
  assert.doesNotMatch(candidateWorkflow, /npm --prefix desktop version/);
  assert.doesNotMatch(candidateWorkflow, /gh release create|git tag|git\/refs/);
  assert.match(candidateWorkflow, /name: desktop-release-candidate/);
  assert.match(candidateWorkflow, /retention-days: 30/);
  assert.match(candidateWorkflow, /cancel-in-progress: false/);
});

test("candidate uses protected signing without Deployment records", () => {
  assert.match(
    candidateWorkflow,
    /environment:\n\s+name: desktop-beta-signing\n\s+deployment: false/,
  );
  assert.match(candidateWorkflow, /os: windows-latest/);
  assert.match(candidateWorkflow, /os: macos-15/);
  assert.match(candidateWorkflow, /repository: xiaotianfotos\/homerail_desktop/);
  assert.match(candidateWorkflow, /ref: \$\{\{ inputs\.desktop_sha \}\}/);
  assert.match(candidateWorkflow, /token: \$\{\{ secrets\.HOMERAIL_DESKTOP_READ_TOKEN \}\}/);
  assert.equal((candidateWorkflow.match(/persist-credentials: false/g) ?? []).length, 4);
  assert.doesNotMatch(candidateWorkflow, /runs-on:.*self-hosted/);
});

test("candidate signs, notarizes, verifies, and creates channel metadata", () => {
  for (const secret of [
    "WIN_CSC_LINK",
    "WIN_CSC_KEY_PASSWORD",
    "MAC_CSC_LINK",
    "MAC_CSC_KEY_PASSWORD",
    "APPLE_API_KEY_P8",
    "APPLE_API_KEY_ID",
    "APPLE_API_ISSUER",
    "APPLE_TEAM_ID",
  ]) {
    assert.match(candidateWorkflow, new RegExp(`secrets\\.${secret}`));
  }
  assert.equal((candidateWorkflow.match(/--config\.forceCodeSigning=true/g) ?? []).length, 2);
  assert.match(candidateWorkflow, /--config\.mac\.notarize=true/);
  assert.equal((candidateWorkflow.match(/--config\.publish\.channel=/g) ?? []).length, 2);
  assert.match(candidateWorkflow, /verify:update-metadata/);
  assert.match(candidateWorkflow, /metadata_release_channel=stable/);
  assert.match(candidateWorkflow, /'latest\.yml', 'alpha\.yml', 'beta\.yml'/);
  assert.match(candidateWorkflow, /"latest-mac\.yml" "alpha-mac\.yml" "beta-mac\.yml"/);
  assert.match(candidateWorkflow, /asset_name="\$\{asset#\.\/\}"/);
  assert.match(candidateWorkflow, /Get-AuthenticodeSignature/);
  assert.match(candidateWorkflow, /codesign --verify --deep --strict/);
  assert.match(candidateWorkflow, /xcrun stapler validate/);
  assert.match(candidateWorkflow, /spctl --assess/);
  assert.match(candidateWorkflow, /release-candidate\.mjs create/);
});

test("Windows candidate runs Node 24 CI before signing and smoke-tests NSIS", () => {
  assert.match(candidateWorkflow, /RELEASE_NODE_VERSION: 24\.18\.0/);
  assert.match(candidateWorkflow, /name: Run public Windows Node 24 CI/);
  assert.match(candidateWorkflow, /npm --prefix homerail-source run ci/);
  assert.match(candidateWorkflow, /name: Verify public Windows CLI release version/);
  assert.match(candidateWorkflow, /Built CLI version .* does not match/);
  assert.match(candidateWorkflow, /name: Run Desktop Windows CI/);
  assert.match(candidateWorkflow, /working-directory: desktop\n\s+env:[\s\S]*?run: npm run ci/);
  assert.match(candidateWorkflow, /VITEST_MAX_WORKERS: "1"/);
  assert.match(candidateWorkflow, /VITEST_TEST_TIMEOUT: "15000"/);
  assert.match(candidateWorkflow, /VITEST_HOOK_TIMEOUT: "30000"/);
  assert.match(candidateWorkflow, /if \(\$signature\.Status -ne 'Valid'\)/);
  assert.match(candidateWorkflow, /-ArgumentList @\('\/S', "\/D=\$installRoot"\)/);
  assert.match(candidateWorkflow, /--user-data-dir=\$electronUserData/);
  assert.match(candidateWorkflow, /Installed CLI version .* does not match/);
  assert.match(candidateWorkflow, /Silent NSIS uninstall left HomeRail\.exe installed/);
  assert.match(candidateWorkflow, /\$_\.Name -match '\\\.\(exe\|blockmap\)\$'/);

  const install = candidateWorkflow.indexOf("Install locked dependencies");
  const publicCi = candidateWorkflow.indexOf("Run public Windows Node 24 CI");
  const publicCliVersion = candidateWorkflow.indexOf("Verify public Windows CLI release version");
  const desktopCi = candidateWorkflow.indexOf("Run Desktop Windows CI");
  const build = candidateWorkflow.indexOf("Build and sign Windows installer");
  const metadata = candidateWorkflow.indexOf("Prepare and verify Windows update metadata");
  const packageVerification = candidateWorkflow.indexOf("Verify Windows package and signature");
  const checksums = candidateWorkflow.indexOf("Write Windows checksums");
  const installSmoke = candidateWorkflow.indexOf("Smoke-test silent Windows installation");
  assert.ok(
    install < publicCi
      && publicCi < publicCliVersion
      && publicCliVersion < desktopCi
      && desktopCi < build
      && build < metadata
      && metadata < packageVerification
      && packageVerification < checksums
      && checksums < installSmoke,
  );
});

test("publish consumes a successful candidate without rebuilding it", () => {
  assert.match(publishWorkflow, /workflow_dispatch:/);
  assert.match(publishWorkflow, /actions: read/);
  assert.match(publishWorkflow, /contents: write/);
  assert.match(
    publishWorkflow,
    /environment:\n\s+name: desktop-release-publishing\n\s+deployment: false/,
  );
  assert.match(publishWorkflow, /desktop-release-candidate\.yml/);
  assert.match(publishWorkflow, /run_conclusion.*success/);
  assert.match(publishWorkflow, /run-id: \$\{\{ inputs\.candidate_run_id \}\}/);
  assert.match(publishWorkflow, /release-candidate\.mjs verify/);
  assert.match(publishWorkflow, /release artifacts are immutable/);
  assert.match(publishWorkflow, /git\/tags/);
  assert.match(publishWorkflow, /refs\/tags\/\$RELEASE_TAG/);
  assert.match(publishWorkflow, /gh release create/);
  assert.match(publishWorkflow, /--verify-tag/);
  assert.match(publishWorkflow, /--prerelease/);
  assert.doesNotMatch(publishWorkflow, /npm (?:ci|run)|electron-builder|forceCodeSigning/);
});

test("release docs preserve candidate, publish, update-test, and fix-forward boundaries", () => {
  assert.match(releaseDocs, /Candidate/);
  assert.match(releaseDocs, /Technical publish/);
  assert.match(releaseDocs, /Announcement/);
  assert.match(releaseDocs, /draft release is not an update-testing surface/);
  assert.match(releaseDocs, /0\.1\.0-alpha\.1/);
  assert.match(releaseDocs, /0\.1\.0-alpha\.2/);
  assert.match(releaseDocs, /Fix forward with `0\.1\.0-alpha\.3`/i);
  assert.match(releaseDocs, /Do not create the version tag\s+when merging code/);
  assert.match(releaseDocs, /byte-identical Alpha and Beta compatibility metadata/);
  assert.match(releaseDocs, /complete public Node 24 CI suite/);
  assert.match(releaseDocs, /does not replace.*real Windows machine/s);
});

test("candidate pins a merged Desktop commit before installing or signing", () => {
  assert.match(candidateWorkflow, /fetch-depth: 0/);
  assert.match(candidateWorkflow, /git -C desktop rev-parse HEAD/);
  assert.match(candidateWorkflow, /git -C desktop merge-base --is-ancestor/);
  assert.match(candidateWorkflow, /desktop_sha must already be merged to homerail_desktop main/);
  assert.ok(
    candidateWorkflow.indexOf("Verify Desktop commit is merged to main")
      < candidateWorkflow.indexOf("Install locked dependencies"),
  );
});

function hash(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function writePlatformFixture(candidateDir, platform, files, sidecar) {
  const platformDir = path.join(candidateDir, "release-assets", platform);
  fs.mkdirSync(platformDir, { recursive: true });
  const checksumLines = [];
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(platformDir, name), content);
    checksumLines.push(`${hash(content)}  ${name}`);
  }
  fs.writeFileSync(path.join(platformDir, sidecar), `${checksumLines.sort().join("\n")}\n`);
}

function writeAlphaCandidateFixture(candidateDir) {
  writePlatformFixture(
    candidateDir,
    "windows",
    {
      "HomeRail Setup 0.1.0-alpha.1.exe": "windows-installer",
      "HomeRail Setup 0.1.0-alpha.1.exe.blockmap": "windows-blockmap",
      "alpha.yml": "version: 0.1.0-alpha.1\n",
    },
    "SHA256SUMS-windows.txt",
  );
  writePlatformFixture(
    candidateDir,
    "macos",
    {
      "HomeRail-0.1.0-alpha.1-arm64.dmg": "mac-dmg",
      "HomeRail-0.1.0-alpha.1-arm64.zip": "mac-zip",
      "alpha-mac.yml": "version: 0.1.0-alpha.1\n",
    },
    "SHA256SUMS-macos.txt",
  );
}

function alphaCandidateCreateArgs(script, candidateDir, runId) {
  return [
    script,
    "create",
    "--candidate-dir",
    candidateDir,
    "--version",
    "0.1.0-alpha.1",
    "--tag",
    "v0.1.0-alpha.1",
    "--channel",
    "alpha",
    "--source-commit",
    "a".repeat(40),
    "--desktop-commit",
    "b".repeat(40),
    "--run-id",
    runId,
  ];
}

test("candidate manifest is reproducibly verified and detects artifact tampering", () => {
  const candidateDir = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-candidate-"));
  const script = path.join(repoRoot, "scripts", "desktop-release", "release-candidate.mjs");
  try {
    writePlatformFixture(
      candidateDir,
      "windows",
      {
        "HomeRail Setup 0.1.0-alpha.1.exe": "windows-installer",
        "HomeRail Setup 0.1.0-alpha.1.exe.blockmap": "windows-blockmap",
        "alpha.yml": "version: 0.1.0-alpha.1\n",
      },
      "SHA256SUMS-windows.txt",
    );
    writePlatformFixture(
      candidateDir,
      "macos",
      {
        "HomeRail-0.1.0-alpha.1-arm64.dmg": "mac-dmg",
        "HomeRail-0.1.0-alpha.1-arm64.zip": "mac-zip",
        "alpha-mac.yml": "version: 0.1.0-alpha.1\n",
      },
      "SHA256SUMS-macos.txt",
    );

    const createArgs = [
      script,
      "create",
      "--candidate-dir",
      candidateDir,
      "--version",
      "0.1.0-alpha.1",
      "--tag",
      "v0.1.0-alpha.1",
      "--channel",
      "alpha",
      "--source-commit",
      "a".repeat(40),
      "--desktop-commit",
      "b".repeat(40),
      "--run-id",
      "12345",
    ];
    const create = spawnSync(process.execPath, createArgs, { encoding: "utf8" });
    assert.equal(create.status, 0, create.stderr);

    const verify = spawnSync(
      process.execPath,
      [
        script,
        "verify",
        "--candidate-dir",
        candidateDir,
        "--version",
        "0.1.0-alpha.1",
        "--run-id",
        "12345",
      ],
      { encoding: "utf8" },
    );
    assert.equal(verify.status, 0, verify.stderr);

    const wrongVersion = spawnSync(
      process.execPath,
      [
        script,
        "verify",
        "--candidate-dir",
        candidateDir,
        "--version",
        "0.1.0-alpha.2",
        "--run-id",
        "12345",
      ],
      { encoding: "utf8" },
    );
    assert.equal(wrongVersion.status, 1, wrongVersion.stderr);
    assert.match(
      wrongVersion.stderr,
      /candidate version 0\.1\.0-alpha\.1 does not match 0\.1\.0-alpha\.2/,
    );

    const wrongRun = spawnSync(
      process.execPath,
      [
        script,
        "verify",
        "--candidate-dir",
        candidateDir,
        "--version",
        "0.1.0-alpha.1",
        "--run-id",
        "99999",
      ],
      { encoding: "utf8" },
    );
    assert.equal(wrongRun.status, 1, wrongRun.stderr);
    assert.match(wrongRun.stderr, /candidate run 12345 does not match 99999/);

    const duplicateCreate = spawnSync(process.execPath, createArgs, { encoding: "utf8" });
    assert.equal(duplicateCreate.status, 1, duplicateCreate.stderr);
    assert.match(
      duplicateCreate.stderr,
      /candidate create directory must contain only release-assets/,
    );

    const globalChecksums = path.join(candidateDir, "SHA256SUMS.txt");
    const originalGlobalChecksums = fs.readFileSync(globalChecksums, "utf8");
    fs.writeFileSync(
      globalChecksums,
      `${originalGlobalChecksums
        .trim()
        .split(/\r?\n/)
        .filter((line) => !line.endsWith("release-notes.md"))
        .join("\n")}\n`,
    );
    const incomplete = spawnSync(
      process.execPath,
      [script, "verify", "--candidate-dir", candidateDir],
      { encoding: "utf8" },
    );
    assert.notEqual(incomplete.status, 0);
    assert.match(incomplete.stderr, /coverage mismatch/);
    fs.writeFileSync(globalChecksums, originalGlobalChecksums);

    fs.appendFileSync(
      path.join(candidateDir, "release-assets", "macos", "HomeRail-0.1.0-alpha.1-arm64.dmg"),
      "tampered",
    );
    const tampered = spawnSync(
      process.execPath,
      [script, "verify", "--candidate-dir", candidateDir],
      { encoding: "utf8" },
    );
    assert.notEqual(tampered.status, 0);
    assert.match(tampered.stderr, /checksum mismatch|manifest mismatch/);
  } finally {
    fs.rmSync(candidateDir, { recursive: true, force: true });
  }
});

test("candidate create and verify reject symlinks that escape release-assets", (t) => {
  const createDir = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-symlink-create-"));
  const verifyDir = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-symlink-verify-"));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-symlink-outside-"));
  const script = path.join(repoRoot, "scripts", "desktop-release", "release-candidate.mjs");
  const outsideTarget = path.join(outsideDir, "outside.exe");

  try {
    fs.writeFileSync(outsideTarget, "outside-candidate");
    writeAlphaCandidateFixture(createDir);
    writeAlphaCandidateFixture(verifyDir);

    const createLink = path.join(
      createDir,
      "release-assets",
      "windows",
      "outside.exe",
    );
    try {
      fs.symlinkSync(outsideTarget, createLink, "file");
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        ["EPERM", "EACCES", "ENOTSUP"].includes(error.code)
      ) {
        t.skip(`symbolic links are unavailable on this host (${error.code})`);
        return;
      }
      throw error;
    }

    const create = spawnSync(
      process.execPath,
      alphaCandidateCreateArgs(script, createDir, "12348"),
      { encoding: "utf8" },
    );
    assert.equal(create.status, 1, create.stderr);
    assert.match(create.stderr, /must not contain symlinks/);

    const validCreate = spawnSync(
      process.execPath,
      alphaCandidateCreateArgs(script, verifyDir, "12349"),
      { encoding: "utf8" },
    );
    assert.equal(validCreate.status, 0, validCreate.stderr);
    fs.symlinkSync(
      outsideTarget,
      path.join(verifyDir, "release-assets", "windows", "outside.exe"),
      "file",
    );

    const verify = spawnSync(
      process.execPath,
      [script, "verify", "--candidate-dir", verifyDir],
      { encoding: "utf8" },
    );
    assert.equal(verify.status, 1, verify.stderr);
    assert.match(verify.stderr, /must not contain symlinks/);
  } finally {
    fs.rmSync(createDir, { recursive: true, force: true });
    fs.rmSync(verifyDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("candidate verify rejects internally inconsistent manifest identity", () => {
  const candidateDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "homerail-manifest-identity-"),
  );
  const script = path.join(repoRoot, "scripts", "desktop-release", "release-candidate.mjs");
  try {
    writeAlphaCandidateFixture(candidateDir);
    const create = spawnSync(
      process.execPath,
      alphaCandidateCreateArgs(script, candidateDir, "12350"),
      { encoding: "utf8" },
    );
    assert.equal(create.status, 0, create.stderr);

    const manifestFile = path.join(candidateDir, "release-manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    manifest.channel = "beta";
    fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

    const verify = spawnSync(
      process.execPath,
      [script, "verify", "--candidate-dir", candidateDir],
      { encoding: "utf8" },
    );
    assert.equal(verify.status, 1, verify.stderr);
    assert.match(
      verify.stderr,
      /version, tag, channel, and prerelease fields disagree/,
    );
  } finally {
    fs.rmSync(candidateDir, { recursive: true, force: true });
  }
});

test("candidate rejects a Windows artifact set without a blockmap", () => {
  const candidateDir = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-no-blockmap-"));
  const script = path.join(repoRoot, "scripts", "desktop-release", "release-candidate.mjs");
  try {
    writePlatformFixture(
      candidateDir,
      "windows",
      {
        "HomeRail Setup 0.1.0-alpha.1.exe": "windows-installer",
        "alpha.yml": "version: 0.1.0-alpha.1\n",
      },
      "SHA256SUMS-windows.txt",
    );
    writePlatformFixture(
      candidateDir,
      "macos",
      {
        "HomeRail-0.1.0-alpha.1-arm64.dmg": "mac-dmg",
        "HomeRail-0.1.0-alpha.1-arm64.zip": "mac-zip",
        "alpha-mac.yml": "version: 0.1.0-alpha.1\n",
      },
      "SHA256SUMS-macos.txt",
    );
    const create = spawnSync(
      process.execPath,
      [
        script,
        "create",
        "--candidate-dir",
        candidateDir,
        "--version",
        "0.1.0-alpha.1",
        "--tag",
        "v0.1.0-alpha.1",
        "--channel",
        "alpha",
        "--source-commit",
        "a".repeat(40),
        "--desktop-commit",
        "b".repeat(40),
        "--run-id",
        "12347",
      ],
      { encoding: "utf8" },
    );
    assert.notEqual(create.status, 0);
    assert.match(create.stderr, /windowsBlockmap/);
  } finally {
    fs.rmSync(candidateDir, { recursive: true, force: true });
  }
});

test("stable candidates require byte-identical Alpha and Beta metadata aliases", () => {
  const goodDir = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-stable-candidate-"));
  const badDir = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-stable-candidate-bad-"));
  const script = path.join(repoRoot, "scripts", "desktop-release", "release-candidate.mjs");
  const metadata = "version: 0.1.0\n";

  const writeStableFixture = (candidateDir, betaMetadata) => {
    writePlatformFixture(
      candidateDir,
      "windows",
      {
        "HomeRail Setup 0.1.0.exe": "windows-installer",
        "HomeRail Setup 0.1.0.exe.blockmap": "windows-blockmap",
        "latest.yml": metadata,
        "alpha.yml": metadata,
        "beta.yml": betaMetadata,
      },
      "SHA256SUMS-windows.txt",
    );
    writePlatformFixture(
      candidateDir,
      "macos",
      {
        "HomeRail-0.1.0-arm64.dmg": "mac-dmg",
        "HomeRail-0.1.0-arm64.zip": "mac-zip",
        "latest-mac.yml": metadata,
        "alpha-mac.yml": metadata,
        "beta-mac.yml": betaMetadata,
      },
      "SHA256SUMS-macos.txt",
    );
  };
  const createArgs = (candidateDir) => [
    script,
    "create",
    "--candidate-dir",
    candidateDir,
    "--version",
    "0.1.0",
    "--tag",
    "v0.1.0",
    "--channel",
    "latest",
    "--source-commit",
    "a".repeat(40),
    "--desktop-commit",
    "b".repeat(40),
    "--run-id",
    "12346",
  ];

  try {
    writeStableFixture(goodDir, metadata);
    const good = spawnSync(process.execPath, createArgs(goodDir), { encoding: "utf8" });
    assert.equal(good.status, 0, good.stderr);
    const verified = spawnSync(
      process.execPath,
      [script, "verify", "--candidate-dir", goodDir],
      { encoding: "utf8" },
    );
    assert.equal(verified.status, 0, verified.stderr);

    writeStableFixture(badDir, `${metadata}stagingPercentage: 50\n`);
    const bad = spawnSync(process.execPath, createArgs(badDir), { encoding: "utf8" });
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /must be byte-identical/);
  } finally {
    fs.rmSync(goodDir, { recursive: true, force: true });
    fs.rmSync(badDir, { recursive: true, force: true });
  }
});

test("tracked release configuration contains no credentials or machine-local identity", () => {
  const tracked = [
    candidateWorkflow,
    publishWorkflow,
    releaseDocs,
    fs.readFileSync(
      path.join(repoRoot, "scripts", "desktop-release", "entitlements.mac.plist"),
      "utf8",
    ),
  ].join("\n");
  assert.doesNotMatch(tracked, /\b(?:10|192\.168|172\.(?:1[6-9]|2[0-9]|3[01]))\.[0-9]{1,3}\.[0-9]{1,3}\b/);
  assert.doesNotMatch(tracked, /\/(?:Users|home|vol[0-9]*)\//);
  assert.doesNotMatch(tracked, /@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  assert.doesNotMatch(
    tracked,
    /(?:BEGIN (?:PRIVATE KEY|CERTIFICATE)|WIN_CSC_LINK=['"][^$]|APPLE_API_KEY=['"][^$])/,
  );
});
