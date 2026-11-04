# Changelog

All notable changes to this package are documented in this file.

## [0.1.2] - 2026-10-31

### Changed

- Maintenance and releases moved to the Pi Desktop repository
  (`packages/checkpoints`); the npm package name and URL are unchanged.
- The terminal command is now `/checkpoint`, previously `/rewind`, so it can
  coexist with `@dieulc/workflow`'s separate `/rewind` implementation.
- Users with `0.1.1` installed should update to `0.1.2`: Pi Desktop prefers an
  installed package copy over its bundled extension.

## [0.1.1] - 2026-10-31

### Fixes

- The extension now loads when Pi calls its factory with the API object alone.
  A required second argument (`deps`) made every `pi` startup abort with
  `Cannot read properties of undefined (reading 'now')` once the package was
  discovered under `~/.pi/agent/extensions/`.
- The profile directory is resolved from `PI_CODING_AGENT_DIR`, then
  `~/.pi/agent`, instead of requiring the host to inject it. Without this the
  shadow repo path would have been a relative `undefined/checkpoints/...`
  directory inside the project.

## [0.1.0] - 2026-10-30

### Features

- Folder checkpoints in a shadow git repository, with `/rewind` for files and
  conversation.
- One snapshot per user prompt, including steer and follow-up prompts.
- Safety snapshot before every file restore, so a rewind is undoable.
