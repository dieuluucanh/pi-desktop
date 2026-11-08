# Integrated terminal

A `terminal` tab is a real PTY-backed shell, rendered by xterm.js. It is **not**
a Pi session: no agent, no model, no transcript, and it is never
`isHostBackedTab`. The composer's `!`/`!!` remains the "the agent should see
this" command runner; the terminal is the "I am driving a shell" surface.

## Surfaces

- One shell per `terminal` tab; tabs live in the existing session strip and work
  in every grid preset.
- xterm instances live in `src/renderer/src/terminal/terminal-pool.ts`. Unmounting
  a view (tab switch, grid change) **moves** the container; it never disposes the
  terminal, so scrollback and alt-screen state survive.
- Lazy start: the shell spawns when the view first mounts (the active tab or a
  visible pane), never for every restored tab at launch.
- The strip's New Terminal control is one joined chip: the left segment opens a
  terminal with the saved default shell, the right chevron opens the one-off
  profile menu. The two segments keep separate accessible names.

### Sizing

`@xterm/addon-fit` measures **`term.element.parentElement`**, not the app's
`terminal-host`. The pool therefore keeps a definite-height chain:

```text
terminal-host (h-full)
  └─ .terminal-container (h-full min-h-0 w-full overflow-hidden)
      └─ xterm mount div (h-full w-full)
          └─ .terminal.xterm
```

If any wrapper loses its definite height, the mount div's `100%` resolves to
auto, FitAddon measures the terminal's own content, and xterm locks to its
initial `rows: 24` — painting only the top of the pane even though the tab
chrome is full height. `TerminalView` also skips fitting while the host has no
layout box, so minimizing a window cannot resize the PTY to FitAddon's 2×1
floor.

## Process layout

```text
Electron main
  TerminalService (per window)      src/main/terminal-service.ts
    TerminalHost (one per window)   src/main/terminal-host.ts
      <bundled node> out/host/terminal.mjs
        TerminalCore                src/host/terminal-core.ts
          PtyPort → node-pty        src/host/pty-node.ts  (the only import)
```

- The terminal host is its own Vite input (`vite.host.config.ts`) and never
  imports `src/host/sdk`; `tests/architecture/node-pty-isolation.test.ts` guards
  both rules.
- `node-pty` 1.x is N-API, so a binary is ABI-stable across the bundled Node 24
  **and** Electron. `electron-builder.yml` sets `npmRebuild: false`; the
  `afterPack` hook prunes the tarball to the target platform/arch (it is ~64 MB
  unpacked) and **fails the package** when no usable binary for the target
  survives.
- `node-pty@1.1.0` publishes only `darwin-*` and `win32-*` prebuilds. Windows and
  macOS use those. Linux has none, so the release builds one explicitly.

### Native binary (Linux)

The packaged binary is loaded by the bundled Node with the **host's** glibc, so
it has to be built against the oldest runtime we support — never against the
runner's.

- Floor: **glibc 2.31 / `GLIBCXX_3.4.28`** (Debian 11 / Ubuntu 20.04), both
  arches. Everything the app claims to support is at least this new.
- `npm run pty:linux -- --arch <x64|arm64>` compiles in the pinned
  `debian:bullseye` container and writes
  `node_modules/node-pty/prebuilds/linux-<arch>/pty.node` plus `BUILD-INFO.json`
  (node-pty version, bundled Node, image digest, measured floor). It then
  deletes `node_modules/node-pty/build`, because node-pty's loader checks
  `build/Release` **before** `prebuilds/` and an unpinned runner build would win.
- The release matrix is `ubuntu-24.04` (x64) and `ubuntu-24.04-arm` (arm64) —
  never `-latest`. In v0.8.0 `ubuntu-latest` had moved to a 26.04-era image
  (glibc 2.42); the binary shipped but could not load on Mint 22 (glibc 2.39).
- `afterPack` runs `readelf --version-info` and rejects a binary above the floor.
  A `.deb` must contain the pinned prebuild, `out/host/terminal.mjs`, and **no**
  `build/Release/pty.node`. The release job then opens a real PTY from the
  unpacked app, the `.deb` and the AppImage, and repeats it inside Debian 11 with
  the app's own bundled Node.
- **npm 12** blocks dependency install scripts unless `package.json`'s
  `allowScripts` approves them (pinned to `node-pty@1.1.0` here). CI loads
  `node-pty` right after `npm ci`, so a policy change is a red job rather than a
  broken package.

### When the native module cannot load

`pty-node.ts` imports `node-pty` **lazily, on the first request**, so a broken
binary cannot kill the host before it answers. `terminal.open` returns a typed
`native_unavailable` error, and `terminal.info` reports every candidate path with
its own loader error — node-pty itself only reports the last one, which is why
v0.8.0 looked like a missing file instead of `version 'GLIBC_2.42' not found`.
The supervisor attaches the host's stderr tail to a crash and appends every
`[terminal]` line to `<profile>/logs/terminal.log`. The tab's error banner keeps
one actionable sentence and a **Details** disclosure with the per-candidate
report; **Diagnostics → Terminal** shows the same state, the last exit and the
log path.

## Protocol and flow control

`src/shared/terminal-protocol.ts` defines JSONL frames over stdio (same
discipline as the Pi host). PTY output is arbitrary bytes, so a chunk travels
base64-encoded and is written to xterm as a `Uint8Array`; xterm owns the UTF-8
decoder, so a multi-byte character split across chunks is safe.

- Output is batched (~16 ms / 32 KiB) and framed in monotonic `seq` order.
- Credit-based backpressure: the renderer acks bytes after `term.write` parses
  them; the host pauses the PTY at 1 MiB unacked and resumes at 256 KiB.
- A 256 KiB per-terminal ring buffer is the replay source. `terminal.attach`
  flushes pending output first and returns the ring + last `seq`; the store drops
  frames at or below that sequence, which makes a renderer reload duplicate-free.
- `node-pty`'s `kill()` only signals the shell, so a `TreeKillPort` kills the
  process group (POSIX) or runs `taskkill /T /F` (Windows). A force-close after
  a 2 s grace always emits an exit event.

## Profiles, environment and trust

- Detection is in `src/main/terminal-profiles.ts` (injected `FsPort`/`CommandRunner`):
  PowerShell 7 → Windows PowerShell → cmd, plus Git Bash and WSL distros on
  Windows; `$SHELL` and the POSIX fallbacks elsewhere. WSL's UTF-16LE listing is
  decoded by stripping NULs, and `C:\x` maps to `/mnt/c/x` for `--cd`.
- Git Bash is discovered from `where.exe git.exe` as well as the conventional
  Program Files/LOCALAPPDATA locations. Both `Git\bin\bash.exe` and
  `Git\usr\bin\bash.exe` are accepted, and either layout keeps `--login -i`
  (including when the user enters it as a custom path).
- **Settings → Terminal** is the profile picker. It lists the detected shells,
  offers `Auto` (the first detected profile, preserving the order above) and a
  validated absolute custom path. The strip's joined New Terminal chip uses the
  saved default for its main segment; its chevron opens a one-off terminal with
  another detected profile without changing the default.
- A terminal opened with a one-off profile stores `profileId` on its `TabRecord`,
  so restore and restart keep the same shell. Changing the default only affects
  new terminals; existing tabs keep the shell they were opened with.
- Main builds the spawn spec. The renderer never supplies a shell path, argv or
  environment; it sends only a validated profile id. `TerminalService`
  re-resolves the id against detected profiles immediately before spawning.
  The shell env adds `TERM=xterm-256color`, `COLORTERM=truecolor`,
  `TERM_PROGRAM=PiDesktop`, `PI_DESKTOP=1` and `PI_CODING_AGENT_DIR` (so `pi`
  inside a terminal uses the same profile), and strips `ELECTRON_RUN_AS_NODE`.
- A terminal in an untrusted project does not spawn. The tab shows a trust
  notice; after the existing trust prompt, the Retry button passes the session
  grant. `never` refuses the spawn.

## Keyboard ownership

`src/shared/terminal-keys.ts` is a pure policy (`pty` / `app:<action>` / `ignore`)
fed to xterm's custom key handler. Shell keys (including Ctrl+C/N/P/W/B/G) go to
the PTY. Only curated chords are app actions: copy/paste, find, clear, new/
toggle/close terminal, tab cycling, palette and terminal font zoom.

On Windows/Linux, main calls `webContents.setIgnoreMenuShortcuts(true)` while a
terminal has focus, so menu accelerators cannot steal those chords; macOS
accelerators are Cmd-based and do not collide. Menu items (`New Terminal`,
`Toggle Terminal`) are the non-terminal entry point.

## Theme and appearance

`src/shared/terminal-theme.ts` maps app tokens to concrete xterm colours, with
`--terminal-*` and `--ansi-0..15` in `styles/tokens.css` for both palettes. A
`data-theme`/style change re-resolves the theme on the live terminals without
losing scrollback.

Fonts need more than CSS: xterm measures its cell grid with a canvas
(`ctx.font = "<size>px <family>"`), and a canvas font string cannot resolve
`var(--font-mono)`. `src/renderer/src/terminal/terminal-font.ts` therefore
resolves the token (and any `var()` in a custom family) to a concrete stack
before xterm sees it, with `monospace` as the last-resort valid font. Passing
`var(...)` to xterm is a regression: the measurement silently falls back to the
canvas default and the text becomes tiny and proportional.

Settings → Terminal edits the same `prefs.terminal` block the runtime uses:
font size (new installs start at 14 px; stored values are not migrated) and
family with a live preview, cursor style/blink, scrollback, copy-on-selection
(after the selection settles), a visual BEL flash and macOS Option-as-Meta.
`TerminalPool.setOptions` applies changes to live xterm instances without
recreating the shell or losing scrollback.

## Tests

- `tests/host/terminal-core|terminal-main|terminal-perf|terminal-integration` —
  lifecycle, batching, credit, replay, tree-kill, 50 MB flood, real shell.
  `terminal-integration` is built first in CI and **required**
  (`PI_REQUIRE_TERMINAL_HOST=1`), so it can no longer silently skip.
- `tests/host/pty-node.test.ts` — the lazy loader, the per-candidate probe and
  the error summary.
- `tests/main/terminal-*`, `tests/main/runtime/child-env.test.ts` — profile
  detection, supervisor RPC and stderr, trust/limits/reconciliation, error
  details, AppImage loader-path hygiene.
- `tests/packaging/node-pty-{prune,artifact,build}.test.ts`,
  `terminal-artifact.test.ts`, `native-install.test.ts` — the fail-closed
  package gate, the ELF floor, the pinned container build, the packaged smoke's
  path resolution and the `allowScripts` pin.
- `tests/renderer/terminal-*` — pool move semantics, store seq/replay, view
  notices and input wiring, error Details/Copy, theme tokens, resolved font
  stacks, terminal settings and the one-off profile menu.
- `tests/e2e/terminal.spec.ts` — real Electron + terminal host on Windows CI.
- Release: `scripts/verify-packaged-terminal.mjs` opens a real PTY from the
  unpacked app, the `.deb`, the AppImage and inside `debian:bullseye`.
