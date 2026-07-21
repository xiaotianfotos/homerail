# Desktop Beta release

HomeRail Desktop Beta releases are built manually from the public `homerail`
repository. The workflow checks out the private `homerail_desktop` repository,
builds Windows x64 and macOS arm64 packages in parallel, and creates a draft
prerelease. It never publishes a release automatically.

## One-time GitHub setup

Create an environment named `desktop-beta-signing` in
`xiaotianfotos/homerail`. Add a required reviewer if the repository settings
support it, and leave self-review enabled when the repository owner is the only
reviewer.

Add these environment secrets:

| Secret | Value |
| --- | --- |
| `HOMERAIL_DESKTOP_READ_TOKEN` | Fine-grained token with read-only Contents access to `xiaotianfotos/homerail_desktop` only |
| `WIN_CSC_LINK` | Base64-encoded Windows code-signing PFX |
| `WIN_CSC_KEY_PASSWORD` | Password for the Windows PFX |
| `MAC_CSC_LINK` | Base64-encoded Developer ID Application P12 |
| `MAC_CSC_KEY_PASSWORD` | Password for the Mac P12 |
| `APPLE_API_KEY_P8` | Base64-encoded App Store Connect `.p8` key |
| `APPLE_API_KEY_ID` | App Store Connect key ID |
| `APPLE_API_ISSUER` | App Store Connect issuer ID |
| `APPLE_TEAM_ID` | Apple Developer team ID |

Keep all certificate passwords and private keys out of Git. The workflow
decodes the Apple API key into the ephemeral macOS runner and removes it after
the notarization attempt.

## Build a beta

1. Open **Actions → Desktop Beta Release → Run workflow**.
2. Select the HomeRail revision to package.
3. Enter a version such as `0.1.0-beta.1`.
4. Enter a `homerail_desktop` commit SHA. `main` is accepted for convenience,
   but a full commit SHA is recommended for a reproducible release.
5. Approve the `desktop-beta-signing` environment deployment.
6. Wait for both signed builds and the draft-release job.

The result is a draft prerelease named `HomeRail Desktop <version>`. Only users
with write access can see a draft release.

## Test before publishing

- Windows: install the public self-signed certificate on the test machine,
  install the NSIS package, launch HomeRail, complete onboarding, and uninstall
  it once.
- macOS: mount the DMG, install HomeRail, confirm Gatekeeper accepts it, launch
  it, complete onboarding, and quit/relaunch it once.
- Install the next draft beta over the first one to verify the upgrade path and
  persisted HomeRail data.

After both platforms pass, edit the draft release in GitHub and publish it as a
prerelease. Do not publish a beta that has only been tested on one platform.
