# Bundled runtime

Pi Desktop ships its own Node runtime instead of relying on the user's machine or
on Electron's Node (plan D3/D21/D22). It is what runs every Pi host process and
every npm install, and the PATH shims make extensions that shell out to
`pi`/`node`/`npm` (workflow's `explore` subagent, reviewer subagents) work with
no global install.

## Layout

```text
resources/runtime/
  node.lock.json          pinned version + sha256 per platform (checked in)
  node/<platform>-<arch>/ installed Node 24 LTS (gitignored)
  bin/                    generated shims (gitignored)

    Windows (win32-*):
      pi  pi.cmd          -> <node> out/host/index.mjs        (the `pi` CLI)
      node                -> the bundled node (Git Bash; cmd/PowerShell use
                             the real node.exe from node/<platform>-<arch>/)
      npm  npm.cmd        -> <node> .../npm/bin/npm-cli.js
      npx  npx.cmd        -> <node> .../npm/bin/npx-cli.js

    macOS / Linux:
      pi  node  npm  npx  -> the same targets, no .cmd twins
```

On Windows there is deliberately **no `node.cmd`**. The host PATH is `bin` first
and `node/<platform>-<arch>` second, so `node` resolves to a real executable that
cmd, PowerShell and `spawn("node")` can all start. `bin` also keeps the
extensionless `node` script for Git Bash.

In a packaged build the same layout sits under `<resources>/runtime`, and the
host entry is `<resources>/app.asar.unpacked/out/host/index.mjs`; the
`electron-builder` `afterPack` hook re-runs `gen-shims.mjs --mode packaged`
inside the finished app to bake that relative path in (`extraResources` is only
copied by then, so `afterPack` is the earliest hook that can).

## Commands

```bash
npm run runtime:fetch     # download + verify + extract + generate shims (this machine)
npm run runtime:fetch -- --platform linux-x64
npm run runtime:fetch -- --all
npm run runtime:fetch -- --force          # repair a damaged install
npm run runtime:fetch -- --verify         # re-check what is on disk, no network
npm run runtime:lock      # refresh node.lock.json from nodejs.org SHASUMS256.txt
npm run runtime:shims     # regenerate shims only
npm run runtime:verify    # hard acceptance check (fails when the runtime is missing)
npm run doctor            # full environment report
```

`npm test` skips the live runtime suites when no runtime is installed, so CI does
not need a 37 MB download; `runtime:verify` sets `PI_DESKTOP_REQUIRE_RUNTIME=1`
and fails loudly instead.

### Verifying a runtime you cannot run

A foreign-platform runtime can never be executed (`node.exe` is not a Linux
binary), and a runnable host is not required to _package_ for another platform.
`runtime:fetch` therefore verifies an install in three ways that need no
runnable binary, and only the host platform additionally runs `<node> --version`:

1. **The archive digest** (sha256, pinned per target in `node.lock.json`).
2. **The npm payload** the distribution ships — `node.lock.json`'s
   `node.npmPayload` holds its sha256, taken over CRLF-normalised content because
   the Windows ZIP ships the same npm files with CRLF while the tarballs ship LF.
3. **The version stamp** in the binary (`node.js/v24.21.0`, present in the `.exe`,
   ELF and Mach-O alike) cross-checked against `include/node/node_version.h`.

This is what makes `npm run package:linux` work from Windows; before it, `--all`
failed on every platform with _the extracted runtime did not run_. The staging
directory is also created _inside_ `resources/runtime/node/` rather than in the
system temp dir, because the install ends in a `rename()` and `/tmp` is a
different filesystem on WSL and many CI images (EXDEV).

## Resolution order (`src/main/runtime/resolve-runtime.ts`)

1. `PI_DESKTOP_NODE` — an explicit node binary (± `PI_DESKTOP_NPM_CLI`). Source `override`.
2. `resources/runtime/node/<platform>-<arch>` — the bundled runtime. Source `bundled`.
3. `node` on PATH / `process.execPath` — **development only**, and only when the
   version passes the Pi engine gate (`>= 22.19.0`). Source `system`, always with a
   problem note, because packaged builds must never depend on the host machine.

`PI_DESKTOP_RUNTIME_DIR` relocates the runtime root, `PI_DESKTOP_HOST_ENTRY`
relocates the host bundle (the supervisor sets both for every host it spawns).

Every candidate is _probed_ (`<node> --version`) and rejected unless it satisfies
the gate from `layout.ts`; a resolution never reports `ok` for a runtime that
cannot run the SDK. When nothing qualifies, the result carries `problems` and a
one-line `hint` (`npm run runtime:fetch`).

For npm installs the resolved runtime is injected as a **runtime settings
override** — `SettingsManager.applyOverrides({ npmCommand: [node, npmCliJs] })` —
so the shared `~/.pi/agent/settings.json` is never rewritten (plan D20).

`runtimeEnvOverrides()` is the pure resolution-to-environment contract. It sets
`PI_DESKTOP_NODE` / `PI_DESKTOP_HOST_ENTRY` and prefixes both the shim directory
and the selected Node's directory (`nodeBinDir`, the `dirname()` of the resolved
binary). The host supervisor composes the same directories through the shared
`joinPathEntries()` helper, so the order is always `binDir`, `nodeBinDir`, then
the inherited PATH. `binDir` wins for `pi`/`npm`/`npx`; `nodeBinDir` supplies the
real `node`, which is why no Windows `node.cmd` is needed.

## Development renderer server

`electron-vite dev` serves the renderer from `http://127.0.0.1:5273`. The port is
not Vite's default on purpose: 5173 is what every project Vite takes, and the
earlier implicit `localhost` bind landed on `::1` only, so a project server could
bind `127.0.0.1:5173` as well or silently fall back to 5174 — and a browser
opening `http://localhost:5173` showed Pi Desktop's renderer without its preload
bridge, which reads as a broken build.

The rules live in `src/main/runtime/dev-server.ts` and are consumed by
`electron.vite.config.ts`:

| Setting      | Value       | Why                                                                 |
| ------------ | ----------- | ------------------------------------------------------------------- |
| `host`       | `127.0.0.1` | one explicit loopback family; no `localhost`/`::1` split            |
| `port`       | `5273`      | outside Vite's 5173+ fallback family and the common framework ports |
| `strictPort` | `true`      | a busy port must fail loudly, never move                            |

`PI_DESKTOP_RENDERER_PORT` overrides the port (a process environment variable,
not a project `.env` value) and must be an integer between 1024 and 65535; a
malformed value fails the config load by name. `strictPort` matters beyond the
port itself: `electron-vite@5` derives `ELECTRON_RENDERER_URL` from the
**configured** port, not Vite's actual port, so a silent fallback would point the
Electron window at whichever server owns the configured port.

`npm run doctor` prints the address and whether it is free. Only `dev` starts a
server: `build`, `preview` and packaged apps load `out/renderer/index.html`.

## Notes from the field

- **Windows `.cmd` shims.** When cmd starts a batch by bare name through PATH
  (the npm cmd-shim pattern, e.g. `pnpm.cmd` invoking `"node"`), `%~dp0` is the
  **current directory**, not the batch file's directory. The `pi.cmd` /
  `npm.cmd` / `npx.cmd` prologues therefore locate themselves on PATH when the
  runtime is not beside `%~dp0`, and they treat `PI_DESKTOP_NODE` as an optional
  override rather than a requirement. `gen-shims.mjs` writes only the target
  platform's files and prunes retired/foreign names (including an older
  `node.cmd`).
- **Windows `tar`.** `fetch-runtime.mjs` calls `%SystemRoot%\System32\tar.exe`
  explicitly: a Git-Bash GNU tar earlier on PATH reads `C:\…` as a remote host and
  fails with _Cannot connect to C_. PowerShell `Expand-Archive` is the fallback.
- **Cold start.** The first host launch on Windows can take >10 s while Defender
  and NTFS walk thousands of SDK files; the live tests therefore use a 90 s spawn
  timeout. Warm starts are ~1.2 s. Step 23 (performance) owns making this visible
  and pre-warming the last session.
- **Electron's Node is never used.** `process.execPath` in Electron reports the
  Electron version, which would pass a naive semver gate; `environment.ts` only
  offers it as a fallback when running under plain Node.

## Packaging the runtime (plan step 26)

`resources/runtime` is fetched per platform and is not committed. `npm run
package:win` fetches the host platform, builds, runs `runtime:verify` and only
then invokes electron-builder; `package:mac` and `package:linux` fetch **all**
platforms first, because those targets build more than the packager's own arch
(macOS builds arm64 + x64, Linux builds x64 + arm64), and a beta release should
not depend on the packager's host arch. Foreign runtimes are verified statically
(see above), so this works from any host.

`--all` writes no shims on purpose — a shim names one `<platform>-<arch>` node
binary, so it is per platform — and `resources/runtime/bin` is gitignored. All
three package scripts therefore run `npm run runtime:shims` before
`runtime:verify`, which is what makes a fresh clone able to verify the runtime it
is about to ship. The generator writes only the target platform's shim set and
prunes any known shim name it did not write, so a shared dev `bin/` cannot keep a
stale `node.cmd` or a foreign-platform `.cmd` twin.

`electron-builder.yml` copies the directory into the app as
`extraResources/runtime` (the app reads it by path, outside the asar) and lists
it in `asarUnpack`. `resolveAppRoots`/`resolveAppRuntime` therefore see the same
layout packaged as in development, and `runtime:verify` proves it before an
installer is produced. `tests/packaging/builder-config.test.ts` checks that
`node.lock.json` has an artifact for every platform the builder targets.

That copy is whole-directory, which is too much when several runtimes are
installed. The `afterPack` hook therefore prunes `runtime/node` down to the
`<platform>-<arch>` the package is being built for, keeping `node.lock.json`,
the runtime README and the regenerated `bin/` shims. There are two reasons: an
installer should not carry ~100 MB per foreign runtime, and on Windows the NSIS
step compresses the packaged app with 7za, which exits 1 on the Linux
distribution's `bin/{npm,npx,corepack}` symlinks (_The directory name is
invalid_) — without the prune, a Windows installer cannot be built from a tree
that also holds a Linux runtime. `afterPack` runs per architecture into its own
app directory, so a multi-arch Linux or macOS build still ships exactly one
runtime per package.
