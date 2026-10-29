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
- an **Office session** — one session tab owns the bridge port (38617); other
  sessions use 38618 and up.

## Installing it

1. **Extensions → Integrations → Pi for Office**.
2. **Install bridge package** runs the standard package consent dialog for
   `@dieulc/pi-office-bridge` (pinned version). Nothing installs without consent.
3. **Set up / Repair** runs the wizard: detect the machine and Office installs →
   install the bridge package → sideload the manifest → verify by opening Office
   and polling the bridge’s `/health` until a pane attaches.

Each step is retryable; a cancel leaves no partial registry value. The card
shows the pinned version, protocol/catalog versions, sideload state, port and the
last health result. **Open Office session** starts (or focuses) the session that
owns the bridge port. **Reset add-in** restores the previous sideload state.

## Using it

With a pane connected, the Documents section appears in the session's right rail
view. From a row you can:

- **Chat about this document** — prepends a `[office:<host> "<name>" id=<id>]`
  tag to the composer draft (the same tag format the bridge extension uses);
- **Insert `#` mention** — inserts the document’s mention value (name when
  unique, otherwise id);
- copy the document id, or open the Office app.

Then just talk to the model: “read A1:C10 from Sheet1 and summarize”. With two
workbooks, `document: "active"` follows focus and an explicit `#name` routes to
that document; ambiguity is reported with the bridge’s candidate list.

**Stop** aborts the Office session’s run, which ends a pane’s answer for every
bridge version. **Promote to Office host** demotes any other Office tab, restarts
the promoted one on port 38617 and resumes its session, so history is preserved.

## Platform support

The wizard is built for Windows first (registry sideload, `Wef` paths), with
macOS app-container paths supported and the manual path documented for
WSL/remote setups. Detection, manifest handling, mirroring and troubleshooting
are OS-injected, so the wizard runs headlessly in tests.

## Troubleshooting

The card’s **Copy diagnostics** produces the same redacted bundle as
Diagnostics. Common issues: port 38617 in use, the add-in not appearing in
Office, a stale sideload entry, version skew between the bridge and the add-in.
Every item names the remedy.

## Uninstalling

**Reset add-in** removes the sideload entry and any manifest copy. Removing the
package is a normal package removal from the Extensions hub. Pi’s settings remain
the source of truth for whether the bridge is installed.

## Related

- [Extensions and packages](extensions-and-packages.md) ·
  [architecture/office-integration.md](../architecture/office-integration.md)
- [Troubleshooting](troubleshooting.md) · [FAQ](faq.md)
