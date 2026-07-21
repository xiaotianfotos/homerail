import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflow = fs.readFileSync(
  path.join(repoRoot, ".github", "workflows", "desktop-beta-release.yml"),
  "utf8",
);

test("desktop beta release is manual, owner-only, and draft-only", () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^\s{2}(?:push|pull_request|schedule):/m);
  assert.match(workflow, /if: github\.actor == 'xiaotianfotos'/);
  assert.match(workflow, /environment: desktop-beta-signing/);
  assert.match(workflow, /--draft/);
  assert.match(workflow, /--prerelease/);
  assert.doesNotMatch(workflow, /--publish always/);
  assert.match(workflow, /cancel-in-progress: false/);
});

test("desktop beta release uses isolated hosted builders and a read-only private checkout", () => {
  assert.match(workflow, /os: windows-latest/);
  assert.match(workflow, /os: macos-15/);
  assert.match(workflow, /repository: xiaotianfotos\/homerail_desktop/);
  assert.match(workflow, /token: \$\{\{ secrets\.HOMERAIL_DESKTOP_READ_TOKEN \}\}/);
  assert.equal((workflow.match(/persist-credentials: false/g) ?? []).length, 2);
  assert.doesNotMatch(workflow, /runs-on:.*self-hosted/);
  assert.match(workflow, /HOMERAIL_SOURCE_DIR: \$\{\{ github\.workspace \}\}\/homerail-source/);
});

test("both packages must be signed and macOS must be notarized", () => {
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
    assert.match(workflow, new RegExp(`secrets\\.${secret}`));
  }
  assert.equal((workflow.match(/--config\.forceCodeSigning=true/g) ?? []).length, 2);
  assert.match(workflow, /--config\.mac\.notarize=true/);
  assert.match(workflow, /openssl base64 -d -A -out "\$key_path"/);
  assert.match(workflow, /printf 'APPLE_API_KEY=%s\\n' "\$key_path" >> "\$GITHUB_ENV"/);
  assert.match(workflow, /Remove Apple notarization key/);
  assert.match(workflow, /Get-AuthenticodeSignature/);
  assert.match(workflow, /codesign --verify --deep --strict/);
  assert.match(workflow, /xcrun stapler validate/);
  assert.match(workflow, /spctl --assess/);
});

test("release artifacts cannot include signing credentials or source archives", () => {
  assert.match(workflow, /Validate release asset boundary/);
  assert.match(workflow, /\*\.exe\|\*\.dmg\|\*\.zip\|\*\.blockmap/);
  assert.doesNotMatch(workflow, /desktop\/dist-electron\/.*\.(?:p12|pfx|pem|key)/i);
  assert.doesNotMatch(workflow, /release-assets\/.*\.(?:p12|pfx|pem|key)/i);
  assert.match(workflow, /permissions:\n\s+contents: write/);
});

test("macOS entitlements support Electron under hardened runtime", () => {
  const entitlements = fs.readFileSync(
    path.join(repoRoot, "scripts", "desktop-release", "entitlements.mac.plist"),
    "utf8",
  );
  assert.match(entitlements, /com\.apple\.security\.cs\.allow-jit/);
  assert.match(entitlements, /com\.apple\.security\.cs\.allow-unsigned-executable-memory/);
  assert.match(entitlements, /com\.apple\.security\.cs\.disable-library-validation/);
  assert.match(workflow, /entitlements\.mac\.plist/);
});

test("tracked release configuration contains no machine-local identity", () => {
  const tracked = [
    workflow,
    fs.readFileSync(
      path.join(repoRoot, "scripts", "desktop-release", "entitlements.mac.plist"),
      "utf8",
    ),
    fs.readFileSync(path.join(repoRoot, "docs", "desktop-beta-release.md"), "utf8"),
  ].join("\n");
  assert.doesNotMatch(tracked, /\b(?:10|192\.168|172\.(?:1[6-9]|2[0-9]|3[01]))\.[0-9]{1,3}\.[0-9]{1,3}\b/);
  assert.doesNotMatch(tracked, /\/(?:Users|home|vol[0-9]*)\//);
  assert.doesNotMatch(tracked, /@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
});
