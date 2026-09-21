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
- **Activate**, which writes Pi’s `theme` setting.

The active Pi theme drives both the TUI surface extensions render into **and**
the app chrome: `src/renderer/src/styles/tokens.css` maps the theme’s colours to
the app’s CSS variables. Until Pi’s theme loads, the appearance preference
(`prefs.theme`) paints the first frame.

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
