import { useCallback, useEffect, useRef, useState } from "react";
import { Paperclip, Send, Square, X } from "lucide-react";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { PROMPT_MAX_HEIGHT_PX, useAutoGrowTextarea } from "../ui/auto-grow";
import { fileToAttachment, isImageFile, type ImageAttachment } from "./image-attachment";
import { NO_ATTACHMENTS } from "./composer-draft";
import type { ComposerCaretRequest } from "./composer-draft-operation";
import { composerSendConsumesDraft, type ComposerSendDisposition } from "./composer-send";
import { lostPasteIds, shouldCollapsePaste } from "./paste-markers";
import { atHistoryEdge, type PromptHistoryStep } from "./prompt-history";
import { textareaVisualLines } from "./textarea-visual-lines";
import { useAppStore } from "../state/app-store";
import { sameFolder } from "../../../shared/rail-scope";
import type { WorkspaceEntryKind } from "../../../shared/workspace";
import { insertWorkspaceMention, workspaceMention } from "../../../shared/workspace-drag";
import { isExcludedShellCommand, isShellCommand } from "../../../shared/shell-command";
import { isExternalFileDrag, isWorkspaceDrag, readWorkspaceDrop } from "../files/workspace-drag";
import { isTabDrag } from "../layout/tab-drag";
import type {
  ContributionModeAction,
  ContributionView,
} from "../../../shared/extension-contributions-view";
import { contributionBorderClass } from "./contribution-tone";
import {
  ComposerModeControl,
  DEFAULT_MODE_CONTROL_WIDTH_PX,
  MAX_MODE_CONTROL_WIDTH_PX,
} from "./ComposerModeControl";
import { ComposerControls } from "./ComposerControls";
import type { ComposerControlDescriptor } from "../../../shared/composer-operation";
import type { TranscriptQueue } from "./session-events";
import { CompletionOverlay } from "../completion/CompletionOverlay";
import { matchShortcut } from "../shortcuts/dom-keys";
import { joinBuffer, offsetToPosition, positionToOffset, splitBuffer } from "../completion/token";
import { caretLabel, caretPosition, type CaretPosition } from "./caret";
import type {
  CompletionItem,
  CompletionProvider,
  CompletionResult,
  CompletionSource,
  CompletionSuggestions,
} from "../completion/types";

/**
 * The composer (plan step 6).
 *
 * A plain-text textarea over a text buffer — decision D-A5 — because Pi's
 * completion providers (step 7, and extension providers in step 16) work on
 * lines and a cursor column, not on rich content.
 *
 * Behaviours that matter and are easy to get wrong:
 *  - **IME safety**: Enter during composition confirms candidates, it must never
 *    send. Both `isComposing` and the legacy `keyCode === 229` are checked.
 *  - **Streaming delivery**: while the agent runs, a message must be marked
 *    `steer` or `followUp` (the host refuses it otherwise, exactly like RPC).
 *    Enter steers; Alt+Enter / Ctrl+Q queue a follow-up. The choice is the
 *    chord, not a remembered toggle — the same model as terminal Pi.
 *  - **Escape**: stop the run and put the queued text back in the editor.
 *  - **History**: Up on the first displayed row (soft-wrapped rows count)
 *    recalls a sent prompt; Down on the last displayed row walks forward and, at
 *    the newest entry, restores the draft and caret stashed when browsing
 *    began. The store owns both buffers, so a history step writes the text and
 *    the composer only places the returned caret.
 */

export interface ComposerProps {
  tabId: string;
  running: boolean;
  /** False when the session cannot accept prompts (failed/crashed). */
  enabled?: boolean;
  /** True while a stopped tab is asleep; the first interaction wakes it. */
  sleeping?: boolean;
  /** Ensures the session is ready (activation on focus/pointer-down/typing). */
  onWake?: () => void;
  /** Incremented by the view to put the caret in the composer (transcript click). */
  focusToken?: number;
  /**
   * A caret/focus request minted by a successful draft apply (plan step 19).
   * The token makes it one-shot; `text` guards against placing the caret in a
   * different draft (a newer edit, or a remount after another change).
   */
  caretRequest?: ComposerCaretRequest | null;
  draft: string;
  queue: TranscriptQueue;
  onDraftChange: (text: string) => void;
  onSend: (
    text: string,
    images: readonly ImageAttachment[],
    options?: { preferredSource?: CompletionSource; followUp?: boolean },
  ) => Promise<ComposerSendDisposition>;
  onStop: () => void;
  /**
   * Escape while a run is streaming (plan step 23). Terminal Pi gives the key
   * to the extension's `onTerminalInput` handlers first and pauses a review; the
   * composer only forwards, the store decides whether anything consumed it.
   * Defaults to `onStop`, so an un-wired caller behaves exactly as before.
   */
  onEscape?: () => void;
  /**
   * True while an extension owns long-running work on an idle tab (a manual
   * Review round). The composer then routes Escape through `onEscape` even
   * though no parent turn is streaming.
   */
  escapeActive?: boolean;
  onClearQueue: () => void;
  /** `clearQueue` and put the queued text back in the draft (Alt+Up, plan step 9). */
  onRestoreQueue: () => void;
  /** The session workspace root, used to validate a dropped path. */
  workspaceRoot?: string | null;
  /** A mention dropped somewhere in the session pane, to insert at the caret. */
  mentionRequest?: {
    id: number;
    tabId: string;
    path: string;
    kind: WorkspaceEntryKind;
  } | null;
  /** Called after a mention request has been inserted (or refused). */
  onMentionHandled?: (id: number) => void;
  /**
   * The session's primary mode contribution, if its publisher has one. It is
   * the composer's identity: label text, border tone, and — when the publisher
   * referenced a live same-owner action — the cycle button.
   */
  contributionMode?: ContributionView | null;
  /** The mode's resolved activation; null keeps the label informative only. */
  contributionModeAction?: ContributionModeAction | null;
  /** Runs the mode control's referenced action (`contributions.run`). */
  onRunContributionMode?: (ownerId: string, id: string) => Promise<boolean>;
  /**
   * True when a published input contribution says another surface owns the
   * turn. The store refuses prose in that state, so the composer must not offer
   * Stop (it would abort the parent run, not the owning surface) and says why.
   */
  inputLocked?: boolean;
  /**
   * The session's registered extension shortcuts, used to give Tab to the mode
   * cycle (the workflow extension registers `tab`). Empty until the store loads
   * them, which the composer requests through `onRequestShortcuts`.
   */
  extensionShortcuts?: readonly { key: string }[];
  /** Runs one extension shortcut through `shortcuts.invoke`. */
  onInvokeShortcut?: (key: string) => void;
  /** Asks the store to load the extension shortcuts (once). */
  onRequestShortcuts?: () => void;
  onHistoryStep: (direction: 1 | -1, caret: number) => PromptHistoryStep;
  /** The completion engine (plan step 7); omit it to disable completion. */
  completion?: ComposerCompletion;
  /** Step 7 attaches the completion overlay here. */
  completionSlot?: React.ReactNode;
  /**
   * The session's compact controls (model, thinking level, context ring),
   * rendered in the blank space above Send (minimal-session-ui step 4). The
   * composer itself stays presentational: the view owns the pickers.
   */
  toolsSlot?: React.ReactNode;
  /**
   * Generic composer controls (2026-11-22 prompt-refinement plan step 21).
   * Already projected and sanitized: this component renders labels, checked
   * state, the allowlisted icon, disabled reasons and pending state, never an
   * extension name or a raw command. The view (or the store projection) owns
   * the descriptors; the composer only places the row at the bottom right. An
   * older host that publishes no `composer-control` kind passes nothing and the
   * row is absent.
   */
  composerControls?: readonly ComposerControlDescriptor[];
  /** Keys of the controls armed right now (published `checked` + local). */
  composerControlArmedKeys?: readonly string[];
  /** True while an operation started from those controls is active. */
  composerControlBusy?: boolean;
  /** Derived conflict explanation (multiple armed, withdrawn publisher, …). */
  composerControlConflict?: string | null;
  /** Runs a control's same-owner toggle action through the host. */
  onActivateComposerControl?: (control: ComposerControlDescriptor) => Promise<boolean> | boolean;
}

/** What the composer needs from the completion engine (plan step 7). */
export interface ComposerCompletion {
  provider: CompletionProvider;
  /**
   * Applies an accepted item. Used when the item came from a host-run extension
   * chain (plan step 16), whose own `applyCompletion` cannot run in the
   * renderer; returns null to fall back to `provider.applyCompletion`.
   */
  apply?: (
    item: CompletionItem,
    suggestions: CompletionSuggestions,
    buffer: { lines: string[]; line: number; col: number },
  ) => Promise<CompletionResult | null>;
}

/** Long enough to coalesce a burst of keystrokes, short enough to feel live. */
const COMPLETION_DEBOUNCE_MS = 60;

/**
 * Enter sends; Shift+Enter inserts a newline. Alt+Enter is Pi's follow-up chord
 * (Ctrl+Q is the alternate) and is not a newline any more (plan step 9, D8).
 *
 * The IME guard uses `isComposing` only: the app ships one Chromium (Electron),
 * which sets it for every composition, so the legacy `keyCode === 229` fallback
 * (and its deprecated React field) is not needed.
 */
export function isSendKey(event: {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
}): boolean {
  if (event.isComposing === true) return false;
  return event.key === "Enter" && !event.shiftKey && !event.altKey;
}

function PendingQueue({
  queue,
  onRestore,
  onClear,
}: {
  queue: TranscriptQueue;
  onRestore: () => void;
  onClear: () => void;
}) {
  const rows = [
    ...queue.steering.map((text, index) => ({ kind: "Steering" as const, text, index })),
    ...queue.followUp.map((text, index) => ({ kind: "Follow-up" as const, text, index })),
  ];
  return (
    <div
      className="mb-2 flex flex-col gap-1 rounded-sm border border-line bg-raised/60 px-2 py-1.5"
      data-testid="pending-queue"
    >
      {rows.map((row) => (
        <div
          key={`${row.kind}-${row.index}`}
          className="flex min-w-0 items-baseline gap-2 text-[11px]"
        >
          <span
            className={cn(
              "shrink-0 rounded-xs px-1 font-medium",
              row.kind === "Steering" ? "bg-accent/15 text-accent" : "bg-raised text-ink-muted",
            )}
          >
            {row.kind}
          </span>
          {/* Full text, bounded to two lines so a long message cannot push the
              composer off screen; the title carries the whole thing. */}
          <span className="line-clamp-2 min-w-0 flex-1 whitespace-pre-wrap" title={row.text}>
            {row.text}
          </span>
        </div>
      ))}
      <div className="flex items-center gap-3 pt-0.5 text-[11px]">
        <button
          type="button"
          className="text-ink-muted hover:text-ink"
          onClick={onRestore}
          title="Alt+Up"
        >
          restore all
        </button>
        <button type="button" className="text-ink-faint hover:text-ink" onClick={onClear}>
          clear queue
        </button>
      </div>
    </div>
  );
}

function AttachmentChips({
  attachments,
  onRemove,
}: {
  attachments: readonly ImageAttachment[];
  onRemove: (id: string) => void;
}) {
  return (
    <div className="mb-2 flex flex-wrap gap-2" data-testid="attachments">
      {attachments.map((attachment) => (
        <span
          key={attachment.id}
          className="flex items-center gap-1.5 rounded-sm border border-line bg-raised px-2 py-1 text-[11px]"
        >
          <img
            alt={attachment.name}
            className="size-6 rounded-xs object-cover"
            src={`data:${attachment.mimeType};base64,${attachment.data}`}
          />
          {attachment.name}
          <button
            type="button"
            aria-label={`Remove ${attachment.name}`}
            onClick={() => onRemove(attachment.id)}
          >
            <X className="size-3" aria-hidden />
          </button>
        </span>
      ))}
    </div>
  );
}

export function Composer({
  tabId,
  running,
  enabled = true,
  sleeping = false,
  onWake,
  focusToken = 0,
  caretRequest = null,
  draft,
  queue,
  contributionMode = null,
  contributionModeAction = null,
  onRunContributionMode,
  inputLocked = false,
  extensionShortcuts,
  onInvokeShortcut,
  onRequestShortcuts,
  workspaceRoot,
  mentionRequest,
  onMentionHandled,
  onDraftChange,
  onSend,
  onStop,
  onEscape,
  escapeActive = false,
  onClearQueue,
  onRestoreQueue,
  onHistoryStep,
  completion,
  completionSlot,
  toolsSlot,
  composerControls = [],
  composerControlArmedKeys = [],
  composerControlBusy = false,
  composerControlConflict = null,
  onActivateComposerControl,
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // The prompt grows with its content up to a fixed cap, then scrolls. A manual
  // resize would be overwritten by the next keystroke, so the handle is gone.
  useAutoGrowTextarea(textareaRef, draft, PROMPT_MAX_HEIGHT_PX);
  // Attachments are tab state, not component state (2026-11-22 prompt-refinement
  // plan step 18): a docked dialog, a remount or a pane move replaces this
  // component, and a locally owned image used to disappear with it. The store
  // record keeps the attachment objects (bytes included) in renderer memory
  // only; nothing here is persisted to `app-state.json`.
  const draftRecord = useAppStore((state) => state.composerDrafts[tabId]);
  const attachments = draftRecord?.attachments ?? NO_ATTACHMENTS;
  const addDraftImages = useAppStore((state) => state.addDraftImages);
  const removeDraftImage = useAppStore((state) => state.removeDraftImage);
  const clearDraftImages = useAppStore((state) => state.clearDraftImages);
  const setDraftSelection = useAppStore((state) => state.setDraftSelection);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [suggestions, setSuggestions] = useState<CompletionSuggestions | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  // The source of the item the user picked, when a name was ambiguous. It is
  // cleared as soon as they type, so it only ever describes the current token.
  const [pickedSource, setPickedSource] = useState<CompletionSource | undefined>();
  const caretRef = useRef(0);
  // The caret's line/column, shown in the status row (plan step 1). The browser's
  // own caret is a thin blinking line that is easy to lose in a long buffer; the
  // readout is the explicit, always-readable position.
  const [caret, setCaret] = useState<CaretPosition>({ line: 1, column: 1 });
  const completionAbortRef = useRef<AbortController | null>(null);
  const completionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A mention insertion updates the controlled draft and then needs to put the
  // DOM caret after the new text. The ref survives the React commit; the effect
  // below applies it once the textarea carries the new value.
  const pendingCaretRef = useRef<{ text: string; caret: number } | null>(null);
  const handledMentionRef = useRef<number | null>(null);

  const queued = [...queue.steering, ...queue.followUp];
  const bashMode = isShellCommand(draft);
  const shellExcluded = isExcludedShellCommand(draft);
  const registerPaste = useAppStore((state) => state.registerPaste);
  const pasteBodies = useAppStore((state) => state.pasteBodies[tabId]);
  // A marker restored from a previous launch has no body: say so, because the
  // alternative is silently sending the marker as prose (plan step 20).
  const lostMarkers = lostPasteIds(
    draft,
    new Set(Object.keys(pasteBodies ?? {}).map((key) => Number(key))),
  );

  // How much room the mode control needs above the prompt text. Measured when
  // the control renders (the old fixed `pr-14` both clipped "Orchestrator" and
  // wasted space on "Plan"); `DEFAULT_MODE_CONTROL_WIDTH_PX` is the safe
  // starting point before measurement, and in jsdom where layout is absent.
  const [modeReservation, setModeReservation] = useState(DEFAULT_MODE_CONTROL_WIDTH_PX);
  const onModeMeasure = useCallback((width: number) => {
    const next = Math.min(
      Math.max(Math.ceil(width) + 8, DEFAULT_MODE_CONTROL_WIDTH_PX),
      MAX_MODE_CONTROL_WIDTH_PX,
    );
    setModeReservation((previous) => (previous === next ? previous : next));
  }, []);
  // Empty until the store loads the session's shortcuts (the composer asks via
  // `onRequestShortcuts` on the first Tab); an unknown list means Tab keeps its
  // completion behaviour rather than swallowing the key.
  const shortcuts = extensionShortcuts ?? [];

  /** The buffer and caret as the provider contract wants them: lines + column. */
  const currentBuffer = useCallback(() => {
    const text = textareaRef.current?.value ?? draft;
    return { lines: splitBuffer(text), position: offsetToPosition(text, caretRef.current) };
  }, [draft]);

  const closeCompletion = useCallback(() => {
    setSuggestions(null);
    setActiveIndex(0);
  }, []);

  /**
   * Mirrors the DOM caret into the completion engine (`caretRef`) and into the
   * readout. One source of truth: the offset the providers see is the offset
   * the user sees.
   */
  const syncCaret = useCallback(
    (node: HTMLTextAreaElement | null) => {
      if (!node) return;
      const offset = node.selectionStart ?? 0;
      caretRef.current = offset;
      // Selection is tracked separately from the content revision: moving the
      // caret must not invalidate a snapshot (plan step 18).
      setDraftSelection(tabId, { start: offset, end: node.selectionEnd ?? offset });
      const next = caretPosition(node.value, offset);
      setCaret((previous) =>
        previous.line === next.line && previous.column === next.column ? previous : next,
      );
    },
    [setDraftSelection, tabId],
  );

  const refreshCompletion = useCallback(
    (force: boolean) => {
      if (!completion) return;
      if (completionTimerRef.current) clearTimeout(completionTimerRef.current);
      completionTimerRef.current = setTimeout(() => {
        completionTimerRef.current = null;
        completionAbortRef.current?.abort();
        const controller = new AbortController();
        completionAbortRef.current = controller;
        const { lines, position } = currentBuffer();
        void completion.provider
          .getSuggestions(lines, position.line, position.col, {
            signal: controller.signal,
            ...(force ? { force: true } : {}),
          })
          .then((result) => {
            if (controller.signal.aborted) return;
            if (!result || result.items.length === 0) {
              closeCompletion();
              return;
            }
            setSuggestions(result);
            setActiveIndex(0);
          })
          .catch(() => {
            if (!controller.signal.aborted) closeCompletion();
          });
      }, COMPLETION_DEBOUNCE_MS);
    },
    [closeCompletion, completion, currentBuffer],
  );

  const applySuggestion = useCallback(
    async (item: CompletionItem): Promise<{ text: string; source?: CompletionSource } | null> => {
      if (!completion || !suggestions) return null;
      const { lines, position } = currentBuffer();
      let next = completion.provider.applyCompletion(
        lines,
        position.line,
        position.col,
        item,
        suggestions.prefix,
      );
      if (completion.apply) {
        const remote = await completion.apply(item, suggestions, {
          lines,
          line: position.line,
          col: position.col,
        });
        if (remote) next = remote;
      }
      const text = joinBuffer(next.lines);
      const caret = positionToOffset(next.lines, { line: next.cursorLine, col: next.cursorCol });
      setPickedSource(item.source);
      closeCompletion();
      onDraftChange(text);
      // The caret has to move after React commits the new value, or the DOM
      // selection would be clamped to the old text length.
      queueMicrotask(() => {
        const node = textareaRef.current;
        if (!node) return;
        node.focus();
        node.setSelectionRange(caret, caret);
        caretRef.current = caret;
        setCaret(caretPosition(text, caret));
      });
      return { text, ...(item.source ? { source: item.source } : {}) };
    },
    [closeCompletion, completion, currentBuffer, onDraftChange, suggestions],
  );

  // A pending debounce or an in-flight request must not outlive the composer.
  useEffect(
    () => () => {
      if (completionTimerRef.current) clearTimeout(completionTimerRef.current);
      completionAbortRef.current?.abort();
    },
    [],
  );

  // A draft that changed from outside the textarea (the history walk, a
  // restored draft) moves the caret too, so the readout is re-read once the
  // DOM carries the new value.
  useEffect(() => {
    const node = textareaRef.current;
    if (node && node.value === draft) syncCaret(node);
  }, [draft, syncCaret]);

  const applyPendingCaret = useCallback(() => {
    const pending = pendingCaretRef.current;
    if (!pending) return;
    const node = textareaRef.current;
    if (!node || node.value !== pending.text) return;
    pendingCaretRef.current = null;
    node.focus();
    node.setSelectionRange(pending.caret, pending.caret);
    caretRef.current = pending.caret;
    setCaret(caretPosition(node.value, pending.caret));
  }, []);

  useEffect(() => {
    applyPendingCaret();
  }, [draft, applyPendingCaret]);

  // A successful draft apply replaces the text from outside the textarea and
  // hands focus back to the composer (plan step 19). The token makes the
  // request one-shot and the text guard means a newer edit wins: the caret is
  // only placed when the DOM carries exactly the applied draft.
  const caretRequestTokenRef = useRef(0);
  useEffect(() => {
    if (!caretRequest || caretRequest.token <= caretRequestTokenRef.current) return;
    const node = textareaRef.current;
    if (!node || node.disabled || node.value !== caretRequest.text) return;
    caretRequestTokenRef.current = caretRequest.token;
    const caret = Math.max(0, Math.min(caretRequest.caret, node.value.length));
    node.focus();
    node.setSelectionRange(caret, caret);
    caretRef.current = caret;
    setCaret(caretPosition(node.value, caret));
    setDraftSelection(tabId, { start: caret, end: caret });
  }, [caretRequest, draft, setDraftSelection, tabId]);

  // Clicking the transcript background is an explicit "talk to this session"
  // gesture; the view increments the token instead of reaching into the DOM.
  useEffect(() => {
    if (focusToken <= 0) return;
    const node = textareaRef.current;
    if (node && !node.disabled) node.focus();
  }, [focusToken]);

  /**
   * Sends an explicit text and source. The Enter-on-completion path must not
   * read the `draft` prop or `pickedSource` state: both are stale while a
   * remote apply is awaited, and sending the old text would lose the fill.
   */
  const submitText = useCallback(
    async (
      text: string,
      source?: CompletionSource,
      followUp?: boolean,
    ): Promise<ComposerSendDisposition> => {
      if (!enabled || busy) return "refused";
      if (text.trim().length === 0 && attachments.length === 0) return "refused";
      setBusy(true);
      try {
        const disposition = await onSend(text, attachments, {
          ...(source ? { preferredSource: source } : {}),
          ...(followUp ? { followUp: true } : {}),
        });
        // Only a real send or a consumed command follows the existing clear
        // rules. A transformation keeps text/attachments until its CAS apply;
        // a refusal preserves them by definition (plan step 20).
        if (composerSendConsumesDraft(disposition)) {
          clearDraftImages(tabId);
          setPickedSource(undefined);
          closeCompletion();
        }
        return disposition;
      } finally {
        setBusy(false);
      }
    },
    [attachments, busy, clearDraftImages, closeCompletion, enabled, onSend, tabId],
  );

  const submit = useCallback(async (): Promise<ComposerSendDisposition> => {
    return submitText(draft, pickedSource);
  }, [draft, pickedSource, submitText]);

  const addFiles = useCallback(
    async (files: readonly File[]) => {
      const images = files.filter((file) => isImageFile(file));
      if (images.length === 0) return;
      const added: ImageAttachment[] = [];
      for (const file of images) {
        const attachment = await fileToAttachment(file);
        if (attachment) added.push(attachment);
      }
      if (added.length > 0) addDraftImages(tabId, added);
    },
    [addDraftImages, tabId],
  );

  const insertMention = useCallback(
    (path: string, kind: WorkspaceEntryKind): boolean => {
      const node = textareaRef.current;
      if (!node || !enabled) return false;
      const focused = document.activeElement === node;
      const start = focused ? (node.selectionStart ?? node.value.length) : node.value.length;
      const end = focused ? (node.selectionEnd ?? start) : start;
      const next = insertWorkspaceMention(node.value, start, end, workspaceMention(path, kind));
      pendingCaretRef.current = { text: next.text, caret: next.caret };
      onDraftChange(next.text);
      // The effect above normally applies the caret after the controlled value
      // commits; the microtask covers a parent that does not re-render.
      queueMicrotask(applyPendingCaret);
      return true;
    },
    [applyPendingCaret, enabled, onDraftChange],
  );

  useEffect(() => {
    if (!mentionRequest || mentionRequest.tabId !== tabId) return;
    if (handledMentionRef.current === mentionRequest.id) return;
    handledMentionRef.current = mentionRequest.id;
    insertMention(mentionRequest.path, mentionRequest.kind);
    onMentionHandled?.(mentionRequest.id);
  }, [insertMention, mentionRequest, onMentionHandled, tabId]);

  return (
    <div
      data-testid="composer-drop"
      className={cn(
        "relative shrink-0 border-t border-line bg-surface px-3 py-2",
        dragging && "ring-1 ring-accent",
      )}
      onDragOver={(event) => {
        if (!isWorkspaceDrag(event.dataTransfer) && !isExternalFileDrag(event.dataTransfer)) {
          return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDragging(false);
      }}
      onDrop={(event) => {
        // A tab drag belongs to the enclosing grid pane, not the composer. Let it
        // bubble instead of consuming it as an (empty) file drop.
        if (isTabDrag(event.dataTransfer)) return;
        const payload = readWorkspaceDrop(event.dataTransfer);
        if (payload) {
          event.preventDefault();
          setDragging(false);
          if (!enabled) {
            useAppStore.getState().setHint("This session cannot accept prompts right now.");
            return;
          }
          if (workspaceRoot && !sameFolder(payload.projectPath, workspaceRoot)) {
            useAppStore.getState().setHint("That file belongs to a different folder.");
            return;
          }
          insertMention(payload.path, payload.kind);
          return;
        }
        event.preventDefault();
        setDragging(false);
        if (enabled) void addFiles([...event.dataTransfer.files]);
      }}
    >
      {bashMode ? (
        <p
          data-testid="composer-shell-mode"
          role="status"
          aria-live="polite"
          className="mb-1 text-[11px] text-warn"
        >
          shell · {shellExcluded ? "output excluded from model" : "output kept in context"}
        </p>
      ) : null}

      {lostMarkers.length > 0 ? (
        <p className="mb-1 text-[11px] text-warn" data-testid="paste-content-lost">
          Paste content for {lostMarkers.map((id) => `#${id}`).join(", ")} is no longer in memory
          (the app restarted). Paste it again before sending.
        </p>
      ) : null}
      {queued.length > 0 ? (
        <PendingQueue queue={queue} onRestore={onRestoreQueue} onClear={onClearQueue} />
      ) : null}
      {attachments.length > 0 ? (
        <AttachmentChips attachments={attachments} onRemove={(id) => removeDraftImage(tabId, id)} />
      ) : null}

      {completionSlot}

      {suggestions && suggestions.items.length > 0 ? (
        <CompletionOverlay
          items={suggestions.items}
          activeIndex={activeIndex}
          onHover={setActiveIndex}
          onPick={applySuggestion}
        />
      ) : null}

      <div className="flex items-stretch gap-2">
        <div data-testid="composer-input" className="relative min-w-0 flex-1">
          <textarea
            ref={textareaRef}
            aria-label="Prompt"
            rows={2}
            value={draft}
            placeholder={
              bashMode
                ? "Shell command — runs in this folder; !! keeps output out of model context…"
                : sleeping && enabled
                  ? "This session is asleep — type or press Tab to wake it…"
                  : enabled
                    ? running
                      ? "Type to steer the run — Enter steers, Alt+Enter queues a follow-up…"
                      : "Ask Pi to change something…  / commands · ! shell · @ files · # documents"
                    : "This session is not running — start it above to send a prompt."
            }
            disabled={!enabled}
            className={cn(
              // The border tracks the published badge's semantic tone.
              // `border-line` is the neutral default and the only class the
              // placeholder set assumes.
              //
              // Focus is an *outer* ring (a box-shadow), never an outline: the
              // ring is painted outside the border, so the mode colour stays
              // readable while the composer is focused. This replaces the global
              // `:focus-visible` outline, which used to cover it in blue.
              "min-h-16 w-full overflow-y-auto rounded-sm border bg-sunken px-2 py-1.5 font-mono text-sm outline-none focus-visible:ring-2 focus-visible:ring-line-strong placeholder:text-ink-faint disabled:opacity-60",
              // The caret is the app's own accent colour, and a selection is
              // tinted with it, so the cursor is never lost in a dark buffer
              // (plan step 1).
              "caret-accent selection:bg-accent/25",
              bashMode ? "border-warn" : contributionBorderClass(contributionMode?.tone),
            )}
            style={contributionMode ? { paddingRight: modeReservation } : undefined}
            onChange={(event) => {
              syncCaret(event.target);
              setPickedSource(undefined);
              onWake?.();
              onDraftChange(event.target.value);
              refreshCompletion(false);
            }}
            onFocus={() => {
              onWake?.();
            }}
            onPointerDown={() => {
              onWake?.();
            }}
            onSelect={(event) => {
              syncCaret(event.currentTarget);
            }}
            onClick={(event) => {
              syncCaret(event.currentTarget);
            }}
            onKeyUp={(event) => {
              syncCaret(event.currentTarget);
            }}
            onPaste={(event) => {
              // Image/file paste keeps the attachment path; only text collapses.
              const files = [...(event.clipboardData?.files ?? [])];
              if (files.length > 0) {
                void addFiles(files);
                return;
              }
              const text = event.clipboardData?.getData("text/plain") ?? "";
              if (!shouldCollapsePaste(text)) return;
              event.preventDefault();
              const marker = registerPaste(tabId, text);
              const node = event.currentTarget;
              const start = node.selectionStart ?? node.value.length;
              const end = node.selectionEnd ?? start;
              const next = `${node.value.slice(0, start)}${marker}${node.value.slice(end)}`;
              onDraftChange(next);
              const caret = start + marker.length;
              queueMicrotask(() => {
                node.setSelectionRange(caret, caret);
                caretRef.current = caret;
                setCaret(caretPosition(next, caret));
              });
            }}
            onKeyDown={(event) => {
              // IME guard first: Enter during composition belongs to the input method.
              if (event.nativeEvent.isComposing) return;

              // Backspace deletes a whole `[paste #N …]` token, never half of it.
              if (event.key === "Backspace") {
                const node = event.currentTarget;
                const start = node.selectionStart ?? 0;
                const end = node.selectionEnd ?? start;
                if (start === end) {
                  const before = node.value.slice(0, start);
                  const marker = /\[paste #\d+ [^\]]*\]$/.exec(before);
                  if (marker && marker[0].length > 0) {
                    const markerStart = start - marker[0].length;
                    event.preventDefault();
                    const next = `${node.value.slice(0, markerStart)}${node.value.slice(start)}`;
                    onDraftChange(next);
                    queueMicrotask(() => {
                      node.setSelectionRange(markerStart, markerStart);
                      caretRef.current = markerStart;
                      setCaret(caretPosition(next, markerStart));
                    });
                    return;
                  }
                }
              }

              const menu = suggestions;
              const menuOpen = Boolean(menu && menu.items.length > 0);
              // The keys an open completion menu owns. Everything *else* still
              // reaches an extension shortcut, and a closed menu blocks nothing.
              const menuKey =
                menuOpen &&
                (event.key === "ArrowDown" ||
                  event.key === "ArrowUp" ||
                  event.key === "Escape" ||
                  event.key === "Tab" ||
                  event.key === "Enter");

              // Extension shortcuts come first, exactly as in Pi's editor
              // (`custom-editor.js:60` checks `onExtensionShortcut` before any
              // editor handling). This is what lets the workflow extension's `tab`
              // cycle the mode, and its `ctrl+alt+p` alias too. Matching against
              // the registered chord list is inherently safe for a text input: a
              // key only fires if the session actually registered it.
              if (!menuKey) {
                const matched = matchShortcut(
                  {
                    key: event.key,
                    ctrlKey: event.ctrlKey,
                    altKey: event.altKey,
                    shiftKey: event.shiftKey,
                    metaKey: event.metaKey,
                  },
                  shortcuts,
                );
                if (matched && onInvokeShortcut) {
                  event.preventDefault();
                  onInvokeShortcut(matched);
                  return;
                }
              }

              // The completion menu owns these keys while it is open, so Enter
              // accepts a suggestion instead of sending half a command.
              if (menu && menu.items.length > 0) {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setActiveIndex((index) => Math.min(index + 1, menu.items.length - 1));
                  return;
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setActiveIndex((index) => Math.max(index - 1, 0));
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  closeCompletion();
                  return;
                }
                if (event.key === "Tab" || event.key === "Enter") {
                  const item = menu.items[activeIndex];
                  if (item) {
                    event.preventDefault();
                    // Pi parity: Enter on a command-name completion applies it
                    // and submits in one keystroke. Argument completions apply
                    // only; the user keeps finishing the command line. Tab never
                    // submits.
                    if (event.key === "Enter" && menu.prefix.startsWith("/")) {
                      void (async () => {
                        const applied = await applySuggestion(item);
                        if (applied) await submitText(applied.text, applied.source);
                      })();
                    } else {
                      void applySuggestion(item);
                    }
                    return;
                  }
                }
              } else if (event.key === "Tab") {
                // No extension shortcut claimed Tab and no menu is open: keep the
                // original completion behaviour. If the list has not been fetched
                // yet, ask for it so the *next* Tab can cycle the mode.
                if (shortcuts.length === 0) onRequestShortcuts?.();
                if (completion) {
                  // Tab on a path-shaped token asks explicitly (Pi's editor does too).
                  event.preventDefault();
                  refreshCompletion(true);
                  return;
                }
              }

              if (event.key === "Escape" && (running || escapeActive)) {
                event.preventDefault();
                // The extension gets the first look (a review pauses); only an
                // unconsumed Escape reaches the stop path.
                (onEscape ?? onStop)();
                return;
              }
              // Pi's dequeue chord (alt+up): take every queued message back into
              // the editor (plan step 9).
              if (event.key === "ArrowUp" && event.altKey) {
                event.preventDefault();
                onRestoreQueue();
                return;
              }
              // Pi's follow-up chords (alt+enter and ctrl+q, both defaults on
              // every platform): queue the text when a run is streaming, and act
              // like Enter when it is not (plan step 9, D8).
              if ((event.key === "Enter" && event.altKey) || (event.key === "q" && event.ctrlKey)) {
                event.preventDefault();
                void (async () => {
                  const text = draft.trim();
                  if (running && text.length > 0) {
                    await submitText(draft, pickedSource, true);
                  } else {
                    await submit();
                  }
                })();
                return;
              }
              // History walks only at the buffer's **displayed** edges, so a
              // soft-wrapped paragraph keeps the browser's native caret movement
              // until the caret reaches the first or last row. Pi's editor measures
              // visual lines the same way (`isOnFirstVisualLine` /
              // `isOnLastVisualLine`, editor.js:328-337). The offset and value come
              // from the live selection rather than React state: a keydown follows a
              // caret move in the same frame, before the state commits.
              const plainArrow =
                (event.key === "ArrowUp" || event.key === "ArrowDown") &&
                !event.shiftKey &&
                !event.ctrlKey &&
                !event.metaKey &&
                !event.altKey;
              const node = event.currentTarget;
              const offset = node.selectionStart ?? 0;
              const collapsed = offset === (node.selectionEnd ?? offset);
              const applyHistory = (direction: 1 | -1): void => {
                const step = onHistoryStep(direction, offset);
                // "none" means the textarea keeps the key: no history movement.
                if (step.kind === "none") return;
                event.preventDefault();
                // Pi cancels autocomplete when it navigates history; do the same
                // so a menu built from the old buffer cannot survive the step.
                closeCompletion();
                setPickedSource(undefined);
                pendingCaretRef.current = { text: step.text, caret: step.caret };
                // The store already wrote the text. The caret can only be placed
                // once the controlled value commits; the microtask also covers a
                // preview identical to the current draft, where the `draft`
                // effect does not re-run (same pattern as insertMention).
                queueMicrotask(applyPendingCaret);
              };
              // Shift/Ctrl/Meta/Alt chords and an active selection stay native:
              // Shift+Up extends the selection, Ctrl+Up moves by word/paragraph,
              // and Alt+Up was the dequeue chord above.
              if (plainArrow && collapsed) {
                const value = node.value;
                const visual = textareaVisualLines(node, offset);
                const line = value.slice(0, offset).split("\n").length;
                const lineCount = value.split("\n").length;
                const direction = event.key === "ArrowUp" ? -1 : 1;
                if (atHistoryEdge({ direction, visual, line, lineCount })) {
                  applyHistory(direction);
                }
              }
              if (
                isSendKey({
                  key: event.key,
                  shiftKey: event.shiftKey,
                  altKey: event.altKey,
                  isComposing: event.nativeEvent.isComposing,
                })
              ) {
                event.preventDefault();
                void submit();
              }
            }}
          />

          <ComposerModeControl
            mode={contributionMode}
            action={contributionModeAction}
            bashMode={bashMode}
            onMeasure={onModeMeasure}
            {...(onRunContributionMode ? { onRunAction: onRunContributionMode } : {})}
          />
        </div>

        <div className="flex flex-col self-stretch gap-1">
          {toolsSlot ? (
            <div data-testid="composer-tools" className="flex h-7 items-center justify-end gap-1">
              {toolsSlot}
            </div>
          ) : null}
          <div className="mt-auto flex h-7 items-center gap-1">
            {/* Bottom-right generic controls. The row shrinks and scrolls
                horizontally (`min-w-0 flex-1 overflow-x-auto`) so a verbose
                publisher can never push Send/Stop off a narrow composer; the
                action buttons below stay `shrink-0`. */}
            {composerControls.length > 0 ? (
              <ComposerControls
                className="min-w-0 flex-1"
                controls={composerControls}
                armedKeys={composerControlArmedKeys}
                busy={composerControlBusy}
                conflictMessage={composerControlConflict}
                onActivate={(control) => onActivateComposerControl?.(control) ?? false}
              />
            ) : null}
            <Button
              size="icon-md"
              variant="primary"
              aria-label="Send"
              className="shrink-0"
              disabled={!enabled || busy}
              onClick={() => void submit()}
              title={running ? "Enter steers · Alt+Enter queues a follow-up" : "Enter"}
            >
              <Send className="size-4" aria-hidden />
            </Button>
            {running && !inputLocked ? (
              <Button
                size="icon-md"
                variant="danger"
                aria-label="Stop"
                className="shrink-0"
                onClick={onStop}
                title="Esc"
              >
                <Square className="size-4" aria-hidden />
              </Button>
            ) : null}
            <Button
              size="icon-md"
              variant="ghost"
              className="shrink-0"
              aria-label="Attach image"
              title="Attach image"
              onClick={() => fileInputRef.current?.click()}
            >
              <Paperclip className="size-4" aria-hidden />
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              data-testid="composer-attach-input"
              onChange={(event) => void addFiles([...(event.target.files ?? [])])}
            />
          </div>
        </div>
      </div>

      <div className="mt-1 flex items-center gap-3 text-[11px] text-ink-faint">
        {/* The hints shrink and clip rather than pushing the readout off the
            row (plan step 6). */}
        <div className="flex min-w-0 shrink items-center gap-3 overflow-hidden">
          <span className="shrink-0">
            <span className="font-mono">/</span> commands
          </span>
          <span
            className="shrink-0"
            data-testid="composer-shell-hint"
            title="Run a shell command in this folder. Use !! to keep its output out of model context."
          >
            <span className="font-mono">!</span> shell
          </span>
          <span className="shrink-0">
            <span className="font-mono">@</span> files
          </span>
          <span className="shrink-0">
            <span className="font-mono">#</span> documents
          </span>
          <span className="shrink-0">
            Enter sends · Shift+Enter newline
            {inputLocked
              ? " · An extension owns this turn — use its controls to continue"
              : running
                ? " · Alt+Enter queues a follow-up · Esc pauses a review or stops the run"
                : ""}
          </span>
        </div>
        {/* Where the cursor is. The browser's caret is a thin blinking line that
            is easy to lose in a long buffer, so the position is also spelled
            out (plan step 1). */}
        <span
          data-testid="composer-caret"
          className="ml-auto shrink-0 tabular-nums"
          title="Cursor position"
        >
          {caretLabel(caret)}
        </span>
      </div>
    </div>
  );
}
