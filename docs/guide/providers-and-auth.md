# Providers and auth

Pi Desktop uses Pi’s own provider layer, so anything you connect here is
immediately visible to terminal Pi — and vice versa. Credentials live in the
profile’s `auth.json` (mode `0600`), written by Pi, never by hand.

Open **Connections** from the sidebar, the command palette, or `/login` /
`/logout`. Providers are grouped into:

- **Subscriptions** — OAuth sign-in (e.g. Anthropic, GitHub Copilot-style
  providers that advertise an OAuth flow).
- **API keys** — paste a key once; it is written through Pi and never read back.
- **Local** — runtimes such as Ollama or LM Studio; usually configured by their
  own environment, nothing to set up here.

## Signing in

Open a provider’s sheet to see its status badge, auth methods, model count and
environment variables. Then:

- **Sign in (OAuth)** — the app opens the provider’s authorization URL in your
  system browser. A device code, progress and any interactive prompt appear in a
  dialog; a code-paste fallback is offered where the provider needs it. Sign-in
  starts immediately (it is never cancelled by a request timeout) and can be
  cancelled from the dialog.
- **API key** — the key field is **write-only**. The app asks Pi to persist it,
  the field is cleared, and the app can only ever see a redacted status
  afterwards. A runtime-only key can be set for the current host without saving
  it to `auth.json`.
- **Sign out** — removes the credential through Pi.

The sheet also shows **“Visible to terminal Pi”** and a **Reveal auth.json**
button, so it is clear that this is the shared profile, not an app-private
secret.

## Custom models and gateways

`Connections → Custom gateways` edits Pi’s `models.json`: id, name, base URL,
API flavour, API key, headers, compatibility flags and the model list. The file
is written **atomically**, and the app verifies the entry loads in a throw-away
Pi runtime before keeping it; on failure the previous bytes are restored. A
malformed file is surfaced, never overwritten.

Pi’s own schema accepts **any** non-empty string as a model id, and real catalogs
ship ids containing `/`, `:`, `~` and `@` (`~anthropic/claude-opus-latest`,
`@cf/meta/llama-3.1-8b-instruct`). The editor allows the same, so a HuggingFace
or router-style id works as-is:

- **Model ids** are comma-separated. An id may contain `/`, `:`, `~`, `@` and
  other punctuation — e.g. `hf:deepseek-ai/DeepSeek-V4.1-Flash` — but not
  whitespace, control characters or a comma (a comma would split it into two
  models), and at most 200 characters. A `/` is fine here: Pi tries the full
  `provider/id` reference first, and the provider id below is guaranteed not to
  contain one.
- **Provider ids** follow the same permissive charset, but may not contain `/`
  — Pi splits `provider/model` at the first slash, so one there would make the
  provider’s own models unreferencable and break the model key. They
  are also limited to 64 characters and refuse the JSON-key hazards
  (`__proto__`, `prototype`, `constructor`, `.`, `..`), because the id is the
  key in the file’s `providers` map.
- **A blank API key keeps the stored one.** Leave the field empty to edit a
  gateway without retyping its credential; typing a value replaces it.
- **Editing a gateway keeps what this editor does not show.** Keys written by
  hand — `modelOverrides`, per-model `cost`/`reasoning`/`input`, `oauth`,
  `authHeader` — survive a save from the app exactly as they were. The rendered
  fields (name, base URL, API flavour, the model list) are authoritative, so
  clearing one clears it, and removing a model id from the list removes it from
  the file.

## Proxy and offline

- `httpProxy` (Settings → Network) is a Pi `settings.json` key and is inherited
  by every host.
- `PI_OFFLINE=1` is process-level: when it is set, hosts skip Pi’s startup
  network calls and the app shows an offline banner. Model lists, update checks
  and package installs are unavailable in that state.

## Where credentials live

```text
~/.pi/agent/
├── auth.json     credentials (0600), written through Pi only
└── models.json   custom providers/gateways
```

The renderer has **no** channel that returns credential material — `providers.*`
returns status summaries only. See
[architecture/app-shell.md](../architecture/app-shell.md) for the IPC rules.

## Related

- [Models and thinking](models-and-thinking.md) · [Settings](settings.md)
- [Troubleshooting](troubleshooting.md) · [FAQ](faq.md)
