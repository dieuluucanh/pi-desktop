# Models and thinking

The composer's controls show the current model (the icon's tooltip), the
thinking level as a four-fill brain icon, a context-usage ring and the
token/cost totals. Each of these has a picker.

## Choosing a model

Open the model picker from the composer's model icon or with `/model`. It groups models by
provider and shows:

- **auth badges** — a provider you are not signed in to says “Sign in” and routes
  to Connections;
- **search**;
- your **model scope** (`enabledModels`) — the starred models, listed first;
- **the thinking levels each model supports**, previewed on its row before you
  select it (Pi's `thinkingLevelMap` is the authority);
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

- **starred** — in scope; the dialog lists these first under **Scoped**, each
  row prefixed with its provider (e.g. `anthropic / Sonnet 4.5`) so two
  providers exposing the same model name stay distinguishable;
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

### Model ids, scope patterns and the saved default

Three rules explain most “the wrong model started” reports, so they are stated
here for anyone editing this area:

1. **A model id may contain a colon.** The synthetic gateway uses `hf:` ids such
   as `hf:deepseek-ai/DeepSeek-V4.1-Flash-1017`.
2. **Pi reads a scope pattern from its last colon.** `provider/id:level` is
   parsed by splitting at the last `:`; if the tail is not a thinking level, Pi
   keeps the whole string as an id and fails to match it. A colon-bearing id
   therefore cannot be written as a scope pattern — writing one produces
   `Invalid thinking level … in pattern …` and silently drops the model from the
   scope. The app never writes such a pattern: it goes through one rule
   (`scopePatternFor` in `src/shared/model-scope.ts`), refuses the write, and
   shows the resolver warning in the picker instead of swallowing it.
3. **A saved default that does not resolve is a silent fallback, so the app says
   it out loud.** For a brand-new session Pi prefers the **first scoped model**,
   then `defaultProvider`/`defaultModel` if the catalogue resolves it, then the
   first available model. When the catalogue does not contain the saved id (for
   example before the provider’s live model list has loaded, or after a provider
   renames a snapshot), the session starts somewhere the user never chose. The
   picker then shows “Saved default model … is not in the catalogue”, Diagnostics
   records one incident, and picking a model replaces the default. The app never
   rewrites `defaultModel` behind the user’s back.

If a provider publishes a new snapshot id, declare it in the profile’s model
list (`models.ts`) so the offline/startup fallback agrees with the live list; the
app itself never edits that catalogue.

## Thinking level

`/thinking`, the composer's brain icon, or `Ctrl/Cmd+Alt+T` cycles the level. The
picker shows the full seven-level scale — `off`, `minimal`, `low`, `medium`,
`high`, `xhigh`, `max` — plus any custom level the host reports. Levels the
selected model does not expose are shown disabled and marked “not supported”, so
the whole vocabulary is visible without the app pretending an unsupported level
will take effect; switching models updates the enabled set. The picker names the
model and sorts the levels canonically. A model without auth shows a single
“off/low” set and a sign-in route.

The brain icon has four fill states plus an empty `off` outline:

| Level            | Brain fill    |
| ---------------- | ------------- |
| `off`            | empty outline |
| `minimal`, `low` | 1/4           |
| `medium`         | 1/2           |
| `high`           | 3/4           |
| `xhigh`, `max`   | full          |

Hovering the icon shows the exact level, its description, the current model and
the model's supported set, so `xhigh` and `max` never look identical by accident.

The workflow extension's `/profile` and `/role` editors use the same model
capability data: when a model disables `minimal` or `medium`, those levels are
not offered, and an unsupported value already stored in a profile is clamped on
save or activation with a warning.

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

The composer's ring reads Pi's own `contextUsage` (percent of the context window)
and the session footer shows tokens and cost from `getSessionStats()`. Long sessions can
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
