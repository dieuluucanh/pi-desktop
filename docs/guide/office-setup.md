# Pi for Office (optional)

Pi for Office connects Word, Excel and PowerPoint documents to a session. It is
an **optional integration**, installed exactly like any other package; the app is
fully usable without it and shows no Office surface until it is set up.

## What it adds

- an **Attached documents** panel listing every pane the bridge reports (host
  app, document name, id, focus, window count, advertised operations, last-seen
  age);
- **`#` mentions** in the composer, fed by the live pane registry — they work
  even when the bridge extension’s own autocomplete provider is absent;
- **office tool cards** that name the target document and show whether a call was
  capability-gated;
- an **on-demand bridge** — no session claims the port at open. Connect the
  session you want from the Documents rail (or run `/office connect` in a
  terminal); only one session owns port 38617 at a time.

## Installing it

1. **Extensions → Integrations → Pi for Office**.
2. **Install bridge package** runs the standard package consent dialog for
   `@dieulc/pi-office-bridge` (pinned version). Nothing installs without consent.
3. **Set up / Repair** runs the wizard: detect the machine and Office installs →
   install the bridge package → sideload the manifest → **connect one Pi
   session** → open Office and poll `/health` until a pane attaches. Setup is
   still zero-touch; normal sessions remain off.

Each step is retryable; a cancel leaves no partial registry value. The card
shows the pinned version, protocol/catalog versions, sideload state, port and the
last health result. **Open Office session** starts (or focuses) the session that
owns the bridge port. **Reset add-in** restores the previous sideload state.

## Using it

The Documents menu appears in the right rail once the bridge package is
configured, **even while the bridge is off**. Its pinned row is the control
surface: _The Office bridge is off_ with **Connect this session**, or _Office
host: …_ / _This session is the Office host._ while it is running.

From a row you can:

- **Chat about this document** — prepends a `[office:<host> "<name>" id=<id>]`
  tag to the composer draft (the same tag format the bridge extension uses);
- **Insert `#` mention** — inserts the document’s mention value (name when
  unique, otherwise id);
- copy the document id, or open the Office app.

Then just talk to the model: “read A1:C10 from Sheet1 and summarize”. With two
workbooks, `document: "active"` follows focus and an explicit `#name` routes to
that document; ambiguity is reported with the bridge’s candidate list.

**Stop** aborts the live owner session’s run, which ends a pane’s answer for
every bridge version. If a terminal Pi owns the bridge, the app cannot abort a
run it does not host; the panel says to stop it there.

### Connecting, moving and closing the bridge

Only one session can serve Office: the tab that holds bridge port 38617. The
Documents row says which one that is and offers:

- **Connect this session** — start the bridge in the active tab;
- **Disconnect** / **Restart** — while this tab owns it;
- **Open host session** — jump to the owning tab;
- **Move bridge here** — asks first, then closes the old tab's bridge and
  connects this one. The old **session stays open**; only the bridge moves, and
  neither session restarts. This is the supported replacement for the old
  promotion/restart flow;
- **Take over bridge** — when a terminal Pi or another program owns 38617. It
  asks first and terminates the holder; the terminal session may need reopening;
- **Update bridge** — when a 0.5.x bridge is detected. That version starts
  automatically and has no close command, so update before using the controls.

`/new`, `/reload`, a crash or a host restart all start the bridge **off**; click
Reconnect/Connect again. This is deliberate — keeping a server across Pi's
extension reload would orphan it. While the bridge is off, the add-in keeps its
own reconnect loop if **Enable local Pi agent** is on; it reattaches as soon as
you connect again. Turn that toggle off in the add-in if you do not want it to
retry.

### What a non-host session can and cannot do

`office_*` calls are served by whichever session owns 38617, so from any other
session:

- you still **see** every attached document, with its facts;
- _Chat about this_ and _Insert #mention_ are **disabled**, and a line says why;
- typing `#` offers **nothing**, because a mention would tag a prompt that session
  cannot answer.

Use **Move bridge here** if you want to work with the documents from this
session. There is no cross-session proxy: routing an `office_*` call to the host
from a non-host session needs its own IPC and is tracked in the backlog.

## Platform support

The wizard is built for Windows first (registry sideload, `Wef` paths), with
macOS app-container paths supported and the manual path documented for
WSL/remote setups. Detection, manifest handling, mirroring and troubleshooting
are OS-injected, so the wizard runs headlessly in tests.

## Troubleshooting

The card’s **Copy diagnostics** produces the same redacted bundle as
Diagnostics. Common issues: the bridge is off (run `/office connect` or click
Connect), port 38617 is held by a terminal/foreign process (close it there or
Take over), an automatic 0.5.x bridge (Update bridge), the add-in not appearing
in Office, a stale sideload entry, version skew between the bridge and the
add-in. Every item names the remedy.

## Uninstalling

**Reset add-in** removes the sideload entry and any manifest copy. Removing the
package is a normal package removal from the Extensions hub. Pi’s settings remain
the source of truth for whether the bridge is installed.

## Related

- [Extensions and packages](extensions-and-packages.md) ·
  [architecture/office-integration.md](../architecture/office-integration.md)
- [Troubleshooting](troubleshooting.md) · [FAQ](faq.md)
