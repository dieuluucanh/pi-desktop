import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

/**
 * Build for the Pi host (`src/host/index.ts` → `out/host/index.mjs`) plus the
 * bundled checkpoint extension (`src/extensions/pi-checkpoints.ts` →
 * `out/host/pi-checkpoints.mjs`).
 *
 * The extension is a **second entry**, not part of the host bundle: Pi's resource
 * loader imports an extension path at runtime, and the host runs outside asar, so
 * it has to be a real file on disk. The input *key* is load-bearing — with
 * `entryFileNames: "[name].mjs"` it is what produces the exact name
 * `src/host/index.ts`'s `resolveCheckpointExtensionPath` looks for.
 *
 * The host runs under the bundled Node runtime, never inside Electron, so every
 * bare import stays external and is resolved from `node_modules` at runtime
 * (asar-unpacked in packaged builds). Bundling `@earendil-works/*` would break
 * jiti-based extension loading and the SDK's asset reads.
 */
const resolve = (relativePath: string): string =>
  fileURLToPath(new URL(relativePath, import.meta.url));

/** Bare specifiers stay external; relative, absolute and file: entries are bundled. */
const isExternal = (id: string): boolean =>
  !id.startsWith(".") &&
  !id.startsWith("/") &&
  !id.startsWith("file:") &&
  !id.startsWith("\0") &&
  !isAbsolute(id);

export default defineConfig({
  build: {
    ssr: true,
    target: "node22",
    outDir: "out/host",
    emptyOutDir: true,
    minify: false,
    sourcemap: true,
    rollupOptions: {
      input: {
        index: resolve("./src/host/index.ts"),
        "pi-checkpoints": resolve("./src/extensions/pi-checkpoints.ts"),
        // The terminal host is its own entry on purpose: loading `index.ts`
        // would link the Pi SDK into a process that only owns PTYs.
        terminal: resolve("./src/host/terminal-main.ts"),
      },
      external: isExternal,
      output: { format: "es", entryFileNames: "[name].mjs", chunkFileNames: "[name]-[hash].mjs" },
    },
  },
});
