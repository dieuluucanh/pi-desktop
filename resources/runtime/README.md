# Bundled runtime (not checked in)

`npm run runtime:fetch` (plan step 2) downloads the pinned Node 24 LTS build for
each requested platform into `node/<platform>-<arch>/` and generates the PATH
shims in `bin/`. Everything in this directory except this README is gitignored.

Layout after fetching:

```
resources/runtime/
  node.lock.json                 pinned versions + sha256 checksums
  node/win32-x64/node.exe ...    the runtime that runs every Pi host
  node/darwin-arm64/bin/node
  bin/pi, pi.cmd, node, npm ...  shims that make extensions shelling out to `pi` work
```

`src/main/runtime/resolve-runtime.ts` resolves these paths in production from
`process.resourcesPath/runtime`, and in development from
`PI_DESKTOP_RUNTIME_DIR` or this directory.
