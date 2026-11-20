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
URL, Desktop reloads the existing tab before focusing it and re-points its link
to the session that just handed it off; a notification can never leave the old
review in front. Tool-result localhost URLs remain background tabs.

Desktop hosts are spawned with `PLANNOTATOR_BROWSER=none`, so Plannotator never
launches the system browser for a review. The review page is an app tab; the
**Open in browser** button in its chrome is the escape hatch. Terminal Pi is
unaffected and keeps opening the system browser.

While Review owns the turn the session shows a **Review bar** (Pause/Resume/
Abort, or **Open review tab** during the handoff). The composer refuses prose
and `!` shell commands with a hint and keeps your draft; `/review-pause`,
`/review-resume`, `/review-abort` and `/model`/`/thinking`/`/profile` stay
available. Approve or annotate in the review tab to hand the plan back to Plan
or Build.

## Auto-close and returning

Plannotator's completion overlay closes the page with `window.close()` after its
own countdown (immediate, 3 seconds, 5 seconds, or off). A web tab is a
`WebContentsView`, which has no window, so Desktop runs that close as a
**request** and closes the tab itself. Plannotator's setting is therefore
honored: with auto-close on the tab disappears; with it off the completion page
stays and the tab remains until you close it.

Closing a web tab — automatically or with its `×` — returns to the **session
that opened it** when that tab is still open, rather than to whichever tab was
most recently active. If the opener is gone, the most recently active tab wins.
A reused review URL re-points the link to the latest session that handed it off.
Closing the owning session also closes its linked review tabs (pinned ones too);
a web tab opened manually with **Open URL in Tab…** is independent and its close
falls back to the most recently active tab.

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
uses inline scripts). The `window.close` bridge is injected through
`executeJavaScript`; it adds no preload, Node surface or bridge channel.

## Navigation and decisions

A navigation that leaves the review is **prevented** and surfaces a dialog:

- **Open in a new tab** — the safest default for a new loopback page;
- **Replace this tab**;
- **Open in the system browser** for anything that is not loopback;
- **Dismiss**.

## Review outcome

A Plannotator decision in a tool result (`approved`, `annotated`, `dismissed`)
becomes a notice next to the tool card, so the outcome is readable without
opening the raw JSON. A web tab linked to a session is restored with it; closing
that session closes the linked tab, while an unlinked localhost tab survives on
its own.

## Related

- [Sessions and tabs](sessions-and-tabs.md) · [Extensions and packages](extensions-and-packages.md)
- [Troubleshooting](troubleshooting.md)
