# Staged extensions

This directory holds extension bundles the app loads **by path** from outside
the asar. Its contents are generated, not tracked:

```text
resources/extensions/workflow/   the pinned `@dieulc/workflow` bundle
```

## Workflow

The bundle is staged from an artifact that is verified against
`resources/workflow.lock.json` (sha512 integrity plus a sha256 for every packed
file):

```bash
# Stage from a locally supplied, already-verified W tarball:
npm run workflow:stage -- --tarball ../pi-workflow/dieulc-workflow-0.17.5.tgz

# Or fetch the explicitly pinned release artifact (nothing else is downloaded):
npm run workflow:stage

# Confirm the staged copy is ship-ready, including an offline load under the
# bundled Node:
npm run workflow:verify -- --offline
```

`workflow:stage` writes the same verified bytes to two layouts:

- `resources/extensions/workflow` — packaged by `extraResources` as
  `extensions/workflow` (fallback: it has no `node_modules` above it);
- `out/extensions/workflow` — the unpacked host-build sibling. In a packaged app
  this lands at `resources/app.asar.unpacked/out/extensions/workflow`, which is
  the copy main prefers because its host-peer imports resolve through
  `app.asar.unpacked/node_modules`. Run staging **after** `npm run build`/
  `npm run build:host`, because those clean `out/`.

The artifact is loaded by the bundled Node's TypeScript type stripping. Relative
imports (including relative dynamic imports), non-code assets and the license
files travel verbatim; the Pi SDK family and `typebox` stay host peers. The
staged `package.json` carries no runtime dependencies and no install-time
lifecycle scripts, so nothing executes merely because the files exist.

No version bump, tag or publish is implied by staging. To move the pin, stage a
new verified tarball with `npm run workflow:lock -- --tarball <file.tgz>` and
commit the updated lock.
