import { fileURLToPath } from "node:url";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * electron-vite config for the three Electron targets.
 *
 * The Pi host is a fourth, node-only target built by `vite.host.config.ts`
 * (`npm run build:host`), because it must run under the bundled Node runtime
 * rather than inside Electron.
 *
 * Output layout (see `electron-builder.yml`):
 *   out/main/index.mjs     ESM main process
 *   out/preload/index.cjs  CJS preload (required: sandboxed preloads cannot be ESM)
 *   out/renderer/          renderer (React)
 *   out/host/index.mjs     Pi host service / `pi` CLI shim entry
 */
const resolve = (relativePath: string): string =>
  fileURLToPath(new URL(relativePath, import.meta.url));

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "out/main",
      rollupOptions: {
        input: { index: resolve("./src/main/index.ts") },
        output: { format: "es", entryFileNames: "[name].mjs", chunkFileNames: "[name]-[hash].mjs" },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "out/preload",
      rollupOptions: {
        input: { index: resolve("./src/preload/index.ts") },
        output: {
          format: "cjs",
          entryFileNames: "[name].cjs",
          chunkFileNames: "[name]-[hash].cjs",
        },
      },
    },
  },
  renderer: {
    root: resolve("./src/renderer"),
    plugins: [react(), tailwindcss()],
    build: {
      outDir: "out/renderer",
      emptyOutDir: true,
      // The renderer ships to users; minify it. Main/preload/host stay readable
      // on purpose: their stack traces are the app's diagnostics.
      minify: "esbuild",
      rollupOptions: { input: { index: resolve("./src/renderer/index.html") } },
    },
  },
});
