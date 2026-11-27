import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { Composer } from "../../src/renderer/src/session/Composer";
import composerControlsSource from "../../src/renderer/src/session/ComposerControls.tsx?raw";
import { ComposerControls } from "../../src/renderer/src/session/ComposerControls";
import {
  COMPOSER_ARMED_HINT,
  MAX_VISIBLE_COMPOSER_CONTROLS,
  composerControlKey,
} from "../../src/renderer/src/session/composer-controls-model";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import type { ComposerControlDescriptor } from "../../src/shared/composer-operation";
import type { ImageAttachment } from "../../src/renderer/src/session/image-attachment";

/**
 * Generic bottom-right composer controls (2026-11-22 prompt-refinement plan
 * step 21).
 *
 * Two *unrelated* publishers with arbitrary labels are used on purpose: the row
 * must render and activate whatever the host projected, with no Desktop branch
 * on an extension name, owner, label or status string. The one-should-not-exist
 * check at the bottom greps the generic module for Workflow identifiers.
 */

const ALPHA = "alpha-tools.ext";
const BETA = "beta.tools";

function descriptor(over: Partial<ComposerControlDescriptor> = {}): ComposerControlDescriptor {
  return {
    ownerId: ALPHA,
    id: "polish",
    label: "Polish",
    description: "Returns a tidier draft; never runs it.",
    icon: "sparkles",
    tone: "accent",
    checked: false,
    enabled: true,
    behavior: "one-shot-return",
    actionRef: "polish-toggle",
    transformActionRef: "polish-transform",
    descriptorGeneration: { ownerId: ALPHA, epoch: 0, revision: 1 },
    ...over,
  };
}

function renderControls(
  overrides: Partial<Parameters<typeof ComposerControls>[0]> = {},
): ReturnType<typeof render> & { onActivate: ReturnType<typeof vi.fn> } {
  const onActivate = vi.fn(async () => true);
  const rendered = render(
    <ComposerControls
      controls={[descriptor(), descriptor({ ownerId: BETA, id: "tighten", label: "Tighten" })]}
      onActivate={onActivate}
      {...overrides}
    />,
  );
  return { ...rendered, onActivate };
}

function renderComposer(overrides: Partial<Parameters<typeof Composer>[0]> = {}) {
  const onSend = vi.fn(
    async (
      _text: string,
      _images: readonly ImageAttachment[],
      _options?: { preferredSource?: unknown; followUp?: boolean },
    ) => "sent" as const,
  );
  const onActivateComposerControl = vi.fn(async () => true);
  const props: Parameters<typeof Composer>[0] = {
    tabId: "tab-1",
    running: false,
    draft: "",
    queue: { steering: [], followUp: [] },
    onDraftChange: vi.fn(),
    onSend,
    onStop: vi.fn(),
    onClearQueue: vi.fn(),
    onRestoreQueue: vi.fn(),
    onHistoryStep: () => ({ kind: "none" }),
    ...overrides,
  };
  const rendered = render(<Composer {...props} />);
  return { ...rendered, onSend, onActivateComposerControl };
}

beforeEach(() => {
  useAppStore.setState({ composerDrafts: {} });
});

describe("ComposerControls", () => {
  it("renders two unrelated publishers with arbitrary labels and checked state", () => {
    const alpha = descriptor({ checked: true });
    const beta = descriptor({
      ownerId: BETA,
      id: "tighten",
      label: "Tighten",
      tone: "info",
      icon: "wand",
      checked: false,
    });
    render(<ComposerControls controls={[alpha, beta]} onActivate={vi.fn()} />);

    const buttons = screen.getAllByTestId("composer-control");
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toHaveAttribute("data-owner", ALPHA);
    expect(buttons[0]).toHaveAttribute("data-checked", "true");
    expect(buttons[0]).toHaveAttribute("aria-pressed", "true");
    expect(buttons[0]).toHaveTextContent("Polish");
    expect(buttons[1]).toHaveAttribute("data-owner", BETA);
    expect(buttons[1]).toHaveAttribute("data-checked", "false");
    expect(buttons[1]).toHaveAttribute("aria-pressed", "false");
    expect(buttons[1]).toHaveTextContent("Tighten");
    // The allowlisted icon is rendered, never arbitrary SVG/HTML.
    expect(within(buttons[0]!).getByTestId("composer-control-icon")).toBeInTheDocument();
    expect(buttons[0]).toHaveAttribute("data-behavior", "one-shot-return");
  });

  it("shows a disabled reason in the tooltip and as text", () => {
    renderControls({
      controls: [descriptor({ enabled: false, disabledReason: "Needs a vision model" })],
    });
    const button = screen.getByTestId("composer-control");
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Needs a vision model");
    expect(button).toHaveTextContent("Needs a vision model");
    expect(button).toHaveAttribute("data-enabled", "false");
  });

  it("keeps the description as the tooltip when nothing is wrong", () => {
    renderControls({ controls: [descriptor()] });
    expect(screen.getByTestId("composer-control")).toHaveAttribute(
      "title",
      "Returns a tidier draft; never runs it.",
    );
  });

  it("activates with the keyboard (Enter and Space) like any button", async () => {
    const user = userEvent.setup();
    const { onActivate } = renderControls();
    const [first, second] = screen.getAllByTestId("composer-control");
    first!.focus();
    await user.keyboard("{Enter}");
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onActivate).toHaveBeenCalledWith(expect.objectContaining({ label: "Polish" }));
    second!.focus();
    await user.keyboard(" ");
    expect(onActivate).toHaveBeenCalledTimes(2);
    expect(onActivate).toHaveBeenLastCalledWith(expect.objectContaining({ label: "Tighten" }));
  });

  it("blocks a disabled control from activating", async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn(async () => true);
    render(
      <ComposerControls
        controls={[descriptor({ enabled: false, disabledReason: "Busy" })]}
        onActivate={onActivate}
      />,
    );
    const button = screen.getByTestId("composer-control");
    button.focus();
    await user.keyboard("{Enter}");
    fireEvent.click(button);
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("announces a pending activation once and ignores a second gesture", async () => {
    let settle: (value: boolean) => void = () => undefined;
    const onActivate = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          settle = resolve;
        }),
    );
    render(<ComposerControls controls={[descriptor({ checked: true })]} onActivate={onActivate} />);
    const button = screen.getByTestId("composer-control");
    fireEvent.click(button);
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(button).toHaveAttribute("data-pending", "true");
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(within(button).getByTestId("composer-control-spin")).toBeInTheDocument();
    // A second pointer gesture while the host acknowledges is ignored.
    fireEvent.click(button);
    expect(onActivate).toHaveBeenCalledTimes(1);

    settle(true);
    await screen.findByText("Polish: off");
    expect(button).toHaveAttribute("data-pending", "false");
    const live = screen.getByTestId("composer-controls-status");
    expect(live).toHaveAttribute("role", "status");
    expect(live).toHaveAttribute("aria-live", "polite");
  });

  it("reports an unconfirmed acknowledgement instead of pretending success", async () => {
    const onActivate = vi.fn(async () => false);
    render(<ComposerControls controls={[descriptor()]} onActivate={onActivate} />);
    fireEvent.click(screen.getByTestId("composer-control"));
    await screen.findByText("Polish: the host did not confirm the change");
  });

  it("states the one-shot contract while a control is armed", () => {
    const control = descriptor({ checked: true });
    const { unmount } = render(
      <ComposerControls controls={[control]} armedKeys={[]} onActivate={vi.fn()} />,
    );
    // The published `checked` flag is not enough on its own: the derived armed
    // set is the authority the composer routes Send with.
    expect(screen.queryByTestId("composer-armed-hint")).not.toBeInTheDocument();
    unmount();

    render(
      <ComposerControls
        controls={[control]}
        armedKeys={[composerControlKey(control)]}
        onActivate={vi.fn()}
      />,
    );
    expect(screen.getByTestId("composer-armed-hint")).toHaveTextContent(COMPOSER_ARMED_HINT);
  });

  it("renders a derived conflict without guessing a winner", () => {
    renderControls({ conflictMessage: "More than one transform control is armed" });
    expect(screen.getByTestId("composer-controls-conflict")).toHaveTextContent(
      "More than one transform control is armed",
    );
  });

  it("stays bounded and scrolls instead of hiding actions", () => {
    const controls = Array.from({ length: MAX_VISIBLE_COMPOSER_CONTROLS + 2 }, (_, index) =>
      descriptor({ id: `c${index}`, label: `Control ${index}` }),
    );
    render(<ComposerControls controls={controls} onActivate={vi.fn()} />);
    expect(screen.getAllByTestId("composer-control")).toHaveLength(MAX_VISIBLE_COMPOSER_CONTROLS);
    const more = screen.getByTestId("composer-controls-more");
    expect(more).toHaveTextContent("+2");
    expect(more).toHaveAttribute("title", "Control 4, Control 5");
    const row = screen.getByTestId("composer-controls");
    expect(row.className).toContain("overflow-x-auto");
    expect(row.className).toContain("min-w-0");
  });

  it("renders nothing when the host publishes no control", () => {
    render(<ComposerControls controls={[]} onActivate={vi.fn()} />);
    expect(screen.queryByTestId("composer-controls")).not.toBeInTheDocument();
  });
});

describe("Composer bottom-right row", () => {
  it("places controls beside Send/Stop and keeps Send usable", () => {
    const { onSend } = renderComposer({
      running: true,
      draft: "hello",
      composerControls: [descriptor({ checked: true })],
      composerControlArmedKeys: [composerControlKey(descriptor())],
      onActivateComposerControl: vi.fn(async () => true),
    });
    expect(screen.getByTestId("composer-controls")).toBeInTheDocument();
    expect(screen.getByTestId("composer-armed-hint")).toHaveTextContent(COMPOSER_ARMED_HINT);
    const send = screen.getByLabelText("Send");
    expect(send).toBeEnabled();
    expect(send.className).toContain("shrink-0");
    expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    fireEvent.click(send);
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("keeps the draft selection and focus on a pointer activation", () => {
    const onActivateComposerControl = vi.fn(async () => true);
    renderComposer({
      draft: "hello world",
      composerControls: [descriptor()],
      onActivateComposerControl,
    });
    const textarea = screen.getByLabelText("Prompt") as HTMLTextAreaElement;
    textarea.focus();
    textarea.setSelectionRange(2, 6);
    expect(document.activeElement).toBe(textarea);

    const button = screen.getByTestId("composer-control");
    // The pointer path must not steal focus or collapse the selection...
    expect(fireEvent.pointerDown(button)).toBe(false);
    fireEvent.click(button);

    expect(onActivateComposerControl).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(textarea);
    expect(textarea.selectionStart).toBe(2);
    expect(textarea.selectionEnd).toBe(6);
  });

  it("routes activation through the control's same-owner action reference", () => {
    const onActivateComposerControl = vi.fn(async () => true);
    renderComposer({
      composerControls: [descriptor({ ownerId: BETA, id: "tighten", actionRef: "tighten-on" })],
      onActivateComposerControl,
    });
    fireEvent.click(screen.getByTestId("composer-control"));
    expect(onActivateComposerControl).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: BETA, id: "tighten", actionRef: "tighten-on" }),
    );
  });
});

describe("generic integration", () => {
  it("contains no extension-specific branch in the generic control module", () => {
    const source = composerControlsSource;
    for (const forbidden of ["workflow", "orchestrator", "plannotator", "review", "subagent"]) {
      expect(source.toLowerCase()).not.toContain(forbidden);
    }
    // State comes from typed descriptor fields, never from comparing labels.
    expect(source).not.toMatch(/label\s*===\s*"/);
    expect(source).not.toMatch(/\).label\s*===/);
  });
});
