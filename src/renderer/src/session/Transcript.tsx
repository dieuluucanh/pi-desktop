import { useEffect, useRef, useState, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { diffLines } from "diff";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { Markdown } from "./Markdown";
import { ExtensionBlock } from "./ExtensionBlock";
import { OfficeToolCard } from "./OfficeToolCard";
import { isOfficeTool, officeToolSummary } from "./office-tool-card";
import { useMarkdownTransform } from "./useMarkdownTransform";
import { useAppStore } from "../state/app-store";
import { isBlobRef } from "../../../shared/host-protocol";
import type { OfficeDocumentPane } from "../../../shared/office-documents";
import {
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
        {text}
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
          {output}
        </pre>
      ) : null}
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
            tool.isError ? "text-danger" : tool.done ? "text-ok" : "text-accent",
          )}
        >
          {tool.isError ? "✗" : tool.done ? "✓" : "●"}
        </span>
        <span className="font-medium text-ink">{tool.toolName}</span>
        {summary ? <span className="truncate text-ink-muted">{summary}</span> : null}
        <span className="ml-auto text-ink-faint">
          {tool.done ? (open ? "▾" : "▸") : "running…"}
        </span>
      </button>
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
  const tone =
    notice.severity === "error" ? "danger" : notice.severity === "warning" ? "warn" : "neutral";
  return (
    <div className="flex items-start gap-3 rounded-sm border border-line bg-surface px-3 py-2 text-xs">
      <Badge tone={tone}>{notice.severity}</Badge>
      <div className="flex-1">
        <div>{notice.text}</div>
        {notice.detail ? (
          <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px] text-ink-faint">
            {notice.detail}
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
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-1 flex gap-2 text-[11px] text-ink-faint">
      <button
        type="button"
        className="hover:text-ink"
        onClick={() => {
          const clipboard = navigator.clipboard;
          if (!clipboard) return;
          void clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1_500);
          });
        }}
      >
        {copied ? "copied" : "copy"}
      </button>
    </div>
  );
}

function MessageView({
  message,
  tabId,
  thinkingLabel,
  toolsExpanded,
}: {
  message: TranscriptMessage;
  tabId?: string;
  thinkingLabel?: string | null;
  toolsExpanded?: boolean;
}) {
  const text = textOf(message.blocks);
  // Pi applies registered markdown transformers to user and assistant text only.
  const transformable = message.role === "user" || message.role === "assistant";
  const transformed = useMarkdownTransform(
    tabId,
    text,
    message.role === "user" ? "user" : "assistant",
    message.streaming,
    transformable,
  );

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
        {text}
      </pre>
    );
  }

  const thinking = message.blocks.filter(
    (block): block is { kind: "thinking"; text: string } => block.kind === "thinking",
  );
  const hasText = message.blocks.some((block) => block.kind === "text" && block.text.length > 0);
  const images = message.blocks.filter((block) => block.kind === "image");
  const calls = message.blocks.filter((block) => block.kind === "toolCall");

  const body = (
    <>
      {thinking.map((block, index) => (
        <ThinkingBlock
          key={`thinking-${index}`}
          text={block.text}
          {...(thinkingLabel ? { label: thinkingLabel } : {})}
        />
      ))}
      {hasText ? <Markdown>{transformed}</Markdown> : null}
      {images.map((block, index) => (
        <img
          key={`image-${index}`}
          alt="attachment"
          className="my-2 max-h-64 rounded-sm border border-line"
          src={`data:${block.mimeType};base64,${block.data}`}
        />
      ))}
      {calls.map((call, index) => (
        <div key={`call-${index}`} className="my-1 text-xs text-ink-muted">
          <Badge tone="accent">{call.name || "tool"}</Badge>{" "}
          <span className="font-mono">{call.arguments}</span>
        </div>
      ))}
      {message.streaming ? <span className="ml-0.5 animate-pulse text-accent">▍</span> : null}
      {!message.streaming && hasText ? <MessageActions text={text} /> : null}
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
  onToggleToolsExpanded,
}: {
  item: TranscriptItem;
  tabId?: string;
  onAbort?: () => void;
  running?: boolean;
  thinkingLabel?: string | null;
  toolsExpanded?: boolean;
  onToggleToolsExpanded?: () => void;
}) {
  if (item.kind === "message")
    return (
      <MessageView
        message={item.message}
        {...(tabId ? { tabId } : {})}
        thinkingLabel={thinkingLabel ?? null}
        {...(toolsExpanded === undefined ? {} : { toolsExpanded })}
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
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 96,
    overscan: 8,
  });

  const lastLength = useRef(items.length);
  useEffect(() => {
    if (items.length === lastLength.current) return;
    lastLength.current = items.length;
    if (stickToBottom.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [items.length]);

  if (items.length === 0 && empty) {
    return <TranscriptEmptyState {...empty} />;
  }

  const trackScroll = (element: HTMLDivElement): void => {
    stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
  };

  if (items.length <= VIRTUALIZE_THRESHOLD) {
    return (
      <div
        ref={scrollRef}
        className="h-full overflow-y-auto px-4 py-3"
        onScroll={(event) => trackScroll(event.currentTarget)}
        data-testid="transcript"
      >
        {items.map((item) => (
          <TranscriptRow key={item.id}>
            <TranscriptItemView
              item={item}
              {...(tabId ? { tabId } : {})}
              {...(onAbort ? { onAbort } : {})}
              {...(running === undefined ? {} : { running })}
              {...(thinkingLabel ? { thinkingLabel } : {})}
              {...(toolsExpanded === null || toolsExpanded === undefined ? {} : { toolsExpanded })}
              {...(onToggleToolsExpanded ? { onToggleToolsExpanded } : {})}
            />
          </TranscriptRow>
        ))}
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      className="h-full overflow-y-auto px-4 py-3"
      onScroll={(event) => trackScroll(event.currentTarget)}
      data-testid="transcript"
    >
      <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((row) => {
          const item = items[row.index];
          if (!item) return null;
          return (
            <div
              key={item.id}
              ref={virtualizer.measureElement}
              data-index={row.index}
              className="absolute left-0 top-0 w-full"
              style={{ transform: `translateY(${row.start}px)` }}
            >
              <TranscriptRow>
                <TranscriptItemView
                  item={item}
                  {...(tabId ? { tabId } : {})}
                  {...(onAbort ? { onAbort } : {})}
                  {...(running === undefined ? {} : { running })}
                  {...(thinkingLabel ? { thinkingLabel } : {})}
                  {...(toolsExpanded === null || toolsExpanded === undefined
                    ? {}
                    : { toolsExpanded })}
                  {...(onToggleToolsExpanded ? { onToggleToolsExpanded } : {})}
                />
              </TranscriptRow>
            </div>
          );
        })}
      </div>
    </div>
  );
}
