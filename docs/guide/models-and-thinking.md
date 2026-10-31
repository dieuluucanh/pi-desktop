# Models and thinking

The session header shows the current model, the thinking level, a context-usage
ring and the token/cost totals. Each of these has a picker.

## Choosing a model

Open the model picker from the header or with `/model`. It groups models by
provider and shows:

- **auth badges** — a provider you are not signed in to says “Sign in” and routes
  to Connections;
- **search**;
- your **model scope** (`enabledModels`) — the starred models, listed first;
- the thinking level the selected model supports;
- the model the session actually reports, which may differ from the one you
  asked for if the provider resolves a catalog entry to its own choice. The app
  shows the recorded model rather than the requested one.

You can apply a model for this session; picking one **also saves it as the
default**, so the next session starts on it (there is no “save as default”
switch to tick). The durable value is Pi’s `defaultProvider`/`defaultModel`
(plus `defaultThinkingLevel` when you change the level); choosing a thinking
level saves that too. A project can define its own default model and thinking
level (see [Projects](projects.md)).

When the workflow extension is installed it additionally records
`workflow.modelDefault`, which makes the choice stick even when the model is not
in your scope: Pi’s own startup resolution prefers the first `enabledModels`
entry over a saved default, and the extension applies its record on
`session_start` for a new session. `/profile use` and `/role set` in that
extension save their model the same way, so the most recent model, profile or
role choice wins.

Switching models mid-session records a `model_change` entry in the session file,
so resuming restores the same model.

## Model scope

The star in the model picker is Pi’s **model scope** (`enabledModels`), the same
list as _Settings → Model scope_. It is the set used by `Ctrl/Cmd+Alt+↓/↑`
cycling and by extension model pickers such as `/profile` and `/role`, so one
star controls all of them:

- **starred** — in scope; the dialog lists these first under **Scoped**;
- **no stars** — no scope is configured, so every available model is usable and
  cycling covers all of them (the dialog says so);
- **changing it** writes `enabledModels` immediately and applies it to every open
  session. If the project’s **Use project settings** switch is on, the edit goes
  to `<project>/.pi/settings.json`; otherwise it goes to the shared global
  settings. The picker says which target is active.

The dialog still lists every available model. Selecting one outside the scope is
allowed (it is added to a non-empty scope), so a star click never makes a model
unreachable. A persisted pattern that matches no currently available model stays
in settings and applies again when the model returns.

Desktop re-reads the shared file when the picker opens, the window regains
focus, Settings is reloaded, or a session starts. A running terminal Pi needs a
restart to update its live `ctx.scopedModels`; `/reload` alone only refreshes its
settings cache.

Editing the same global list in Settings is equivalent. Project scope is edited
from the project panel (the Settings switch and **Edit JSON…**).

`/scoped-models` opens the same picker (Pi’s terminal command name); the star
remains the only persisted scope state.

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

Next/Previous model walk the **model scope** (see above); with no scope
configured they walk every available model.

These are editable in `keybindings.json` (see
[Skills, themes and keybindings](skills-themes-keybindings.md)).

## Usage

The header’s ring reads Pi’s own `contextUsage` (percent of the context window)
and the footer shows tokens and cost from `getSessionStats()`. Long sessions can
be compacted manually with `/compact`, or automatically according to the
compaction settings.

## Tool detail

Tool cards and command prompts are expanded or collapsed with
<kbd>Ctrl</kbd>+<kbd>O</kbd> (Pi's `app.tools.expand`), and each card also has its
own chevron. There is no Normal/Verbose/Summary mode: the app follows terminal
Pi here, where Ctrl+O is the only expand-all switch. Command prompts stay
collapsed by default; `prefs.showExpandedPrompts` changes that default for plain
prompts and commands such as `/commit`.

## Related

- [Providers and auth](providers-and-auth.md) · [Settings](settings.md)
- [Sessions and tabs](sessions-and-tabs.md)
