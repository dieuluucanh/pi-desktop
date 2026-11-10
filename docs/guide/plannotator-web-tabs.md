# Web tabs (Plannotator and localhost UIs)

Some workflows render a UI on `http://127.0.0.1:<port>` — the Plannotator review
page is the common example. Pi Desktop can open such a page in an **in-app tab**
instead of your system browser.

## Opening one

- **Automatically**: a loopback URL in an extension **notification** (the
  Plannotator review-ready message) opens or focuses a web tab, so the new plan
  is in front. A URL found in a **tool result** opens in the background; it does
  not steal the session you are reading. An existing tab for the same URL is
  reloaded and focused for a notification, never duplicated — a fixed
  `PLANNOTATOR_PORT` therefore cannot leave the previous round's plan on screen.
  The owning session stays protected from idle/RSS recycling while its review tab
  is active or visible.
- **Manually**: the command palette or `File → Open URL in Tab…`.
- A session tab that a web tab came from shows a **Review:** chip linking back.

## Review handoffs

Each later Review round opens its own focused review tab. If Plannotator reuses a
URL, Desktop reloads the existing tab before focusing it; a notification can
never leave the old review in front. Tool-result localhost URLs remain
background tabs.

## Chrome

Back / forward / reload-stop, an editable address field, favicon and title, copy
URL, open in the system browser, and zoom. An unreachable page shows a retry
affordance.

## Isolation

Each web tab is a separate `WebContentsView` in a shared partition with **no
preload**: `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`
and every permission request denied. The page cannot reach `window.pi` or the Pi
bridge. The app’s own Content Security Policy is not injected into these pages on
purpose — that would break the very UIs this feature exists to host (Plannotator
uses inline scripts).

## Navigation and decisions

A navigation that leaves the review is **prevented** and surfaces a dialog:

- **Open in a new tab** — the safest default for a new loopback page;
- **Replace this tab**;
- **Open in the system browser** for anything that is not loopback;
- **Dismiss**.

## Review outcome

A Plannotator decision in a tool result (`approved`, `annotated`, `dismissed`)
becomes a notice next to the tool card, so the outcome is readable without
opening the raw JSON. Tabs survive a restart while their URL is reachable.

## Related

- [Sessions and tabs](sessions-and-tabs.md) · [Extensions and packages](extensions-and-packages.md)
- [Troubleshooting](troubleshooting.md)
