import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

/**
 * Build for the Pi host (`src/host/index.ts` → `out/host/index.mjs`).
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
      input: { index: resolve("./src/host/index.ts") },
      external: isExternal,
      output: { format: "es", entryFileNames: "[name].mjs", chunkFileNames: "[name]-[hash].mjs" },
    },
  },
});
