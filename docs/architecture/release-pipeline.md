# Release pipeline

Pi Desktop ships from `.github/workflows/release.yml`. There is no release-a-machine
step: pushing an annotated `v*` tag builds Windows, Linux and macOS on GitHub-hosted
runners, uploads every installer and every `electron-updater` manifest into a **draft**
GitHub Release, and publishes that release only once all three platforms succeeded.

The repository is public, which is part of the design rather than an accident:

- standard GitHub-hosted runners — macOS included — are free in a public repository;
- Release assets download without a token, which is exactly what `electron-updater`
  needs (`src/main/electron-updater.ts` is the only module that reads the feed);
- the feed URL is derived from `package.json`'s repository and must stay equal to
  `PI_DESKTOP_RELEASES_URL` (`src/shared/updates.ts`), which
  `tests/packaging/release.test.ts` asserts.

Making the repository private again would break the second point (a private repo's
release assets return 404 to end users) and start drawing macOS minutes from the plan's
included compute allowance.

## Triggers

| Event                                               | Builds        | Publishes                                         |
| --------------------------------------------------- | ------------- | ------------------------------------------------- |
| `push` of a `v*` tag                                | yes           | yes, automatically, when all three jobs pass      |
| `workflow_dispatch` with `publish: false` (default) | yes (dry run) | no — artefacts are uploaded as workflow artifacts |
| `workflow_dispatch` with `publish: true`            | yes           | yes (the tag must already exist)                  |

`prepare` resolves the tag (dispatch input, or `v<package.json version>`), refuses a tag
push whose tag disagrees with `package.json`, and refuses a missing
`docs/releases/<tag>.md`. The same file becomes the release body, so it must be final
before the tag is pushed.

## Draft → publish

`electron-updater` cannot see a draft release, so the draft is what makes the feed
atomic: the first moment `latest*.yml` is readable, every installer it names is already
uploaded. A partially uploaded draft is invisible to end users; a half-uploaded _live_
release would break updates for everyone until it was fixed.

```text
prepare   gh release create <tag> --draft --verify-tag --notes-file docs/releases/v0.6.0.md
windows   build → verify → gh release upload *.exe *.blockmap latest.yml --clobber
linux     build → verify → gh release upload *.AppImage *.deb latest-linux*.yml --clobber
macos     build → verify → gh release upload *.dmg *.zip latest-mac.yml --clobber
publish   gh release edit <tag> --draft=false --latest
          then re-reads the feed anonymously and checks a ranged GET per installer
```

`needs: [prepare, windows, linux, macos]` on the publish job is the whole safety
property: a failed or cancelled platform means the release stays a draft.

## Per-platform build contract

Each job builds on its own OS and asserts the finished artefacts, not the build log.

| Platform | Runner                    | Artefacts                                                                            | Manifests                                    |
| -------- | ------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------- |
| Windows  | `windows-latest` (bash)   | `Pi-Desktop-<v>-win-x64-setup.exe`, `…-setup.exe.blockmap`, `…-win-x64-portable.exe` | `latest.yml`                                 |
| Linux    | `ubuntu-latest`           | `…-linux-x86_64-appimage.AppImage`, `…-linux-amd64-deb.deb`, and the `arm64` pair    | `latest-linux.yml`, `latest-linux-arm64.yml` |
| macOS    | `macos-latest` (arm64 M1) | `…-mac-arm64.dmg`, `…-mac-x64.dmg`, `…-mac-arm64.zip`, `…-mac-x64.zip`               | `latest-mac.yml`                             |

`${os}` renders as `win`/`linux`/`mac` and `${arch}` as `x64`, `x86_64`, `amd64` or
`arm64` depending on the target, which is why `scripts/release-assets.mjs` encodes the
literal names instead of globbing for extensions. It runs in every job and fails when an
artefact is missing or when a manifest names a file that is not there — the two failures
that look like success until an installed app tries to update.

Runtime fetching order matters in the Linux and macOS jobs: `runtime:fetch` writes
`resources/runtime/bin` for the **last** `--platform` it is given, and `runtime:verify`
executes that shim, so the foreign architecture is fetched first with `--skip-shims` and
the host architecture last.

### Windows

`npm run package:win` fetches the win32-x64 runtime, builds, regenerates the host shims,
runs `runtime:verify`, then produces NSIS + portable. The job asserts that
`release/win-unpacked/resources/runtime/node` holds **exactly** `win32-x64` (the
`afterPack` prune), that `app-update.yml` names the GitHub provider, and that
`build-info.json` reports `channel: "release"` and the expected version.

### Linux

`dpkg-deb -I` checks the control fields and `dpkg-deb -c` proves the package contains the
bundled runtime (outside the asar), exactly one `linux-*` runtime, the unpacked host
bundle and the `.desktop` entry. AppImages are checked for the ELF magic and a size
above 150 MB — a truncated AppImage is the classic packaging failure.

Linux remains **beta**: the `.deb`/AppImage are built and inspected on a real Ubuntu
host, but a real install and first session on a desktop are not part of CI.

### macOS

macOS is **beta** too, and for a firmer reason: no human has launched it.

The bundle is ad-hoc signed (`-c.mac.identity=-`, `CSC_IDENTITY_AUTO_DISCOVERY=false`)
because no Apple Developer identity exists. Ad-hoc is the minimum for Apple Silicon — an
unsigned arm64 bundle reports "damaged" once quarantined — but it is still a real
signature, so the job requires:

- `codesign --verify --deep --strict` to pass for **both** `.app` bundles;
- `spctl -a` to say `rejected` and never `damaged` (notarization is what would make it
  accepted; that needs a Developer ID);
- the packaged `Contents/Resources/runtime/bin/pi --version` to run under
  `env -i PATH=/usr/bin:/bin`, and the bundled
  `runtime/node/darwin-arm64/bin/node --version` — this is what proves the
  `app.asar.unpacked` paths survive packaging;
- `build-info.json` to report `channel: "release"` and `macSigning: "adhoc"`.

A 15-second launch of the packaged `.app` is recorded in the run summary with
`continue-on-error`, because a macOS runner may have no GUI session. It is evidence, not
a gate.

`latest-mac.yml` is a single file for both arches; the job prints it into the summary so a
dry run can confirm that both `-arm64.` and `-x64.` zips are listed before the tag is cut.

#### Why macOS updates are download-only

Squirrel.Mac validates a downloaded update against the running app's _designated
requirement_. An ad-hoc signature's requirement is cdhash-based and changes with every
build, so an in-app update can never install — it fails with
`Code signature … did not pass validation`.

Rather than offer a button that must fail, `resolveUpdateSupport` refuses the updater on
macOS unless `build-info.json` says `macSigning: "developer-id"` (one predicate,
`inAppUpdatesAllowed`, shared with the port construction in `src/main/index.ts`). The
Settings card then shows **Manual updates** and links to the Releases page, and
`describeUnsupported` explains where updates come from.

Restoring in-app macOS updates needs either the Apple Developer Program (Developer ID +
notarization, the only friction-free option) or a stable **self-signed** certificate whose
designated requirement stays constant across releases. Both are backlog items; neither
changes anything outside `release.yml`, the workflow secrets and `PI_MAC_SIGNING`.

## Dry run

```bash
gh workflow run release.yml --ref <branch> -f publish=false
```

Same builds, same assertions, no release. Each job uploads its installers and manifests
as a workflow artifact (`windows-<v>`, `linux-<v>`, `macos-<v>`), which is how a new
platform is validated before anything is published. Artifact storage is free on a public
repository; they still expire, so download what you need.

## Product site

The public site is `https://dieuluucanh.github.io/pi-desktop/`. It lives in
`site/` (Astro + Starlight, its own `package-lock.json`) and is deployed by
`.github/workflows/pages.yml` on a push to `main` and by `workflow_dispatch`.
There is deliberately no `release: published` trigger: the release workflow
publishes with the repository `GITHUB_TOKEN`, and GitHub suppresses workflow runs
for events generated by that token. The version bump and
`docs/releases/<tag>.md` are merged to `main` before the tag, so the `main`
deploy already carries the release content.

The site's installer buttons link directly at the versioned release assets
(`…/releases/download/v<version>/Pi-Desktop-<version>-<suffix>`), so they download
without JavaScript. A small client script then makes one anonymous request to the
public Releases API and rewrites the links to a newer published release when one
exists; if the request fails, the static links stay. The site is built from `main`
before the tag is pushed, so in the window between the deploy and the release
publish the newest version's links can briefly 404 for visitors without
JavaScript — the API rewrite and the GitHub Releases link cover the rest. Release
asset names are **not** renamed for the site — they are part of the updater
manifests and the release guard. The site build checks every internal link and
anchor against the GitHub Pages base path.

One-time setup: Settings → Pages → Source = **GitHub Actions**. The site build
regenerates docs from `docs/`; never edit generated content under
`site/src/content/docs/`.

## Cutting the next release

1. Bump `package.json` (`npm version <v> --no-git-tag-version`) and the lockfile.
2. Write `docs/releases/v<v>.md` — it becomes the release body. `tests/packaging/release.test.ts`
   requires `## Known limitations` and the phrases `Unsigned builds`, `macOS and Linux are
beta`, `Upstream` and `Verified structurally, not on a live machine`; update the guide,
   README, docs index, backlog and traceability with the same version.
3. Run the gates, merge to `main`, push.
4. Dry-run the workflow on the branch if anything in the pipeline or a platform changed.
5. `git tag -a v<v> -m "Pi Desktop v<v>" && git push origin v<v>`.
6. Watch the run: `prepare` creates the draft, three builds upload, `publish` flips it and
   verifies the feed anonymously. A failure after the tag is a **new patch release**, never
   a moved tag.
7. Install from the published URL on each platform you can reach and record what you did
   not verify.
8. Confirm the site shows the new version and its release-notes page, and that the primary
   download resolves to the new installer. If the site lags (for example a tag was cut from a
   commit that never reached `main`), run the Pages `workflow_dispatch` and investigate why.

## Failure modes this pipeline is built against

| Failure                                  | Guard                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------ |
| Tag does not match `package.json`        | `prepare` exits 1 before building                                        |
| Missing release notes                    | `prepare` exits 1 (the body would be empty)                              |
| One platform fails after others uploaded | the release stays a draft; nothing is served                             |
| Forgot a manifest                        | `scripts/release-assets.mjs` per job; the publish step re-reads all four |
| Manifest names an uploaded-soon file     | the asset guard checks the file exists locally, before upload            |
| Wrong runtime in a package               | `afterPack` prune + per-package runtime assertion                        |
| Broken mac signature                     | `codesign --verify` + the `damaged` check                                |
| Feed not actually public                 | anonymous `curl` in the publish job, no token                            |
| Two releases racing                      | `concurrency: release-<ref>`, `cancel-in-progress: false`                |
