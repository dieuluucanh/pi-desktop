# Troubleshooting

Start with **Diagnostics** (sidebar or the command palette): it shows hosts and
their logs, incidents, extension errors, the Office probe, runtime versions,
environment facts and the startup budget, and it can export a **redacted** support
bundle.

```bash
# the same probe from a terminal, when the app will not start
npm run doctor            # runtime, profile, extensions, bridge, git, Office status
npm run office:doctor     # Office detection + sideload state + bridge health
```

## The app will not start / an extension breaks it

Use **safe mode**:

```bash
pi-desktop --safe-mode          # or PI_DESKTOP_SAFE_MODE=1
```

Safe mode loads no third-party code, refuses package mutations and starts no
session host on its own, so you can reach Extensions and disable the offending
resource. The window shows a safe-mode banner.

### Linux: the AppImage or the window will not start

- **`AppImage` won't run, or nothing happens on double-click.** The AppImage
  format needs FUSE. Either install it (`sudo apt install libfuse2` on Ubuntu
  22.04+, `fuse2` on Fedora/Arch) or run it without FUSE:
  `./Pi-Desktop-*.AppImage --appimage-extract-and-run`.
- **`error while loading shared libraries: libnspr4.so` (or `libnss3.so`,
  `libasound.so.2`).** You extracted the AppImage or installed the `.deb` with
  `dpkg -i`, which skips dependency resolution. Install through apt so they are
  pulled in: `sudo apt install ./Pi-Desktop-*-linux-amd64-deb.deb`. If you must
  use `dpkg -i`, follow it with `sudo apt-get -f install`.
- **The window opens but shows a generic icon, or a second icon appears in the
  dock.** The launcher entry and the window's `app_id` have to agree; the app
  sets both to `pi-desktop`. Log out and back in after installing so the desktop
  database is re-read (`update-desktop-database ~/.local/share/applications`).
- **No tray/notification icon.** Some desktops need an indicator extension for
  Electron's tray; unavailable-toast grouping also depends on the desktop
  environment. Neither affects the app itself.

### macOS: the app will not open

- **“Apple could not verify…” on first launch.** The build is not notarized.
  Since macOS 15 (Sequoia), Control-clicking and choosing Open no longer
  overrides this: open **System Settings → Privacy & Security**, scroll to the
  bottom, and choose **Open Anyway** next to Pi Desktop (once per app).
- **“Pi Desktop is damaged and should be moved to the Trash.”** This is a
  quarantine flag on a valid bundle, usually after unzipping the `.zip` instead
  of mounting the `.dmg`. Reinstall from the `.dmg`, or clear the flag:
  `xattr -dr com.apple.quarantine "/Applications/Pi Desktop.app"`.
- **There is no “Restart & install” for updates.** Deliberate: Squirrel.Mac
  rejects an update whose code-signing identity differs from the running app, and
  these builds are ad-hoc signed. **About & updates** says **Manual
  updates** and links to the Releases page; download the new `.dmg`.

## A session looks idle/asleep after a long break

- **`ready` is the normal idle state.** The host and session are open and no turn
  is streaming; type a prompt and it runs normally. The badge says `working`
  while a turn is streaming.
- **Clicking the transcript background focuses the composer**, and focusing or
  typing runs a readiness check. If the host was recycled (RSS or an explicit
  stop), the badge shows `starting` and returns to `ready` when the session has
  resumed; your draft is preserved.
- **Sleep/resume or a hidden window** can miss pushes. Returning to the window
  (or `powerMonitor` resume/unlock) reconciles the tab table and repairs the
  active tab; other tabs stay asleep until you interact with them.
- **A tab that says `asleep`** has no running host. Clicking it, focusing the
  composer or typing wakes it; you do not need the Start session link.
- The time-based 15-minute idle recycler is **on by default**; only inactive
  tabs sleep. The active tab, visible panes, the control host, the bridge owner
  and a session linked to an active/visible review tab are protected from idle
  sleep and from the 1 GB RSS guardrail. An active host over 1 GB shows a memory
  warning with a **Restart** action; it is not killed automatically. Background
  hosts are recycled only after two consecutive over-budget samples and a
  one-minute startup grace period. Both reasons show in the host log and
  Diagnostics.
- **A session that keeps reconnecting** (the badge alternates `starting` and
  `ready`, and the footer statuses reload) is not fixed by typing harder. Passive
  reads no longer wake a stopped host; activate the tab to resume it. If it
  repeats, open **Diagnostics** — the host log and the `host_restart_loop`
  incident name the stop reason, and the previous run is kept in `logs/<tab>.1.log`.

## The Sessions browser is empty

- **A large profile used to look empty.** Host responses at or above 1 MiB are
  spilled to a blob cache and replaced by `{$blob, bytes}`. Older builds read the
  missing `sessions` field as an empty profile, so `/resume` showed nothing even
  though the files existed. Current builds read the blob back in chunks, project
  the list in the host and show an error instead of a silent empty state — update
  if you still see this.
- **Check the control host log.** Open **Diagnostics → Hosts** and look at the
  control host (or `logs/control.log`). A healthy large list has no “frame
  exceeded the size limit” and no `session.list` timeout. The first open can take
  a moment while Pi reads every session JSONL; later searches use the short cache.
- **Search covers the full transcript**, so a match can appear on a row whose
  title does not contain the word. Typing is debounced by ~150 ms; wait for
  “Searching…” to clear.
- **The history still shows old data after an update.** The control host is
  long-lived and pinned, like a session host; a renderer reload does not restart
  it. Restart the app after rebuilding `out/host` so it runs the new
  `session.list` (scope filtering, real timestamps). Diagnostics marks a host
  whose bundle is older than the app as `stale build`.

## The app's memory keeps growing, or a Pi terminal gets slow

- Open **Diagnostics** first. The Hosts card reports `live/target (ceiling)`,
  aggregate `host RSS / limit`, system free/total memory and live web views. A
  warn badge (`over target` or `over memory`) names the pressure instead of
  guessing.
- **Live host target:** 20 % of physical RAM at 512 MB per host, clamped 2–8.
  The ceiling is target + 2 (4–10). Opening more session tabs does not raise it;
  idle sessions sleep and resume from JSONL.
- **Web tabs:** unlimited as records, but at most four live renderers are kept.
  Switching back to an old review reloads it.
- **Dev mode:** an `electron-vite --watch` restart kills main; hosts now exit
  when their stdin pipe closes. If you upgraded from an older build, any host
  left from yesterday's run may still be alive — close the dev terminal (or use
  Task Manager / `ps`) once, then restart.
- If the machine is still tight, close pinned/background sessions you are not
  using, or close the app and the dev terminal; the process tree goes with it.

## A session stopped responding

- Press `Esc` to stop the run (this clears the queue and restores the text).
- If the host crashed or wedged, the tab shows a **Restart** banner; restarting
  re-spawns the host and resumes the session from its JSONL. History is not lost.
- A closed tab mid-run leaves no orphan process: hosts are owned by the main
  process and stopped on close and on quit.

## A `!` shell command did not run

- `!command` and `!!command` are executed by the host through the same Bash Pi
  uses; they are not an interactive terminal. Commands that need a password, an
  editor or another TTY prompt belong in the **integrated terminal**
  (`New terminal` in the strip, `Ctrl/Cmd+Shift+T`, or `Ctrl/Cmd+J` to toggle).
  `git push` works when
  git's credential helper or SSH agent is already configured.
- The integrated terminal does not spawn in an untrusted project. The tab shows a
  trust notice; grant trust and press **Retry**, or set the project to `never`
  and use an external terminal. If a terminal tab shows an exit banner, the
  shell process group is already gone — close the tab and open a new one; the
  app kills the whole tree (POSIX process group / `taskkill /T`) so no shell
  survives it.
- A session host older than the app can fail with a `_bashAbortControllers` /
  `_bashAbortController` message. Restart the session tab or the app; current
  builds call the SDK method with its session receiver.
- `!` needs Bash on `PATH` (Git Bash on Windows). If Bash or `git` is missing,
  the app reports it rather than hanging. `Esc` cancels a running command.
- A project tool that starts its own `node` through `cmd` (for example
  `npm run dev` → turbo → `pnpm.cmd`) can fail with **“The system cannot find the
  path specified”** before any project code runs. That was the old Windows
  `node.cmd` shim, which used the batch file's `%~dp0` even when cmd had started
  it by bare name; the shim now locates itself and the real `node.exe` is on
  `PATH`. Update Pi Desktop, or run `npm run runtime:shims` in a development
  tree. On 0.6.0 and earlier the stopgap is adding `PI_DESKTOP_NODE` to turbo's
  `globalPassThroughEnv`. `npm run doctor` prints the runtime and shim paths.

## A localhost URL shows Pi Desktop instead of my app

A project's dev server prints a URL, the browser opens it, and the page is Pi
Desktop — usually with **The preload bridge is unavailable (window.pi is
missing)**.

- **Cause.** Older Pi Desktop builds served their own renderer on
  `localhost:5173`, Vite's default. A project Vite that also uses 5173 either
  falls back to 5174 or binds the other loopback address (`127.0.0.1` while the
  app held `::1`), so `http://localhost:5173` can be the app, not the project.
  A renderer served outside Electron has no preload bridge, so that banner is
  all it can show.
- **Find out which server owns the port.** `netstat -ano | findstr :5173`
  (Windows) or `lsof -nP -iTCP:5173 -sTCP:LISTEN` (macOS, Linux), then
  `curl -s http://127.0.0.1:5173/ | grep -i "<title>"`: `Pi Desktop` is the app;
  anything else is the project. `npm run doctor` prints the app's own dev-server
  address and whether it is free.
- **Fix.** Update Pi Desktop: the renderer dev server is
  `http://127.0.0.1:5273` and never takes 5173. If a stale process holds a port,
  stop it (`taskkill /PID <pid> /T /F` on Windows, `kill <pid>` elsewhere). To run
  the app elsewhere, set `PI_DESKTOP_RENDERER_PORT=5274` for `npm run dev`. For
  the project, enable `strictPort: true` in its Vite config (or give it a
  distinct `VITE_PORT`) so a taken port fails loudly instead of drifting.

## Slash-command suggestions stopped working after a host edit

Extension sub-commands (`/profile `, `/commit-policy `, `/write-policy `) are
computed by the **host process**, which keeps running the bundle it was spawned
from. If `out/host/index.mjs` was rebuilt while the app stayed open, the
renderer is current but the host is not.

- Restart the session tab (or the app). The app also shows a **stale host**
  banner with **Restart session** when it detects the mismatch, and Diagnostics
  marks the host `stale build`.
- `npm run dev` runs a host watch build beside `electron-vite dev --watch`:
  host, main and preload bundles all rebuild, and Electron restarts when
  main/preload changes. If you start `electron-vite dev` yourself, pass
  `--watch` and run `npm run build:host` after host edits.
- In an idle session the app recycles a stale host automatically before the next
  request; it never interrupts a streaming, compacting or queued session.

## A model star fails with “unsupported host method model.scope.toggle”

The star is a `session.request` whose method is validated by the **main
process** before it reaches a host. A hot-reloaded renderer can be newer than a
main process started before `model.scope.toggle` was added, so the star is
visible while main still rejects the call.

- Restart the app. `npm run dev` now runs `electron-vite dev --watch`, so a main
  or shared-protocol edit rebuilds main and restarts Electron. When a running
  main is detected as older, the app shows a **Restart app** banner instead of
  the raw IPC error.
- If you start `electron-vite dev` yourself, pass `--watch`; for host edits also
  run `npm run build:host`.

## Provider or network problems

- **Offline banner** — `PI_OFFLINE` is set or a request failed with a
  connectivity error. Model lists, update checks and installs are unavailable.
- **Wrong or missing credentials** — check **Connections**; a provider shows a
  status badge and a sign-in route. `auth.json` is shared, so terminal Pi sees
  the same credentials.
- **A custom model id will not save** — the dialog names the exact problem. An id
  may contain `/`, `:`, `~`, `@` and other punctuation (e.g.
  `hf:deepseek-ai/DeepSeek-V4.1-Flash`), but not spaces, control characters or a
  comma, and at most 200 characters. A comma cannot be typed into the
  comma-separated field: add such an id to `models.json` by hand instead. Provider
  ids additionally cannot contain `/` (Pi splits `provider/model` at the first
  slash), are capped at 64 characters, and refuse `__proto__` and friends because
  the id is a JSON object key.
- **A custom gateway lost its API key after an edit** — leave the key field
  blank to keep the stored value; typing a value replaces it. Deleting a gateway
  with the button removes the whole entry, key included.
- **Proxy** — set `httpProxy` in Settings → Network; every host inherits it.

## Disk and permission problems

If the profile is read-only or the disk is full, writes fail with a
user-readable fix in the failure hint:

- **read-only profile** — the profile directory or `settings.json` lacks write
  permission; the app never retries by overwriting.
- **disk full** — free space; backups and atomic writes need room to rename.

A **malformed** `settings.json`, `auth.json` or `app-state.json` is reported and
left untouched; fix it by hand and reload. `settings.json` is backed up before
the first write per run.

## Display and window

- **The UI is too small or too large** — <kbd>Ctrl/Cmd</kbd>+<kbd>=</kbd> zooms
  in, <kbd>Ctrl/Cmd</kbd>+<kbd>-</kbd> zooms out, and <kbd>Ctrl/Cmd</kbd>+<kbd>0</kbd>
  resets to 100 %. The status bar's `− 100 % +` cluster and Settings → Display
  zoom do the same; the level survives a restart. The range is 50 %–300 %.
- **Zoom resets after a reload** — it should not: main re-applies
  `prefs.zoomFactor` on `did-finish-load`. If it does, check that
  `app-state.json` is writable.

## Extensions and packages

- A loader error appears in the Extensions hub’s status banner and diagnostics,
  with the source path.
- A crashing extension is recorded as an `extension_error` incident; the session
  is not blocked.
- `/reload` reloads a live session and shows what changed; **Reload runtime** in
  the hub does the same with no session open.
- Pin a known-good version from the package list if an update broke something.
- **Cannot copy text from an extension panel** — select the text and press
  <kbd>Ctrl</kbd>+<kbd>C</kbd> / <kbd>Cmd</kbd>+<kbd>C</kbd>, or use the panel's
  **Copy** button, or right-click → **Copy**. A selection is copied instead of
  being sent to the extension;
  with nothing selected the chord still reaches it, and <kbd>Esc</kbd> aborts.

## Pi for Office

- **Nothing listens on 38617** — the bridge is off. Run `/office connect` in the
  session you want, or click **Connect this session** in the Documents rail. The
  bridge does not start just because a session opened.
- **Port conflict** — another Pi session or program owns 38617. The row shows the
  owner (PID/cwd); close it there, or use **Take over** in Desktop. A terminal
  user can run `/office close` in the owner or use
  `/office connect <port>`.
- **"Automatic bridge (legacy)"** — a 0.5.x bridge auto-starts and has no close
  command. Click **Update bridge** to install the pinned 0.6+ package.
- **Add-in not appearing in Office** — use **Copy diagnostics**; common causes
  are a stale sideload entry, an Office update invalidating the cache, or a
  WSL/remote setup that cannot see the host registry. **Reset add-in** then
  re-runs the wizard.

## Updates

`Help → Check for Updates…` opens **About & updates** (sidebar, below
Diagnostics) and runs a check. A released build checks once after launch; a
version is offered as a bell notification with a **View update** action, and the
About & updates sidebar item shows a dot until you install or the build is up to
date. All outcomes live in that view: up to date, downloading, ready, error, and
**no published release**. There is no status-bar update chip.

A locally built package (stamped `local` in `resources/build-info.json`) does not
auto-check; a manual check only tells you whether a published release exists. A
missing release is the neutral “No published release was found for this build”
state, not a failure. Errors keep their raw message under **Technical details**
and can be dismissed; automatic failures never open a banner. A development build
reports that updates are checked in installed builds only.

## Logs and the support bundle

```text
userData/logs/              per-host logs (main-process log too)
userData/backups/           settings.json/auth.json backups
Diagnostics → Save         redacted support bundle (no credentials)
```

The bundle runs `redactSecrets` over the whole document, so it is safe to attach
to an issue.

## Known limitations in v0.8.0

Every known limitation is recorded with the release notes:
[`docs/releases/v0.8.0.md`](../releases/v0.8.0.md). The short version:

- **Unsigned builds** — SmartScreen/Gatekeeper warn on first launch; signing is
  deferred ([backlog](../product/backlog.md)).
- **macOS and Linux are beta** — built and structurally verified in CI, but no
  real macOS launch and no fresh Linux desktop install have been exercised by a
  person for this release. Windows is the verified target.
- **macOS updates are manual** — an ad-hoc signature cannot satisfy Squirrel.Mac,
  so the app links to the release instead of offering an in-place install.
- **The updater** is verified against its policy and a fake port, not a live
  GitHub Release feed.
- **The terminal is local only** — one shell per tab, no SSH/remote session, no
  tmux control mode and no docked split panel; it does not spawn in an untrusted
  project until you grant trust. Linux arm64 packages compile `node-pty` on the
  target runner because there is no upstream prebuild.
- **Informational notifications are hidden by default** — enable
  **Informational messages** in Settings → Notifications to show them in the
  bell and transcript. Hidden rows are never lost: **Show hidden (N)** in the
  bell recovers them.
- **The update offer is in-app only** — the bell row, its toast and the
  About & updates dot are the whole surface; there is no OS notification, and
  dismissing the row keeps the dot until the offer is installed or replaced.
- **Verified structurally, not on a live machine:** provider OAuth flows,
  extension TUI/renderer fidelity in the packaged app, the Office wizard and
  bridge end to end, the Plannotator round trip, web-tab isolation on a _loaded_
  page, crash/timeout banners, safe mode against a genuinely broken extension,
  the terminal inside a packaged macOS or Linux build, and the 60 fps / RSS
  numbers.
- **Upstream:** Pi's own `settings.json` and session-JSONL writes are not
  crash-atomic; the app's own profile writes are (`fsync` + rename).
- **Deferred features** are listed in [`../product/backlog.md`](../product/backlog.md).

If one of these bites you, the diagnostics bundle above is the fastest path to a
useful issue.

## Related

- [FAQ](faq.md) · [Getting started](getting-started.md)
- [Release notes v0.8.0](../releases/v0.8.0.md) · [Backlog](../product/backlog.md)
- [architecture/app-shell.md](../architecture/app-shell.md)
