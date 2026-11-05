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
- `node-pty` 1.x is N-API, so its prebuilt binaries work under the bundled Node
  24 **and** Electron. `electron-builder.yml` sets `npmRebuild: false`, and the
  `afterPack` hook prunes the tarball to the target platform/arch (it is ~64 MB
  unpacked).
- Linux has no upstream prebuild. The release workflow builds Linux as a matrix:
  x64 on `ubuntu-latest`, arm64 on `ubuntu-24.04-arm`, so node-gyp compiles for
  the target instead of cross-compiling.

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
  validated absolute custom path. The strip's New Terminal button uses the
  saved default; its chevron opens a one-off terminal with another detected
  profile without changing the default.
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
- `tests/main/terminal-*` — profile detection, supervisor RPC, trust/limits/
  reconciliation, env composition.
- `tests/renderer/terminal-*` — pool move semantics, store seq/replay, view
  notices and input wiring, theme tokens, resolved font stacks, terminal
  settings and the one-off profile menu.
- `tests/e2e/terminal.spec.ts` — real Electron + terminal host on Windows CI.
