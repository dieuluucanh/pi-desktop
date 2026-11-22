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
export default function (pi) {
  let index = 0;
  let revision = 0;
  let supported = false;
  let sessionId = "fixture";

  const contributions = () => [
    {
      id: "mode",
      kind: "mode",
      slot: "mode",
      label: MODES[index],
      tone: index === 1 ? "warning" : index === 2 ? "info" : "accent",
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

  function publish() {
    revision += 1;
    pi.events.emit("host-contributions:update", {
      version: 1,
      owner: { id: "fixture.mode" },
      sessionId,
      epoch: 0,
      revision,
      removed: [],
      contributions: contributions(),
    });
  }

  // One controller for every entry point: the button's command and the key.
  function cycle() {
    index = (index + 1) % MODES.length;
    publish();
  }

  pi.events.on("host-contributions:hello", () => { supported = true; publish(); });
  pi.events.on("host-contributions:probe", () => { if (supported) publish(); });
  pi.on("session_start", (_event, ctx) => {
    try { sessionId = ctx.sessionManager.getSessionId(); } catch { /* keep default */ }
    if (supported) publish();
  });

  pi.registerCommand("fixture-cycle", { description: "Cycle fixture mode", handler: async () => cycle() });
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

  // Click → Plan; the corner is the only mode control.
  await button.click();
  await expect(button).toHaveText("Plan");
  await expect(app.window.getByTestId("contributions-bar")).toHaveCount(0);

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

  // Geometry: the reserved padding covers the control at 100% and 200% zoom, so
  // the label never sits on top of the first line of prompt text.
  for (const zoom of [1, 2]) {
    await app.app.evaluate(({ BrowserWindow }, factor) => {
      BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(factor);
    }, zoom);
    await expect(button).toBeVisible();
    const geometry = await app.window.evaluate(() => {
      const control = document.querySelector<HTMLElement>('[data-testid="composer-mode-button"]');
      const input = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Prompt"]');
      if (!control || !input) return null;
      const controlRect = control.getBoundingClientRect();
      const inputRect = input.getBoundingClientRect();
      const style = window.getComputedStyle(input);
      return {
        control: { left: controlRect.left, right: controlRect.right, width: controlRect.width },
        input: { left: inputRect.left, right: inputRect.right, width: inputRect.width },
        paddingRight: Number.parseFloat(style.paddingRight),
        fontSize: Number.parseFloat(style.fontSize),
      };
    });
    expect(geometry).not.toBeNull();
    if (!geometry) return;
    // Inside the input, never wider than its reserved right padding.
    expect(geometry.control.left).toBeGreaterThanOrEqual(geometry.input.left);
    expect(geometry.control.right).toBeLessThanOrEqual(geometry.input.right);
    expect(geometry.control.width).toBeLessThanOrEqual(geometry.paddingRight + 1);
    // The full accessible text is available even when the label is truncated.
    await expect(button).toHaveAttribute("aria-label", /—\s*Cycle mode/);
  }
});
