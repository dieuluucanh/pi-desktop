---
title: Privacy
description: What the Pi Desktop website and app collect, where data lives, and how to opt out.
---

Pi Desktop is built to keep your data on your machine. This page describes the current
behaviour of the website and the app; it is not a legal contract.

## This website

- The site is static. It sets no cookies and has no analytics, advertising, A/B testing or
  third-party scripts.
- GitHub Pages hosts the site, so GitHub may process standard web-server logs (IP address,
  user agent, requested URL) under
  [GitHub's privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement).
- The download buttons make one anonymous request to the public GitHub Releases API to find the
  current installer. That request carries no account token and no identifier beyond a normal
  HTTPS request. If it fails, the buttons simply open the Releases page.
- The site loads no remote fonts or CDN assets.

## The app

- **Telemetry is off by default.** The first-run screen explains the optional anonymous
  install/update ping; turning it on is an app preference and never rewrites the shared Pi
  `settings.json`. Turning it off again is the same switch.
- **The Pi profile is shared by default.** The app uses `~/.pi/agent`, the same profile as
  terminal Pi, so sessions, credentials, settings, extensions, skills and themes are visible in
  both. Onboarding offers a separate app-private profile if you prefer.
- Sessions (JSONL), credentials and Pi settings live in the Pi profile. Project configuration
  lives in `<project>/.pi/`. App state (tabs, recents, preferences) and logs live in Electron's
  `userData` directory; the Diagnostics view exports a redacted support bundle.
- Uninstalling the app does not delete the shared Pi profile. Remove the app's own `userData`
  separately if you want to clear its tabs, preferences and logs.
- Pi for Office is an optional integration. It is not installed or connected unless you set it
  up.

See the [FAQ](/guide/faq/) for the short answers, [Getting started](/guide/getting-started/) for
the data-location table, and the [repository](https://github.com/dieuluucanh/pi-desktop) for
the code.
