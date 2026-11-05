/**
 * The renderer development server's address (`electron-vite dev` only).
 *
 * 2026-11-05: the app served its renderer on Vite's default `localhost:5173`.
 * `localhost` resolved to one address family (`::1` here), so a project's Vite
 * could either bind `127.0.0.1:5173` as well or silently fall back to 5174 —
 * and `http://localhost:5173` then showed Pi Desktop in a browser, without a
 * preload bridge. Keep the app out of the ports projects take, bind one explicit
 * family, and never fall back (`strictPort` is what makes the last part true).
 *
 * Pure on purpose (no `electron`, no `net`, no filesystem): the Vite config, the
 * doctor report and the guard tests all read these rules from one place.
 */

/** The only override. Read from the process environment, not a project `.env`. */
export const RENDERER_DEV_PORT_ENV = "PI_DESKTOP_RENDERER_PORT";

/**
 * A dedicated loopback port outside Vite's 5173+ fallback family and the usual
 * framework ports. It is invisible to users: packaged builds load the renderer
 * from `file://` and never start a server.
 */
export const DEFAULT_RENDERER_DEV_PORT = 5273;

/**
 * One explicit family. The earlier implicit `localhost` bind landed on `::1`
 * only, which is exactly how two servers could both claim port 5173.
 */
export const RENDERER_DEV_HOST = "127.0.0.1";

/**
 * Ports a project dev server commonly takes. The app's default must not be one
 * of them; `npm run doctor` warns when an override is.
 */
export const COMMON_PROJECT_DEV_PORTS: readonly number[] = [
  3000, 3001, 4000, 4173, 4200, 4321, 5000, 5173, 5174, 5175, 5176, 5177, 5178, 5179, 5180, 5500,
  8000, 8080, 8888,
];

/** `process.env` (or a test fixture) as the input to the rules below. */
export type RendererDevEnvironment = Readonly<Record<string, string | undefined>>;

export function isCommonProjectDevPort(port: number): boolean {
  return COMMON_PROJECT_DEV_PORTS.includes(port);
}

/**
 * The renderer dev port: `PI_DESKTOP_RENDERER_PORT` when set, the default
 * otherwise.
 *
 * A malformed override throws while the Vite config loads. A typo must be a
 * visible error, never a silent fall back to a port someone else may own.
 */
export function resolveRendererDevPort(env: RendererDevEnvironment): number {
  const raw = env[RENDERER_DEV_PORT_ENV];
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_RENDERER_DEV_PORT;

  const value = raw.trim();
  // Decimal digits only: `Number()` would otherwise accept `0x1499`, `1e3` or
  // `Infinity`, which are not ports.
  const port = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(
      `${RENDERER_DEV_PORT_ENV} must be an integer between 1024 and 65535 (got "${value}").`,
    );
  }
  return port;
}

/** The Vite `server` options for the renderer dev server. */
export interface RendererDevServerOptions {
  host: typeof RENDERER_DEV_HOST;
  port: number;
  strictPort: true;
}

/**
 * The `renderer.server` block. `strictPort` is deliberate: `electron-vite@5`
 * derives `ELECTRON_RENDERER_URL` from the *configured* port, so a silent
 * fallback would point the Electron window at whichever server owns that port.
 */
export function rendererDevServer(env: RendererDevEnvironment): RendererDevServerOptions {
  return {
    host: RENDERER_DEV_HOST,
    port: resolveRendererDevPort(env),
    strictPort: true,
  };
}

/** `http://127.0.0.1:5273` — the address `electron-vite` prints and loads. */
export function rendererDevUrl(env: RendererDevEnvironment): string {
  return `http://${RENDERER_DEV_HOST}:${resolveRendererDevPort(env)}`;
}
