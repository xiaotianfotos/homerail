# Desktop release train

HomeRail is entering its Beta release channel. The release train uses one SemVer
version across the public runtime packages and the private Desktop shell:

```text
0.1.0-alpha.1
0.1.0-alpha.2
0.1.0-alpha.3.1
0.1.0-beta.1
0.1.0
```

Alpha is a retired legacy feed retained only as an upgrade bridge for installed
Alpha clients. Alpha publishing is retired, Beta is the active test channel,
and Stable remains reserved for later quality gates. Git tags use the updater-compatible form
`v0.1.0-alpha.1`; component prefixes such as `desktop-v` are not allowed.
When npm publication is enabled, the matching dist-tags are `alpha`, `beta`,
and `latest`. These Desktop workflows do not publish npm packages.

The release process intentionally separates four milestones:

1. **Build gate**: the public repository checks out an exact unmerged private
   Desktop commit and produces unsigned Windows/macOS artifacts for automated
   packaging validation. These artifacts are not a release.
2. **Candidate**: platform-policy-verified artifacts exist privately as one
   immutable GitHub Actions artifact.
3. **Technical publish**: the exact candidate receives an annotated Git tag and
   a public GitHub prerelease, making it visible to `electron-updater`.
4. **Announcement**: installed-update testing passed and the release is ready
   to recommend to the community.

A GitHub draft release is not an update-testing surface because
`electron-updater` cannot see drafts.

## One-time GitHub setup

Keep the existing `desktop-beta-signing` environment until signing credentials
are migrated deliberately. Configure it with required reviewers when the
repository plan supports the desired review policy.

Add these environment secrets:

| Secret | Value |
| --- | --- |
| `HOMERAIL_DESKTOP_READ_TOKEN` | Fine-grained token with read-only Contents access to `xiaotianfotos/homerail_desktop` only |
| `MAC_CSC_LINK` | Base64-encoded Developer ID Application P12 |
| `MAC_CSC_KEY_PASSWORD` | Password for the Mac P12 |
| `APPLE_API_KEY_P8` | Base64-encoded App Store Connect `.p8` key |
| `APPLE_API_KEY_ID` | App Store Connect key ID |
| `APPLE_API_ISSUER` | App Store Connect issuer ID |
| `APPLE_TEAM_ID` | Apple Developer team ID |

Create a second environment named `desktop-release-publishing`. It needs no
secrets. Protect it with the maintainer approval policy used for public
releases.

Both workflow environments set `deployment: false`. They retain environment
secrets and approvals without creating public Deployment records for signing or
release administration.

The Candidate workflow keeps Windows packages explicitly unsigned for both the
historical Alpha channel and the active Beta channel. It requires both the NSIS
installer and packaged executable to report `NotSigned` with no signer
certificate. macOS always requires Developer ID signing and Apple notarization.

Keep all certificate passwords, private keys, and repository tokens out of Git.
The candidate workflow writes the Apple API key only to the ephemeral macOS
runner and removes it after the notarization attempt.

## Prepare a unified release version

Version changes are code changes and must be reviewed before building:

1. Update every public package and package lock to the same version.
2. Update `homerail_desktop/package.json` and its lock to the same version.
3. Push the private Desktop branch and record its full 40-character commit SHA.
4. For Alpha, run the unsigned public **Desktop Build Gate** against that exact
   unmerged SHA. For Beta, run local CI and merge before using the protected
   Candidate environment.
5. Merge the Desktop and public version changes.
6. Run the immutable Candidate workflow and test its platform artifacts on the
   real Windows and macOS test machines.

The workflows never rewrite package versions while building. They fail if the
requested version differs from any public or Desktop package manifest, or if the
pinned checkout differs from the requested SHA. The Build Gate deliberately
accepts an unmerged private commit; the Candidate additionally requires that
commit to be merged to `homerail_desktop/main`.

## Build an unsigned pre-merge package gate

Open **Actions → Desktop Build Gate → Run workflow** on public `homerail/main`.
Enter the unified Alpha version and the full private Desktop branch SHA.

The public workflow uses standard GitHub-hosted Windows, macOS, and Ubuntu
runners. It checks out only that private commit with the read-only Desktop
token, runs public and Desktop CI, exercises Docker's real context matcher,
builds explicitly unsigned Windows and macOS packages, verifies package/update
metadata, records checksums and size reports, and uploads separate 30-day
artifacts. It creates no tag, Release, signing operation, or Deployment.

Do not run equivalent hosted package jobs in the private Desktop repository.
This keeps the authoritative build and its Actions usage in the public
repository. Local packages are preflight evidence only and must not be treated
as authoritative build-gate artifacts.

Building does not authorize human testing. Wait for the maintainer's explicit
approval before handing these artifacts to the Windows or macOS test machines.

For the first public Alpha, use:

```text
version: 0.1.0-alpha.1
tag created later: v0.1.0-alpha.1
update metadata: alpha.yml and alpha-mac.yml
```

## Build an immutable candidate

Open **Actions → Desktop Release Candidate → Run workflow** on `main`.

Enter:

- the unified version, such as `0.1.0-beta.1`;
- the full `homerail_desktop` commit SHA.

The workflow:

1. verifies the owner, `main` branch, version syntax, and unified package
   versions;
2. checks out the private Desktop source by full commit SHA;
3. builds Windows x64 and macOS arm64 on isolated hosted runners;
4. applies the channel policy: Windows is explicitly unsigned, while macOS is
   Developer ID signed and Apple-notarized;
5. asks the pinned Desktop release tooling to prepare and verify channel-specific
   metadata against the packaged files;
6. creates platform checksums and a combined release manifest;
7. uploads one `desktop-release-candidate` Actions artifact for 30 days.

Historical Alpha candidates emit `alpha.yml` / `alpha-mac.yml`. Beta emits
canonical `beta.yml` / `beta-mac.yml` plus a byte-identical Alpha compatibility
alias from the same build. That one-way bridge lets already-installed Alpha
clients discover Beta without publishing another Alpha version. New Desktop
clients always map Early Access to the Beta feed. Stable emits canonical
`latest.yml` / `latest-mac.yml` plus byte-identical Alpha and Beta compatibility
metadata from the same build, after the separate Stable gate is enabled. Every
emitted metadata file is covered by both the platform checksum list and the
combined candidate manifest.

### Windows unsigned policy

Windows Alpha and Beta installers are explicitly unsigned. The Candidate
workflow passes `win.signExecutable=false` and
`win.verifyUpdateCodeSignature=false` on the Windows candidate
electron-builder command. It does not disable updater signature verification
globally in Desktop production code. The unsigned pre-merge Build Gate remains
Alpha-only.

The Windows gate requires exactly one NSIS installer, verifies its
Authenticode status is `NotSigned` with no signer certificate, and rejects a
packaged `app-update.yml` containing `publisherName`. Users should expect
Windows SmartScreen and an **Unknown Publisher** warning. Update integrity
currently depends on delivery from the GitHub Release and electron-updater's
SHA-512 metadata check, supplemented by the candidate SHA-256 manifests. That
does not authenticate a publisher and is weaker than trusted Authenticode.
Windows Beta is explicitly unsigned under the current release policy.

Omitting `publisherName` also preserves a migration path to a future
trusted-signed Windows build. An unsigned Alpha or Beta can discover and install
that signed build, but the first update from an unsigned build to a future signed
installer does not verify that installer with Authenticode; the old client's
updater configuration still relies on GitHub and SHA-512 for that hop. After the
signed version is installed, its own `app-update.yml` can restore `publisherName`
and signature verification for subsequent updates.

Windows Beta rejects a candidate unless the Authenticode status is `NotSigned`
for both the installer and packaged `HomeRail.exe`. Its packaged
`app-update.yml` must omit `publisherName` and target the `beta` channel.

[SignPath Foundation](https://signpath.org/) is a possible no-cost signing path
for qualifying open-source projects. HomeRail has not been applied for or
approved, so it is a future option rather than a current release capability.

The candidate does not create a Git tag or GitHub Release.

The hosted Windows candidate runs the complete public Node 24 CI suite and the
private Desktop CI suite before packaging. After signing-policy and static
package verification, it uses an isolated temporary profile to silently install
the NSIS package, execute the packaged CLI and verify its release version, keep
the Desktop process alive for a bounded startup smoke, and silently uninstall
it.
This non-interactive runner smoke does not prove that a visible GUI rendered,
that onboarding works, or that an installed update preserves real user data. It
does not replace the following acceptance checks on a real Windows machine.

After the hosted-runner gates pass, download the candidate from the workflow
run and perform direct-install checks:

- Windows Beta: acknowledge the expected SmartScreen / Unknown Publisher
  warning, then install, launch HomeRail, complete onboarding, restart, and
  uninstall once.
- macOS: mount the DMG, install HomeRail, confirm Gatekeeper accepts it, launch,
  complete onboarding, quit, and relaunch.
- Both: verify the packaged CLI, Manager/Node/Worker startup, settings
  persistence, Realtime Voice basics, and expected app version.

Reject a candidate rather than publishing it if either platform fails. A
rejected candidate has no tag to clean up.

Do not rerun individual jobs from a failed Candidate run. Dispatch a new Candidate
run so its immutable platform artifacts and final candidate all share one clean
run identity.

## Publish the exact candidate

After direct-install checks pass, open
**Actions → Desktop Release Publish → Run workflow** on `main`.

Enter the candidate workflow run ID and the same version. The protected publish
job:

1. proves the source run was a successful main-branch Candidate workflow;
2. downloads `desktop-release-candidate` from that run;
3. revalidates its identity, asset boundary, platform checksums, manifest, and
   global checksums;
4. refuses to replace an existing tag or release;
5. creates an annotated `v<version>` tag at the candidate's public source
   commit;
6. creates a GitHub prerelease for the exact Beta candidate without
   rebuilding.

The Publish workflow accepts only Beta manifests before tag and release lookup
or creation. Alpha publishing is retired; the Alpha-named files attached to a
Beta Release are compatibility metadata pointing to the same immutable Beta
assets, not a new Alpha release. Stable publishing remains blocked until its
policy is deliberately enabled.

This is the point at which the tag is created. Do not create the version tag
when merging code or starting a candidate build.

If tag creation succeeds but GitHub Release creation fails, stop and inspect the
partial publish. Never move or delete the tag merely to rerun the workflow.

## Alpha.1 to Alpha.2 installed-update test

The first two Alpha releases establish the update baseline:

1. Build and direct-install-test `0.1.0-alpha.1`.
2. Technically publish Alpha.1 without a broad community announcement.
3. Keep Alpha.1 installed on both test platforms with representative data.
4. Build and direct-install-test `0.1.0-alpha.2`.
5. Technically publish Alpha.2.
6. Confirm the Alpha.1 installations discover, download, and install Alpha.2.
7. Verify the version, expected Windows unsigned status, macOS signature and
   notarization, services, onboarding state, settings, data, CLI, and Realtime
   Voice after the update.
8. Announce Alpha.2 only after both platforms pass.

Technical publish is necessarily public because the GitHub update provider
cannot serve draft releases. Before HomeRail has a larger Early Access cohort,
keep the first technical Alpha publishes unannounced and tightly observed.

If Alpha.2 fails installed-update testing, do not replace its assets and do not
move its tag. Fix forward with `0.1.0-alpha.3`.

## Release gates

Create the version tag only when all of these are true:

- the updater and release workflow changes are merged to `main`;
- the matching private Desktop change is merged and pinned by full SHA;
- that Desktop commit contains the tested `verify:update-metadata` release tool;
- all public and private package versions match;
- required CI is green in both repositories;
- the Candidate run succeeded for Windows and macOS;
- the exact Candidate artifact passed direct-install checks on both platforms;
- release notes and the source commits in `release-manifest.json` were reviewed;
- the publishing environment approval is intentional.

Beta additionally requires explicit acceptance of unsigned Windows
distribution, a reliable Alpha upgrade history, stable configuration/data
migrations, no known data-loss or security issue, and a substantially frozen
core feature set. Stable still requires trusted Windows signing and is not part
of the current release plan.
