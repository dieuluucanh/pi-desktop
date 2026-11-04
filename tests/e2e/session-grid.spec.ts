import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Locator } from "@playwright/test";

import { launchFakeApp, type FakeApp } from "./fixtures/fake-app";

/**
 * Session view grid smoke (2026-11-03 plan step 15).
 *
 * Real Electron, real main/preload/renderer: a session and a file are on screen
 * in two panes at the same time, and the layout survives a relaunch through
 * `prefs.grid`. The drag/swap rules are pinned in `tests/renderer/pane-grid` and
 * `grid-store`; this covers the wiring that only a real window can show.
 */

let app: FakeApp | undefined;
let projectDir: string | undefined;

test.afterEach(async () => {
  if (app) {
    await app.shutdown();
    app = undefined;
  }
  if (projectDir) {
    rmSync(projectDir, { recursive: true, force: true });
    projectDir = undefined;
  }
});

async function box(locator: Locator) {
  const bounds = await locator.boundingBox();
  expect(bounds).not.toBeNull();
  return bounds!;
}

test("@smoke shows a session and a file in two panes at once", async () => {
  projectDir = mkdtempSync(join(tmpdir(), "pi-desktop-grid-e2e-"));
  writeFileSync(join(projectDir, "app.ts"), "const answer = 1;\n", "utf8");

  app = await launchFakeApp({ projectDir });
  const window = app.window;

  // The session strip's `+` is the one always-mounted New session control: the
  // welcome CTA and the per-project row come and go with the shell's state, and a
  // loose role query can resolve to a hidden one.
  const strip = window.getByTestId("session-tab-strip");
  await expect(strip).toBeVisible({ timeout: 30_000 });
  await strip.getByRole("button", { name: "New session" }).click();
  await expect(window.getByLabel("Prompt")).toBeVisible({ timeout: 30_000 });

  await expect(window.getByTestId("right-rail")).toBeVisible();
  await window.getByTestId("rail-menu-explorer").click();
  const row = window.getByTestId("explorer-row").filter({ hasText: "app.ts" });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "app.ts" }).click();
  await expect(window.locator(".cm-editor")).toBeVisible();

  // Two panes. The preset seeds pane 1 with whatever is active (the file, since
  // it was just opened), so put the session in pane 1 explicitly and the file in
  // pane 2 — one tab per pane, and assigning a tab another pane holds swaps.
  await app.menuCommand("grid-two");
  await expect(window.getByTestId("pane-grid")).toHaveAttribute("data-layout", "two");
  await expect(window.getByTestId("pane-0")).toBeVisible();
  await expect(window.getByTestId("pane-1")).toBeVisible();

  await window.getByTestId("pane-picker-0").click();
  // The first menu item is the first session tab: sessions render before the
  // editor group, and the tab's title is the folder's basename (not the seeded
  // project label), so name matching would depend on the temp dir.
  await window.getByRole("menu").getByRole("menuitem").first().click();
  await expect(window.getByTestId("pane-0").getByLabel("Prompt")).toBeVisible({
    timeout: 30_000,
  });

  await window.getByTestId("pane-picker-1").click();
  await window.getByRole("menuitem", { name: /app\.ts/ }).click();

  // Both surfaces are live at the same time — the whole point of the grid.
  await expect(window.getByTestId("pane-1").locator(".cm-editor")).toBeVisible();
  await expect(window.getByTestId("pane-0").getByLabel("Prompt")).toBeVisible();

  // Geometry is explicit, not auto-placed: two panes are two full-height
  // columns, and the three-pane presets put the tall pane on the right side.
  const twoGrid = await box(window.getByTestId("pane-grid"));
  const twoLeft = await box(window.getByTestId("pane-0"));
  const twoRight = await box(window.getByTestId("pane-1"));
  expect(Math.abs(twoLeft.y - twoRight.y)).toBeLessThan(4);
  expect(Math.abs(twoLeft.height - twoRight.height)).toBeLessThan(4);
  expect(Math.abs(twoLeft.y + twoLeft.height - (twoGrid.y + twoGrid.height))).toBeLessThan(12);

  await app.menuCommand("grid-three-left");
  await expect(window.getByTestId("pane-grid")).toHaveAttribute("data-layout", "three-left");
  const threeLeftGrid = await box(window.getByTestId("pane-grid"));
  const leftTall = await box(window.getByTestId("pane-0"));
  const rightTop = await box(window.getByTestId("pane-1"));
  const rightBottom = await box(window.getByTestId("pane-2"));
  expect(leftTall.height).toBeGreaterThan(rightTop.height * 1.5);
  expect(
    Math.abs(leftTall.y + leftTall.height - (threeLeftGrid.y + threeLeftGrid.height)),
  ).toBeLessThan(12);
  expect(Math.abs(rightTop.height - rightBottom.height)).toBeLessThan(4);
  expect(Math.abs(rightTop.x - rightBottom.x)).toBeLessThan(4);
  expect(rightBottom.y - (rightTop.y + rightTop.height)).toBeGreaterThanOrEqual(0);
  expect(rightBottom.y - (rightTop.y + rightTop.height)).toBeLessThan(10);

  await app.menuCommand("grid-three-right");
  await expect(window.getByTestId("pane-grid")).toHaveAttribute("data-layout", "three-right");
  const threeRightGrid = await box(window.getByTestId("pane-grid"));
  const rightTall = await box(window.getByTestId("pane-1"));
  const leftTop = await box(window.getByTestId("pane-0"));
  const leftBottom = await box(window.getByTestId("pane-2"));
  expect(rightTall.height).toBeGreaterThan(leftTop.height * 1.5);
  expect(
    Math.abs(rightTall.y + rightTall.height - (threeRightGrid.y + threeRightGrid.height)),
  ).toBeLessThan(12);
  expect(Math.abs(leftTop.height - leftBottom.height)).toBeLessThan(4);
  expect(Math.abs(leftTop.x - leftBottom.x)).toBeLessThan(4);
  expect(leftBottom.y - (leftTop.y + leftTop.height)).toBeGreaterThanOrEqual(0);
  expect(leftBottom.y - (leftTop.y + leftTop.height)).toBeLessThan(10);
});

test("@smoke anchors the empty-pane picker to the header and clears without leaving the grid", async () => {
  projectDir = mkdtempSync(join(tmpdir(), "pi-desktop-grid-e2e-"));
  writeFileSync(join(projectDir, "app.ts"), "const answer = 1;\n", "utf8");

  app = await launchFakeApp({ projectDir });
  const window = app.window;

  const strip = window.getByTestId("session-tab-strip");
  await expect(strip).toBeVisible({ timeout: 30_000 });
  await strip.getByRole("button", { name: "New session" }).click();
  await expect(window.getByLabel("Prompt")).toBeVisible({ timeout: 30_000 });

  await expect(window.getByTestId("right-rail")).toBeVisible();
  await window.getByTestId("rail-menu-explorer").click();
  const row = window.getByTestId("explorer-row").filter({ hasText: "app.ts" });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "app.ts" }).click();
  await expect(window.locator(".cm-editor")).toBeVisible();

  await app.menuCommand("grid-four");
  await expect(window.getByTestId("pane-grid")).toHaveAttribute("data-layout", "four");

  // Put the session in pane 0 and the editor in pane 1, leaving pane 2 empty.
  await window.getByTestId("pane-picker-0").click();
  await window.getByRole("menu").getByRole("menuitem").first().click();
  await expect(window.getByTestId("pane-0").getByLabel("Prompt")).toBeVisible({
    timeout: 30_000,
  });
  await window.getByTestId("pane-picker-1").click();
  await window.getByRole("menuitem", { name: /app\.ts/ }).click();
  await expect(window.getByTestId("pane-1").locator(".cm-editor")).toBeVisible();

  const empty = window.getByTestId("pane-2");
  await expect(empty.getByText("Pick a session")).toBeVisible();

  // The instructional copy is not a trigger: only the centred + opens the menu.
  await empty.getByText("Pick a session").click();
  await expect(window.getByTestId("pane-picker-menu-2")).toHaveCount(0);

  await window.getByTestId("pane-empty-picker-2").click();
  const menu = window.getByTestId("pane-picker-menu-2");
  await expect(menu).toBeVisible();

  // The menu must hang off the header chevron, not the centre/bottom of the
  // full-size empty placeholder: their right edges share an anchor.
  const menuBox = await box(menu);
  const chevronBox = await box(window.getByTestId("pane-picker-2"));
  expect(Math.abs(menuBox.x + menuBox.width - (chevronBox.x + chevronBox.width))).toBeLessThan(12);
  await window.keyboard.press("Escape");

  // Clearing the focused editor pane hands focus to the session pane.
  await window.getByRole("button", { name: "Clear pane 2" }).click();
  await expect(window.getByTestId("workspace-view")).toHaveAttribute("data-grid-mode", "grid");
  await expect(window.getByTestId("pane-1").getByText("Pick a session")).toBeVisible();
  await expect(window.getByTestId("pane-0")).toHaveAttribute("data-pane-active", "true");

  // Returning to another grid preset must not re-insert the cleared session.
  await app.menuCommand("grid-three-left");
  await expect(window.getByTestId("pane-grid")).toHaveAttribute("data-layout", "three-left");
  await expect(window.getByTestId("pane-1").getByText("Pick a session")).toBeVisible();

  // Clearing the last occupied pane keeps the empty grid, even with no active tab.
  await window.getByRole("button", { name: "Clear pane 1" }).click();
  await expect(window.getByTestId("workspace-view")).toHaveAttribute("data-grid-mode", "grid");
  await expect(window.getByTestId("pane-grid")).toBeVisible();
  await expect(window.getByTestId("pane-0").getByText("Pick a session")).toBeVisible();
  await expect(window.getByTestId("pane-1").getByText("Pick a session")).toBeVisible();
});

test("@smoke restores the layout and its panes after a relaunch", async () => {
  projectDir = mkdtempSync(join(tmpdir(), "pi-desktop-grid-e2e-"));
  writeFileSync(join(projectDir, "one.ts"), "export const one = 1;\n", "utf8");

  app = await launchFakeApp({ projectDir });
  const window = app.window;

  const strip = window.getByTestId("session-tab-strip");
  await expect(strip).toBeVisible({ timeout: 30_000 });
  await strip.getByRole("button", { name: "New session" }).click();
  await expect(window.getByLabel("Prompt")).toBeVisible({ timeout: 30_000 });

  await app.menuCommand("grid-four");
  await expect(window.getByTestId("pane-grid")).toHaveAttribute("data-layout", "four");

  await app.relaunch();

  // `prefs.grid` is persisted with the rest of the app state.
  await expect(app.window.getByTestId("pane-grid")).toHaveAttribute("data-layout", "four");
  await expect(app.window.getByTestId("pane-3")).toBeVisible();
});
