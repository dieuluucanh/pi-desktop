import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { diffLines } from "diff";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { copyText, hasSelectionWithin } from "../ui/clipboard";
import { cn } from "../ui/cn";
import { Markdown } from "./Markdown";
import { HighlightText } from "./Highlight";
import { FindPatternContext } from "./find-context";
import { TranscriptFindBar } from "./TranscriptFindBar";
import { findInTranscript, stepMatchIndex } from "./transcript-search";
import { ExtensionBlock } from "./ExtensionBlock";
import { OfficeToolCard } from "./OfficeToolCard";
import { isOfficeTool, officeToolSummary } from "./office-tool-card";
import { useMarkdownTransform } from "./useMarkdownTransform";
import { useAppStore } from "../state/app-store";
import { matchesBinding } from "../shortcuts/dom-keys";
import { isNotificationSuppressed } from "../../../shared/notifications";
import { resolveDesktopKeymap } from "../../../shared/desktop-keymap";
import { isBlobRef } from "../../../shared/host-protocol";
import type { OfficeDocumentPane } from "../../../shared/office-documents";
import {
  imagesOfPartial,
  stopReasonNote,
  textOfPartial,
  type TranscriptBlock,
  type TranscriptItem,
  type TranscriptMessage,
  type TranscriptNotice,
  type TranscriptToolRun,
} from "./session-events";

/**
 * The chat transcript (plan step 5).
 *
 * Virtualized, because a long session is thousands of items, and each item kind
 * has its own renderer: markdown prose, collapsible thinking, tool cards with
 * diffs, notices, and compaction cards. Custom messages fall back to their text
 * until step 18 supplies an extension renderer.
 */

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** Stable empty registry so the selector does not allocate a new array. */
const EMPTY_PANES: readonly OfficeDocumentPane[] = [];

function isAbsoluteOrRelativePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** One-line summary of a tool call, the way a terminal client shows it. */
export function toolSummary(tool: TranscriptToolRun): string {
  const args = asRecord(tool.args);
  const candidate =
    args.path ?? args.file ?? args.command ?? args.query ?? args.pattern ?? args.name ?? args.url;
  if (isAbsoluteOrRelativePath(candidate)) return candidate;
  const first = Object.entries(args)[0];
  return first ? `${first[0]}=${String(first[1]).slice(0, 60)}` : "";
}

function textOf(blocks: readonly TranscriptBlock[]): string {
  return blocks.map((block) => (block.kind === "text" ? block.text : "")).join("");
}

/**
 * One transcript row (plan step 5).
 *
 * The vertical rhythm lives here, as **padding**, and not as a margin on the
 * item itself: the virtualizer measures each row's border box, so a margin
 * would sit outside the measurement — the gaps disappeared (and the rows
 * overlapped) as soon as a session passed the virtualization threshold.
 *
 * The same wrapper is used by the plain list and by the virtualized list, so
 * a short session and a long one are spaced the same way.
 */
const ROW_PADDING = "px-1 py-1.5";

function TranscriptRow({ children }: { children: ReactNode }) {
  return (
    <div data-testid="transcript-row" className={ROW_PADDING}>
      {children}
    </div>
  );
}

export function ThinkingBlock({ text, label }: { text: string; label?: string }) {
  if (text.trim().length === 0) return null;
  return (
    <details className="my-2 rounded-sm border border-line bg-sunken/60 px-3 py-2">
      <summary className="cursor-pointer text-xs text-ink-muted">{label ?? "Thinking"}</summary>
      <pre className="mt-2 overflow-x-auto whitespace-pre-wrap font-mono text-xs text-ink-muted">
        <HighlightText text={text} />
      </pre>
    </details>
  );
}

/** Unified diff rows for an `edit`/`write` tool call, in the theme's diff colours. */
export function DiffView({ before, after }: { before: string; after: string }) {
  const parts = diffLines(before, after);
  return (
    <pre className="overflow-x-auto rounded-sm border border-line bg-sunken p-2 font-mono text-xs">
      <code>
        {parts.map((part, index) => (
          <span
            key={index}
            className={cn(
              "block whitespace-pre-wrap",
              part.added && "bg-ok/10 text-ok",
              part.removed && "bg-danger/10 text-danger",
            )}
          >
            {part.value
              .replace(/\n$/, "")
              .split("\n")
              .map((line, lineIndex) => (
                <span key={lineIndex} className="block">
                  {part.added ? "+" : part.removed ? "-" : " "}
                  {line}
                </span>
              ))}
          </span>
        ))}
      </code>
    </pre>
  );
}

function diffPropsFor(tool: TranscriptToolRun): { before: string; after: string } | null {
  const args = asRecord(tool.args);
  if (
    tool.toolName === "edit" &&
    typeof args.oldString === "string" &&
    typeof args.newString === "string"
  ) {
    return { before: args.oldString, after: args.newString };
  }
  if (tool.toolName === "write" && typeof args.content === "string") {
    return { before: "", after: args.content };
  }
  return null;
}

export function ToolCard({
  tool,
  tabId,
  expanded,
  onToggle,
}: {
  tool: TranscriptToolRun;
  /** Present when the transcript can run extension tool renderers (step 18). */
  tabId?: string;
  /** The app's expand-all state; when absent the card keeps its own default. */
  expanded?: boolean;
  /** Flips the app's expand-all state (Ctrl+O); absent means a local toggle. */
  onToggle?: () => void;
}) {
  const [localOpen, setLocalOpen] = useState(tool.isError);
  // A global expand state forces every card; otherwise a card keeps its own
  // default, so a failing tool still starts open.
  const open = expanded ?? (localOpen || tool.isError);
  const toggle = (): void => {
    if (onToggle) onToggle();
    else setLocalOpen((value) => !value);
  };
  const officePanes = useAppStore((state) => state.officeDocuments?.panes ?? EMPTY_PANES);
  const diff = diffPropsFor(tool);
  const resultImages = imagesOfPartial(tool.result ?? tool.partialResult);

  // A large tool result arrives as a BlobRef *in place* (host plan step 24): the
  // card keeps its identity and fetches the body only when it is opened.
  const spilledRef = isBlobRef(tool.result)
    ? tool.result
    : isBlobRef(tool.partialResult)
      ? tool.partialResult
      : null;
  const blobPath = spilledRef?.$blob ?? null;
  const blob = useAppStore((state) => (blobPath ? state.blobs[blobPath] : undefined));
  const loadBlob = useAppStore((state) => state.loadBlob);
  useEffect(() => {
    if (!open || !blobPath || !tabId || !spilledRef) return;
    void loadBlob(tabId, spilledRef);
  }, [open, blobPath, tabId, loadBlob, spilledRef]);
  const spilledText = ((): string | null => {
    if (!spilledRef || !blob || blob.status !== "ready") return null;
    try {
      return textOfPartial(JSON.parse(blob.contents ?? ""));
    } catch {
      return blob.contents ?? "";
    }
  })();
  const loadingSpilled = spilledRef !== null && (blob?.status === "loading" || !blob);
  const output = spilledRef
    ? (spilledText ?? (blob?.status === "error" ? `[unavailable: ${blob.error}]` : ""))
    : (tool.resultText ?? tool.partial ?? "");
  const summary = officeToolSummary(tool, officePanes) ?? toolSummary(tool);
  const previewSource = (tool.resultText ?? tool.partial ?? "").trim();
  const previewLines = previewSource.length > 0 ? previewSource.split("\n") : [];
  const preview = previewLines.slice(0, 10).join("\n");
  const moreLines = Math.max(0, previewLines.length - 10);

  // What a tool without an extension renderer shows: the app's native diff or
  // output card, which is also Pi's fallback when a renderer throws.
  const nativeBody = (
    <>
      {diff ? <DiffView {...diff} /> : null}
      {loadingSpilled ? (
        <p className="mt-2 text-xs text-ink-faint" data-testid="tool-result-loading">
          Loading large result…
        </p>
      ) : output ? (
        <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap font-mono text-xs text-ink-muted">
          <HighlightText text={output} />
        </pre>
      ) : null}
      {resultImages.map((image, index) => (
        <img
          key={`tool-image-${index}`}
          alt="tool result"
          className="mt-2 max-h-64 rounded-sm border border-line"
          src={`data:${image.mimeType};base64,${image.data}`}
        />
      ))}
      {!diff && !output && !loadingSpilled ? (
        <p className="text-xs text-ink-faint">No output captured yet.</p>
      ) : null}
    </>
  );
  // Office tools get the app's target/capability card (plan step 20); a tool
  // with an extension renderer still wins, with that card as its fallback.
  const officeBody = isOfficeTool(tool.toolName) ? (
    <OfficeToolCard tool={tool} fallback={nativeBody} />
  ) : (
    nativeBody
  );
  const body =
    tabId && tool.toolName ? (
      <ExtensionBlock
        tabId={tabId}
        input={{
          target: "tool",
          type: tool.toolName,
          toolCallId: tool.toolCallId,
          args: tool.args,
          result: tool.result ?? tool.partialResult,
          isPartial: !tool.done,
          isError: tool.isError,
          // `tool_execution_start` carries the already-parsed arguments.
          argsComplete: true,
          version: tool.version,
        }}
        expanded={open}
        fallback={officeBody}
      />
    ) : (
      officeBody
    );

  return (
    <div
      data-testid="tool-card"
      className={cn(
        "rounded-sm border bg-raised/60",
        tool.isError ? "border-danger/60" : "border-line",
      )}
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs"
        onClick={toggle}
        aria-expanded={open}
      >
        {/* Pi's tool header: a status glyph plus the tool name in bold
            (`theme.fg("toolTitle", theme.bold(toolName))`). The glyph says the
            state at a glance; the name stays plain text. */}
        <span
          aria-hidden
          className={cn(
            "font-mono leading-none",
            tool.cancelled
              ? "text-ink-faint"
              : tool.isError
                ? "text-danger"
                : tool.done
                  ? "text-ok"
                  : "text-accent",
          )}
        >
          {tool.cancelled ? "⊘" : tool.isError ? "✗" : tool.done ? "✓" : "●"}
        </span>
        <span className="font-medium text-ink">{tool.toolName}</span>
        {summary ? <span className="truncate text-ink-muted">{summary}</span> : null}
        <span className="ml-auto text-ink-faint">
          {tool.cancelled ? "cancelled" : tool.done ? (open ? "▾" : "▸") : "running…"}
        </span>
      </button>
      {!open && !diff && preview ? (
        <div className="border-t border-line px-3 py-2">
          <pre className="max-h-40 overflow-hidden whitespace-pre-wrap font-mono text-[11px] text-ink-muted">
            <HighlightText text={preview} />
          </pre>
          {moreLines > 0 ? (
            <p className="mt-1 text-[11px] text-ink-faint">
              {moreLines} more line{moreLines === 1 ? "" : "s"} — expand
            </p>
          ) : null}
        </div>
      ) : null}
      {open ? <div className="border-t border-line px-3 py-2">{body}</div> : null}
    </div>
  );
}

function NoticeView({
  notice,
  onAbort,
  running,
}: {
  notice: TranscriptNotice;
  onAbort?: () => void;
  running?: boolean;
}) {
  const notifications = useAppStore((state) => state.prefs.notifications);
  // A suppressed extension notification (class off or a mute rule) stays in the
  // notification archive, but it must not take a row in the transcript. The
  // hook runs before this early return, so enabling the class restores the row.
  if (
    notice.event === "oi.notify" &&
    isNotificationSuppressed({ message: notice.text, type: notice.severity }, notifications)
  ) {
    return null;
  }
  const tone =
    notice.severity === "error" ? "danger" : notice.severity === "warning" ? "warn" : "neutral";
  return (
    <div className="flex items-start gap-3 rounded-sm border border-line bg-surface px-3 py-2 text-xs">
      <Badge tone={tone}>{notice.severity}</Badge>
      <div className="flex-1">
        <div>{<HighlightText text={notice.text} />}</div>
        {notice.detail ? (
          <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px] text-ink-faint">
            <HighlightText text={notice.detail} />
          </pre>
        ) : null}
      </div>
      {notice.severity === "error" && running && onAbort ? (
        <Button size="sm" variant="ghost" onClick={onAbort}>
          Abort run
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Message actions (plan step 5).
 *
 * Only what works today: copying a message's text. “Fork from here” and “revert
 * to here” need the session *tree* (entry ids, branch navigation) and land with
 * step 11; “retry” is a composer concern (step 6). Shipping dead buttons would
 * teach users not to trust the transcript's controls.
 */
function MessageActions({ text }: { text: string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <div className="mt-1 flex gap-2 text-[11px] text-ink-faint">
      <button
        type="button"
        className="hover:text-ink"
        onClick={() => {
          void copyText(text).then((ok) => {
            setStatus(ok ? "copied" : "failed");
            setTimeout(() => setStatus("idle"), 1_500);
          });
        }}
      >
        {status === "copied" ? "copied" : status === "failed" ? "copy failed" : "copy"}
      </button>
    </div>
  );
}

function MessageTextBlock({
  tabId,
  text,
  role,
  streaming,
}: {
  tabId?: string;
  text: string;
  role: "user" | "assistant";
  streaming: boolean;
}) {
  const transformed = useMarkdownTransform(tabId, text, role, streaming, true);
  return <Markdown streaming={streaming}>{transformed}</Markdown>;
}

function MessageView({
  message,
  tabId,
  thinkingLabel,
  toolsExpanded,
  toolCardIds,
  promptExpanded,
  onTogglePrompt,
}: {
  message: TranscriptMessage;
  tabId?: string;
  thinkingLabel?: string | null;
  toolsExpanded?: boolean;
  toolCardIds?: ReadonlySet<string>;
  /** The command-prompt body is visible (only meaningful with promptOrigin). */
  promptExpanded?: boolean;
  onTogglePrompt?: () => void;
}) {
  const text = textOf(message.blocks);

  if (message.role === "compaction" || message.role === "branchSummary") {
    return (
      <details className="rounded-sm border border-line bg-sunken/60 px-3 py-2">
        <summary className="cursor-pointer text-xs text-ink-muted">
          {message.role === "compaction" ? "Context compacted" : "Branch summary"}
        </summary>
        <Markdown className="mt-2 text-xs text-ink-muted">{text}</Markdown>
      </details>
    );
  }

  if (message.role === "custom") {
    // A custom message goes through `registerMessageRenderer`, a bare custom
    // entry through `registerEntryRenderer`. Both fall back to this text card,
    // except a bare entry: Pi renders nothing for an entry whose renderer is
    // missing, and that is what keeps a mode switch (the workflow extension's
    // `pi.appendEntry("workflow", …)`) out of the transcript entirely.
    const fallback = (
      <div className="rounded-sm border border-dashed border-line px-3 py-2">
        <div className="text-[11px] text-ink-faint">{message.customType ?? "custom message"}</div>
        <Markdown className="mt-1">{text}</Markdown>
      </div>
    );
    if (!tabId || !message.customType) return fallback;
    const isEntry = message.customKind === "entry";
    return (
      <ExtensionBlock
        tabId={tabId}
        input={{
          target: isEntry ? "entry" : "message",
          type: message.customType,
          ...(isEntry ? { entry: message.customPayload } : { message: message.customPayload }),
          version: message.id,
        }}
        expanded={toolsExpanded === true}
        fallback={fallback}
        hideWhenUnrendered={isEntry}
      />
    );
  }

  if (message.role === "bashExecution") {
    return (
      <pre className="overflow-x-auto rounded-sm border border-line bg-sunken p-2 font-mono text-xs">
        <HighlightText text={text} />
      </pre>
    );
  }

  const orderedBlocks: TranscriptBlock[] = [];
  for (const block of message.blocks) {
    const last = orderedBlocks[orderedBlocks.length - 1];
    if (block.kind === "thinking" && last?.kind === "thinking") {
      orderedBlocks[orderedBlocks.length - 1] = {
        kind: "thinking",
        text: `${last.text}\n\n${block.text}`,
      };
    } else {
      orderedBlocks.push(block);
    }
  }
  const hasText = message.blocks.some((block) => block.kind === "text" && block.text.length > 0);
  const stopNote = stopReasonNote(message);
  const commandOrigin =
    message.role === "user" && message.promptOrigin ? message.promptOrigin : undefined;
  const isCommandPrompt = commandOrigin !== undefined;
  const promptVisible = !isCommandPrompt || promptExpanded === true;
  const promptLines = text.length === 0 ? 0 : text.split("\n").length;
  const copyText = isCommandPrompt && !promptVisible ? commandOrigin : text;

  const commandHeader = isCommandPrompt ? (
    <div className="mb-1 flex min-w-0 items-center gap-2 text-[11px]" data-testid="command-prompt">
      <Badge tone="accent">command</Badge>
      <span
        className="min-w-0 truncate font-mono text-ink-muted"
        title={commandOrigin}
        data-testid="command-origin"
      >
        {commandOrigin}
      </span>
      {onTogglePrompt ? (
        <button
          type="button"
          className="shrink-0 text-ink-muted hover:text-ink"
          aria-expanded={promptVisible}
          onClick={onTogglePrompt}
          data-testid="command-prompt-toggle"
        >
          {promptVisible ? "Hide prompt" : "Show prompt"}
        </button>
      ) : null}
    </div>
  ) : null;

  const body = (
    <>
      {commandHeader}
      {!promptVisible ? (
        <p className="text-xs text-ink-faint" data-testid="command-prompt-hidden">
          Expanded prompt hidden · {promptLines} {promptLines === 1 ? "line" : "lines"}
        </p>
      ) : null}
      {orderedBlocks.map((block, index) => {
        if (block.kind === "thinking") {
          return (
            <ThinkingBlock
              key={`block-${index}`}
              text={block.text}
              {...(thinkingLabel ? { label: thinkingLabel } : {})}
            />
          );
        }
        if (block.kind === "text") {
          if (block.text.length === 0) return null;
          // The body of a command prompt is the expanded instruction, not what
          // the user typed; hide it until the row (or the setting/Ctrl+O) says
          // otherwise (2026-10-26 composer plan).
          if (isCommandPrompt && !promptVisible) return null;
          return (
            <MessageTextBlock
              key={`block-${index}`}
              {...(tabId ? { tabId } : {})}
              text={block.text}
              role={message.role === "user" ? "user" : "assistant"}
              streaming={message.streaming}
            />
          );
        }
        if (block.kind === "image") {
          return (
            <img
              key={`block-${index}`}
              alt="attachment"
              className="my-2 max-h-64 rounded-sm border border-line"
              src={`data:${block.mimeType};base64,${block.data}`}
            />
          );
        }
        // The tool card is authoritative; only show the inline fallback when
        // no run card exists (history or an interrupted/custom tool).
        if (toolCardIds?.has(block.id)) return null;
        return (
          <div
            key={`block-${index}`}
            data-testid="inline-tool-call"
            className="my-1 text-xs text-ink-muted"
          >
            <Badge tone="accent">{block.name || "tool"}</Badge>{" "}
            <span className="font-mono">{block.arguments}</span>
          </div>
        );
      })}
      {stopNote ? (
        <p
          role="status"
          className={cn(
            "mt-2 text-xs",
            stopNote.severity === "error" ? "text-danger" : "text-warn",
          )}
        >
          {stopNote.text}
        </p>
      ) : null}
      {message.streaming ? <span className="ml-0.5 animate-pulse text-accent">▍</span> : null}
      {!message.streaming && hasText ? <MessageActions text={copyText} /> : null}
    </>
  );

  if (message.role === "user") {
    // The desktop keeps the bubble (a chat affordance the terminal cannot
    // have) and names the speaker, so the two roles stay readable in a dense
    // column (plan step 5).
    return (
      <div className="ml-auto max-w-[85%]">
        <div className="mb-1 text-right text-[10px] uppercase tracking-wide text-ink-faint">
          You
        </div>
        <div className="rounded-md border border-line bg-surface px-3 py-2">{body}</div>
      </div>
    );
  }

  return <div className="max-w-[95%]">{body}</div>;
}

function TranscriptItemView({
  item,
  tabId,
  onAbort,
  running,
  thinkingLabel,
  toolsExpanded,
  toolCardIds,
  onToggleToolsExpanded,
  promptExpanded,
  onTogglePrompt,
}: {
  item: TranscriptItem;
  tabId?: string;
  onAbort?: () => void;
  running?: boolean;
  thinkingLabel?: string | null;
  toolsExpanded?: boolean;
  toolCardIds?: ReadonlySet<string>;
  onToggleToolsExpanded?: () => void;
  promptExpanded?: boolean;
  onTogglePrompt?: () => void;
}) {
  if (item.kind === "message")
    return (
      <MessageView
        message={item.message}
        {...(tabId ? { tabId } : {})}
        thinkingLabel={thinkingLabel ?? null}
        {...(toolsExpanded === undefined ? {} : { toolsExpanded })}
        {...(toolCardIds ? { toolCardIds } : {})}
        {...(promptExpanded === undefined ? {} : { promptExpanded })}
        {...(onTogglePrompt ? { onTogglePrompt } : {})}
      />
    );
  if (item.kind === "tool")
    return (
      <ToolCard
        tool={item.tool}
        {...(tabId ? { tabId } : {})}
        {...(toolsExpanded === undefined ? {} : { expanded: toolsExpanded })}
        {...(onToggleToolsExpanded ? { onToggle: onToggleToolsExpanded } : {})}
      />
    );
  return (
    <NoticeView
      notice={item.notice}
      {...(onAbort ? { onAbort } : {})}
      {...(running === undefined ? {} : { running })}
    />
  );
}

export function TranscriptEmptyState({
  cwd,
  project,
  model,
}: {
  cwd?: string;
  project?: string | null;
  model?: string | null;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
      <h2 className="text-sm font-semibold">This session is ready</h2>
      <p className="max-w-md text-xs text-ink-muted">
        Ask for a change, a review, or an explanation. Sessions run in{" "}
        <span className="font-mono">{cwd ?? "the project folder"}</span> with the shared Pi profile,
        so their history and settings are the same as terminal Pi.
      </p>
      {project ? (
        <p className="text-xs text-ink-faint">
          Project: <span className="font-mono">{project}</span>
          {model ? ` · model: ${model}` : ""}
        </p>
      ) : null}
      <ul className="mt-2 space-y-1 text-left text-xs text-ink-faint">
        <li>
          <span className="font-mono">/</span> commands · extension commands, templates, skills
        </li>
        <li>
          <span className="font-mono">@</span> files · attach a file to the prompt
        </li>
        <li>
          <span className="font-mono">#</span> documents · Office documents, once the bridge is set
          up
        </li>
      </ul>
    </div>
  );
}

/**
 * Below this many items the transcript renders plainly: virtualizing five
 * messages costs more than it saves, and a plain list is what tests and small
 * sessions exercise. The 10k-item acceptance path still virtualizes.
 */
export const VIRTUALIZE_THRESHOLD = 50;

export function Transcript({
  items,
  tabId,
  onAbort,
  running,
  empty,
  thinkingLabel,
  toolsExpanded,
  onToggleToolsExpanded,
  followPaused = false,
  active = true,
}: {
  items: readonly TranscriptItem[];
  /** The session tab, so tool/message renderers can run in its host (step 18). */
  tabId?: string;
  onAbort?: () => void;
  running?: boolean;
  empty?: { cwd?: string; project?: string | null; model?: string | null };
  /** `ctx.ui.setHiddenThinkingLabel`; null keeps the app default. */
  thinkingLabel?: string | null;
  /** The expand-all state; null leaves each card's own default. */
  toolsExpanded?: boolean | null;
  /** Flips the app's expand-all state (`app.tools.expand`). */
  onToggleToolsExpanded?: () => void;
  /**
   * False for a transcript in a background grid pane (2026-11-03 plan).
   *
   * The find bar and jump-to-bottom are `window` listeners, so several mounted
   * transcripts would all react to one keystroke. Only the focused pane's
   * transcript claims them; a background pane's stays inert until it is clicked.
   */
  active?: boolean;
  /**
   * Suspends auto-follow while an overlay owns the user's attention (a picker or
   * dialog). Streaming continues; the viewport just stops chasing it.
   */
  followPaused?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  // The ref is the source of truth for the scroll effect (no re-render lag);
  // the state only drives the "jump to latest" pill.
  const stickToBottom = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const [hasNews, setHasNews] = useState(false);
  const toolCardIds = useMemo(
    () => new Set(items.flatMap((item) => (item.kind === "tool" ? [item.tool.toolCallId] : []))),
    [items],
  );

  // Command prompts (2026-10-26 composer plan): Ctrl+O is the global override,
  // the App preference is the neutral default, and a per-row toggle wins until
  // the global state changes. The Normal/Verbose/Summary mode was removed
  // (2026-10-30 copy plan); Ctrl+O is the only expand-all switch.
  const showExpandedPrompts = useAppStore((state) => state.prefs.showExpandedPrompts);
  const defaultPromptExpanded = toolsExpanded ?? showExpandedPrompts;
  const [promptOverrides, setPromptOverrides] = useState<Record<string, boolean>>({});
  useEffect(() => {
    setPromptOverrides({});
  }, [toolsExpanded, showExpandedPrompts]);
  const collapsedPromptIds = useMemo(() => {
    const ids = new Set<string>();
    for (const item of items) {
      if (item.kind !== "message" || !item.message.promptOrigin) continue;
      if (!(promptOverrides[item.id] ?? defaultPromptExpanded)) ids.add(item.id);
    }
    return ids;
  }, [items, defaultPromptExpanded, promptOverrides]);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 96,
    overscan: 8,
  });

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = "auto", options?: { force?: boolean }) => {
      const node = scrollRef.current;
      if (!node) return;
      // A live selection belongs to the user. Auto-follow must not move the
      // viewport out from under a drag-select while a response streams; the
      // pill and Ctrl+End are the explicit ways to force it (2026-10-30 copy
      // plan).
      if (!options?.force && hasSelectionWithin(node)) {
        setAtBottom(false);
        setHasNews(true);
        return;
      }
      if (typeof node.scrollTo === "function") {
        node.scrollTo({ top: node.scrollHeight, behavior });
      } else {
        node.scrollTop = node.scrollHeight;
      }
      stickToBottom.current = true;
      setAtBottom(true);
      setHasNews(false);
    },
    [],
  );

  /**
   * A size signature of the last item's streamed text. Streaming deltas grow the
   * content without adding an item, so the old item-count effect never fired
   * (plan step 10); this covers the no-`ResizeObserver` path (jsdom, old hosts)
   * deterministically.
   */
  const streamSize = useMemo(() => {
    const last = items[items.length - 1];
    if (!last) return 0;
    if (last.kind === "message") {
      return last.message.blocks.reduce(
        (total, block) =>
          total + (block.kind === "text" || block.kind === "thinking" ? block.text.length : 0),
        0,
      );
    }
    if (last.kind === "tool") {
      return (last.tool.partial?.length ?? 0) + (last.tool.resultText?.length ?? 0);
    }
    return last.notice.text.length;
  }, [items]);

  const lastLength = useRef(items.length);
  useEffect(() => {
    if (items.length === lastLength.current) return;
    lastLength.current = items.length;
    if (stickToBottom.current && !followPaused) scrollToBottom();
  }, [items.length, followPaused, scrollToBottom]);

  // Follow streamed growth while pinned. Scrolling up detaches; the pill is the
  // only way back (terminal's fullscreen view behaves the same).
  useEffect(() => {
    if (!stickToBottom.current) {
      // New content arrived while the user is reading above: offer the pill.
      setHasNews(true);
      return;
    }
    if (followPaused) return;
    scrollToBottom();
  }, [streamSize, followPaused, scrollToBottom]);

  // Layout growth (an image decoding, a Mermaid block settling) does not change
  // text length, so observe the content box where the platform supports it.
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    if (typeof ResizeObserver === "undefined") return;
    let frame: number | null = null;
    const observer = new ResizeObserver(() => {
      if (!stickToBottom.current) {
        setHasNews(true);
        return;
      }
      if (followPaused || frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        scrollToBottom();
      });
    });
    observer.observe(content);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [followPaused, scrollToBottom]);

  // `Ctrl+End` is terminal Pi's jump-to-bottom; it must never steal the chord
  // from a native editor (where it means "end of document").
  useEffect(() => {
    // Only the focused pane owns the global chord: a grid mounts several
    // transcripts, and each one listening would scroll all of them at once.
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.ctrlKey || event.key !== "End") return;
      const target = event.target as HTMLElement | null;
      if (target?.closest?.("input, textarea, [contenteditable='true']")) return;
      event.preventDefault();
      scrollToBottom("smooth", { force: true });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [scrollToBottom, active]);

  // ---- Transcript find (plan step 11) ----
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findRegex, setFindRegex] = useState(false);
  const [findQuerySettled, setFindQuerySettled] = useState("");
  const [activeMatch, setActiveMatch] = useState(-1);

  // A per-keystroke search over a long transcript stalls typing; 150 ms still
  // feels immediate (plan step 11's debounce).
  useEffect(() => {
    if (!findOpen) return;
    const timer = setTimeout(() => setFindQuerySettled(findQuery), 150);
    return () => clearTimeout(timer);
  }, [findQuery, findOpen]);

  const find = useMemo(
    () =>
      findInTranscript(items, findQuerySettled, {
        useRegex: findRegex,
        collapsedPromptIds,
      }),
    [items, findQuerySettled, findRegex, collapsedPromptIds],
  );

  useEffect(() => {
    setActiveMatch(find.matches.length > 0 ? 0 : -1);
  }, [find.matches.length, find.pattern]);

  // `Ctrl+F` opens find (terminal's `tui.altScreen.search`), resolved from the
  // desktop keymap so a remap in Settings is honoured (plan steps 22-23). A
  // dialog keeps the chord so an extension surface can own it.
  const findOverride = useAppStore((state) => state.prefs.desktopKeybindings?.["transcript.find"]);
  const findKeys = useMemo(
    () => resolveDesktopKeymap({ "transcript.find": findOverride })["transcript.find"],
    [findOverride],
  );
  useEffect(() => {
    // Same rule as Ctrl+End: one find bar per keystroke, owned by the focused pane.
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (findKeys.length === 0) return;
      if (!matchesBinding(event, findKeys)) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest?.('[role="dialog"]')) return;
      event.preventDefault();
      setFindOpen(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [findKeys, active]);

  const activeItemId =
    activeMatch >= 0 ? (find.matches[activeMatch]?.itemId ?? undefined) : undefined;
  useEffect(() => {
    if (!activeItemId) return;
    const index = items.findIndex((item) => item.id === activeItemId);
    if (index < 0) return;
    // Virtualized rows have no DOM node when off screen, so the virtualizer owns
    // the jump; the plain list scrolls the rendered row into view.
    if (items.length > VIRTUALIZE_THRESHOLD) {
      virtualizer.scrollToIndex(index, { align: "center" });
      return;
    }
    const node = scrollRef.current?.querySelector(`[data-row-index="${index}"]`);
    node?.scrollIntoView?.({ block: "center" });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the match only
  }, [activeItemId]);

  const stepFind = (direction: 1 | -1): void => {
    const next = stepMatchIndex(activeMatch, find.matches.length, direction);
    if (next >= 0) setActiveMatch(next);
  };

  const closeFind = (): void => {
    setFindOpen(false);
    setFindQuery("");
    setFindQuerySettled("");
    setActiveMatch(-1);
  };

  const findBar = findOpen ? (
    <TranscriptFindBar
      query={findQuery}
      onQueryChange={setFindQuery}
      regex={findRegex}
      onToggleRegex={() => setFindRegex((value) => !value)}
      count={find.matches.length}
      activeIndex={activeMatch}
      error={find.error}
      onNext={() => stepFind(1)}
      onPrev={() => stepFind(-1)}
      onClose={closeFind}
    />
  ) : null;

  if (items.length === 0 && empty) {
    return <TranscriptEmptyState {...empty} />;
  }

  const trackScroll = (element: HTMLDivElement): void => {
    const bottom = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    stickToBottom.current = bottom;
    setAtBottom(bottom);
    if (bottom) setHasNews(false);
  };

  const pill =
    !atBottom && items.length > 0 ? (
      <button
        type="button"
        data-testid="jump-to-latest"
        className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-line bg-surface px-3 py-1 text-xs shadow-sm hover:bg-raised"
        onClick={() => scrollToBottom("smooth", { force: true })}
      >
        {hasNews ? "New messages · jump to latest" : "Jump to latest"}
      </button>
    ) : null;

  const row = (item: TranscriptItem) => {
    const isCommandPrompt = item.kind === "message" && Boolean(item.message.promptOrigin);
    return (
      <TranscriptItemView
        item={item}
        {...(tabId ? { tabId } : {})}
        {...(onAbort ? { onAbort } : {})}
        {...(running === undefined ? {} : { running })}
        {...(thinkingLabel ? { thinkingLabel } : {})}
        {...(toolsExpanded === null || toolsExpanded === undefined ? {} : { toolsExpanded })}
        {...(toolCardIds.size > 0 ? { toolCardIds } : {})}
        {...(onToggleToolsExpanded ? { onToggleToolsExpanded } : {})}
        {...(isCommandPrompt ? { promptExpanded: !collapsedPromptIds.has(item.id) } : {})}
        {...(isCommandPrompt
          ? {
              onTogglePrompt: () =>
                setPromptOverrides((current) => ({
                  ...current,
                  [item.id]: !(current[item.id] ?? defaultPromptExpanded),
                })),
            }
          : {})}
      />
    );
  };

  if (items.length <= VIRTUALIZE_THRESHOLD) {
    return (
      <FindPatternContext.Provider value={findOpen ? find.pattern : null}>
        <div className="relative h-full">
          {findBar}
          <div
            ref={scrollRef}
            className="h-full overflow-y-auto px-4 py-3"
            onScroll={(event) => trackScroll(event.currentTarget)}
            data-testid="transcript"
          >
            <div
              ref={contentRef}
              data-testid="transcript-content"
              className="mx-auto w-full max-w-[var(--transcript-measure)]"
            >
              {items.map((item, index) => (
                <div key={item.id} data-row-index={index} data-item-id={item.id}>
                  <TranscriptRow>{row(item)}</TranscriptRow>
                </div>
              ))}
            </div>
          </div>
          {pill}
        </div>
      </FindPatternContext.Provider>
    );
  }

  return (
    <FindPatternContext.Provider value={findOpen ? find.pattern : null}>
      <div className="relative h-full">
        {findBar}
        <div
          ref={scrollRef}
          className="h-full overflow-y-auto px-4 py-3"
          onScroll={(event) => trackScroll(event.currentTarget)}
          data-testid="transcript"
        >
          <div
            ref={contentRef}
            data-testid="transcript-content"
            className="relative mx-auto w-full max-w-[var(--transcript-measure)]"
            style={{ height: virtualizer.getTotalSize() }}
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const item = items[virtualRow.index];
              if (!item) return null;
              return (
                <div
                  key={item.id}
                  ref={virtualizer.measureElement}
                  data-index={virtualRow.index}
                  data-item-id={item.id}
                  className="absolute left-0 top-0 w-full"
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                >
                  <TranscriptRow>{row(item)}</TranscriptRow>
                </div>
              );
            })}
          </div>
        </div>
        {pill}
      </div>
    </FindPatternContext.Provider>
  );
}
