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
const buildGateWorkflow = fs
  .readFileSync(
    path.join(repoRoot, ".github", "workflows", "desktop-build-gate.yml"),
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
const macEntitlements = fs.readFileSync(
  path.join(repoRoot, "scripts", "desktop-release", "entitlements.mac.plist"),
  "utf8",
);
const currentPublicVersion = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
).version;

function workflowStep(workflow, name) {
  const marker = `      - name: ${name}\n`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `missing workflow step: ${name}`);
  const next = workflow.indexOf("\n      - name: ", start + marker.length);
  return workflow.slice(start, next === -1 ? undefined : next);
}

function candidateStep(name) {
  return workflowStep(candidateWorkflow, name);
}

function buildGateStep(name) {
  return workflowStep(buildGateWorkflow, name);
}

function publishStep(name) {
  return workflowStep(publishWorkflow, name);
}

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

test("public Desktop build gate owns unsigned pre-merge hosted builds", () => {
  assert.match(buildGateWorkflow, /workflow_dispatch:/);
  assert.doesNotMatch(buildGateWorkflow, /^\s{2}(?:push|pull_request|schedule):/m);
  assert.match(
    buildGateWorkflow,
    /github\.actor == 'xiaotianfotos' && github\.ref == 'refs\/heads\/main'/,
  );
  assert.match(buildGateWorkflow, /desktop_sha must be a full lowercase 40-character commit SHA/);
  assert.match(buildGateWorkflow, /repository: xiaotianfotos\/homerail_desktop/);
  assert.match(buildGateWorkflow, /ref: \$\{\{ inputs\.desktop_sha \}\}/);
  assert.match(buildGateWorkflow, /secrets\.HOMERAIL_DESKTOP_READ_TOKEN/);
  assert.doesNotMatch(buildGateWorkflow, /merge-base --is-ancestor/);
  assert.doesNotMatch(buildGateWorkflow, /desktop-beta-signing|MAC_CSC|APPLE_API|gh release|git tag/);
  assert.match(buildGateWorkflow, /os: windows-latest/);
  assert.match(buildGateWorkflow, /os: macos-15/);
  assert.match(buildGateWorkflow, /HOMERAIL_REQUIRE_DOCKER_CONTEXT_TEST: "1"/);
  assert.match(buildGateWorkflow, /--config\.win\.signExecutable=false/);
  assert.match(buildGateWorkflow, /CSC_IDENTITY_AUTO_DISCOVERY: "false"/);
  assert.match(buildGateWorkflow, /retention-days: 30/);
  assert.match(buildGateWorkflow, /These are unsigned pre-merge artifacts/);

  const exactCommit = buildGateStep("Verify exact Desktop commit");
  assert.match(exactCommit, /git -C desktop rev-parse HEAD/);
  const windowsCodex = buildGateStep("Smoke-test packaged Windows Codex runtime");
  assert.match(windowsCodex, /windows-codex-runtime-smoke\.mjs/);
});

test("candidate uses protected release environment without Deployment records", () => {
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

test("candidate keeps Windows unsigned while signing and notarizing macOS", () => {
  for (const secret of [
    "MAC_CSC_LINK",
    "MAC_CSC_KEY_PASSWORD",
    "APPLE_API_KEY_P8",
    "APPLE_API_KEY_ID",
    "APPLE_API_ISSUER",
    "APPLE_TEAM_ID",
  ]) {
    assert.match(candidateWorkflow, new RegExp(`secrets\\.${secret}`));
  }
  assert.doesNotMatch(candidateWorkflow, /secrets\.WIN_CSC_(?:LINK|KEY_PASSWORD)/);

  const prepareGuard = candidateStep("Allow Alpha and Beta release channels");
  assert.match(prepareGuard, /\[\[ "\$RELEASE_CHANNEL" == "latest" \]\]/);
  assert.match(prepareGuard, /supports Alpha and Beta/);

  const windowsBuild = candidateStep("Build unsigned Windows installer");
  assert.match(windowsBuild, /if: runner\.os == 'Windows'/);
  assert.match(windowsBuild, /--config\.win\.signExecutable=false/);
  assert.match(windowsBuild, /--config\.win\.verifyUpdateCodeSignature=false/);
  assert.match(windowsBuild, /--config\.publish\.channel=/);
  assert.doesNotMatch(windowsBuild, /forceCodeSigning|WIN_CSC/);
  assert.equal(
    (candidateWorkflow.match(/--config\.win\.signExecutable=false/g) ?? []).length,
    1,
  );
  assert.equal(
    (
      candidateWorkflow.match(/--config\.win\.verifyUpdateCodeSignature=false/g)
      ?? []
    ).length,
    1,
  );

  const macBuild = candidateStep("Build, sign, and notarize macOS app");
  assert.match(macBuild, /--config\.forceCodeSigning=true/);
  assert.match(macBuild, /--config\.mac\.notarize=true/);
  assert.match(macBuild, /--config\.mac\.entitlements=/);
  assert.match(macBuild, /--config\.mac\.entitlementsInherit=/);
  assert.equal((candidateWorkflow.match(/--config\.forceCodeSigning=true/g) ?? []).length, 1);
  assert.equal((candidateWorkflow.match(/--config\.publish\.channel=/g) ?? []).length, 2);
  assert.match(candidateWorkflow, /verify:update-metadata/);
  assert.match(candidateWorkflow, /metadata_release_channel=stable/);
  assert.match(candidateWorkflow, /elseif \(\$env:RELEASE_CHANNEL -eq 'beta'\)/);
  assert.match(candidateWorkflow, /@\('beta\.yml', 'alpha\.yml'\)/);
  assert.match(candidateWorkflow, /elif \[\[ "\$RELEASE_CHANNEL" == "beta" \]\]/);
  assert.match(candidateWorkflow, /metadata_names=\("beta-mac\.yml" "alpha-mac\.yml"\)/);
  assert.match(candidateWorkflow, /'latest\.yml', 'alpha\.yml', 'beta\.yml'/);
  assert.match(candidateWorkflow, /"latest-mac\.yml" "alpha-mac\.yml" "beta-mac\.yml"/);
  assert.match(candidateWorkflow, /asset_name="\$\{asset#\.\/\}"/);
  const macVerification = candidateStep("Verify macOS package, signature, and notarization");
  assert.match(macVerification, /codesign --verify --deep --strict/);
  assert.match(macVerification, /HomeRail Helper\*\.app/);
  assert.match(macVerification, /Expected four signed HomeRail Helper apps/);
  assert.match(macVerification, /codesign -d --entitlements -/);
  assert.match(macVerification, /com\\\.apple\\\.security\\\.device\\\.audio-input/);
  assert.match(macVerification, /Missing enabled microphone entitlement/);
  assert.match(macVerification, /xcrun stapler validate/);
  assert.match(macVerification, /spctl --assess/);
  const macUpload = candidateStep("Upload macOS candidate assets");
  for (const metadata of ["latest-mac.yml", "alpha-mac.yml", "beta-mac.yml"]) {
    assert.match(macUpload, new RegExp(`desktop/dist-electron/${metadata}`));
  }
  assert.doesNotMatch(macUpload, /desktop\/dist-electron\/\*\.yml/);
  assert.match(candidateWorkflow, /release-candidate\.mjs create/);
});

test("macOS release entitlements enable microphone input for the app and helpers", () => {
  assert.match(
    macEntitlements,
    /<key>com\.apple\.security\.device\.audio-input<\/key>\s*<true\/>/,
  );
});

test("Windows candidate runs Node 24 CI before unsigned packaging and installation smoke", () => {
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

  const packageVerificationStep = candidateStep("Verify Windows package and unsigned policy");
  assert.match(packageVerificationStep, /npm --prefix desktop run verify:package/);
  assert.match(packageVerificationStep, /if \(\$LASTEXITCODE -ne 0\)/);
  assert.match(packageVerificationStep, /\$installers\.Count -ne 1/);
  assert.match(
    packageVerificationStep,
    /Get-AuthenticodeSignature -LiteralPath \$signedFile/,
  );
  assert.ok(
    packageVerificationStep.includes("Authenticode status for ${signedFile}:"),
    "PowerShell variables followed by a colon must use delimited interpolation",
  );
  assert.match(packageVerificationStep, /\$signature\.StatusMessage/);
  assert.match(packageVerificationStep, /if \(\$signature\.Status -ne 'NotSigned'\)/);
  assert.doesNotMatch(packageVerificationStep, /\$signature\.Status -ne 'Valid'/);
  assert.match(
    packageVerificationStep,
    /if \(\$null -ne \$signature\.SignerCertificate\)/,
  );
  assert.match(
    packageVerificationStep,
    /desktop\/dist-electron\/win-unpacked\/resources\/app-update\.yml/,
  );
  assert.match(
    packageVerificationStep,
    /\[System\.IO\.File\]::ReadAllText\([\s\S]*Resolve-Path[\s\S]*\.Path/,
  );
  assert.ok(
    packageVerificationStep.includes(
      "$hasPublisherName = $appUpdateYaml -match '(?m)^\\s*publisherName\\s*:'",
    ),
  );
  assert.match(packageVerificationStep, /must not contain publisherName/);
  assert.doesNotMatch(packageVerificationStep, /must contain publisherName/);
  for (const expectedUpdateTarget of [
    "provider: github",
    "owner: xiaotianfotos",
    "repo: homerail",
  ]) {
    assert.match(packageVerificationStep, new RegExp(expectedUpdateTarget));
  }
  assert.match(packageVerificationStep, /"channel: \$env:RELEASE_CHANNEL"/);
  assert.match(packageVerificationStep, /\[regex\]::Escape\(\$expectedLine\)/);
  assert.match(packageVerificationStep, /\$appUpdateYaml -notmatch \$pattern/);

  const checksumStep = candidateStep("Write Windows checksums");
  assert.match(checksumStep, /Get-FileHash -Algorithm SHA256/);
  assert.match(checksumStep, /SHA256SUMS-windows\.txt/);
  assert.match(checksumStep, /\$_\.Name -match '\\\.\(exe\|blockmap\)\$'/);
  assert.match(checksumStep, /"\$env:RELEASE_CHANNEL\.yml"/);

  const installSmokeStep = candidateStep("Smoke-test silent Windows installation");
  assert.match(installSmokeStep, /-ArgumentList @\('\/S', "\/D=\$installRoot"\)/);
  assert.match(installSmokeStep, /--user-data-dir=\$electronUserData/);
  assert.match(installSmokeStep, /Installed CLI version .* does not match/);
  assert.match(installSmokeStep, /Start-Sleep -Seconds 12/);
  assert.match(installSmokeStep, /Silent NSIS uninstall left HomeRail\.exe installed/);

  const uploadStep = candidateStep("Upload Windows candidate assets");
  assert.match(uploadStep, /desktop\/dist-electron\/\*\.exe/);
  assert.match(uploadStep, /desktop\/dist-electron\/\*\.blockmap/);
  for (const metadata of ["latest.yml", "alpha.yml", "beta.yml"]) {
    assert.match(uploadStep, new RegExp(`desktop/dist-electron/${metadata}`));
  }
  assert.doesNotMatch(uploadStep, /desktop\/dist-electron\/\*\.yml/);
  assert.match(uploadStep, /desktop\/dist-electron\/SHA256SUMS-windows\.txt/);
  assert.match(uploadStep, /if-no-files-found: error/);

  const install = candidateWorkflow.indexOf("Install locked dependencies");
  const publicCi = candidateWorkflow.indexOf("Run public Windows Node 24 CI");
  const publicCliVersion = candidateWorkflow.indexOf("Verify public Windows CLI release version");
  const desktopCi = candidateWorkflow.indexOf("Run Desktop Windows CI");
  const windowsBuild = candidateWorkflow.indexOf("Build unsigned Windows installer");
  const metadata = candidateWorkflow.indexOf("Prepare and verify Windows update metadata");
  const packageVerification = candidateWorkflow.indexOf("Verify Windows package and unsigned policy");
  const checksums = candidateWorkflow.indexOf("Write Windows checksums");
  const installSmoke = candidateWorkflow.indexOf("Smoke-test silent Windows installation");
  const upload = candidateWorkflow.indexOf("Upload Windows candidate assets");
  for (const index of [
    install,
    publicCi,
    publicCliVersion,
    desktopCi,
    windowsBuild,
    metadata,
    packageVerification,
    checksums,
    installSmoke,
    upload,
  ]) {
    assert.notEqual(index, -1);
  }
  assert.ok(
    install < publicCi
      && publicCi < publicCliVersion
      && publicCliVersion < desktopCi
      && desktopCi < windowsBuild
      && windowsBuild < metadata
      && metadata < packageVerification
      && packageVerification < checksums
      && checksums < installSmoke
      && installSmoke < upload,
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

  const candidateVerification = publishStep(
    "Verify candidate identity, assets, and checksums",
  );
  const manifestRead = candidateVerification.indexOf(
    'JSON.parse(fs.readFileSync("candidate/release-manifest.json", "utf8"))',
  );
  const prereleaseGuard = candidateVerification.indexOf(
    'if (manifest.channel !== "beta")',
  );
  const tagCheck = publishWorkflow.indexOf(
    "Refuse to replace an existing tag or release",
  );
  const tagCreation = publishWorkflow.indexOf("Create immutable annotated tag");
  const releaseCreation = publishWorkflow.indexOf(
    "Publish exact candidate as a GitHub release",
  );
  assert.match(
    candidateVerification,
    /only Beta candidates may be published; Alpha is retired/,
  );
  for (const index of [
    manifestRead,
    prereleaseGuard,
    tagCheck,
    tagCreation,
    releaseCreation,
  ]) {
    assert.notEqual(index, -1);
  }
  assert.ok(
    manifestRead < prereleaseGuard
      && publishWorkflow.indexOf("Verify candidate identity, assets, and checksums")
        < tagCheck
      && tagCheck < tagCreation
      && tagCreation < releaseCreation,
  );
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
  assert.match(releaseDocs, /byte-identical Alpha and Beta compatibility\s+metadata/);
  assert.match(releaseDocs, /Beta.*byte-identical.*Alpha.*compatibility\s+alias/is);
  assert.match(releaseDocs, /Alpha publishing is retired/i);
  assert.match(releaseDocs, /complete public Node 24 CI suite/);
  assert.match(releaseDocs, /does not replace.*real Windows machine/s);
  assert.match(releaseDocs, /SmartScreen/);
  assert.match(releaseDocs, /Unknown Publisher/);
  assert.match(releaseDocs, /GitHub Release[\s\S]*SHA-512/);
  assert.match(releaseDocs, /weaker than trusted Authenticode/i);
  assert.match(releaseDocs, /Beta is the active test channel/i);
  assert.match(releaseDocs, /Windows Beta is explicitly unsigned/i);
  assert.match(releaseDocs, /Authenticode status is `NotSigned`/i);
  assert.match(releaseDocs, /SignPath Foundation/);
  assert.match(releaseDocs, /not been applied for or\s+approved/i);
  assert.match(
    releaseDocs,
    /first update from an unsigned build to a future signed\s+installer[\s\S]*does not verify that installer with Authenticode/i,
  );
  assert.match(
    releaseDocs,
    /signed\s+version is installed[\s\S]*app-update\.yml[\s\S]*publisherName/i,
  );
  assert.match(
    releaseDocs,
    /Windows candidate\s+electron-builder command/i,
  );
  assert.doesNotMatch(releaseDocs, /WIN_CSC_LINK|WIN_CSC_KEY_PASSWORD/);
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

    const releaseNotes = fs.readFileSync(
      path.join(candidateDir, "release-notes.md"),
      "utf8",
    );
    assert.match(releaseNotes, /Windows: explicitly unsigned Alpha installer/);
    assert.match(releaseNotes, /macOS: Developer ID signed and Apple-notarized/);
    assert.match(releaseNotes, /platform-specific release gates/);
    assert.match(
      releaseNotes,
      /unstable build intended only for automatic upgrade testing/,
    );
    assert.match(releaseNotes, /Do not install it for general use/);
    assert.doesNotMatch(releaseNotes, /This is a signed HomeRail Desktop/);
    assert.doesNotMatch(
      releaseNotes,
      /passed build-time signature, notarization, package/,
    );

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

test("Beta candidates require byte-identical Alpha compatibility aliases", () => {
  const goodDir = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-beta-candidate-"));
  const badDir = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-beta-candidate-bad-"));
  const script = path.join(repoRoot, "scripts", "desktop-release", "release-candidate.mjs");
  const metadata = "version: 0.1.0-beta.1\n";

  const writeBetaFixture = (candidateDir, alphaMacMetadata) => {
    writePlatformFixture(
      candidateDir,
      "windows",
      {
        "HomeRail Setup 0.1.0-beta.1.exe": "windows-installer",
        "HomeRail Setup 0.1.0-beta.1.exe.blockmap": "windows-blockmap",
        "beta.yml": metadata,
        "alpha.yml": metadata,
      },
      "SHA256SUMS-windows.txt",
    );
    writePlatformFixture(
      candidateDir,
      "macos",
      {
        "HomeRail-0.1.0-beta.1-arm64.dmg": "mac-dmg",
        "HomeRail-0.1.0-beta.1-arm64.zip": "mac-zip",
        "beta-mac.yml": metadata,
        "alpha-mac.yml": alphaMacMetadata,
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
    "0.1.0-beta.1",
    "--tag",
    "v0.1.0-beta.1",
    "--channel",
    "beta",
    "--source-commit",
    "a".repeat(40),
    "--desktop-commit",
    "b".repeat(40),
    "--run-id",
    "12351",
  ];

  try {
    writeBetaFixture(goodDir, metadata);
    const good = spawnSync(process.execPath, createArgs(goodDir), { encoding: "utf8" });
    assert.equal(good.status, 0, good.stderr);
    const releaseNotes = fs.readFileSync(
      path.join(goodDir, "release-notes.md"),
      "utf8",
    );
    assert.match(
      releaseNotes,
      /Windows: explicitly unsigned Beta prerelease installer/,
    );
    assert.doesNotMatch(releaseNotes, /trusted Authenticode signing is required/);

    writeBetaFixture(badDir, "version: 0.1.0-beta.1\nbridge: stale\n");
    const bad = spawnSync(process.execPath, createArgs(badDir), { encoding: "utf8" });
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /must be byte-identical/);
  } finally {
    fs.rmSync(goodDir, { recursive: true, force: true });
    fs.rmSync(badDir, { recursive: true, force: true });
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
