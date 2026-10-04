# Branding and app icons

Where the Pi Desktop logo comes from, which mark belongs to which product, and
how the icons reach the installer and the running window. The asset directory has
its own short reference — [`assets/README.md`](../../assets/README.md) — and this
page is the longer explanation.

## Two products, one mark

Pi Desktop is a standalone desktop app. **Pi for Office is an optional
integration** it can set up, not the thing it is. Both share the same squircle
"pi" mark, and the two are told apart by their lockups:

|         | Pi Desktop                                                  | Pi for Office (the add-in)                                                |
| ------- | ----------------------------------------------------------- | ------------------------------------------------------------------------- |
| Mark    | `assets/pi-desktop-icon.svg`                                | `assets/pi-for-office-icon-primary.svg`                                   |
| Lockup  | `assets/pi-desktop-logo-full.svg` — wordmark **PI DESKTOP** | `assets/pi-for-office-logo-full.svg` — wordmark **FOR OFFICE**            |
| Used by | the app window, its chrome, this repo's docs                | `resources/office/manifest.prod.xml` and the hosted icons on GitHub Pages |

The desktop files are **derived**: they are copies of the add-in's files with only
the `<title>`, `aria-label` and the lockup's sub-line changed. Derive a new
desktop mark that way rather than editing an Office-branded original — the
add-in's copies are its identity, and `tests/packaging/icons.test.ts` fails if the
desktop lockup starts shipping the wrong wordmark.

## Colours

The palette lives inside the SVG files. No component, stylesheet or theme knows a
hex: `src/renderer/src/styles/tokens.css` remains the only source of renderer
colour, and the marks reach components as imported image URLs.

| Hex       | Role                                                         |
| --------- | ------------------------------------------------------------ |
| `#FDFBF3` | Parchment — the squircle fill                                |
| `#0A3D9C` | Deep blue — the squircle stroke                              |
| `#0B4DA6` | Blue — the `p`, the first rule segment                       |
| `#D9A00A` | Antique gold — the `i`, the second rule segment, the diamond |

## Where each mark appears

| Surface                               | File                       | Notes                                                      |
| ------------------------------------- | -------------------------- | ---------------------------------------------------------- |
| Title bar                             | `pi-desktop-icon.svg`      | Beside the "Pi Desktop" text, not instead of it            |
| Welcome view                          | `pi-desktop-icon.svg`      | Beside the `<h1>`                                          |
| Onboarding, welcome step              | `pi-desktop-icon.svg`      | Below the step title                                       |
| `README.md` and docs                  | `pi-desktop-logo-full.svg` | The lockup, which is the only place the wordmark is needed |
| Windows window and installer          | `icon.ico`                 |                                                            |
| macOS Dock, Windows/Linux about panel | `icon-512.png`             | macOS gets its `.icns` from the same PNG                   |

Every in-app mark is decorative: `alt=""` plus `aria-hidden`, so the text beside
it stays the accessible name and screen readers do not announce the app twice.
`tests/renderer/branding.test.tsx` pins that pairing.

## How the icons reach the packaged app

Two separate paths, because they answer different questions:

1. **`electron-builder.yml` icon keys** (`win.icon`, `mac.icon`, `linux.icon`)
   brand the executables and the installers. Windows uses the committed
   `icon.ico`; macOS and Linux are handed `icon-512.png` and electron-builder
   converts it to `.icns` and to the deb/AppImage size set. NSIS installer and
   uninstaller icons default to the app icon, so naming it once is enough.
2. **`extraResources`** copies `icon.ico` and `icon-512.png` into
   `resources/branding/`. The running app reads them by path for the window icon
   and the about panel, which is why they cannot live inside the asar.
   `src/main/branding.ts` resolves that directory; in development it resolves
   `assets/` in the repository instead, so `npm run dev` is branded with no build
   step.

The `extraResources` filter is an explicit two-file list on purpose: the
Office-branded SVGs and the add-in's 80px raster have no reason to travel inside
the desktop app. Adding an asset means adding it there, and the packaging test
fails if a named icon does not exist on disk.

## Regenerating `icon.ico`

```bash
npm run icons:gen     # scripts/gen-icons.mjs
```

The output is committed so a release can be reproduced offline without a
converter. `png-to-ico` embeds each PNG at its native size and never resizes, so
the script feeds it `icon-{16,32,128,256}.png`: an ICO directory entry stores its
dimensions in one byte, which caps it at 256, and Windows scales the 32px entry
up to 48 when it needs one. The 80px file is the add-in's hosted size, not a
Windows icon size.

## Known limits

- The marks are SVG `<text>` over a system font stack (`Cinzel`, Palatino,
  Garamond, serif). Metrics vary per platform; converting the text to outlines is
  the fix when it matters, and is on the backlog.
- In `npm run dev` the _process_ icon is still `electron.exe`'s. The window and
  alt-tab icon come from the mark, but some shell surfaces do not; packaged
  executables embed the icon properly.
- macOS `.icns` and the Linux icon set are produced by electron-builder from
  `icon-512.png` and have not been verified on real hardware.
