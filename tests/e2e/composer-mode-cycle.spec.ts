import { expect, test } from "@playwright/test";

import { removeTempDirs } from "./fixtures/app";
import { launchFakeApp, type FakeApp } from "./fixtures/fake-app";

/**
 * Composer mode-cycle control in the real app (2026-11-22 plan, step 9).
 *
 * The fixture extension is deliberately generic: arbitrary owner, arbitrary
 * mode names, one same-owner cycle action. It publishes through the normal bus
 * (`host-contributions:update`) and drives its cycle from one controller used by
 * both its registered command (the corner button) and its `tab` shortcut. This
 * is what proves the Desktop side has no Workflow-specific behaviour and that a
 * click and Tab produce the same sequence.
 *
 * NOTE: geometry assertions need the real layout engine, which is why they live
 * here rather than in the jsdom suite.
 */

let app: FakeApp | undefined;

test.setTimeout(120_000);

test.afterEach(async () => {
  if (!app) return;
  await app.shutdown();
  removeTempDirs(app.paths);
  app = undefined;
});

const MODE_EXTENSION = `
const MODES = ["Default", "Plan", "Orchestrator", "Build"];
const SLUGS = ["default", "plan", "orchestrator", "build"];
const TONES = ["accent", "warning", "info", "accent"];
export default function (pi) {
  let index = 0;
  let revision = 0;
  let supported = false;
  let sessionId = "fixture";
  // One menu group, published until "Hide controls" runs. This is what makes
  // the merged bar visible when idle: mode data alone is not bar content.
  let menu = true;

  const contributions = () => {
    const list = [
      {
        id: "mode",
        kind: "mode",
        slot: "mode",
        label: MODES[index],
        tone: TONES[index],
        order: 0,
        actionRef: "mode-cycle",
        actions: [],
      },
      {
        id: "mode-cycle",
        kind: "action",
        slot: "action",
        label: "Cycle mode",
        tone: "neutral",
        order: 20,
        command: { name: "fixture-cycle" },
        enabled: true,
      },
    ];
    // A mode-choice references a real same-owner action. The action is consumed
    // by the composer menu, so it never shows as a duplicate bar button.
    SLUGS.forEach((slug, mode) => {
      list.push({
        id: "mode-" + slug,
        kind: "action",
        slot: "action",
        label: MODES[mode],
        tone: "neutral",
        order: 30 + mode,
        command: { name: "fixture-select-" + slug },
        enabled: mode !== index,
        ...(mode === index ? { disabledReason: "current mode" } : {}),
      });
      list.push({
        id: "choice-" + slug,
        kind: "mode-choice",
        slot: "mode-choice",
        label: MODES[mode],
        tone: "neutral",
        order: 10 + mode,
        actionRef: "mode-" + slug,
        checked: mode === index,
      });
    });
    if (menu) {
      list.push({
        id: "hide-controls",
        kind: "action",
        slot: "action",
        label: "Hide controls",
        tone: "neutral",
        order: 50,
        command: { name: "fixture-hide" },
        enabled: true,
        group: { id: "view", label: "View", order: 1, placement: "menu" },
      });
    }
    return list;
  };

  function publish() {
    revision += 1;
    pi.events.emit("host-contributions:update", {
      version: 1,
      owner: { id: "fixture.mode" },
      sessionId,
      epoch: 0,
      revision,
      // Withdrawing an id is explicit: the registry merges revisions.
      removed: menu ? [] : ["hide-controls"],
      contributions: contributions(),
    });
  }

  // One controller for every entry point: the button's command and the key.
  function cycle() {
    index = (index + 1) % MODES.length;
    publish();
  }

  function select(mode) {
    index = mode;
    publish();
  }

  function hide() {
    menu = false;
    publish();
  }

  pi.events.on("host-contributions:hello", () => { supported = true; publish(); });
  pi.events.on("host-contributions:probe", () => { if (supported) publish(); });
  pi.on("session_start", (_event, ctx) => {
    try { sessionId = ctx.sessionManager.getSessionId(); } catch { /* keep default */ }
    if (supported) publish();
  });

  pi.registerCommand("fixture-cycle", { description: "Cycle fixture mode", handler: async () => cycle() });
  SLUGS.forEach((slug, mode) => {
    pi.registerCommand("fixture-select-" + slug, {
      description: "Select fixture mode " + MODES[mode],
      handler: async () => select(mode),
    });
  });
  pi.registerCommand("fixture-hide", { description: "Hide fixture controls", handler: async () => hide() });
  pi.registerShortcut("tab", { description: "Cycle fixture mode", handler: async () => cycle() });
}
`;

async function openSession(current: FakeApp): Promise<void> {
  const newSession = current.window.getByRole("button", { name: /new session/i }).first();
  await expect(newSession).toBeVisible({ timeout: 60_000 });
  await newSession.click({ timeout: 60_000 });
  await expect(current.window.getByLabel("Prompt")).toBeVisible({ timeout: 60_000 });
}

/** The control's visible mode text. */
function modeText(current: FakeApp) {
  return current.window.getByTestId("composer-mode-button");
}

test("click and Tab walk the same cycle and the label follows published state", async () => {
  app = await launchFakeApp({ launch: { extensions: { "mode-cycle.js": MODE_EXTENSION } } });
  await openSession(app);

  const button = modeText(app);
  await expect(button).toBeVisible({ timeout: 60_000 });
  await expect(button).toHaveText("Default");

  // Click → Plan; the corner is the only mode control, and the fixture's menu
  // group is the bar's only content (mode data alone is never a bar).
  await button.click();
  await expect(button).toHaveText("Plan");
  await expect(app.window.getByTestId("contributions-bar")).toHaveCount(0);
  await expect(app.window.getByTestId("working-bar")).toHaveCount(1);
  await expect(app.window.getByTestId("composer-mode-menu")).toBeVisible();
  // A mode choice's referenced action is consumed by the menu, never a second
  // mode button in the bar.
  const bar = app.window.getByTestId("working-bar");
  await expect(bar.getByRole("button", { name: "Plan", exact: true })).toHaveCount(0);
  await expect(bar.getByRole("button", { name: "Cycle mode", exact: true })).toHaveCount(0);

  // Tab in the prompt advances the same controller → Orchestrator.
  await app.window.getByLabel("Prompt").click();
  await app.window.keyboard.press("Tab");
  await expect(button).toHaveText("Orchestrator");

  // The button itself, then Tab again, stay in lockstep with the cycle.
  await button.click();
  await expect(button).toHaveText("Build");
  await app.window.getByLabel("Prompt").click();
  await app.window.keyboard.press("Tab");
  await expect(button).toHaveText("Default");
});

test("clicking the control preserves the prompt draft and caret", async () => {
  app = await launchFakeApp({ launch: { extensions: { "mode-cycle.js": MODE_EXTENSION } } });
  await openSession(app);

  const prompt = app.window.getByLabel("Prompt");
  await prompt.click();
  await prompt.fill("draft survives the mode click");
  await prompt.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(6, 10));

  await modeText(app).click();
  await expect(modeText(app)).toHaveText("Plan");
  await expect(prompt).toHaveValue("draft survives the mode click");
  const selection = await prompt.evaluate((element: HTMLTextAreaElement) => [
    element.selectionStart,
    element.selectionEnd,
  ]);
  expect(selection).toEqual([6, 10]);
});

test("the control is keyboard reachable, does not trap focus and does not overlap text", async () => {
  app = await launchFakeApp({ launch: { extensions: { "mode-cycle.js": MODE_EXTENSION } } });
  await openSession(app);

  const button = modeText(app);
  await expect(button).toBeVisible({ timeout: 60_000 });

  // Keyboard activation.
  await button.focus();
  await app.window.keyboard.press("Enter");
  await expect(button).toHaveText("Plan");

  // Normal focus navigation: Tab leaves the button instead of being swallowed
  // by the app-wide shortcut dispatcher.
  await button.focus();
  expect(
    await app.window.evaluate(
      () => (document.activeElement as HTMLElement | null)?.dataset.testid ?? null,
    ),
  ).toBe("composer-mode-button");
  await app.window.keyboard.press("Tab");
  // Tab leaves the button (native focus order); the dispatcher does not swallow
  // it into another mode cycle.
  expect(
    await app.window.evaluate(
      () => (document.activeElement as HTMLElement | null)?.dataset.testid ?? null,
    ),
  ).not.toBe("composer-mode-button");
  await expect(button).toHaveText("Plan");

  // Geometry: the reserved padding covers the *whole* control (label + mode
  // chevron) at 100% and 200% zoom, so neither sits on top of the first line of
  // prompt text.
  for (const zoom of [1, 2]) {
    await app.app.evaluate(({ BrowserWindow }, factor) => {
      BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(factor);
    }, zoom);
    await expect(button).toBeVisible();
    await expect(app.window.getByTestId("composer-mode-menu")).toBeVisible();
    const geometry = await app.window.evaluate(() => {
      const control = document.querySelector<HTMLElement>(
        '[data-testid="composer-contribution-badge"]',
      );
      const chevron = document.querySelector<HTMLElement>('[data-testid="composer-mode-menu"]');
      const input = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Prompt"]');
      if (!control || !chevron || !input) return null;
      const controlRect = control.getBoundingClientRect();
      const chevronRect = chevron.getBoundingClientRect();
      const inputRect = input.getBoundingClientRect();
      const style = window.getComputedStyle(input);
      return {
        control: { left: controlRect.left, right: controlRect.right, width: controlRect.width },
        chevron: { left: chevronRect.left, right: chevronRect.right },
        input: { left: inputRect.left, right: inputRect.right, width: inputRect.width },
        paddingRight: Number.parseFloat(style.paddingRight),
      };
    });
    expect(geometry).not.toBeNull();
    if (!geometry) return;
    // Inside the input, never wider than its reserved right padding.
    expect(geometry.control.left).toBeGreaterThanOrEqual(geometry.input.left);
    expect(geometry.control.right).toBeLessThanOrEqual(geometry.input.right);
    expect(geometry.control.width).toBeLessThanOrEqual(geometry.paddingRight + 1);
    // The chevron is part of the measured control, not hanging outside it.
    expect(geometry.chevron.left).toBeGreaterThanOrEqual(geometry.control.left - 1);
    expect(geometry.chevron.right).toBeLessThanOrEqual(geometry.control.right + 1);
    // The whole control stays left of the first line's text area.
    const textBoundary = geometry.input.right - geometry.paddingRight;
    expect(geometry.control.left).toBeGreaterThanOrEqual(textBoundary - 1);
    // The full accessible text is available even when the label is truncated.
    await expect(button).toHaveAttribute("aria-label", /—\s*Cycle mode/);
  }
});

test("the chevron opens upward and selecting a mode runs its referenced action", async () => {
  app = await launchFakeApp({ launch: { extensions: { "mode-cycle.js": MODE_EXTENSION } } });
  await openSession(app);

  const button = modeText(app);
  await expect(button).toHaveText("Default");
  const chevron = app.window.getByTestId("composer-mode-menu");
  await expect(chevron).toBeVisible();

  // Drop-up, not drop-down: Radix reports the resolved side, and the whole menu
  // sits above the trigger rather than over the prompt.
  await chevron.click();
  const menu = app.window.getByTestId("composer-mode-menu-content");
  await expect(menu).toBeVisible();
  expect(await menu.getAttribute("data-side")).toBe("top");
  const menuBottom = await menu.evaluate((node) => node.getBoundingClientRect().bottom);
  const chevronTop = await chevron.evaluate((node) => node.getBoundingClientRect().top);
  expect(menuBottom).toBeLessThanOrEqual(chevronTop + 1);

  // The current mode is checked and disabled; the other modes are selectable.
  const current = app.window.getByRole("menuitemradio", { name: "Default" });
  await expect(current).toHaveAttribute("aria-checked", "true");
  await expect(current).toHaveAttribute("aria-disabled", "true");

  // Direct selection runs the referenced same-owner action; the label follows
  // the *next* snapshot, never an optimistic local step.
  await app.window.getByRole("menuitemradio", { name: "Build" }).click();
  await expect(button).toHaveText("Build");
  await expect(menu).toHaveCount(0);

  // The choice-owned actions are consumed by the menu: no duplicate mode button
  // in the bar, its dots menu or the overflow.
  const bar = app.window.getByTestId("working-bar");
  await expect(bar.getByRole("button", { name: "Plan", exact: true })).toHaveCount(0);
  await expect(bar.getByRole("button", { name: "Build", exact: true })).toHaveCount(0);
  await expect(bar.getByRole("button", { name: "Cycle mode", exact: true })).toHaveCount(0);

  // Old bar testids are gone; only the merged bar exists.
  await expect(app.window.getByTestId("contributions-bar")).toHaveCount(0);
  await expect(app.window.getByTestId("extension-working-row")).toHaveCount(0);

  // The grouped dots menu also points upward. Hiding the fixture's only bar
  // content removes the bar; the mode control stays.
  const dots = app.window.getByTestId("working-bar-menu");
  await dots.click();
  const groupMenu = app.window.getByRole("menu");
  await expect(groupMenu).toBeVisible();
  expect(await groupMenu.getAttribute("data-side")).toBe("top");
  await expect(groupMenu.getByText("View")).toBeVisible();
  await groupMenu.getByText("Hide controls").click();
  await expect(app.window.getByTestId("working-bar")).toHaveCount(0);
  await expect(button).toHaveText("Build");
  await expect(chevron).toBeVisible();
});
