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
prepare   gh release create <tag> --draft --verify-tag --notes-file docs/releases/v0.8.0.md
windows   build → verify → gh release upload *.exe *.blockmap latest.yml --clobber
linux     build → verify → gh release upload *.AppImage *.deb latest-linux*.yml --clobber
macos     build → verify → gh release upload *.dmg *.zip latest-mac.yml --clobber
publish   gh release edit <tag> --draft=false --latest
          then re-reads the feed anonymously and checks a ranged GET per installer
```

`needs: [prepare, windows, linux, macos]` on the publish job is the whole safety
property: a failed or cancelled platform means the release stays a draft.

## Network resilience

A release performs several kinds of network work: `npm ci` (registry tarballs and,
on both Linux jobs, a `node-pty` → `node-gyp` Node-headers download because the
package ships no Linux prebuild), `runtime:fetch` (nodejs.org), electron-builder
(the Electron zip plus its builder tools), `gh release create/upload/edit`, and
the anonymous `curl` feed checks. The v0.8.0 run failed because electron-builder's
downloader retries a GitHub 504 only for about 12 seconds: `app-builder-lib` wraps
`@electron/get@3.1.0` (which uses `got@11.8.6`) in
`retry({ retries: 3, interval: 2000, backoff: 2000 })` — 2 s, 4 s, 6 s — and all
four runners exhausted that window together.

The workflow now has two retry layers and a verified cache:

- `scripts/package-retry.sh` runs electron-builder three times with 60 s and
  120 s waits, removing `release/` between attempts.
- `scripts/retry.sh` does the same for `npm ci`, `gh release upload` and
  `gh release create`. The `publish` job has no checkout, so its
  `gh release edit` retry is an inline function rather than a script call.
- `scripts/fetch-retry.mjs` retries `runtime:fetch` and `--update-lock` on
  408/425/429/5xx and network errors, honours `Retry-After`, and enforces a
  per-attempt request timeout. The timeout covers the request/headers; the
  caller streams the body under the job timeout.
- The publish job re-checks each manifest and each ranged installer GET five
  times before failing, and every `curl` has a connect/overall timeout.

Release jobs also pin `setup-node` to `24.22.2`, matching
`resources/runtime/node.lock.json`, so the build is reproducible.

`DEBUG=@electron/get:*` is set on each package step, so the log names the
cache decision and the URL instead of a bare `Response code 504`. An
`if: failure()` step prints the cache sizes and the partially built `release/`
tree.

### Caching

Each build job restores and saves `actions/cache` entries for:

- `${{ runner.temp }}/electron-cache` — electron-builder's Electron zips,
  selected explicitly with `-c.electronDownload.cache=...`;
- `${{ runner.temp }}/electron-builder-cache` — `ELECTRON_BUILDER_CACHE`, the
  NSIS / winCodeSign / AppImage / fpm / 7zip tools.

Only successful jobs save the cache (`if: success()`), and the key carries a
`release-v1-` segment: bump it to discard a bad cache without changing a
dependency. This is deliberately not the `setup-node` npm cache: `node_modules`,
`~/.npm` and the dependency tree are never restored. The cached entries are the
Electron zips and builder-tool archives that electron-builder verifies against
`SHASUMS256.txt` and its hardcoded tool checksums; a tampered archive fails
verification rather than reaching an installer. node-gyp headers are not cached
because the workflow cannot independently verify them; `npm ci` is retried
instead. The release workflow runs on tags and `main` only, and a pull request
cannot write the base-branch cache. The cache is best-effort: a cold tag cache
still has both retry layers.

### Timeouts

A stalled download used to consume the six-hour job default. The jobs now time
out at 10 minutes for `prepare`, 60 for Windows/Linux, 90 for macOS and 15 for
`publish`; a stuck request fails while the log still has the attempt banners.

## Per-platform build contract

Each job builds on its own OS and asserts the finished artefacts, not the build log.

| Platform | Runner                                            | Artefacts                                                                            | Manifests                                    |
| -------- | ------------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------- |
| Windows  | `windows-latest` (bash)                           | `Pi-Desktop-<v>-win-x64-setup.exe`, `…-setup.exe.blockmap`, `…-win-x64-portable.exe` | `latest.yml`                                 |
| Linux    | `ubuntu-latest` (x64), `ubuntu-24.04-arm` (arm64) | `…-linux-x86_64-appimage.AppImage`, `…-linux-amd64-deb.deb`, and the `arm64` pair    | `latest-linux.yml`, `latest-linux-arm64.yml` |
| macOS    | `macos-latest` (arm64 M1)                         | `…-mac-arm64.dmg`, `…-mac-x64.dmg`, `…-mac-arm64.zip`, `…-mac-x64.zip`               | `latest-mac.yml`                             |

`${os}` renders as `win`/`linux`/`mac` and `${arch}` as `x64`, `x86_64`, `amd64` or
`arm64` depending on the target, which is why `scripts/release-assets.mjs` encodes the
literal names instead of globbing for extensions. It runs in every job and fails when an
artefact is missing or when a manifest names a file that is not there — the two failures
that look like success until an installed app tries to update. The Linux job passes
`--arch <x64|arm64>` because the matrix builds one architecture per job: the guard then
expects only that arch's AppImage, deb and `latest-linux*.yml`, and omitting the flag
asks for both (what a local `npm run package:linux` produces).

Runtime fetching order matters in the Linux and macOS jobs: `runtime:fetch` writes
`resources/runtime/bin` for the **last** `--platform` it is given, and `runtime:verify`
executes that shim, so the foreign architecture is fetched first with `--skip-shims` and
the host architecture last.

### Windows

The release job runs `npm run build`, `runtime:fetch -- --platform win32-x64` and
`runtime:verify` as separate steps, then packages with electron-builder. Splitting them
means a transient-download retry never rebuilds the app or refetches the runtime;
`npm run package:win` remains the local one-shot equivalent. The job asserts that
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

Run this on the exact commit that will be tagged **before** pushing the tag. Same
builds, same assertions, no release. Each job uploads its installers and manifests as a
workflow artifact (`windows-<v>`, `linux-<arch>-<v>`, `macos-<v>`), which is how a new
platform is validated before anything is published. In the log, check the
`actions/cache/restore` and `save` lines, the `@electron/get:*` URL lines and the
`attempt N/3` package banners. Artifact storage is free on a public repository; they
still expire, so download what you need.

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
public Releases API and applies the newest **published** release. It never treats
an older release as an upgrade: if `releases/latest` is behind the version the
page was built for (the normal window between the Pages deploy and the release
publish), the buttons keep the newest installer that actually exists and the
status line says `Latest published v<old> · v<new> is publishing`. That
behind-build answer is deliberately not cached, so the next load after `publish`
switches to the new release; a release at or ahead of the build is cached for ten
minutes. If the request fails, the static build links stay. The site is built
from `main` before the tag is pushed, so in that window the newest version's links
can briefly 404 for visitors without JavaScript; with JavaScript the page offers
the previous published installer and names the pending version instead of
silently presenting it as latest. Release asset names are **not** renamed for the
site — they are part of the updater manifests and the release guard. The site
build checks every internal link and anchor against the GitHub Pages base path.

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
4. Dry-run the release commit before tagging:
   `gh workflow run release.yml --ref main -f publish=false`. Confirm the cache
   restore/save, the `@electron/get:*` URL lines and the `attempt N/3` package
   banners. This is the only step that exercises the complete pipeline before a tag.
5. `git tag -a v<v> -m "Pi Desktop v<v>" && git push origin v<v>`.
6. Watch the run: `prepare` creates the draft, three builds upload, `publish` flips it and
   verifies the feed anonymously. If a build fails on an upstream 5xx, a timeout or a
   truncated download, run `gh run rerun <id> --failed`: the draft is reused and uploads
   are `--clobber`. If the failure is deterministic (a wrong command, archive name or
   platform config), land the fix and cut a **new patch release**; never move the tag.
   Delete the stale draft when a new patch supersedes it and keep the old tag as history.
7. Install from the published URL on each platform you can reach and record what you did
   not verify.
8. Confirm `https://api.github.com/repos/dieuluucanh/pi-desktop/releases/latest` returns
   the new tag first, then the site shows the new version and its release-notes page, and the
   primary download resolves to the new installer. If the release run is still uploading, the
   site intentionally keeps the previous published installer and says `v<new> is publishing`;
   that is not a site failure. If the site lags after `releases/latest` has advanced (for example
   a tag was cut from a commit that never reached `main`), run the Pages `workflow_dispatch`
   and investigate why.

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
| Upstream 5xx during a download           | two retry layers (`package-retry.sh`, `retry.sh`, `fetchWithRetry`)      |
| Stalled download                         | per-request timeouts + 10/60/90/15-minute job timeouts                   |
| npm registry 5xx                         | npm fetch retries + `scripts/retry.sh 3 30 -- npm ci`                    |
| Upload or publish API 5xx                | `scripts/retry.sh` with `--clobber`; inline publish retry                |
| Retry budget exhausted                   | the job fails and the release stays a draft; rerun or cut a new patch    |
| Cache poisoning                          | checksum-verified upstream archives; no `node_modules`/npm cache; tags   |
| Tag cache miss                           | best-effort cache; both retry layers still run                           |
| Two releases racing                      | `concurrency: release-<ref>`, `cancel-in-progress: false`                |

## Native terminal (`node-pty`)

`node-pty` 1.x is N-API, so its prebuilt binaries are ABI-stable across the
bundled Node 24 and Electron; `electron-builder.yml` sets `npmRebuild: false`
so packaging never replaces them. `afterPack` prunes `node-pty` to the target
platform/arch (`scripts/electron-builder-after-pack.mjs`).

Linux has no upstream prebuild, so the `linux` job is a matrix: x64 on
`ubuntu-latest`, arm64 on `ubuntu-24.04-arm`; each run fetches only its own
runtime and packages one arch (`--${{ matrix.arch }}`). The `linux.target`
entries in `electron-builder.yml` deliberately carry **no** `arch` list: a pinned
list overrides `--x64`/`--arm64`, so each job would package both architectures and
`afterPack` would fail on the one whose runtime the job did not fetch. The publish
job still gates on `[prepare, windows, linux, macos]` because the matrix aggregates
under `linux`.
