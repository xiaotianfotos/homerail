# Desktop prerelease updates (Alpha is current)

HomeRail uses one SemVer version across the repository. The current public
release train starts at package/release version `0.1.0-alpha.1`, followed by
`0.1.0-alpha.2` and so on. A same-Alpha repair may use a legal SemVer such as
`0.1.0-alpha.3.1`. Beta (`0.1.0-beta.1`) and Stable (`0.1.0`) are reserved
future stages; documenting them does not mean they are ready to publish.

The Git tag is the same version with a single `v` prefix, for example
`v0.1.0-alpha.1`. The package version and GitHub Release title omit `v`.
Prefixes such as `desktop-v` and `rust-v` are forbidden: electron-updater
6.8.9 rejects those tags as invalid SemVer while scanning the GitHub release
feed.

The manual workflow checks out the private `homerail_desktop` repository,
builds signed Windows x64 and macOS arm64 packages in parallel, and creates a
draft prerelease. It never publishes a release automatically.

## Update channels

The Desktop UI offers two persisted choices:

- **Stable** (default for a final installed version) uses `latest.yml` on
  Windows and `latest-mac.yml` on macOS. It never accepts a prerelease.
- **Early Access** (the migration default for an installed prerelease) follows
  Alpha, then Beta, then Stable without asking the user to opt in again. Alpha
  releases use `alpha.yml` / `alpha-mac.yml`; Beta releases use `beta.yml` /
  `beta-mac.yml`.

electron-updater changes the requested metadata name as a prerelease moves from
Alpha to Beta; a Beta install stays on Beta and never receives Alpha. When
Early Access reaches a final release, it keeps the saved preference so the next
Alpha can be discovered. A future Stable release must therefore upload
canonical `latest.yml` / `latest-mac.yml` plus byte-identical Alpha and Beta
compatibility metadata (`alpha.yml`, `beta.yml`, and their `-mac` forms)
produced from that same build. The private desktop script
`scripts/update-metadata.mjs` verifies every referenced artifact checksum and
creates only those Stable aliases.

Downgrades are always disabled. Switching an Alpha or Beta install to Stable
does not install an older final version; the UI explains that it will wait for
a newer Stable version.

GitHub draft releases are invisible to electron-updater. A signed draft becomes
available to installed applications only after a human publishes it. Alpha and
Beta releases must remain marked as prereleases when published.

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

## Build an Alpha draft

1. Open **Actions → Desktop Alpha/Beta Release → Run workflow**.
2. Select the HomeRail revision to package.
3. Enter `0.1.0-alpha.1` (or the next Alpha SemVer).
4. Enter a full `homerail_desktop` commit SHA. `main` is accepted for
   convenience, but a commit SHA is reproducible.
5. Approve the `desktop-beta-signing` environment deployment.
6. Confirm both signed builds and the draft-release job succeed.

The workflow derives tag `v0.1.0-alpha.1` and channel `alpha`; callers cannot
provide an arbitrary tag or metadata channel. It passes the channel to the
locked electron-builder, verifies `alpha.yml` and `alpha-mac.yml`, checks that
their SHA-512 values match artifacts from the same build, includes installers
and blockmaps in the checksum manifests, and uploads only the explicit asset
allowlist.

The result is a draft prerelease named `HomeRail Desktop 0.1.0-alpha.1`. Only
users with write access can see the draft, and no installed app can update from
it.

## Signed-install acceptance before publishing

Use signed installations on both operating systems. Do not claim these checks
from an unsigned local package or from metadata-only tests.

| Installed preference/version | Published releases | Expected result |
| --- | --- | --- |
| Stable / final | newer final | Downloads the final update |
| Stable / final | Alpha or Beta only | No update |
| Early Access / `0.1.0-alpha.1` | `0.1.0-alpha.2` | Downloads Alpha 2 |
| Early Access / latest Alpha | `0.1.0-beta.1` | Downloads Beta 1 |
| Early Access / Alpha or Beta | `0.1.0` | Downloads Stable |
| Early Access / `0.1.0` after that upgrade | next train Alpha | Still opted in and downloads it |

Also switch a prerelease install to Stable while no higher final version
exists. It must not downgrade, and Settings must show the waiting explanation.

On Windows, install the NSIS package, launch HomeRail, complete onboarding,
exercise “Restart to update,” and uninstall once. On macOS, install from the
DMG, confirm Gatekeeper acceptance, launch and complete onboarding, exercise
“Restart to update,” and quit/relaunch once. Publish the draft prerelease only
after both platforms pass. Publishing and the future full Stable release flow
are outside this workflow.
