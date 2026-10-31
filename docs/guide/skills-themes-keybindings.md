# Skills, themes and keybindings

The **Skills** view gathers Pi’s prompt-side resources and the app’s appearance
and key configuration. All of it reads and writes the shared profile, so
terminal Pi sees the same things.

## Skills and prompt templates

Each skill row shows its name, description, source, scope and provenance. **Run**
inserts `/skill:<name>` into the composer — it never sends silently, so you can
add context or arguments first. Prompt templates are listed with their argument
hints; invoking one fills the arguments and sends through Pi, which expands the
template.

Everything else (extension commands, templates) is reachable through `/` in the
composer. See [Extensions and packages](extensions-and-packages.md).

## Themes

Themes are listed as built-in, user or project. Each row shows:

- a **swatch preview** resolved from the theme’s colours (including the ANSI-256
  ramp);
- scope and variant badges;
- an **Import `.json`** action for a user/project theme file;
- the whole row is a **radio** — click anywhere on it (including its swatches)
  to apply that theme. The active row is checked and shows **Active**; applying
  another writes Pi’s `theme` setting and recolours the app chrome.

The active Pi theme drives both the TUI surface extensions render into **and**
the app chrome: `src/renderer/src/styles/tokens.css` maps the theme’s colours to
the app’s CSS variables. The catalogue is loaded at startup, so the selected
theme applies without visiting this view; `prefs.theme` only caches the active
theme’s dark/light variant for the first frame before the catalogue answers.

**Match system appearance** is a switch above the catalogue. While it is on,
the app watches the OS light/dark setting and activates the built-in `dark` or
`light` theme (writing Pi’s `theme` setting so terminal Pi follows too). It is
off by default; choosing any theme manually turns it off. Custom themes are
always explicit choices — there is no meaningful way for them to follow the OS.

## Keybindings

`keybindings.json` is edited in a grouped table using the documented, namespaced
ids. Behaviour:

- Only **overrides** are saved; unchanged rows stay out of the file.
- Clearing a row unbinds it (an empty array); **Reset** deletes the file.
- Keys are validated before writing, and a canonical form is shown.
- **Conflicts** are detected. Pi’s own defaults collide across modal contexts by
  design, so the full list is informational; only a conflict involving one of
  _your_ overrides warns.

The effective bindings are installed into the host, so extension components
render the right `keyHint()` strings and extension shortcuts fire with the
remapped key.

## Desktop shortcuts

The app owns a small set of actions that Pi does not (tabs, the command palette,
the session browser, Settings, updates, find in transcript). They live in
**Skills, themes & keys → Desktop shortcuts** as `UiPrefs.desktopKeybindings`, a
separate map from `keybindings.json`:

- **Change** starts capturing: press the chord (Backspace removes the last one,
  Escape cancels). `Cmd`/`Meta` is not part of Pi's key grammar and is rejected.
- A chord chip can be clicked to remove it; **Reset** restores that row's
  defaults and drops the override.
- Only rows that differ from the defaults are stored. A row whose chords match
  the defaults again disappears from the map.
- The menu's accelerators come from this registry, so remapping "New session"
  also moves the File menu item. Menu accelerators are restricted to
  menu/global actions — an accelerator fires before the renderer and would
  swallow a composer key.
- A real collision (another desktop action, a Pi binding, or a live extension
  shortcut) is flagged per scope. Pi's own cross-modal duplicates stay
  informational, exactly as in the `keybindings.json` editor.

Pi actions (`app.message.copy`, `app.editor.external`, `app.tools.expand`,
`app.message.followUp`, …) are **not** duplicated there: remap them in
`keybindings.json` and the desktop dispatcher follows, because it resolves them
from `keybindings.effective`.

## Shortcuts help

`Ctrl/Cmd+/` opens the shortcuts dialog, grouped into desktop commands, Pi
bindings and extension shortcuts. Extension shortcuts are listed from the live
runner with the effective bindings and invoked through the host, so the handler
runs with the right context.

While the composer has focus, extension shortcuts are scoped to non-editing
targets so typing is never hijacked; `Meta`/`Cmd` chords belong to the
application menu.

## Related

- [Extensions and packages](extensions-and-packages.md) · [Settings](settings.md)
- [architecture/extension-ui.md](../architecture/extension-ui.md)
