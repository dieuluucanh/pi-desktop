# Third-party notices

Pi Desktop is distributed under the MIT License (see [`LICENSE`](LICENSE)).
It bundles and/or depends on the following third-party components. Their
licenses apply to those components; this file is a summary, not a replacement
for the licenses themselves.

## Bundled runtime

| Component | Version                                          | License      |
| --------- | ------------------------------------------------ | ------------ |
| Node.js   | 24.22.2 (per `resources/runtime/node.lock.json`) | MIT          |
| npm CLI   | the `npm` shipped in that Node distribution      | Artistic-2.0 |

The runtime is fetched at build time by `npm run runtime:fetch`; it is not
committed to the repository.

## Application runtime

| Component                                                             | License                               |
| --------------------------------------------------------------------- | ------------------------------------- |
| Electron (includes Chromium and Node)                                 | MIT / BSD-style (Chromium components) |
| React, React DOM                                                      | MIT                                   |
| `@earendil-works/pi-coding-agent`, `pi-agent-core`, `pi-ai`, `pi-tui` | MIT                                   |
| `zustand`                                                             | MIT                                   |
| `@tanstack/react-virtual`                                             | MIT                                   |
| `react-markdown`, `remark-gfm`                                        | MIT                                   |
| `shiki`                                                               | MIT                                   |
| `diff`                                                                | BSD-3-Clause                          |
| `cmdk`                                                                | MIT                                   |
| `sonner`                                                              | MIT                                   |
| `lucide-react`                                                        | ISC                                   |
| Radix UI React packages                                               | MIT                                   |
| `class-variance-authority`                                            | Apache-2.0                            |
| `clsx`, `tailwind-merge`, `tailwindcss`                               | MIT                                   |
| `get-east-asian-width`                                                | MIT                                   |
| `semver`                                                              | ISC                                   |
| `typebox`                                                             | MIT                                   |
| `electron-updater`                                                    | MIT                                   |

## Development tools (not distributed)

TypeScript (Apache-2.0), Vite and electron-vite (MIT), Vitest (MIT),
`@playwright/test` (Apache-2.0), electron-builder (MIT), ESLint (MIT) and
Prettier (MIT).

## Optional packages (not bundled)

Extensions and packages installed by the user — including
`@dieulc/pi-office-bridge`, `@dieulc/workflow`, `@dieulc/autocompact` and
community packages from the Pi gallery — are fetched by the package manager at
the user's request and carry their own licenses. They are not part of this
distribution.

## Trademarks

Pi is a project of its respective owners. Pi Desktop is an independent client
built on the Pi SDK and is not affiliated with or endorsed by the Pi project.
