# FAQ

**Is Pi Desktop the official Pi app?**
No. Pi Desktop is a desktop client built on the Pi coding agent SDK
(`@earendil-works/pi-coding-agent`). Pi itself is by the Pi project; this app is
independent and does not claim to be official.

**Do I need terminal Pi installed?**
No. The app bundles its own Node runtime and the Pi runtime; that is what makes
the “no terminal, no global installs” promise hold. Installing the app is enough.

**Does it share my terminal Pi setup?**
By default, yes: the app uses the same `~/.pi/agent` profile, so sessions,
credentials, extensions, settings, skills and themes are shared in both
directions. Onboarding offers a separate app-private profile if you would rather
keep them apart.

**Can terminal Pi and the app run at the same time?**
Yes, on the same profile. Sessions are separate files; the app writes settings
and credentials through Pi’s own managers, atomically. If terminal Pi edits a
settings file while the app is open, the app detects it and offers a reload
rather than overwriting it.

**Where is my data?**
Sessions and Pi configuration live in the Pi profile (`~/.pi/agent` by default);
project config lives in `<project>/.pi/`; app state (tabs, recents, preferences)
lives in Electron’s `userData`. Nothing Pi-related is stored in app state.

**What happens to my data if I uninstall the app?**
Uninstalling the app does not delete the shared Pi profile — your sessions and
configuration stay where terminal Pi can use them. The app’s own `userData`
(tabs, preferences, logs) is app-only and can be removed separately.

**Does it support MCP?**
Pi deliberately ships no built-in MCP client. Pi Desktop is at parity: an
MCP-bridge extension or package installs through the normal Extensions hub and
then works like any other extension. See
[parity.md](../product/parity.md#mcp).

**Is there an in-app terminal?**
Not in v0.3.0 (it is explicit post-MVP backlog). The app ships a `pi` PATH shim
and can open an external terminal in a project folder.

**Can I open several projects at once?**
Yes — tabs are per session and sessions belong to projects; the sidebar groups
them. There is one window in v0.3.0 (multi-window is backlog).

**Why does Windows/macOS warn when I install it?**
The v0.3.0 artefacts are unsigned. Windows SmartScreen: “More info → Run anyway”;
macOS: right-click → Open. Signing is tracked in the backlog.

**Does the app send telemetry?**
Not unless you opt in. Pi’s install telemetry is forced off with
`PI_TELEMETRY=0`; the first-run screen explains it, and turning it on is an app
preference that never rewrites the shared `settings.json`.

**Can extensions do anything they want?**
Extensions are not sandboxed — the same as terminal Pi. That is why installs
require a consent dialog that names the source, why projects need trust before
project resources load, and why safe mode exists. The app itself is isolated:
sandboxed renderer, strict CSP, allowlisted IPC, web tabs without a preload.

**How do I get a newer version?**
Release builds check GitHub Releases once after launch. An available version
appears as a small **Update vX** chip in the status bar; the full status,
**Download** and **Restart & install** live in **Settings → About & updates**.
`Help → Check for Updates…` opens that card and checks on demand. Locally built
packages are not on the update feed: automatic checks are off and the card says
so. Package installs are separate: the app updates its own code, the package
manager updates extensions.

**Is it translated?**
Not yet (i18n is backlog). The UI is English in v0.3.0.

**How do I copy the proposed commit message from `/commit`?**
The extension renders it in a questionnaire panel. Select the text and press
<kbd>Ctrl</kbd>+<kbd>C</kbd> (<kbd>Cmd</kbd>+<kbd>C</kbd> on macOS), or use the
panel's **Copy** button, right-click → **Copy**, or the panel's own context menu;
The selection takes precedence over the extension's
`^C`, and <kbd>Esc</kbd> still aborts. The same works for any text an extension
draws, and for ordinary assistant messages in the transcript.

**How do I make the app bigger or smaller?**
Use <kbd>Ctrl/Cmd</kbd>+<kbd>=</kbd> to zoom in, <kbd>Ctrl/Cmd</kbd>+<kbd>-</kbd> to
zoom out, and <kbd>Ctrl/Cmd</kbd>+<kbd>0</kbd> for 100 %. The same controls are in
View → Zoom In / Zoom Out / Actual Size, in the status bar's `− 100 % +`
cluster, and in Settings → Display zoom. The level is remembered across
launches.

**Where do I report a bug?**
Attach a Diagnostics support bundle (it is redacted) and the version from
Settings → About or the status bar, and open an issue on the repository.
