import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchFakeApp, type FakeApp } from "./fixtures/fake-app";
import { removeTempDirs } from "./fixtures/app";

/**
 * Terminal E2E (2026-11-05 terminal plan, step 13).
 *
 * Runs the real app: Electron main, the per-window terminal host under the
 * bundled Node, `node-pty` and ConPTY/POSIX. xterm paints to a canvas, so the
 * assertions are about the surface (the live view, the xterm element, no error
 * notice) rather than reading glyphs back out of the renderer.
 */

let app: FakeApp | undefined;

/** The token the pasted command writes; counted per line in the marker file. */
const PASTE_TOKEN = "pasted-once-7f3a";

/**
 * Counts the token in whichever decoding the shell's redirection produced
 * (PowerShell 5.1 writes UTF-16LE, bash/cmd write single-byte text).
 */
function countToken(file: string, token: string): number {
  const raw = readFileSync(file);
  const utf8 = raw.toString("utf8");
  const text = utf8.includes(token) ? utf8 : raw.toString("utf16le");
  return text.split(token).length - 1;
}

test.afterEach(async () => {
  if (!app) return;
  await app.shutdown();
  removeTempDirs(app.paths);
  app = undefined;
});

test("@smoke opens a terminal tab, starts a real shell and accepts input", async () => {
  app = await launchFakeApp();

  await app.window.getByRole("button", { name: "New terminal" }).click();
  await expect(app.window.getByTestId("terminal-view")).toBeVisible({ timeout: 30_000 });

  const host = app.window.getByTestId("terminal-host");
  await expect(host.locator(".xterm")).toBeVisible({ timeout: 30_000 });

  // The xterm surface must fill the pane, not just the initial 24 rows. FitAddon
  // measures the mount div's parent, so this catches a broken height chain.
  await expect
    .poll(async () => {
      const hostBox = await host.boundingBox();
      const xtermBox = await host.locator(".xterm").boundingBox();
      if (!hostBox || !xtermBox || hostBox.height === 0) return 0;
      return xtermBox.height / hostBox.height;
    })
    .toBeGreaterThan(0.85);

  await host.click();
  await app.window.keyboard.type("echo terminal-e2e");
  await app.window.keyboard.press("Enter");

  // The shell accepted the input: no exit/error notice appeared.
  await expect(app.window.getByText(/Terminal exited/)).toHaveCount(0);
  await expect(app.window.getByText("This project is not trusted")).toHaveCount(0);
});

test("Ctrl+V pastes the clipboard into the shell exactly once", async () => {
  app = await launchFakeApp();

  await app.window.getByRole("button", { name: "New terminal" }).click();
  await expect(app.window.getByTestId("terminal-view")).toBeVisible({ timeout: 30_000 });
  const host = app.window.getByTestId("terminal-host");
  await expect(host.locator(".xterm")).toBeVisible({ timeout: 30_000 });
  await host.click();

  // The pasted command is self-terminating and complete, so a paste count of N
  // appends N lines: immediately executed when the shell has no bracketed-paste
  // mode, held in the buffer and executed by the Enter below when it does. The
  // extra Enter is a no-op in the first case.
  const marker = join(app.projectDir, "paste-marker.txt");
  const command = `echo ${PASTE_TOKEN} >> "${marker}"`;
  await app.app.evaluate(({ clipboard }, text) => clipboard.writeText(text), `${command}\n`);

  // NOTE: CDP-injected keys may not run Chromium's browser-side editing command,
  // so what this pins is the *app* path — one claimed keydown must write once.
  // Before the fix the same gesture wrote three times (keydown + keyup + the
  // browser's own paste). The native menu-paste writer is covered by the
  // renderer suite; do not weaken this into a "the surface is still there" test.
  await app.window.keyboard.press(process.platform === "darwin" ? "Meta+V" : "Control+V");
  await app.window.keyboard.press("Enter");

  await expect
    .poll(async () => (existsSync(marker) ? countToken(marker, PASTE_TOKEN) : 0), {
      timeout: 15_000,
    })
    .toBe(1);
});

test("a terminal tab survives a grid layout switch", async () => {
  app = await launchFakeApp();
  await app.window.getByRole("button", { name: "New terminal" }).click();
  const view = app.window.getByTestId("terminal-view");
  await expect(view).toBeVisible({ timeout: 30_000 });

  // The strip's layout menu is the grid entry point; switching to a multi-pane
  // layout remounts the surface, and the pooled xterm must move with it.
  await app.window.getByRole("button", { name: /layout/i }).click();
  await app.window.getByRole("menuitemradio", { name: /two/i }).click();
  await expect(app.window.getByTestId("pane-grid")).toBeVisible();
  await app.window.getByRole("button", { name: "Grid layout" }).click();
  await app.window.getByRole("menuitemradio", { name: /single/i }).click();
  await expect(app.window.getByTestId("terminal-view")).toBeVisible({ timeout: 10_000 });
});
