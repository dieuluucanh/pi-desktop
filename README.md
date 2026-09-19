# Pi Desktop

A standalone desktop app for the [Pi coding agent](https://pi.dev) — no terminal, no global
installs. Sessions, extensions, packages, providers and settings are managed through a UI, and the
same app can drive Microsoft Office through the [Pi for Office](https://github.com/dieuluucanh/pi-for-office)
add-in with zero-touch setup.

> **Status:** early. The Office setup backend (detect → install bridge → sideload → verify →
> troubleshoot) is implemented and tested. The Electron shell, chat UI and the wizard's React panel
> are next (see [Roadmap](#roadmap)).

## Current state

Implemented and covered by tests (`npm test`, 151 tests):

| Area              | Module                                | What it does                                                                                                                                                                                                                                                                                   |
| ----------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Office detection  | `src/main/office/detect.ts`           | Detects the OS, WSL, installed Office apps (registry / filesystem / app bundles), the installed Office version, and whether the Pi for Office add-in is already sideloaded — plus whether that sideload points at the current hosted task pane.                                                |
| Windows registry  | `src/main/office/registry.ts`         | `reg.exe` query/add/delete with hive normalisation (`HKLM` ↔ `HKEY_LOCAL_MACHINE`), empty-value handling and wrapped-value joining.                                                                                                                                                            |
| Manifest handling | `src/main/office/manifest.ts`         | Parses add-in manifests and identifies the Pi for Office add-in by `<Id>` (or by a task-pane URL), so unrelated add-ins are never claimed or modified.                                                                                                                                         |
| Bridge package    | `src/main/office/bridge-install.ts`   | Installs and **pins** `@dieulc/pi-office-bridge` into Pi's npm root (`~/.pi/agent/npm`, layout `pi-extensions` + lockfile + `.gitignore`), then verifies the declared extension entry actually exists.                                                                                         |
| Sideloading       | `src/main/office/sideload.ts`         | Plans and performs the sideload: `HKCU\Software\Microsoft\Office\16.0\WEF\Developer` (no admin) plus a manifest copy in `%LOCALAPPDATA%\Microsoft\Office\16.0\Wef`; on macOS copies into each `~/Library/Containers/com.microsoft.<App>/Data/Documents/wef`. Reversible via `unsideloadAddIn`. |
| Verification      | `src/main/office/verify.ts`           | Opens the Office host (`shell.openPath`), polls `GET http://127.0.0.1:38617/health` until a task pane attaches, distinguishes a port conflict from "nothing listening", and projects everything into a live checklist.                                                                         |
| Troubleshooting   | `src/main/office/troubleshoot.ts`     | Ranked, actionable items (port in use, Office missing, add-in not appearing, WSL/remote, version skew, stale sideload entries) and a **redacted** diagnostics bundle for "Copy diagnostics".                                                                                                   |
| Wizard            | `src/main/office/setup-controller.ts` | The panel's contract: `run()`, per-step retries, `cancel()`, `refreshHealth()`, `unsideload()`, live `onChange` state, checklist + troubleshooting + diagnostics.                                                                                                                              |
| Package plumbing  | `src/main/packages/*`                 | Pi-compatible package source parsing (`npm:`, `git:`, URLs, paths), settings.json read/atomic-write with filters preserved, npm-root management, and an npm installer behind a port.                                                                                                           |

### Deliberately not done yet

- The React panel that renders `OfficeSetupController` state, and the Electron shell that supplies
  `shell.openPath` / `shell.openExternal` and the real bundled Node + npm paths. The controller is
  UI-free by design so the panel is a thin binding.
- Bundling the Pi runtime and the managed Node 24 runtime (see the plan).

## Layout

```
src/shared/office.ts          Pi for Office constants (add-in id, bridge package, ports, hosts)
src/main/fs-port.ts           FsPort + Node and in-memory implementations
src/main/office/*             detection, registry, manifest, sideload, verify, troubleshoot, wizard
src/main/packages/*           spec parsing, settings.json, npm root, installer
resources/office/             vendored manifest.prod.xml + lockfile (hash-checked)
scripts/sync-office-manifest.mjs   re-vendor the manifest from the pi-for-office repo
tests/                        vitest suites, including a live probe of this machine
```

## Verifying

```bash
npm ci
npm run typecheck
npm test                       # 151 unit + integration tests

npm run office:doctor          # probe THIS machine: OS, Office install, sideload state, bridge health
npm run office:manifest:check  # verify the vendored manifest against its recorded hash
```

`office:doctor` is the honest check: it runs the real detection code against the real machine
(registry, filesystem, `/health`) and prints a report. On a Windows machine with Office it prints
something like:

```
os: windows
office: 16.0.20326.20144 (x64) via HKLM\SOFTWARE\Microsoft\Office\ClickToRun\Configuration
products: O365HomePremRetail
apps: Excel=C:\Program Files\Microsoft Office\root\Office16\EXCEL.EXE, Word=..., PowerPoint=...
sideloaded: no
```

## Design notes

- **Shared profile.** The app reads and writes the same `~/.pi/agent` profile as terminal Pi
  (`settings.json`, `auth.json`, `sessions/`, `npm/`), so the two are interchangeable. Writes are
  atomic, malformed JSON is never overwritten, and `settings.json` is backed up before the first
  change.
- **Verify, never assume.** Every write is followed by detection: the bridge package must expose a
  real extension entry, and the sideload must be visible to the same detector Office would satisfy.
- **Ports.** The bridge listens on loopback port `38617` (`PI_OFFICE_BRIDGE_PORT` overrides). A
  second Pi session must use a different port; the app reports a port conflict explicitly instead of
  failing silently.
- **No proxy needed.** The app runs in Node, so provider HTTP requests are not CORS-blocked — the
  `pi-for-office-proxy` step is unnecessary for desktop users.
- **Testability.** Every OS interaction (filesystem, registry, npm, fetch, clock, `openPath`) is
  injected, so the whole wizard runs headlessly against an in-memory filesystem, a stateful `reg.exe`
  double and a fake `fetch`.

## Roadmap

1. Electron shell (main/preload/renderer) + the setup wizard panel wired to `OfficeSetupController`.
2. Bundled Node 24 + npm + Pi runtime, and the `pi` PATH shim so extensions that shell out to `pi`
   keep working.
3. Session host per tab, extension UI host (dialogs + TUI surface), chat UI, providers, settings.
4. Packages/extensions hub, Plannotator webview tabs, Office session tab.
5. Hardening, packaging (Windows NSIS + portable), auto-update, docs.

## License

MIT.
