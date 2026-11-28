import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";

import { removeTempDirs } from "./fixtures/app";
import { launchFakeApp, type FakeApp } from "./fixtures/fake-app";

/**
 * Composer prompt-refinement E2E (2026-11-22 prompt-refinement parity, step 36).
 *
 * This drives the **real Electron app**: the real host composer-transform
 * registry, the real private single-use EventBus rendezvous, the real IPC and
 * the real renderer reducer. Only the publisher is a fixture extension, and it
 * is deliberately generic — arbitrary owner id, arbitrary labels, one
 * `composer-control` contribution and the frozen `composer-transform-v1`
 * contract. Desktop therefore has to have no Workflow-specific branch for any
 * of this to pass.
 *
 * The fixture records every host-side fact it observes (bootstrap args keys,
 * claimed request, draft snapshot, candidate, applied receipt) as JSON lines in
 * a temp file, so the tests can assert the side-effect counts that must stay
 * zero (no parent turn, no provider request, no plain-command fallback) without
 * reading anything private out of the renderer.
 *
 * Covered here: toggle position/accessibility, refine→send→return→off→edit→send,
 * typed `/command` equivalence, keyboard/completion routes, images and pasted
 * text, question docking/remount, newer-typing conflict, cancellation and error
 * retry, two tabs, background attention, renderer reload and applied-receipt
 * loss. Geometry assertions need the real layout engine, which is why they live
 * in Playwright rather than the jsdom suite.
 */

test.setTimeout(150_000);

/**
 * Generic fixture publisher. Behaviour is driven by env:
 *   FIXTURE_SCENARIO      candidate | question | hold | fail
 *   FIXTURE_RELEASE_FILE  when set, the operation waits for this file to exist
 *   FIXTURE_COMPOSER_LOG  append-only JSONL evidence log
 */
const REFINEMENT_EXTENSION = `
import { appendFileSync, existsSync } from "node:fs";

const CONTRACT = "composer-transform-v1";
const CHANNEL_PREFIX = "composer-transform:v1:rendezvous:";
const OWNER = "e2e.refine";
const PUBLIC_COMMAND = "fixture-prompt";
const COMPANION_COMMAND = "fixture-refine-companion";
const TOGGLE_COMMAND = "fixture-refine-toggle";
const SCENARIO_COMMAND = "fixture-scenario";

export default function (pi) {
  let revision = 0;
  let sessionId = "fixture";
  let armed = false;
  let supported = false;
  let starts = 0;
  let scenario = process.env.FIXTURE_SCENARIO || "candidate";

  function log(event, data) {
    const path = process.env.FIXTURE_COMPOSER_LOG;
    if (!path) return;
    try {
      appendFileSync(path, JSON.stringify(Object.assign({ event, at: Date.now() }, data || {})) + "\\n");
    } catch {
      /* evidence is best effort, never a reason to fail an operation */
    }
  }

  function contributions() {
    return [
      {
        id: "refine",
        kind: "composer-control",
        slot: "composer-actions",
        label: "Refine prompt",
        description: "Returns a refined draft; never runs it.",
        icon: "sparkles",
        tone: "accent",
        order: 0,
        checked: armed,
        enabled: true,
        behavior: "one-shot-return",
        actionRef: "refine-toggle",
        transformActionRef: "refine-send",
        operation: {
          contract: CONTRACT,
          publicCommand: PUBLIC_COMMAND,
          companionCommand: COMPANION_COMMAND,
        },
      },
      {
        id: "refine-toggle",
        kind: "action",
        slot: "action",
        label: "Toggle refinement",
        tone: "neutral",
        order: 10,
        command: { name: TOGGLE_COMMAND },
        enabled: true,
      },
      {
        id: "refine-send",
        kind: "action",
        slot: "action",
        label: "Refine and return",
        tone: "neutral",
        order: 11,
        command: { name: PUBLIC_COMMAND },
        enabled: true,
      },
    ];
  }

  function publish() {
    revision += 1;
    pi.events.emit("host-contributions:update", {
      version: 1,
      owner: { id: OWNER },
      sessionId,
      epoch: 0,
      revision,
      removed: [],
      contributions: contributions(),
    });
    log("publish", { revision, armed, scenario });
  }

  pi.registerCommand(TOGGLE_COMMAND, {
    description: "Toggle the fixture refinement",
    handler: async () => {
      armed = !armed;
      log("toggle", { armed });
      publish();
    },
  });

  pi.registerCommand(SCENARIO_COMMAND, {
    description: "Set the fixture refinement scenario",
    handler: async (args) => {
      scenario = String(args || "").trim() || "candidate";
      log("scenario", { scenario });
    },
  });

  // The advertised transform entrance. A typed "/fixture-prompt <text>" must
  // reach the structured operation instead of this handler; reaching it is a
  // routing failure the tests assert against.
  pi.registerCommand(PUBLIC_COMMAND, {
    description: "Refine a prompt and return it to the composer",
    handler: async (args, ctx) => {
      log("public-command-ran", { argsLength: String(args || "").length });
      ctx.ui.notify("fixture-prompt ran as a plain command", "warning");
    },
  });

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitForRelease(signal) {
    const path = process.env.FIXTURE_RELEASE_FILE;
    if (!path) return true;
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      if (signal.aborted) return false;
      if (existsSync(path)) {
        log("released");
        return true;
      }
      await delay(50);
    }
    log("release-timeout");
    return false;
  }

  async function run(port, ctx) {
    const request = port.operation.request;
    const signal = port.operation.signal;
    starts += 1;
    log("started", {
      starts,
      requestId: request.requestId,
      ownerId: request.ownerId,
      controlId: request.controlId,
      actionId: request.actionId,
      transformActionId: request.transformActionId,
      text: request.snapshot.text,
      expandedText: request.snapshot.expandedText === undefined ? null : request.snapshot.expandedText,
      selection: request.snapshot.selection,
      attachmentCount: request.snapshot.attachments.length,
      imageCount: Array.isArray(request.images) ? request.images.length : 0,
      inputState: request.snapshot.inputState,
    });
    port.progress({ state: "running", phase: "inspect", message: "Fixture: inspecting" });
    if (!(await waitForRelease(signal))) {
      log("aborted-before-scenario");
      return;
    }
    log("scenario", { scenario });
    if (signal.aborted) {
      log("aborted");
      return;
    }
    if (scenario === "fail") {
      port.fail({ code: "provider-error", message: "fixture provider failure" });
      log("failed");
      return;
    }
    if (scenario === "question") {
      port.progress({ state: "awaiting-input", phase: "clarify", message: "Fixture: one question" });
      let answer = null;
      try {
        answer = await ctx.ui.select("Which audience should the prompt target?", [
          "End users",
          "Maintainers",
        ]);
      } catch (error) {
        log("question-error", { message: String(error) });
      }
      log("answered", { answer: answer === undefined || answer === null ? null : String(answer) });
      if (signal.aborted) {
        log("aborted");
        return;
      }
      port.progress({ state: "running", phase: "compose", message: "Fixture: composing" });
    }
    if (scenario === "hold") {
      signal.addEventListener("abort", () => log("aborted-hold"));
      log("holding");
      return;
    }
    const text = "Refined: " + request.snapshot.text;
    // The host rejects a candidate whose revision is not newer than the
    // operation's (each progress frame bumps it), exactly like a real runtime.
    port.candidate({
      candidateRevision: 100,
      text,
      summary: "Fixture refinement: kept the intent.",
    });
    log("candidate", { text });
  }

  pi.registerCommand(COMPANION_COMMAND, {
    description: "Fixture refinement companion (grant-only bootstrap)",
    handler: async (args, ctx) => {
      let bootstrap;
      try {
        bootstrap = JSON.parse(String(args || ""));
      } catch {
        log("bootstrap-invalid");
        return;
      }
      const keys = Object.keys(bootstrap).sort();
      const grant = typeof bootstrap.grant === "string" ? bootstrap.grant : "";
      log("bootstrap", { contract: bootstrap.contract, keys, grantPresent: grant.length > 0 });
      const parts = grant.split(".");
      if (parts.length !== 2) {
        log("bootstrap-invalid-grant");
        return;
      }
      pi.events.emit(CHANNEL_PREFIX + parts[0], {
        contract: CONTRACT,
        grantId: parts[0],
        proof: parts[1],
        accept: (port) => {
          void run(port, ctx);
        },
      });
      log("claim-emitted", { grantId: parts[0] });
    },
  });

  // The host emits this only after the renderer confirmed the atomic apply.
  // Like the real Workflow adapter, the *publisher* owns the armed flag: the
  // applied receipt is the one automatic disarm, and it must be republished so
  // a reloaded renderer reads off instead of resurrecting a stale on.
  pi.events.on("composer-transform:v1:applied", (payload) => {
    const record = payload && typeof payload === "object" ? payload : {};
    log("applied", {
      requestId: typeof record.requestId === "string" ? record.requestId : null,
      appliedRevision: typeof record.appliedRevision === "number" ? record.appliedRevision : null,
    });
    if (armed) {
      armed = false;
      publish();
    }
  });

  pi.events.on("host-contributions:hello", () => {
    supported = true;
    publish();
  });
  pi.events.on("host-contributions:probe", () => {
    if (supported) publish();
  });
  pi.on("session_start", (_event, ctx) => {
    try {
      sessionId = ctx.sessionManager.getSessionId();
    } catch {
      /* keep the default */
    }
    if (supported) publish();
  });
}
`;

interface LogEntry {
  event: string;
  [key: string]: unknown;
}

let app: FakeApp | undefined;
let logDir: string | undefined;
/** Temp project dirs a test created itself (the two-pane launch seeds two). */
const extraTempDirs: string[] = [];

// Playwright requires an object pattern; this one intentionally requests no
// fixture (the default `page` fixture would launch Chromium).
// eslint-disable-next-line no-empty-pattern
test.afterEach(async ({}, testInfo) => {
  // A failed refinement assertion is nearly always explained by what the
  // publisher observed, so keep that evidence in the Playwright report.
  if (testInfo.status !== testInfo.expectedStatus && logDir) {
    const logPath = join(logDir, "composer.jsonl");
    const entries = existsSync(logPath) ? readFileSync(logPath, "utf8").trim() : "(empty)";
    await testInfo.attach("publisher-log.jsonl", { body: entries, contentType: "text/plain" });
    console.log(`publisher log (${testInfo.title}):\n${entries}`);
  }
  if (app) {
    await app.shutdown();
    removeTempDirs(app.paths);
    app = undefined;
  }
  while (extraTempDirs.length > 0) {
    const dir = extraTempDirs.pop();
    if (dir === undefined) break;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows keeps a handle briefly after exit.
    }
  }
  if (logDir) {
    try {
      rmSync(logDir, { recursive: true, force: true });
    } catch {
      // Windows keeps a handle briefly after exit.
    }
    logDir = undefined;
  }
});

interface Launched {
  app: FakeApp;
  logPath: string;
  log(): LogEntry[];
  waitForLog(event: string, timeoutMs?: number): Promise<LogEntry>;
}

async function launchRefinement(
  scenario: string,
  options: {
    release?: boolean;
    extraEnv?: Record<string, string>;
    appState?: Record<string, unknown>;
  } = {},
): Promise<Launched> {
  logDir = mkdtempSync(join(tmpdir(), "pi-desktop-e2e-refine-"));
  const logPath = join(logDir, "composer.jsonl");
  const releasePath = options.release === true ? join(logDir, "release") : undefined;
  const launched = await launchFakeApp({
    ...(options.appState === undefined ? {} : { appState: options.appState }),
    launch: {
      extensions: { "refinement-fixture.js": REFINEMENT_EXTENSION },
      env: {
        FIXTURE_COMPOSER_LOG: logPath,
        FIXTURE_SCENARIO: scenario,
        // This spec predates managed attachments and exercises the legacy
        // composer image path that the refinement transform consumes. The
        // dedicated attachments spec enables the managed path explicitly.
        PI_DESKTOP_ATTACHMENTS: "0",
        ...(releasePath === undefined ? {} : { FIXTURE_RELEASE_FILE: releasePath }),
        ...(options.extraEnv ?? {}),
      },
    },
  });
  app = launched;
  const read = (): LogEntry[] => {
    if (!existsSync(logPath)) return [];
    return readFileSync(logPath, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as LogEntry);
  };
  return {
    app: launched,
    logPath,
    log: read,
    async waitForLog(event, timeoutMs = 30_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found = read().find((entry) => entry.event === event);
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(
        `the fixture never logged ${JSON.stringify(event)}; saw ${JSON.stringify(
          read().map((entry) => entry.event),
        )}`,
      );
    },
  };
}

/** Releases a scenario that was launched with `release: true`. */
function release(search: (name: string) => string): void {
  writeFileSync(search("release"), "go\n", "utf8");
}

async function openSession(current: FakeApp): Promise<void> {
  const newSession = current.window.getByRole("button", { name: /new session/i }).first();
  await expect(newSession).toBeVisible({ timeout: 60_000 });
  await newSession.click({ timeout: 60_000 });
  await expect(composer(current)).toBeVisible({ timeout: 60_000 });
}

function composer(current: FakeApp): Locator {
  // The refinement control's accessible name also contains "prompt", so match
  // the textbox role rather than every label substring.
  return current.window.getByRole("textbox", { name: "Prompt" });
}

function control(current: FakeApp): Locator {
  return current.window.getByTestId("composer-control").first();
}

function sendButton(current: FakeApp): Locator {
  return current.window.getByRole("button", { name: "Send" });
}

async function arm(current: FakeApp): Promise<void> {
  await expect(control(current)).toBeVisible({ timeout: 60_000 });
  await control(current).click();
  await expect(control(current)).toHaveAttribute("aria-pressed", "true", { timeout: 30_000 });
}

/** Waits until the composer's own candidate text is in place. */
async function expectDraft(current: FakeApp, text: string): Promise<void> {
  await expect(composer(current)).toHaveValue(text, { timeout: 60_000 });
}

/** One rendered transcript row per message/tool/notice item. */
function transcriptRows(page: Page): Locator {
  return page.getByTestId("transcript-row");
}

/**
 * No refinement leaked into the conversation.
 *
 * The transcript legitimately contains the session's own "Session started"
 * info row, so a row *count* proves nothing. What must stay at zero is any row
 * carrying the draft, the candidate, the typed command, or a plain-command
 * notice: refinement is a composer operation, never a turn.
 */
async function expectNoConversationRow(current: FakeApp): Promise<void> {
  const rows = transcriptRows(current.window);
  await expect(rows.filter({ hasText: "Refined:" })).toHaveCount(0);
  await expect(rows.filter({ hasText: "/fixture-prompt" })).toHaveCount(0);
  await expect(rows.filter({ hasText: "fixture-prompt ran as a plain command" })).toHaveCount(0);
  // Every notice lives inside a transcript row, so the row filters above already
  // cover notices. (A bare notice locator also matches the "Session started"
  // row of both panes, which would be a strict-mode violation, not a leak.)
}

test("the control sits in the bottom-right composer row and reports armed state accessibly", async () => {
  const launched = await launchRefinement("candidate");
  await openSession(launched.app);

  const target = control(launched.app);
  await expect(target).toBeVisible({ timeout: 60_000 });
  await expect(target).toHaveAttribute("aria-pressed", "false");
  await expect(target).toHaveAttribute("data-behavior", "one-shot-return");
  await expect(target).toHaveAttribute("data-checked", "false");
  await expect(target).toHaveAccessibleName(/Refine prompt.*off/);

  const row = launched.app.window.getByTestId("composer-controls");
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute("role", "group");
  await expect(row).toHaveAttribute("aria-label", "Composer controls");

  // Geometry: the generic row is inside the composer, on the same bottom line
  // as Send and to its left, so a verbose publisher cannot hide Send/Stop.
  const controlBox = await target.boundingBox();
  const sendBox = await sendButton(launched.app).boundingBox();
  expect(controlBox).not.toBeNull();
  expect(sendBox).not.toBeNull();
  if (!controlBox || !sendBox) return;
  expect(Math.abs(controlBox.y + controlBox.height - (sendBox.y + sendBox.height))).toBeLessThan(4);
  expect(controlBox.x + controlBox.width).toBeLessThanOrEqual(sendBox.x + 1);
  const composerBox = await launched.app.window.getByTestId("composer-drop").boundingBox();
  expect(composerBox).not.toBeNull();
  if (composerBox) {
    expect(controlBox.y).toBeGreaterThanOrEqual(composerBox.y);
    expect(controlBox.y + controlBox.height).toBeLessThanOrEqual(
      composerBox.y + composerBox.height + 1,
    );
  }

  // A pointer click preserves the draft and the caret (the composer keeps focus).
  const prompt = composer(launched.app);
  await prompt.click();
  await prompt.fill("keeps my caret while toggling");
  await prompt.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(4, 9));
  await target.click();
  await expect(target).toHaveAttribute("aria-pressed", "true");
  await expect(launched.app.window.getByTestId("composer-armed-hint")).toHaveText(
    "Send refines, does not run",
  );
  await expect(prompt).toHaveValue("keeps my caret while toggling");
  expect(
    await prompt.evaluate((element: HTMLTextAreaElement) => [
      element.selectionStart,
      element.selectionEnd,
    ]),
  ).toEqual([4, 9]);

  // Keyboard activation is accessible and toggles the same state back off.
  await target.focus();
  await launched.app.window.keyboard.press("Space");
  await expect(target).toHaveAttribute("aria-pressed", "false");
  await expect(launched.app.window.getByTestId("composer-armed-hint")).toHaveCount(0);
});

test("refine → send → return → off → edit → send dispatches only the later human send", async () => {
  const launched = await launchRefinement("candidate");
  await openSession(launched.app);

  await arm(launched.app);
  const prompt = composer(launched.app);
  await prompt.click();
  await prompt.fill("make the paragrph better");
  await prompt.press("Enter");

  // The candidate returns to the same editable composer, with the prefix-free
  // text, and the one-shot control disarms exactly once.
  await expectDraft(launched.app, "Refined: make the paragrph better");
  await expect(control(launched.app)).toHaveAttribute("aria-pressed", "false");
  // The applied receipt surfaces as the one automatic disarm: the armed hint
  // is gone and no candidate strip is left asking for a decision. (The host's
  // receipt echo is not an extension event; the disarm is the renderer's.)
  await expect(launched.app.window.getByTestId("composer-armed-hint")).toHaveCount(0);
  await expectNoConversationRow(launched.app);
  expect(launched.app.provider.requests).toHaveLength(0);

  const entries = launched.log();
  expect(entries.filter((entry) => entry.event === "started")).toHaveLength(1);
  expect(entries.filter((entry) => entry.event === "public-command-ran")).toHaveLength(0);

  // Editing and sending again is an ordinary task dispatch.
  await prompt.fill("now actually run this");
  await prompt.press("Enter");
  await expect
    .poll(() => launched.app.provider.requests.length, { timeout: 30_000 })
    .toBeGreaterThan(0);
  await expect(prompt).toHaveValue("", { timeout: 30_000 });
  await expect(
    transcriptRows(launched.app.window).filter({ hasText: "now actually run this" }),
  ).toHaveCount(1, { timeout: 30_000 });
  const started = launched.log().filter((entry) => entry.event === "started");
  expect(started).toHaveLength(1);
});

test("a typed /command runs the same structured operation as an armed Send", async () => {
  const launched = await launchRefinement("candidate");
  await openSession(launched.app);

  const prompt = composer(launched.app);
  await prompt.click();
  await prompt.fill("/fixture-prompt rewrite the intro for maintainers");
  await prompt.press("Enter");

  const started = await launched.waitForLog("started");
  // The literal arguments are the refinement input; the buffer stays the base.
  expect(started.text).toBe("rewrite the intro for maintainers");
  await expectDraft(launched.app, "Refined: rewrite the intro for maintainers");
  await expect(control(launched.app)).toHaveAttribute("aria-pressed", "false");
  expect(launched.log().filter((entry) => entry.event === "public-command-ran")).toHaveLength(0);
  await expectNoConversationRow(launched.app);
  expect(launched.app.provider.requests).toHaveLength(0);
});

test("Tab completes the advertised transform command and Enter still routes it", async () => {
  const launched = await launchRefinement("candidate");
  await openSession(launched.app);

  const prompt = composer(launched.app);
  await prompt.click();
  await prompt.fill("/fixture-pr");
  // The completion overlay is debounced; accepting before it opens would prove
  // nothing. Wait for the host-backed suggestion, then accept it with Tab.
  await expect(launched.app.window.getByTestId("completion-overlay")).toBeVisible({
    timeout: 30_000,
  });
  await prompt.press("Tab");
  await expect(prompt).toHaveValue(/^\/fixture-prompt\b/, { timeout: 30_000 });

  await prompt.fill("/fixture-prompt tighten the opening sentence");
  await prompt.press("Enter");
  const started = await launched.waitForLog("started");
  expect(started.text).toBe("tighten the opening sentence");
  await expectDraft(launched.app, "Refined: tighten the opening sentence");
  expect(launched.app.provider.requests).toHaveLength(0);
});

test("images and a collapsed paste survive refinement and the later human send", async () => {
  const launched = await launchRefinement("candidate");
  await openSession(launched.app);

  const prompt = composer(launched.app);
  await prompt.click();
  await prompt.fill("keep the screenshot and the pasted log");

  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  await launched.app.window
    .getByTestId("composer-attach-input")
    .setInputFiles({ name: "shot.png", mimeType: "image/png", buffer: png });
  await expect(launched.app.window.getByTestId("attachments")).toContainText("shot.png");

  // A large paste collapses into the canonical marker (line 20 proves the
  // expanded text is what the operation receives).
  await prompt.evaluate((element: HTMLTextAreaElement) => {
    const text = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
    const data = new DataTransfer();
    data.setData("text/plain", text);
    element.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
    );
  });
  await expect(prompt).toHaveValue(/\[paste #\d+ \+\d+ lines\]/, { timeout: 30_000 });

  await arm(launched.app);
  await prompt.press("Enter");
  const started = await launched.waitForLog("started");
  expect(started.attachmentCount).toBe(1);
  expect(started.imageCount).toBe(1);
  expect(String(started.text)).toContain("[paste #");
  expect(String(started.expandedText)).toContain("line 20");

  await expect
    .poll(async () => composer(launched.app).inputValue(), { timeout: 60_000 })
    .toMatch(/^Refined: keep the screenshot and the pasted log/);
  // Attachments are preserved through the CAS apply.
  await expect(launched.app.window.getByTestId("attachments")).toContainText("shot.png");

  // The later human send carries the image for real.
  await composer(launched.app).press("Enter");
  await expect
    .poll(() => launched.app.provider.requests.length, { timeout: 30_000 })
    .toBeGreaterThan(0);
  const request = launched.app.provider.requests.at(-1);
  expect(JSON.stringify(request?.body ?? {})).toContain("image_url");
});

test("a question docks over the composer and remounts it with draft and image intact", async () => {
  const launched = await launchRefinement("question", { release: true });
  await openSession(launched.app);

  const prompt = composer(launched.app);
  await prompt.click();
  await prompt.fill("summarise the failure for the release notes");
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  await launched.app.window
    .getByTestId("composer-attach-input")
    .setInputFiles({ name: "trace.png", mimeType: "image/png", buffer: png });

  await arm(launched.app);
  await prompt.press("Enter");
  const started = await launched.waitForLog("started");
  expect(started.attachmentCount).toBe(1);

  release((name) => join(logDir ?? "", name));

  const title = launched.app.window.getByTestId("extension-dialog-title");
  await expect(title).toBeVisible({ timeout: 60_000 });
  await expect(title).toContainText("Which audience should the prompt target?");

  // Answer with the keyboard: the composer was replaced by the dialog, then
  // remounted with the same draft and attachment.
  await launched.app.window.keyboard.press("ArrowDown");
  await launched.app.window.keyboard.press("Enter");
  await expect(title).toHaveCount(0, { timeout: 60_000 });

  await expectDraft(launched.app, "Refined: summarise the failure for the release notes");
  await expect(launched.app.window.getByTestId("attachments")).toContainText("trace.png");
  const answered = await launched.waitForLog("answered");
  expect(answered.answer).toBe("Maintainers");
  expect(launched.app.provider.requests).toHaveLength(0);
});

test("typing while a refinement runs wins: the candidate conflicts instead of overwriting", async () => {
  const launched = await launchRefinement("candidate", { release: true });
  await openSession(launched.app);

  const prompt = composer(launched.app);
  await prompt.click();
  await prompt.fill("base text");
  await arm(launched.app);
  await prompt.press("Enter");
  const started = await launched.waitForLog("started");
  expect(started.text).toBe("base text");

  // Newer typing moves the draft revision past the captured base.
  await prompt.fill("base text plus my newest edit");
  release((name) => join(logDir ?? "", name));

  await launched.waitForLog("candidate");
  const conflict = launched.app.window.getByTestId("composer-operation-conflict");
  await expect(conflict).toBeVisible({ timeout: 60_000 });
  await expect(prompt).toHaveValue("base text plus my newest edit");
  // The original stays recoverable without replacing the newer draft.
  await expect(launched.app.window.getByTestId("composer-operation-view-original")).toBeVisible();
  await expect(launched.app.window.getByTestId("composer-operation-replace")).toBeVisible();
});

test("cancellation keeps the arm and a retryable error keeps the draft", async () => {
  const launched = await launchRefinement("hold", { release: true });
  await openSession(launched.app);

  const prompt = composer(launched.app);
  await prompt.click();
  await prompt.fill("hold this draft");
  await arm(launched.app);
  await prompt.press("Enter");
  await launched.waitForLog("started");
  release((name) => join(logDir ?? "", name));
  await launched.waitForLog("holding");

  // Esc is routed to the refinement first; the draft is untouched and the
  // control stays armed for a retry (only an explicit toggle-off disarms).
  await launched.app.window.keyboard.press("Escape");
  await launched.waitForLog("aborted-hold");
  await expect(prompt).toHaveValue("hold this draft");
  await expect(control(launched.app)).toHaveAttribute("aria-pressed", "true");
  await expect(launched.app.window.getByTestId("composer-operation-cancel")).toHaveCount(0);
  await expectNoConversationRow(launched.app);
  expect(launched.app.provider.requests).toHaveLength(0);

  // A provider failure is not a send and not a disarm.
  await prompt.fill("/fixture-scenario fail");
  await prompt.press("Enter");
  await prompt.fill("retry after the provider error");
  await prompt.press("Enter");
  await launched.waitForLog("failed");
  await expect(prompt).toHaveValue("retry after the provider error");
  await expect(control(launched.app)).toHaveAttribute("aria-pressed", "true");
  await expect(launched.app.window.getByTestId("composer-operation-status")).toBeVisible({
    timeout: 30_000,
  });
  await expectNoConversationRow(launched.app);
});

test("two tabs stay isolated and a background question only marks attention", async () => {
  const launched = await launchRefinement("question", { release: true });
  await openSession(launched.app);
  await arm(launched.app);
  const prompt = composer(launched.app);
  await prompt.click();
  await prompt.fill("first tab draft");
  await prompt.press("Enter");
  await launched.waitForLog("started");

  // Second tab: its own composer, no operation panel and its own draft.
  const newSession = launched.app.window.getByRole("button", { name: /new session/i }).first();
  await newSession.click();
  await expect(composer(launched.app)).toBeVisible({ timeout: 60_000 });
  await expect(launched.app.window.getByTestId("composer-operation-panel")).toHaveCount(0);
  await composer(launched.app).fill("second tab draft");

  release((name) => join(logDir ?? "", name));

  const tabs = launched.app.window.getByRole("tab");
  const firstTab = tabs.first();
  // The attention flag is on the tab chip wrapper; the accessible `role=tab`
  // button is its child (and its title also announces the waiting state).
  const attentionChip = launched.app.window.locator('[data-attention="true"]');
  await expect(attentionChip).toHaveCount(1, { timeout: 60_000 });
  await expect(attentionChip.getByTestId("tab-attention")).toBeVisible();
  await expect(firstTab).toHaveAttribute("title", /waiting for your input/);
  // The background tab's question does not steal focus from the second tab.
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(composer(launched.app)).toHaveValue("second tab draft");

  // Answering in the first tab applies the candidate there only.
  await firstTab.click();
  const title = launched.app.window.getByTestId("extension-dialog-title");
  await expect(title).toBeVisible({ timeout: 60_000 });
  await launched.app.window.keyboard.press("Enter");
  await expect(title).toHaveCount(0, { timeout: 60_000 });
  await expectDraft(launched.app, "Refined: first tab draft");

  await tabs.nth(1).click();
  await expect(composer(launched.app)).toHaveValue("second tab draft");
});

test("two panes keep their own arm, draft and candidate", async () => {
  // Two projects → two session tabs with distinct titles, so the pane picker
  // can address each one without relying on a menu index.
  const alpha = mkdtempSync(join(tmpdir(), "pi-desktop-e2e-pane-alpha-"));
  const beta = mkdtempSync(join(tmpdir(), "pi-desktop-e2e-pane-beta-"));
  extraTempDirs.push(alpha, beta);
  const launched = await launchRefinement("candidate", {
    appState: {
      projects: [
        { path: alpha, name: "Alpha", addedAt: 1, lastOpenedAt: 2 },
        { path: beta, name: "Beta", addedAt: 2, lastOpenedAt: 1 },
      ],
      activeProject: alpha,
    },
  });
  await openSession(launched.app);
  await expect(control(launched.app)).toBeVisible({ timeout: 60_000 });

  // The second session lives in the other project and gets its own tab.
  await launched.app.window.getByRole("button", { name: "Beta", exact: true }).click();
  await launched.app.window
    .getByTestId("session-tab-strip")
    .getByRole("button", { name: "New session" })
    .click();
  await expect(launched.app.window.getByRole("tab")).toHaveCount(2, { timeout: 60_000 });
  await expect(composer(launched.app)).toBeVisible({ timeout: 60_000 });

  // Two panes, one session tab each.
  await launched.app.menuCommand("grid-two");
  await expect(launched.app.window.getByTestId("pane-grid")).toHaveAttribute("data-layout", "two");
  const pane0 = launched.app.window.getByTestId("pane-0");
  const pane1 = launched.app.window.getByTestId("pane-1");
  await launched.app.window.getByTestId("pane-picker-0").click();
  await launched.app.window
    .getByTestId("pane-picker-menu-0")
    .getByRole("menuitem")
    .filter({ hasText: /alpha/i })
    .click();
  await expect(pane0.getByRole("textbox", { name: "Prompt" })).toBeVisible({
    timeout: 30_000,
  });
  await launched.app.window.getByTestId("pane-picker-1").click();
  await launched.app.window
    .getByTestId("pane-picker-menu-1")
    .getByRole("menuitem")
    .filter({ hasText: /beta/i })
    .click();
  const prompt1 = pane1.getByRole("textbox", { name: "Prompt" });
  await expect(prompt1).toBeVisible({ timeout: 30_000 });

  const prompt0 = pane0.getByRole("textbox", { name: "Prompt" });
  const control0 = pane0.getByTestId("composer-control").first();
  const control1 = pane1.getByTestId("composer-control").first();
  await expect(control0).toBeVisible({ timeout: 30_000 });
  await expect(control1).toBeVisible({ timeout: 30_000 });

  // Arming and refining in pane 0 leaves pane 1 off and empty.
  await control0.click();
  await expect(control0).toHaveAttribute("aria-pressed", "true");
  await expect(control1).toHaveAttribute("aria-pressed", "false");
  await prompt0.click();
  await prompt0.fill("alpha pane draft");
  await prompt0.press("Enter");

  await expect(prompt0).toHaveValue("Refined: alpha pane draft", { timeout: 60_000 });
  await expect(control0).toHaveAttribute("aria-pressed", "false");
  await expect(prompt1).toHaveValue("");
  await expect(control1).toHaveAttribute("aria-pressed", "false");
  await expect(pane1.getByTestId("composer-operation-panel")).toHaveCount(0);

  // Exactly one operation started, its input was the pane-0 draft, and nothing
  // was dispatched to the model by either pane.
  const started = launched.log().filter((entry) => entry.event === "started");
  expect(started).toHaveLength(1);
  expect(started[0]?.text).toBe("alpha pane draft");
  expect(launched.app.provider.requests).toHaveLength(0);
  await expectNoConversationRow(launched.app);
});

test("a renderer reload keeps the applied text once and never re-runs the operation", async () => {
  const launched = await launchRefinement("candidate");
  await openSession(launched.app);

  const prompt = composer(launched.app);
  await prompt.click();
  await prompt.fill("reload keeps this candidate");
  await arm(launched.app);
  await prompt.press("Enter");
  await expectDraft(launched.app, "Refined: reload keeps this candidate");

  await launched.app.window.reload();
  await expect(composer(launched.app)).toBeVisible({ timeout: 60_000 });
  // Activation re-reads the tab's contributions and reconciles the operation.
  await launched.app.window.getByRole("tab").first().click();
  await expect(composer(launched.app)).toHaveValue("Refined: reload keeps this candidate");
  await expect(control(launched.app)).toHaveAttribute("aria-pressed", "false");
  expect(launched.log().filter((entry) => entry.event === "started")).toHaveLength(1);
  expect(launched.app.provider.requests).toHaveLength(0);
});

test("a reload mid-refinement never starts a second operation and never double-inserts", async () => {
  const launched = await launchRefinement("candidate", { release: true });
  await openSession(launched.app);

  const prompt = composer(launched.app);
  await prompt.click();
  await prompt.fill("reload during the refinement");
  await arm(launched.app);
  await prompt.press("Enter");
  const started = await launched.waitForLog("started");
  expect(started.text).toBe("reload during the refinement");

  // Give the draft mirror a moment to persist, then reload while the host
  // operation is still live. The renderer loses its operation record and its
  // in-memory applied-receipt table, which is exactly the ack-lost shape.
  await launched.app.window.waitForTimeout(400);
  await launched.app.window.reload();
  await expect(composer(launched.app)).toBeVisible({ timeout: 60_000 });
  await expect(composer(launched.app)).toHaveValue("reload during the refinement");
  await launched.app.window.getByRole("tab").first().click();
  await expect(control(launched.app)).toBeVisible({ timeout: 60_000 });

  release((name) => join(logDir ?? "", name));
  await launched.waitForLog("candidate");

  // Union of the surfaces a reloaded renderer may legitimately offer: an
  // adopted result/conflict, or nothing at all (see the fixme below). Either
  // way the safety guarantees hold: no second provider call, no overwrite of
  // the draft, and at most one copy of the refined text.
  const replace = launched.app.window.getByTestId("composer-operation-replace");
  if (await replace.isVisible().catch(() => false)) await replace.click();
  await expect
    .poll(async () => (await composer(launched.app).inputValue()).split("Refined:").length - 1, {
      timeout: 30_000,
    })
    .toBeLessThanOrEqual(1);
  expect(launched.log().filter((entry) => entry.event === "started")).toHaveLength(1);
  expect(launched.app.provider.requests).toHaveLength(0);
  await expectNoConversationRow(launched.app);
});

test("a typed transform command carries its images into the later human send", async () => {
  const launched = await launchRefinement("candidate");
  await openSession(launched.app);

  const prompt = composer(launched.app);
  await prompt.click();
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  await launched.app.window
    .getByTestId("composer-attach-input")
    .setInputFiles({ name: "typed.png", mimeType: "image/png", buffer: png });
  await expect(launched.app.window.getByTestId("attachments")).toContainText("typed.png");

  // The typed prefix route is the second entrance to the same structured
  // operation, so it must capture the attachment snapshot exactly like an
  // armed Send does — and it must not clear the composer or consume the image.
  await prompt.fill("/fixture-prompt describe this screenshot for the changelog");
  await prompt.press("Enter");
  const started = await launched.waitForLog("started");
  expect(started.text).toBe("describe this screenshot for the changelog");
  expect(started.attachmentCount).toBe(1);
  expect(started.imageCount).toBe(1);

  await expect
    .poll(async () => composer(launched.app).inputValue(), { timeout: 60_000 })
    .toBe("Refined: describe this screenshot for the changelog");
  await expect(launched.app.window.getByTestId("attachments")).toContainText("typed.png");
  await expect(control(launched.app)).toHaveAttribute("aria-pressed", "false");
  expect(launched.log().filter((entry) => entry.event === "public-command-ran")).toHaveLength(0);
  expect(launched.app.provider.requests).toHaveLength(0);

  // The image is still the *draft's* image until the human send.
  await composer(launched.app).press("Enter");
  await expect
    .poll(() => launched.app.provider.requests.length, { timeout: 30_000 })
    .toBeGreaterThan(0);
  const request = launched.app.provider.requests.at(-1);
  expect(JSON.stringify(request?.body ?? {})).toContain("image_url");
});

test("an applied receipt lost on reload is never re-applied and never double-inserts", async () => {
  const launched = await launchRefinement("candidate");
  await openSession(launched.app);

  const prompt = composer(launched.app);
  await prompt.click();
  await prompt.fill("applied receipt survives the reload");
  await arm(launched.app);
  await prompt.press("Enter");
  await expectDraft(launched.app, "Refined: applied receipt survives the reload");

  // A second tab makes a later reactivation explicit; the applied receipt
  // ledger itself is renderer memory, so the reload below is the ack-lost
  // shape: the host may still believe the operation is live/candidate while
  // this renderer has no record that its candidate already landed.
  await launched.app.window
    .getByTestId("session-tab-strip")
    .getByRole("button", { name: "New session" })
    .click();
  await expect(launched.app.window.getByRole("tab")).toHaveCount(2, { timeout: 60_000 });
  await expect(composer(launched.app)).toBeVisible({ timeout: 60_000 });

  // Give the ordinary preferences mirror time to persist the applied text.
  await launched.app.window.waitForTimeout(600);
  await launched.app.window.reload();
  await expect(composer(launched.app)).toBeVisible({ timeout: 60_000 });

  const tabs = launched.app.window.getByRole("tab");
  await tabs.first().click();
  await expect(composer(launched.app)).toHaveValue("Refined: applied receipt survives the reload", {
    timeout: 60_000,
  });

  // Reconcile again by leaving and returning: the host's applied status is
  // replayed for a renderer that lost its receipts, and that replay must stay
  // idempotent instead of inserting the candidate a second time.
  await tabs.nth(1).click();
  await expect(composer(launched.app)).toHaveValue("");
  await tabs.first().click();
  await expect(composer(launched.app)).toHaveValue("Refined: applied receipt survives the reload", {
    timeout: 60_000,
  });
  await expect(control(launched.app)).toHaveAttribute("aria-pressed", "false");
  // No stale decision surface: an already-applied receipt is not a conflict
  // and does not offer to replace the (newer) applied draft again.
  await expect(launched.app.window.getByTestId("composer-operation-replace")).toHaveCount(0);
  await expect(launched.app.window.getByTestId("composer-operation-view-result")).toHaveCount(0);
  await expect(launched.app.window.getByTestId("composer-operation-conflict")).toHaveCount(0);

  // One operation, no second provider turn, and exactly one inserted copy.
  expect(launched.log().filter((entry) => entry.event === "started")).toHaveLength(1);
  expect(launched.app.provider.requests).toHaveLength(0);
  const value = await composer(launched.app).inputValue();
  expect(value.split("Refined:").length - 1).toBe(1);
  await expectNoConversationRow(launched.app);
});

// KNOWN GAP (plan step 23, recorded by plan step 36): the renderer adopts a
// *settled* operation and a lost apply receipt, but a reload during a still
// live refinement loses the progress/candidate panel. `composer.current`
// answers for the session epoch the renderer asks about; the reloaded renderer
// learns a newer epoch than the one the live job was bound to, so the host
// reports "nothing live" and the late candidate is dropped. The safety path
// above pins what must still hold. Fixing adoption needs the host to migrate (or
// keep answering for) a live job across a same-session reattach; that is a
// protocol change and is tracked in
// docs/architecture/refinement-acceptance-2026-11-24.md rather than faked here.
test.fixme("a reload mid-refinement adopts the live operation and offers its candidate", async () => {
  const launched = await launchRefinement("candidate", { release: true });
  await openSession(launched.app);

  const prompt = composer(launched.app);
  await prompt.click();
  await prompt.fill("reload during the refinement");
  await arm(launched.app);
  await prompt.press("Enter");
  await launched.waitForLog("started");
  await launched.app.window.waitForTimeout(400);
  await launched.app.window.reload();
  await expect(composer(launched.app)).toBeVisible({ timeout: 60_000 });
  await launched.app.window.getByRole("tab").first().click();
  await expect(control(launched.app)).toBeVisible({ timeout: 60_000 });

  release((name) => join(logDir ?? "", name));
  await launched.waitForLog("candidate");
  await expect(
    launched.app.window
      .getByTestId("composer-operation-view-result")
      .or(launched.app.window.getByTestId("composer-operation-replace")),
  ).toBeVisible({ timeout: 60_000 });
});
