# Settings

The **Settings** view edits every key in Pi’s `docs/settings.md`, global or
per project, plus a raw JSON editor. Because it writes Pi’s own `settings.json`,
terminal Pi sees the change immediately.

## Groups

| Group             | What it covers                                           |
| ----------------- | -------------------------------------------------------- |
| Model & Thinking  | Startup provider/model, thinking level, per-model levels |
| UI & Display      | Theme, editor chrome, tree filters, analytics            |
| Network           | Proxy and network settings                               |
| Warnings          | Transcript warnings the agent may show                   |
| Compaction        | When and how the conversation is compacted               |
| Branch Summary    | How branch history is summarised                         |
| Retry             | Automatic retries for transient provider errors          |
| Message Delivery  | Steering/follow-up modes and transport timeouts          |
| Terminal & Images | Terminal rendering overrides and image handling          |
| Shell             | The shell and npm used for tools and packages            |
| Tools             | Which built-in tools are enabled at startup              |
| Sessions          | Where session files are stored                           |
| Model Cycling     | Model patterns included when cycling                     |
| Markdown          | Code-block indentation and Mermaid rendering             |
| Resources         | Packages, extensions, skills, prompts and themes         |

Each field shows a **provenance badge** — where its effective value came from
(default, global, project). Values are validated before anything is written; an
invalid value shows an inline error and never corrupts the file.

## Global vs project scope

Every key is editable in either scope. Project scope is disabled while a project
is untrusted. Project values win with Pi’s nested-merge semantics, so a project
can override one nested key without replacing the whole object. A **save to
project** action promotes the current value.

Use the per-field scope switch to move a value between scopes.

## Raw JSON, diff and reset

- **Raw JSON** opens a dialog with a scope tab (global/project), formats the
  document, and lets you copy it out or paste an import. The paste is validated
  against the schema before it is written.
- **Diff vs defaults** shows exactly what differs from Pi’s defaults.
- **Reset** clears a single field or a whole scope.

## Safety

- `settings.json` is **backed up** to the app’s `userData/backups` directory
  before the first write per file per host process.
- A **malformed** file is reported, never repaired silently, and never
  overwritten.
- If terminal Pi edits the file while the app is open, an **external edit**
  banner appears (detected by mtime) with **Reload from disk**.
- `/reload` reloads extensions and settings in a live session.

## Preferences that are _not_ Pi settings

A few things live in app state on purpose, so they never change terminal Pi’s
behaviour:

- theme fallback before Pi’s theme loads (`prefs.theme`);
- sidebar layout, view mode, favourites and per-tab drafts;
- telemetry opt-in (`PI_TELEMETRY=0` unless enabled);
- the Pi profile choice (shared vs app-private);
- `externalEditor` is a Pi setting, but the launcher that spawns the editor is
  app-side.

## Related

- [Providers and auth](providers-and-auth.md) · [Extensions and packages](extensions-and-packages.md)
- [architecture/app-shell.md](../architecture/app-shell.md)
