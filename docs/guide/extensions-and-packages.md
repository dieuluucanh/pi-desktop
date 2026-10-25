# Extensions and packages

Pi Desktop loads the **same** extensions, skills, prompts, themes and packages as
terminal Pi, from the shared profile and each project’s `.pi/`. The
**Extensions** view is the hub; it works with or without a session tab open.

## The hub

- **Search** across every resource, and a status banner when a loader error
  exists.
- **Per-kind sections** — extensions, skills, prompts, themes — each row showing
  its source (global/profile vs project), provenance (built-in, user, project,
  package) and what it contributes: tools, commands, shortcuts, flags.
- **Enable / disable** toggles write Pi’s documented settings-array filters
  (`-path` to exclude, `+path` to include) in the resource’s own scope, then
  reload. A disabled resource stays listed so it can be re-enabled; a `+path` Pi
  did not load is reported as a diagnostic, never invented.
- **Reload runtime** (`/reload`) reloads a live session host and shows a diff of
  what changed.
- **Diagnostics** show loader errors and a bounded history of live
  `extension_error` events, so a broken extension is visible instead of silent.
- **Recommended for Pi Desktop** is a small, checked-in set. Installing runs the
  package manager with the exact source shown on the card.
- **What can extensions do?** states the privilege model: extensions are **not
  sandboxed**, which is why installs require consent and safe mode exists.

The Office integration lives under **Integrations** at the bottom of the hub —
see [Pi for Office](office-setup.md).

## Packages

The **Packages** section installs, updates, removes and pins Pi packages.

- Sources: `npm:pkg[@version]`, a bare name (normalised to `npm:`), `git:…`, a
  GitHub URL, or an absolute/relative path.
- **Scope**: user (profile, the default) or project (`<project>/.pi/npm`). A
  project-scope request without a project is refused rather than installed
  somewhere else. The default is user/global, matching terminal Pi. Project
  scope is available only while the project’s **Use project settings** switch is
  on; otherwise enable it in the project panel first.
- **Pin / unpin** reinstall the exact installed version, or the latest. Git and
  path sources have no pin action.
- **Update** one package or **Update all**; npm’s output tail is shown, and a
  failure carries actionable hints (offline, 404, auth, peer dependency).
- **Consent is required** before any install or update: a dialog states that
  extensions run with full system access and shows the source verbatim. The host
  enforces this — a renderer that skipped the dialog cannot install anything.
- Installs use the **bundled npm**, so they work with no system Node or npm.

A browsable gallery is a read-only link to <https://pi.dev/packages>; the app
never installs from a feed silently.

## Extension UI in the app

Extensions see the desktop as a `tui` host and behave as they do in the
terminal: dialogs (`select`, `confirm`, `input`, `editor`), notifications,
status-bar entries, widgets around the composer, working state, autocomplete
providers, custom tool/message renderers, footers/headers/editors and
`ctx.ui.custom()` components rendered as ANSI frames. The full member-by-member
mapping is in
[architecture/extension-ui.md](../architecture/extension-ui.md).

## Safe mode

Start with `--safe-mode` (or `PI_DESKTOP_SAFE_MODE=1`) to load **no**
third-party code: every loader collection is disabled, package mutations are
refused, and the app starts no session host on its own. Use it to recover from a
bad install. See [Troubleshooting](troubleshooting.md).

## Where resources are configured

```text
~/.pi/agent/
├── settings.json         the packages/extensions/skills/prompts/themes arrays
├── npm/                  user-scope package installs (pi-extensions layout)
├── extensions/ skills/ prompts/ themes/
└── keybindings.json
<project>/.pi/
├── settings.json         project-scope arrays and overrides
├── extensions/ skills/ prompts/ themes/
└── npm/                  project-scope package installs
```

Project resources load only when the project is trusted — see
[Projects](projects.md).

## Related

- [Settings](settings.md) · [Skills, themes and keybindings](skills-themes-keybindings.md)
- [Pi for Office](office-setup.md) · [FAQ](faq.md)
