# Brand assets

The two brand marks both products derive from, the rasters the OS and the
installers need, and the rule for which file belongs to whom.

## Files

| File | Used by | Role |
| ---- | ------- | ---- |
| `icon-16/32/128/256.png` | Pi Desktop | Windows `.ico` source sizes |
| `icon-512.png` | Pi Desktop | macOS `.icns` + Linux size-set source (electron-builder converts it) |
| `icon.ico` | Pi Desktop | Windows app + installer icon, dev window icon (generated — see below) |
| `pi-desktop-icon.svg` | Pi Desktop | The squircle "pi" mark: title bar, welcome view, onboarding |
| `pi-desktop-logo-full.svg` | Pi Desktop | Full lockup, wordmark **PI DESKTOP**: README and docs |
| `icon-80.png` | Pi for Office only | The add-in's hosted `HighResolutionIconUrl` size |
| `pi-for-office-icon-primary.svg` | Pi for Office only | The add-in's mark |
| `pi-for-office-logo-full.svg` | Pi for Office only | The add-in's lockup, wordmark FOR OFFICE |

## The derivation rule

Pi Desktop is a standalone app; **Pi for Office is an optional integration** it
can set up. The two are separate products that share one mark, so:

- `pi-desktop-*.svg` are the files the desktop app references. They are copies of
  the `pi-for-office-*.svg` originals with only the `<title>`, `aria-label` and
  the lockup's sub-line changed (`FOR OFFICE` → `PI DESKTOP`).
- The `pi-for-office-*.svg` originals are **the add-in's identity and stay
  untouched**, matching `resources/office/manifest.prod.xml` and the hosted icons
  on `dieuluucanh.github.io/pi-for-office`. They are not shipped inside the
  desktop app — `electron-builder.yml` copies only `icon.ico` and
  `icon-512.png` into `resources/branding/`.
- Do not re-derive one product's lockup by editing the other's file.

## Colours

The palette lives inside the SVG files; no component or stylesheet knows a hex
(`src/renderer/src/styles/tokens.css` is the only source of theme colour).

| Hex | Role |
| --- | ---- |
| `#FDFBF3` | Parchment — the squircle fill |
| `#0A3D9C` | Deep blue — the squircle stroke |
| `#0B4DA6` | Blue — the `p`, the first rule segment |
| `#D9A00A` | Antique gold — the `i`, the second rule segment, the diamond |

## Regenerating `icon.ico`

`icon.ico` is committed, so `npm run package:*` never needs a converter at
package time. After changing any of `icon-{16,32,128,256}.png`:

```bash
npm run icons:gen     # -> scripts/gen-icons.mjs, writes assets/icon.ico
```

The script embeds the PNGs at their native sizes — no resizing — so the 512 and
80 px files are deliberately excluded: `.ico` entries top out at 256, and 80 is
not a Windows icon size. Windows scales the 32 px entry up to 48 when it needs
it, so the absence of a native 24/48/64 entry is expected.

`tests/packaging/icons.test.ts` pins the file set, that each PNG's dimensions
match its filename, that `icon-512.png` is exactly 512×512 (the macOS conversion
floor), and that `icon.ico` is a well-formed 4-entry ICO containing a 256.

## Known cosmetic limits

- The marks are SVG `<text>` over a system font stack (`Cinzel`, Palatino,
  Garamond, serif). Metrics vary per platform; converting the text to outlines is
  the fix when it matters.
- In `npm run dev` the *process* icon is still `electron.exe`'s — the window and
  alt-tab icon come from `assets/icon.ico`, but some shell surfaces do not. The
  packaged executables embed the icon properly (rcedit).
- macOS `.icns` and the Linux icon set are produced by electron-builder from
  `icon-512.png` and have not been verified on real hardware.
