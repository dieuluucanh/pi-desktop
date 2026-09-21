# Models and thinking

The session header shows the current model, the thinking level, a context-usage
ring and the token/cost totals. Each of these has a picker.

## Choosing a model

Open the model picker from the header or with `/model`. It groups models by
provider and shows:

- **auth badges** — a provider you are not signed in to says “Sign in” and routes
  to Connections;
- **search** and your **favourites** (stored as an app preference, not Pi state);
- the **scoped models** Pi is configured to offer (`enabledModels`);
- the thinking levels the selected model supports;
- the model the session actually reports, which may differ from the one you
  asked for if the provider resolves a catalog entry to its own choice. The app
  shows the recorded model rather than the requested one.

You can apply a model **for this session only** or tick **save as default**,
which writes the durable Pi setting. A project can define its own default model
and thinking level (see [Projects](projects.md)).

Switching models mid-session records a `model_change` entry in the session file,
so resuming restores the same model.

## Thinking level

`/thinking`, the header picker, or `Ctrl/Cmd+Alt+T` cycles the level. The list is
clamped to `getAvailableThinkingLevels()` for the current model, so you can never
select a level the model does not support. A model without auth shows a single
“off/low” set and a sign-in route.

Cycling shortcuts (from Pi’s keybindings):

| Action               | Default          |
| -------------------- | ---------------- |
| Next model           | `Ctrl/Cmd+Alt+↓` |
| Previous model       | `Ctrl/Cmd+Alt+↑` |
| Cycle thinking level | `Ctrl/Cmd+Alt+T` |

These are editable in `keybindings.json` (see
[Skills, themes and keybindings](skills-themes-keybindings.md)).

## Usage

The header’s ring reads Pi’s own `contextUsage` (percent of the context window)
and the footer shows tokens and cost from `getSessionStats()`. Long sessions can
be compacted manually with `/compact`, or automatically according to the
compaction settings.

## View mode

The session header’s **view mode** controls how much tool detail the transcript
shows:

- **Normal** — tool cards collapsed to a summary.
- **Verbose** — every tool call expanded.
- **Summary** — the most compact rendering.

The mode is an app preference (`prefs.viewMode`) and persists across sessions. It
also overrides the `app.tools.expand` binding (`Ctrl+O`) for the transcript.

## Related

- [Providers and auth](providers-and-auth.md) · [Settings](settings.md)
- [Sessions and tabs](sessions-and-tabs.md)
