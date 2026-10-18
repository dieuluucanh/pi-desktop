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

## A session stopped responding

- Press `Esc` to stop the run (this clears the queue and restores the text).
- If the host crashed or wedged, the tab shows a **Restart** banner; restarting
  re-spawns the host and resumes the session from its JSONL. History is not lost.
- A closed tab mid-run leaves no orphan process: hosts are owned by the main
  process and stopped on close and on quit.

## Provider or network problems

- **Offline banner** — `PI_OFFLINE` is set or a request failed with a
  connectivity error. Model lists, update checks and installs are unavailable.
- **Wrong or missing credentials** — check **Connections**; a provider shows a
  status badge and a sign-in route. `auth.json` is shared, so terminal Pi sees
  the same credentials.
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

## Extensions and packages

- A loader error appears in the Extensions hub’s status banner and diagnostics,
  with the source path.
- A crashing extension is recorded as an `extension_error` incident; the session
  is not blocked.
- `/reload` reloads a live session and shows what changed; **Reload runtime** in
  the hub does the same with no session open.
- Pin a known-good version from the package list if an update broke something.

## Pi for Office

- **Nothing listens on 38617** — the Office session is not running or Office is
  not open. Open the Office host app; the card’s **Re-check bridge** polls
  `/health`.
- **Port conflict** — another program owns 38617. The card says so explicitly;
  close it and retry, or use a different bridge port via
  `PI_OFFICE_BRIDGE_PORT`.
- **Add-in not appearing in Office** — use **Copy diagnostics**; common causes
  are a stale sideload entry, an Office update invalidating the cache, or a
  WSL/remote setup that cannot see the host registry. **Reset add-in** then
  re-runs the wizard.

## Updates

`Help → Check for Updates…` runs a check. Development builds have no feed and say
so. A failed check shows a Retry in the banner; the error text is kept in the
updater state.

## Logs and the support bundle

```text
userData/logs/              per-host logs (main-process log too)
userData/backups/           settings.json/auth.json backups
Diagnostics → Save         redacted support bundle (no credentials)
```

The bundle runs `redactSecrets` over the whole document, so it is safe to attach
to an issue.

## Known limitations in v0.1.0

Every known limitation is recorded with the release notes:
[`docs/releases/v0.1.0.md`](../releases/v0.1.0.md). The short version:

- **Unsigned builds** — SmartScreen/Gatekeeper warn on first launch; signing is
  deferred ([backlog](../product/backlog.md)).
- **macOS and Linux are beta** — built from the same config, but no real
  Mac/Linux install has been exercised. Windows is the verified target.
- **The updater** is verified against its policy and a fake port, not a live
  GitHub Release feed.
- **Verified structurally, not on a live machine:** provider OAuth flows,
  extension TUI/renderer fidelity in the packaged app, the Office wizard and
  bridge end to end, the Plannotator round trip, web-tab isolation on a _loaded_
  page, crash/timeout banners, safe mode against a genuinely broken extension,
  and the 60 fps / RSS numbers.
- **Upstream:** Pi's own `settings.json` and session-JSONL writes are not
  crash-atomic; the app's own profile writes are (`fsync` + rename).
- **Deferred features** are listed in [`../product/backlog.md`](../product/backlog.md).

If one of these bites you, the diagnostics bundle above is the fastest path to a
useful issue.

## Related

- [FAQ](faq.md) · [Getting started](getting-started.md)
- [Release notes v0.1.0](../releases/v0.1.0.md) · [Backlog](../product/backlog.md)
- [architecture/app-shell.md](../architecture/app-shell.md)
