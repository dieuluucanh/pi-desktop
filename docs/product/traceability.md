# Requirement traceability

The original asks behind Pi Desktop → the plan steps that satisfy them → the
evidence in this repository. The executable plan is gitignored, so this table is
the durable record; `tests/packaging/release.test.ts` parses it and asserts every
row names a step range and points at a file that exists.

A row is either **automated** (the referenced test or E2E spec covers it) or a
**documented limitation** (a user-visible caveat in
[`releases/v0.5.0.md`](../releases/v0.5.0.md) or
[`guide/troubleshooting.md`](../guide/troubleshooting.md)). The distinction is
recorded with the release, not hidden here.

| Requirement                                                                   | Steps                                | Evidence                                                                                                               |
| ----------------------------------------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Correct the project's purpose (Pi coding agent GUI; Office optional)          | 1, 19                                | `docs/product/parity.md`, `docs/architecture/app-shell.md`                                                             |
| Working New Session (menu, shortcut, button), no placeholder UI               | 1, 3, 10, 11                         | `tests/e2e/session.spec.ts`, `docs/architecture/app-shell.md`                                                          |
| Chat / prompt input / interaction with the LLM in a session                   | 3, 4, 5, 6                           | `tests/host/integration.test.ts`, `tests/e2e/session.spec.ts`                                                          |
| Manage projects                                                               | 10                                   | `tests/main/projects-service.test.ts`, `docs/guide/projects.md`                                                        |
| Manage sessions inside projects                                               | 11                                   | `tests/e2e/persistence.spec.ts`, `docs/guide/sessions-and-tabs.md`                                                     |
| Switch model, set thinking level                                              | 8, 9                                 | `tests/renderer/model-store.test.ts`, `docs/guide/models-and-thinking.md`                                              |
| Add context: any file (`@`), images                                           | 6, 7                                 | `tests/renderer/completion.test.tsx`, `tests/renderer/image-attachment.test.ts`                                        |
| `/` commands, `@` file mentions, `#` Office documents                         | 7, 16, 20                            | `tests/renderer/completion.test.tsx`, `tests/renderer/documents-section.test.tsx`                                      |
| Inherit all Pi Core Agent features                                            | 4, 5, 12, 13, 14, 15, 16, 17, 18, 21 | `docs/product/parity.md`, `tests/host/integration.test.ts`                                                             |
| Install custom extensions/packages and use them seamlessly                    | 13, 14, 15, 16, 17, 18               | `tests/renderer/extensions.test.tsx`, `tests/packages/npm-root.test.ts`                                                |
| Pi for Office as a normal optional extension (install helper, bridge testing) | 19, 20                               | `tests/office/setup-service.test.ts`, `docs/guide/office-setup.md`                                                     |
| Skills / MCP / other integrations installed like terminal Pi                  | 13, 14, 15                           | `docs/guide/skills-themes-keybindings.md`, `docs/product/parity.md`                                                    |
| Provider and model connectivity equal to terminal Pi                          | 8, 9, 12, 14                         | `tests/renderer/provider-login.test.tsx`, `docs/guide/providers-and-auth.md`                                           |
| UI/UX best practice (Claude/ChatGPT/Codex/OpenCode desktop)                   | 1, 5, 6, 7, 8, 11, 16, 17            | `tests/e2e/shell.spec.ts`, `docs/architecture/app-shell.md`                                                            |
| Source control: staging, hunk staging, commit/amend, discard, stash, sync     | 1, 2, 3, 4, 5, 6, 9, 11, 12, 13, 14  | `tests/git/service.test.ts`, `tests/renderer/rail-changes.test.tsx`, `tests/renderer/rail-commit.test.tsx`             |
| Folder checkpoints for any folder, with restore, undo and retention           | 17, 18, 19, 20, 21, 22, 27           | `tests/checkpoints/store.test.ts`, `tests/main/checkpoint-service.test.ts`, `tests/renderer/rail-checkpoints.test.tsx` |
| `/checkpoint` in terminal Pi from the same checkpoint store                   | 23, 24, 25, 26                       | `tests/checkpoints/extension.test.ts`, `tests/packaging/extension-artifact.test.ts`                                    |
| One published release for Windows, Linux and macOS, with a live update feed   | 7, 8, 10                             | `.github/workflows/release.yml`, `scripts/release-assets.mjs`, `docs/architecture/release-pipeline.md`                 |

## How to read a "documented limitation"

A row whose live verification needs hardware, a real provider or a real Office
install is still listed as satisfied by its automated coverage, and the parts
that remain unverified are enumerated in the release notes' known-limitations
list. That is the honest contract: nothing in this table claims a live run that
has not happened.
