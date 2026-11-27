# Packaged/offline Workflow acceptance (plan step 39)

Plan: `.pi/plans/2026-11-22-prompt-refinement-workflow-parity.md`, step 39 —
"Validate packaged/offline Desktop and platform behavior".

This file is the **evidence record**, not a new contract. It lists the local
package that was built (without publishing), the rows the packaged bytes were
made to prove, the two defects the run found and fixed, and the platform rows
that could **not** be run here. An unrun row is a release blocker, never an
implied pass.

## Environment and exact versions

Recorded while producing the rows below (Windows, automated session; no
interactive GUI/TTY and no authorized live provider).

| Component                               | Version / evidence                                                                                |
| --------------------------------------- | ------------------------------------------------------------------------------------------------- |
| OS                                      | `Microsoft Windows [Version 10.0.26300.9974]`                                                     |
| Desktop app                             | `0.11.0`, commit `b59a40710d79`, channel `local` (`build-info.json`)                              |
| Electron                                | `44.4.3`                                                                                          |
| Bundled Node (what the package runs on) | `v24.22.2` (`resources/runtime/node/win32-x64/node.exe`)                                          |
| Pi SDK / agent                          | `@earendil-works/pi-coding-agent 1.5.0` (exact pin)                                               |
| Workflow extension (W)                  | `@dieulc/workflow 0.13.0`, 90 staged files                                                        |
| Bundle integrity                        | `sha512-4ZJnYM2X0okttM59ZUZtMnIMCkyi7gaV4LxpoJTZabfcmi4c8mUg1TXHvUTRZNQi1SFnbk5ErMdxc9bz49Oc6g==` |
| Package used for the rows               | `release/win-unpacked` (local, unsigned, `--publish never`)                                       |

## How the package was produced (no publish, no bump)

```bash
npm run workflow:verify                       # pin still matches every staged byte
npm run build                                 # host + main + renderer
npx electron-builder --win --dir --publish never
```

`--dir` writes an unpacked Windows package under `release/win-unpacked`; nothing
was signed with a release identity, tagged, uploaded or installed. The staged
artifact is the pinned `0.13.0` copy (`resources/extensions/workflow`), and the
build also carries the unpacked host-build sibling
(`resources/app.asar.unpacked/out/extensions/workflow`).

To prove the package does not secretly depend on the developer checkout it was
built in, the same directory was copied to
`%TEMP%\pi desktop acceptance\Pi Desktop` (a path with spaces, outside the
repository) and every row below was run against **that** copy. Running it only
inside `release/win-unpacked` would have hidden the defect described next.

## Defects found and fixed in this row

### 1. The packaged bundle only resolved host peers inside the checkout

`resources/extensions/workflow` imports the Pi SDK family and `typebox`. Node
resolves a bare import by walking up from the importing file, so inside a
developer build it found `C:\…\pi-desktop\node_modules` above `release/`. In an
installed layout there is nothing above `<resources>/extensions/`, and the
extension failed to load:

```
Cannot find package '@earendil-works/pi-coding-agent' imported from
<install>/resources/extensions/workflow/index.ts
```

`builtin:workflow` was reported as registered (that only says the factory was
handed over) while the hub showed zero Workflow rows. Fix:
`src/main/runtime/workflow-bundle.ts` now prefers
`<resources>/app.asar.unpacked/out/extensions/workflow`, which sits beside
`app.asar.unpacked/node_modules`, and keeps the `extraResources` copy as a
fallback. Tests: `tests/runtime/workflow-bundle.test.ts`.

### 2. A missing/corrupt bundle produced no repair diagnostics

The hub showed no Workflow row and no diagnostic, so a user could not tell why
Workflow vanished or what to do. `src/host/resources.ts` now adds, for
`disabledBy: "missing-bundle" | "invalid-bundle"`, one error per recorded problem
plus a `repair:` warning with the existing hint. Safe mode, a loaded copy and the
user's own `-builtin:workflow` opt-out add nothing. Tests:
`tests/host/resources.test.ts`.

## Rows run against the packaged bytes

Command (from the repository root):

```bash
node scripts/verify-packaged-workflow.mjs --dir "%TEMP%\pi desktop acceptance\Pi Desktop"
# or against the build output directly:
node scripts/verify-packaged-workflow.mjs --dir release/win-unpacked
```

Every spawned process is the **packaged** runtime: the bundled Node, the packaged
`app.asar.unpacked/out/host/index.mjs`, a fresh empty `PI_CODING_AGENT_DIR` and
`HOME`, a `PATH` containing one empty directory (no system `pi`/`node`/`npm`),
and proxy variables pointed at `127.0.0.1:9` so any network attempt fails rather
than passing because the machine was online.

| Row                          | What it proves                                                                                                                                                                          | Windows status |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `artifact-integrity`         | Both shipped copies of `@dieulc/workflow@0.13.0` match `resources/workflow.lock.json` (90 files, per-file sha256), the metadata document and the entry.                                 | PASS           |
| `artifact-self-contained`    | No developer-checkout path in the artifact, no runtime dependencies, no install-time lifecycle scripts.                                                                                 | PASS           |
| `clean-profile-registration` | A clean profile with no installed Workflow and no system Pi loads **exactly one** Workflow registration: `builtin:workflow`, version `0.13.0`, source bundled, enabled, no diagnostics. | PASS           |
| `offline-startup`            | The packaged host answers `host.hello` / `resources.list` with every network path blocked (Node `v24.22.2`, Pi `1.5.0`) and writes nothing to stderr.                                   | PASS           |
| `refinement-capability`      | The packaged artifact advertises the refinement surface: `/prompt`, `/prompt-model`, `/prompt-refine`, `/prompt-refine-companion`.                                                      | PASS           |
| `parity-commands`            | 33 commands advertised, including the representative parity slice (modes/`workflow-cycle`, `/role`, `/profile`, policies, `/commit`, review, handoff, todos, rewind, btw).              | PASS           |
| `child-cli-launch`           | The packaged Pi CLI (`dist/bundle/cli.js` under `app.asar.unpacked`) runs under the bundled Node with the hostile env; `--version` prints `1.5.0`, `--help` exits 0.                    | PASS           |
| `restart`                    | Starting the host a second time against the same profile is identical: one registration, same pinned version, no duplication.                                                           | PASS           |
| `explicit-override`          | `PI_DESKTOP_WORKFLOW_BUNDLE_DIR` pointing at a valid copy outside the package wins and registers exactly once.                                                                          | PASS           |
| `disable-optout`             | `extensions: ["-builtin:workflow"]` loads nothing, advertises no commands, and leaves one disabled, re-enableable builtin row.                                                          | PASS           |
| `safe-mode`                  | Safe mode registers no builtin (`disabledBy: "safe-mode"`), lists zero extensions and reads nothing third-party.                                                                        | PASS           |
| `broken-bundle`              | A corrupt override is reported as `invalid-bundle`: no registration, no `/prompt`, and the hub carries the repair error plus `repair: run \`npm run workflow:stage\` …`.                | PASS           |

Summary line from the run: **12/12 rows passed** (2026-11-24, run against the
copy outside the checkout as well as `release/win-unpacked`).

## Draft preservation and fail-closed behavior

The packaged evidence for "never execute a request without its intended
refinement":

1. With a broken or missing bundle the host reports `registered: false` and the
   hub lists **no** Workflow commands (`broken-bundle` above). A typed `/prompt`
   is therefore an unknown command; Desktop's command router turns that into a
   hint and never falls through to `prompt` (`app-store.ts:runCommandInput`,
   covered by the renderer tests).
2. An armed Send cannot exist without an advertised, enabled composer control, so
   there is no path that dispatches the draft as a normal send when the transform
   capability is absent (`composer-send.ts`, `composer-command-route.ts`).
3. The hub now explains the fault instead of staying silent (defect 2 above), so
   the user sees the repair step rather than a phantom missing feature.
4. Draft/attachment preservation on live operation failures is covered by the
   renderer/E2E rows in
   `docs/architecture/refinement-acceptance-2026-11-24.md`; this row adds the
   packaged-artifact half of the chain.

## Platform matrix

| Platform | Runtime/argv/package paths                                                                                                                         | Keyboard/GUI                                                |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Windows  | PASS — packaged runtime, bundled Node argv, Pi CLI launch, bundle resolution, restart                                                              | **NOT RUN** — no interactive GUI automation in this session |
| macOS    | **NOT RUN — release blocker.** Needs the same script on `darwin` (`--platform darwin`), a `release/mac*` package, and the packaged `--dir` layout. | **NOT RUN — release blocker**                               |
| Linux    | **NOT RUN — release blocker.** Needs the same script on `linux`, a `release/linux-unpacked` package, and the packaged `--dir` layout.              | **NOT RUN — release blocker**                               |

The script accepts `--platform`/`--arch` so the macOS/Linux runs are the same
code path, not a rewritten check. Until each returns 12/12, packaged macOS/Linux
support is unverified.

## Not run in this row

- Packaged GUI keyboard/dialog interaction (toggle, question docking, Esc, focus,
  native dialogs) — the automated session has no interactive desktop.
- Playwright against the packaged application (the composer suite runs against
  the repo build; see the step-36 record).
- A real-provider refinement in the packaged app — no authorized live model.
- macOS and Linux packages — not buildable/not runnable here.
- Code signing, installer (`--dir` only), auto-update and release publication —
  out of scope; nothing was published.

## Reproduce

```bash
cd <pi-desktop>
npm run workflow:verify
npm run build
npx electron-builder --win --dir --publish never
node scripts/verify-packaged-workflow.mjs --dir release/win-unpacked
# and outside the checkout, which is what actually catches peer-resolution bugs:
cp -r release/win-unpacked "$TEMP/Pi Desktop acceptance"
node scripts/verify-packaged-workflow.mjs --dir "$TEMP/Pi Desktop acceptance"
npx vitest run tests/runtime/workflow-bundle.test.ts \
  tests/packaging/packaged-workflow-acceptance.test.ts \
  tests/host/resources.test.ts
```

## Row 40 acceptance review

Row 40 re-ran the packaged/platform evidence above together with the parity
matrix, quality record and security/compatibility suites. No packaged row or
platform result changed: Windows packaged rows are 12/12 in
`release/win-unpacked`, and macOS/Linux remain **NOT RUN — release blockers**.

One reproducible acceptance failure was found and fixed outside the packaged
rows: this step-39 record was missing from `site/src/data/nav.mjs`, so
`tests/site/site-contract.test.ts` › "names every user/architecture/product doc
in the navigation" failed. The nav entry was added and the existing contract
test is the regression guard. It is a documentation/navigation defect, not a
change to packaged behaviour or scope.

Gates rerun after the fix (all exit 0): D `format:check`, `typecheck`, `lint`
(0 errors), full `vitest` (6130 passed, 4 skipped), `build`, `workflow:verify`,
`workflow:package:verify --dir release/win-unpacked` (12/12) and the
architecture/host/packaging suites (1145 passed, 3 skipped). The live-provider,
GUI keyboard, Playwright-against-package and macOS/Linux items listed above
remain NOT RUN and are not implied by any automated pass.
