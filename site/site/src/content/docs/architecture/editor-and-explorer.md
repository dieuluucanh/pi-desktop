---
title: "File explorer and editor"
description: "Status: implemented 2026-11-01 (plan steps 1-13); project-wide search and drag-to-chat extended 2026-11-02. See..."
editUrl: "https://github.com/dieuluucanh/pi-desktop/edit/main/docs/architecture/editor-and-explorer.md"
---

**Status:** implemented 2026-11-01 (plan steps 1-13); project-wide search and
drag-to-chat extended 2026-11-02. See
`.pi/plans/2026-11-01-file-explorer-and-editor.md` and
`.pi/plans/2026-11-02-explorer-search-and-drag-to-chat.md` for the designs.

## Surfaces

- **Explorer** is the first menu in the right rail. It is always presented
  first, even though the persisted three-menu order from older profiles stays
  valid. The tree loads one directory at a time and shows hidden files greyed
  and git-ignored files dimmed; the toolbar can hide either, search names and
  paths across the whole project, and refresh.
- **Explorer search** replaces the tree with a flat ranked result list while a
  query is active. It searches the project's file list, not just the folders
  that happen to be expanded, and has an `x` clear button plus Escape-to-clear.
  The hidden/ignored toggles change the backend flags, so `.pi/plans` is
  searchable when both are on and excluded when `Show ignored` is off.
- **Editor tabs** are ordinary tabs with `kind: "editor"` and a
  project-relative `filePath`. They have no Pi host. They live in their own row
  under the session strip (rendered only while a file is open), so a file never
  competes with a running session for the same strip. The chip shows the
  language badge (`TS`, `JSON`, `MD`, …) and a dirty dot; session tabs keep
  their status dot, web tabs their globe. The row has no redundant “Editors”
  label because the separate row and badge already identify it. Both rows share
  the same active tab: clicking a file replaces the main view (or fills the
  focused grid pane — see the session view grid in `app-shell.md`; one tab can be
  visible in one pane only, because there is one CodeMirror view per tab id).
- **Quick open** (`Ctrl+P`, File → Open File…) searches the flat,
  gitignore-aware file list.
- **Diff** keeps the existing viewer and adds a fullscreen toggle.

## Layers

```
renderer: ExplorerSection / ExplorerRow / ExplorerSearchResults / EditorTabView
          explorer-store, quick-open-store, editor-store + buffer-registry
                       │  window.pi.workspace.*
preload:  workspace bridge (allowlisted IPC only)
main:     ipc.ts parsers → workspace-service.ts
          ├── src/workspace/tree.ts          directory listing + hidden/ignored
          ├── src/workspace/file-listing.ts  flat git/walk listing
          ├── src/workspace/file-search.ts   project-wide name/path ranking
          ├── src/workspace/file-content.ts  read/stat/atomic write + conflict
          ├── src/workspace/editorconfig.ts  .editorconfig
          ├── src/workspace/backup.ts        hot-exit records
          └── src/workspace/path-guard.ts    lexical + realpath containment
```

`src/workspace` is pure Node and injected-port based, shared with the host's
`files.list/read/write` handlers. `src/host/**` still owns the agent-facing file
tools; the explorer/editor use the main-process service because they must work
without a session host.

## Safety

- Renderer paths are project-relative POSIX strings; absolute paths, `..`,
  backslashes and `.git` are rejected in `src/shared/workspace.ts`.
- Main resolves the project against the open-tab/project allowlist, then
  applies `resolveInsideRoot` (lexical + realpath) before every operation.
- Reads cap at 5 MB; editable writes and backups at 2 MB. Larger, binary or
  UTF-16 files open read-only.
- A write carries the mtime the editor loaded; a changed file becomes a
  `conflict` result instead of overwriting the agent's edit. `.git` is never
  written.
- External formatter commands are gated by `prefs.editor.allowCommandFormatters`
  and read from validated prefs in main; the renderer can never supply a
  command. Commands run with `shell: false`, a 10 s timeout and output caps.

## Search

- `workspace:search-files` takes the project folder, the query and the two
  visibility flags. Main applies the same open-project allowlist as the rest of
  the workspace bridge and returns a `WorkspaceResult` envelope.
- `src/workspace/file-search.ts` reuses `listWorkspaceFiles`, so it never reads
  file contents. It matches every whitespace-separated term against the
  project-relative path, ranks basename matches above directory/path matches,
  and caps the result at 200 (500 maximum).
- The non-ignored listing uses `git ls-files -co --exclude-standard` when git is
  available. The ignored-inclusive listing uses the pruning walk so a huge
  build tree cannot overflow the git runner's stdout cap; both modes always
  skip `.git` and `node_modules`.
- Caps are honest: 20 000 candidates, 5 000 directories and depth 16. When a cap
  cuts the list, `truncated` reaches the renderer and the footer says so rather
  than pretending the result is complete.
- The renderer debounces typing by 180 ms and keeps a per-project request id, so
  a slow response for an older query can never overwrite a newer one. Search
  state is per project; switching projects never mixes results.
- No content search, no regex, no result paging. `node_modules` and `.git` are
  not searched; a file there can still be opened by expanding the tree.

## Drag to chat

- Tree rows and search results are HTML5 drag sources. They write
  `application/x-pi-workspace-path` with a small JSON payload
  (`version`, `projectPath`, `path`, `kind`) and `text/plain` as a fallback.
- The composer accepts the typed payload, validates that its `projectPath`
  matches the session `cwd` through `sameFolder`, and inserts an
  `@relative/path` mention at the caret. A directory keeps a trailing `/`; a
  path with whitespace is quoted as `@"path with spaces"` (Pi's convention).
  If the textarea is not focused, the mention is appended at the end.
- The whole session pane is a drop target. A drop on the transcript (or any
  non-composer part) becomes a `mentionRequest` that the composer inserts at
  its caret; a `pointer-events-none` overlay says `Drop to mention this file in
the prompt` while a workspace drag is over the pane. The composer handles a
  drop on itself and the pane only clears the overlay.
- `@path` is plain prompt text: the Pi host does not expand it, the agent reads
  the file with its normal tools. `@` file completion keeps the `@` in the
  inserted value so both entry points produce the same mention.
- A cross-project drop is refused with a hint instead of inserting a path
  relative to the wrong root. The app-level drag guard prevents an external OS
  file drop from navigating the main window to `file://`.

## Data safety

Dirty buffers are debounced to `<userData>/editor-backups/<tabId>.json`. On
load, a backup whose text differs from disk is restored as dirty. Closing a
dirty tab prompts Save / Discard / Cancel; `pagehide`/`blur` flush pending
backups. The main-process quit handshake is the remaining hardening item. A
tab-table publish never replaces a dirty buffer (see **Load and refresh**).

## Load and refresh

The tab table is metadata, not a file event. Main republishes it on state frames
(including `message_end`) and the renderer's `applyTabs` reuses a record whose
fields did not change, so a publish cannot re-read an open file.
`EditorTabView` keys its effect on the tab **id**: a tab with no metadata loads
once, and a remount (switching away and back) only runs the cheap `stat`.

- `editor-store.load` coalesces concurrent reads per tab: the mount effect,
  `openFileTab` and a tab-table publish share one promise.
- Only the first load (no buffer) shows `Loading file…`. A refresh keeps the
  mounted CodeMirror view and shows a small `Reloading…` chip; the new text is
  applied by `editor/doc-sync.ts` as one transaction, so undo history, cursor
  and scroll survive.
- A dirty buffer is never overwritten by a background refresh: the store sets
  `externalChange` and the existing "File changed on disk" banner offers
  **Reload** (forced: replaces the doc and deletes the backup) or **Overwrite**.
- The 4 s external-change poll skips a hidden window, a loading tab and an
  in-flight read.
- Main's `publishTabs` also skips the IPC emit when the envelope is identical to
  the last one it sent.

## Formatting

`Format Document` calls `formatWorkspaceText` in main. Provider order:
user-configured native command → bundled Prettier → `not_configured`.
`.editorconfig` supplies tab width/EOL. Format-on-save is a preference (UI
surface still pending).

## Keyboard

- `Ctrl/Cmd+S` saves the active file. CodeMirror owns the chord while the code
  surface has focus; `EditorTabView` has a container-level fallback for the
  toolbar and any other part of the view. A repeated press reuses the in-flight
  write instead of sending two writes with the same baseline.
- `Shift+Alt+F` formats the active file (same two layers).
- File → Save File / Format Document and the command palette entries have **no**
  Electron accelerator. A menu accelerator fires before the renderer and would
  swallow Pi's selector/TUI-local `Ctrl+S` (`app.thinking.save`,
  `app.models.save`, `app.session.toggleSort`).
- Pi's composer-oriented actions (`Ctrl+O` expand tools, `Ctrl+G` external
  editor) are ignored while the event originates inside `.cm-editor`.
- Both tab rows scroll horizontally with the mouse wheel; `Ctrl/Cmd+wheel`
  remains pinch-zoom. The active tab is revealed when the selection changes;
  the user's manual scroll position survives status/title updates and window
  focus, and native browser focus scrolling covers keyboard traversal. The
  tab-strip horizontal scrollbar is 2 px; the strips reset
  `scrollbar-width`/`scrollbar-color` so the WebKit pixel size applies.

## File actions

Right-click a file, folder, search result or the tree's blank area. Files expose
Open, Add to Chat, Copy/Cut/Paste, Rename, Delete, Reveal, Copy Path and Copy
Relative Path; folders add New File, New Folder and Add Folder to Chat. New
entries use an inline row and a created file opens immediately. Delete is a
recoverable move to the OS Recycle Bin/Trash; rename/move retarget open editor
tabs, and a dirty buffer prompts Save/Discard/Cancel first.

The renderer never receives a permanent-delete API. Main applies the same
project allowlist and realpath guard used by read/write, and existing-source
operations resolve the parent (not the final symlink) so a link can be renamed
or deleted without following it. Copy/move stages through a hidden sibling and
refuses collisions, `.git`, the project root and outside-pointing links.

## Limits / non-goals

No LSP/IntelliSense, no debugger/terminal, no binary preview, no UTF-16 editing,
no OS filesystem watcher (refresh on focus, save and an 8 s poll). Search is
name/path-only (no content snippets), has no regex or paging, and deliberately
never walks `node_modules`/`.git`. Drag and file operations are single-item: the
Explorer has no multi-select, and an external OS file drop has no path bridge
(use the Explorer tree or Quick Open).
