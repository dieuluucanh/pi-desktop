import { fileURLToPath } from "node:url";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import type { Plugin } from "vite";
import { CSP_PLACEHOLDER, rendererCspFor } from "./src/main/security";

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

/**
 * Injects the renderer Content Security Policy into `index.html` (plan step 23).
 *
 * A CSP has to be a `<meta>` tag for a `file://` page — Electron's
 * `webRequest.onHeadersReceived` never fires for the file scheme — so the
 * policy is spliced into the HTML at build time. `ctx.server` distinguishes the
 * dev server (Vite's inline refresh preamble needs `'unsafe-inline'`) from a
 * production build, which gets the strict policy.
 */
function rendererCspPlugin(): Plugin {
  return {
    name: "pi-desktop-renderer-csp",
    transformIndexHtml: {
      order: "pre",
      handler(html, ctx) {
        return html.replace(CSP_PLACEHOLDER, rendererCspFor(Boolean(ctx.server)));
      },
    },
  };
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "out/main",
      rollupOptions: {
        input: { index: resolve("./src/main/index.ts") },
        // Prettier is a Node package loaded on Format Document, not part of the
        // app bundle. Externalizing it avoids shipping/bundling its large
        // generated parser files and keeps the main bundle readable.
        external: ["prettier", /^prettier\//],
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
    plugins: [rendererCspPlugin(), react(), tailwindcss()],
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
