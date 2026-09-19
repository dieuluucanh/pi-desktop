# Pinned versions

Recorded 2026-09-19. Every pin is exact in `package.json` except where noted.
Changing a pin here means changing it there.

| Component                                          | Pin                  | Why                                                                                                                                                                                    |
| -------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `electron`                                         | `44.4.3`             | Electron 44 ships Node 24.21.0 / Chromium 152 (plan D3/D22). Electron patch updates within 44.x are safe; a minor bump must be re-checked against the SDK's `engines.node >= 22.19.0`. |
| `electron-vite`                                    | `5.0.0`              | Latest stable. 6.x was still in beta on 2026-09-19.                                                                                                                                    |
| `vite`                                             | `^7.3.6`             | `electron-vite@5` peers `vite ^5 \|\| ^6 \|\| ^7`; Vite 8 is not accepted yet.                                                                                                         |
| `@vitejs/plugin-react`                             | `5.2.0`              | 6.x requires Vite 8.                                                                                                                                                                   |
| `react` / `react-dom`                              | `19.3.0`             | Latest stable.                                                                                                                                                                         |
| `@earendil-works/pi-coding-agent`                  | `0.85.1` (exact)     | The SDK contract we build against (`bindExtensions`, `ExtensionUIContext`, `DefaultPackageManager`, exported `main`). See risk R1.                                                     |
| `@earendil-works/pi-agent-core`, `pi-ai`, `pi-tui` | `0.85.1` (exact)     | Must match the coding agent exactly.                                                                                                                                                   |
| `typebox`                                          | `1.3.7` (exact)      | Matches the version the coding agent depends on, so extensions get the same runtime.                                                                                                   |
| `electron-builder`                                 | `26.15.3`            | Packaging.                                                                                                                                                                             |
| `electron-updater`                                 | `6.8.9`              | Auto-update (wired in plan step 26).                                                                                                                                                   |
| `eslint` / `@eslint/js`                            | `10.11.0` / `10.0.1` | Flat config. `typescript-eslint@8.70.0`, `eslint-plugin-react-hooks@7.1.1` and `eslint-plugin-react-refresh@0.5.7` all accept ESLint 10.                                               |
| `typescript`                                       | `^5.9.3`             | `typescript-eslint` peers `>=4.8.4 <6.1.0`.                                                                                                                                            |
| `vitest`                                           | `^4.1.9`             | Existing suite.                                                                                                                                                                        |
| `@playwright/test`                                 | `1.63.0`             | Electron E2E (plan step 24).                                                                                                                                                           |

## Runtime the app bundles (not an npm dependency)

| Component | Pin                                                                                   | Where                                       |
| --------- | ------------------------------------------------------------------------------------- | ------------------------------------------- |
| Node.js   | Node 24 LTS, exact build recorded in `resources/runtime/node.lock.json` (plan step 2) | `resources/runtime/node/<platform>-<arch>/` |
| npm CLI   | the `npm` shipped inside that Node distribution                                       | invoked as `<bundledNode> <npmCliJs>`       |

The bundled runtime — not Electron's Node — runs every Pi host process and every
npm install (plan D3). `resources/runtime/` is gitignored; `npm run runtime:fetch`
populates it.
