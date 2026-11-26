/**
 * The commit box.
 *
 * The composer is the tallest fixed thing in a 320 px column, so it is shaped
 * around frequency: the message and the button are used constantly, amend
 * occasionally, the identity almost never.
 *
 * ```text
 *  ┌ textarea, grows to 10 rem ─────────┐
 *  │ 0 / 20000 · Ada <ada@…> [global] ⋯ │  meta row
 *  │ [ Commit ]                         │  full width
 *  └────────────────────────────────────┘
 * ```
 *
 * The `⋯` list is **inline**, like the rail strip's reorder menu: a portal popup
 * in this column clips and steals pointer events. It holds *Amend last commit*,
 * and whichever of *Change identity* / *Set identity* applies.
 *
 * The **sparkle** in the textarea's top-right corner asks the model for a
 * message; the chevron beside it picks the model. Both are app-native (no
 * extension, no session), the input is the *staged* diff only, and the result
 * lands in the composer — the user still presses Commit. A draft is never
 * replaced without a confirmation, and nothing here stages anything (that is the
 * `/commit` vs `/commit -a` rule).
 *
 * The three rules that keep it honest:
 *
 *  - **The button says what it will do.** With nothing staged but changes
 *    present it reads *Stage all and commit* and stages first, so the click
 *    never means something the label did not say.
 *  - **Amend prefills HEAD's whole message.** `--amend -F -` replaces the
 *    message, so prefilling only the subject would silently drop a body.
 *  - **The identity form is repo-local and opt-in.** Writing `.git/config` is a
 *    deliberate act behind a checkbox; the global hint is shown as text and
 *    never executed on the user's behalf.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ChevronDown, Ellipsis, Loader2, Sparkles } from "lucide-react";
import { Button } from "../ui/button";
import { ConfirmDialog } from "../ui/confirm-dialog";
import { COMMIT_MESSAGE_MAX_HEIGHT_PX, useAutoGrowTextarea } from "../ui/auto-grow";
import { CommitModelMenu } from "./CommitModelMenu";
import { RailMenuItem } from "./RailMenuItem";
import { useAppStore } from "../state/app-store";
import {
  commitBlockedNotice,
  commitReadiness,
  identitySummary,
  messageCount,
  primaryActionLabel,
} from "./commit-view";

export interface CommitBoxProps {
  /** The folder the rail is showing. */
  projectPath: string;
}

export function CommitBox({ projectPath }: CommitBoxProps) {
  const snapshot = useAppStore((state) => state.git[projectPath]);
  const runGitAction = useAppStore((state) => state.runGitAction);
  const loadHeadCommitMessage = useAppStore((state) => state.loadHeadCommitMessage);
  const generateCommitMessage = useAppStore((state) => state.generateCommitMessage);
  const cancelCommitMessage = useAppStore((state) => state.cancelCommitMessage);
  const generation = useAppStore((state) => state.commitGeneration[projectPath]);
  const modelChoice = useAppStore((state) => state.prefs.commitMessage.model);

  const [message, setMessage] = useState("");
  const messageRef = useRef<HTMLTextAreaElement | null>(null);
  // The message grows with its content up to a cap, then scrolls. The box is
  // still non-resizable: a drag would be overwritten by the next keystroke.
  useAutoGrowTextarea(messageRef, message, COMMIT_MESSAGE_MAX_HEIGHT_PX);
  const [amend, setAmend] = useState(false);
  const [busy, setBusy] = useState(false);
  const [identityOpen, setIdentityOpen] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const optionsTrigger = useRef<HTMLButtonElement | null>(null);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const modelTrigger = useRef<HTMLButtonElement | null>(null);
  // "Replace the current commit message?" — only when the box already has a draft.
  const [replaceOpen, setReplaceOpen] = useState(false);
  const closeModelMenu = useCallback(() => setModelMenuOpen(false), []);
  const [consent, setConsent] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");

  // Escape closes the options list and hands focus back to its trigger, so a
  // keyboard user is never stranded in a list they cannot see.
  useEffect(() => {
    if (!optionsOpen) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOptionsOpen(false);
      optionsTrigger.current?.focus();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [optionsOpen]);

  // Nothing to commit from a folder git cannot serve.
  if (!snapshot?.available) return null;

  const identity = snapshot.repo?.identity ?? null;
  const readiness = commitReadiness(snapshot, message, identity);
  const count = messageCount(message);
  const label = primaryActionLabel(snapshot, amend);
  const summary = identity ? identitySummary(identity) : null;
  const generating = generation?.phase === "running";
  const modelLabel = modelChoice
    ? `${modelChoice.provider}/${modelChoice.id}`
    : "Default mode model";

  // `generateCommitMessage` owns the context read, the prompt and the request;
  // this is only the paint: a success fills the box, a failure leaves the draft.
  const runGeneration = async (): Promise<void> => {
    const result = await generateCommitMessage(projectPath);
    if (result.ok) {
      setMessage(result.message);
      toast.success(`Message generated with ${result.model.provider}/${result.model.id}`);
      return;
    }
    // The draft is the user's work, not the failed attempt's: never clear it.
    toast.error(result.error);
  };

  const startGeneration = (): void => {
    if (generating) {
      void cancelCommitMessage(projectPath);
      return;
    }
    // A commit in flight owns the box; generating into it would race the click.
    if (busy) return;
    if (snapshot.staged.length === 0) {
      // Staged-only, like `/commit` and unlike `/commit -a`: never stage here.
      toast.warning("Stage the changes you want to commit first.");
      return;
    }
    // Replacing a draft is destructive to typed work, so it asks first (D13).
    if (message.trim().length > 0) {
      setReplaceOpen(true);
      return;
    }
    void runGeneration();
  };

  const submit = async (): Promise<void> => {
    if (busy) return;
    if (!readiness.canCommit) {
      // The box spends no row on advice (2026-10-30 project-scoped rail plan): a
      // permanent "Write a commit message" beside an empty textarea is noise in a
      // 320 px column. The click is where the missing thing actually matters, so
      // that is where it is explained, as a notification.
      const notice = commitBlockedNotice(snapshot, message, identity);
      if (notice) toast.warning(notice);
      // No identity configured: also open the form, since the toast names a menu
      // the user would otherwise have to find.
      if (!identity) setIdentityOpen(true);
      return;
    }
    setBusy(true);
    try {
      // The label promised to stage first when nothing was staged yet.
      if (snapshot.staged.length === 0 && snapshot.changed.length > 0) {
        const staged = await runGitAction(projectPath, {
          kind: "stage",
          paths: snapshot.changed.map((file) => file.path),
        });
        // A failed stage must not be followed by a commit of the old index.
        if (!staged.ok) return;
      }
      const result = await runGitAction(projectPath, { kind: "commit", message, amend });
      if (result.ok) {
        // A committed message belongs to the commit, not to the next one.
        setMessage("");
        setAmend(false);
      }
    } finally {
      setBusy(false);
    }
  };

  const onAmendChange = async (next: boolean): Promise<void> => {
    setAmend(next);
    setOptionsOpen(false);
    if (!next) return;
    const head = await loadHeadCommitMessage(projectPath);
    if (head !== null) setMessage(head);
  };

  const saveIdentity = async (): Promise<void> => {
    if (!consent || busy) return;
    setBusy(true);
    try {
      const result = await runGitAction(projectPath, {
        kind: "set-identity",
        name: name.trim(),
        email: email.trim(),
      });
      if (result.ok) {
        setIdentityOpen(false);
        setConsent(false);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5 px-3 pt-2" data-testid="commit-box">
      {/* The control is inside the textarea's corner, so the text keeps clear of
          it with `pr-12` (two icon buttons) rather than a second row. */}
      <div className="relative">
        <textarea
          ref={messageRef}
          aria-label="Commit message"
          placeholder="Commit message"
          rows={2}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void submit();
            }
            if (event.key === "Escape") {
              // Escape gives the keyboard back to the session; it never discards
              // what the user typed.
              event.currentTarget.blur();
            }
          }}
          className="w-full resize-none overflow-y-auto rounded-sm border border-line bg-sunken px-2 py-1 pr-12 text-xs text-ink outline-none focus:border-accent"
        />
        <div className="absolute right-1 top-1 flex items-center gap-0.5">
          <Button
            size="icon-sm"
            variant="ghost"
            data-testid="commit-generate"
            aria-label={generating ? "Cancel commit message generation" : "Generate commit message"}
            title={
              generating
                ? "Cancel the generation that is running"
                : `Generate from staged changes (${modelLabel})`
            }
            // A commit in flight owns the box, and a cancellable run is never
            // disabled: the second click is the abort.
            disabled={busy}
            onClick={startGeneration}
          >
            {generating ? (
              <Loader2
                className="size-3 animate-spin"
                aria-hidden
                data-testid="commit-generate-spinner"
              />
            ) : (
              <Sparkles className="size-3" aria-hidden />
            )}
          </Button>
          <Button
            ref={modelTrigger}
            size="icon-sm"
            variant="ghost"
            data-testid="commit-model"
            aria-label="Commit message model"
            aria-expanded={modelMenuOpen}
            aria-controls="commit-model-menu"
            onClick={() => setModelMenuOpen((open) => !open)}
          >
            <ChevronDown className="size-3" aria-hidden />
          </Button>
        </div>
      </div>

      {/* In flow, never a portal: a popup in this 320 px column clips. */}
      {modelMenuOpen ? (
        <CommitModelMenu
          projectPath={projectPath}
          onClose={closeModelMenu}
          returnFocusTo={modelTrigger}
        />
      ) : null}

      {/* Meta row: how long the message is, who it is attributed to, options. */}
      <div className="flex items-center gap-2 text-[11px] text-ink-faint">
        <span data-testid="commit-counter" className={count.over ? "text-danger" : undefined}>
          {count.text}
        </span>
        {summary ? (
          <span
            className="flex min-w-0 flex-1 items-center gap-1"
            data-testid="commit-identity"
            title={`${summary.label} — ${summary.sourceNote}`}
          >
            <span className="min-w-0 flex-1 truncate">{summary.label}</span>
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate" data-testid="commit-identity">
            No identity
          </span>
        )}
        <button
          ref={optionsTrigger}
          type="button"
          className="shrink-0 rounded-xs px-1 text-ink-faint hover:bg-raised hover:text-ink"
          aria-label="Commit options"
          aria-expanded={optionsOpen}
          aria-controls="commit-options"
          onClick={() => setOptionsOpen((open) => !open)}
        >
          <Ellipsis className="size-3" aria-hidden />
        </button>
      </div>

      {/*
        Inline, not a portal popup: this column is 320 px wide, so a floating menu
        clips and steals pointer events (the branch list made the same call).
      */}
      {optionsOpen ? (
        <div
          className="flex flex-col gap-0.5 rounded-sm border border-line bg-raised/40 p-1"
          id="commit-options"
          role="menu"
          data-testid="commit-options"
        >
          <RailMenuItem
            role="menuitemcheckbox"
            checked={amend}
            ariaLabel="Amend last commit"
            onSelect={() => void onAmendChange(!amend)}
          >
            Amend last commit
          </RailMenuItem>
          <RailMenuItem
            ariaLabel={identity ? "Change identity" : "Set identity"}
            onSelect={() => {
              setOptionsOpen(false);
              setIdentityOpen(true);
            }}
          >
            {identity ? "Change identity" : "Set identity"}
          </RailMenuItem>
          {/* Amend is a mode, not a one-shot: the button below reads "Amend commit"
              while it is on, and the list says so when it is. */}
        </div>
      ) : null}

      {/*
        No always-on reason line. The metas row above already shows the length
        and the identity; anything else is said when the user tries to commit
        (`commitBlockedNotice`). The identity form stays reachable from `⋯`.
      */}

      <Button
        size="sm"
        variant="primary"
        // `busy` is the only real disablement: a logical blocker must stay
        // clickable so the click can explain itself (`aria-disabled` announces
        // the same thing to assistive technology without swallowing the press).
        disabled={busy}
        aria-disabled={!readiness.canCommit || count.over}
        title={readiness.reason ?? label}
        onClick={() => void submit()}
        aria-label={label}
      >
        {busy ? "Committing…" : label}
      </Button>

      {identityOpen ? (
        <form
          className="mt-1 flex flex-col gap-1.5 rounded-sm border border-line bg-raised/60 p-2"
          data-testid="identity-form"
          onSubmit={(event) => {
            event.preventDefault();
            void saveIdentity();
          }}
        >
          <p className="text-[11px] text-ink-muted">
            These are written to <span className="font-mono">.git/config</span>, for this repository
            only — never to your global git config.
          </p>
          <input
            aria-label="Commit name"
            placeholder="Name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="rounded-sm border border-line bg-sunken px-2 py-1 text-xs text-ink outline-none focus:border-accent"
          />
          <input
            aria-label="Commit email"
            placeholder="Email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="rounded-sm border border-line bg-sunken px-2 py-1 text-xs text-ink outline-none focus:border-accent"
          />
          <label className="flex items-start gap-1.5 text-[11px] text-ink-muted">
            <input
              type="checkbox"
              aria-label="Write identity to this repository"
              checked={consent}
              onChange={(event) => setConsent(event.target.checked)}
              className="mt-0.5"
            />
            Write these to this repository&apos;s config
          </label>
          <div className="flex items-center justify-end gap-2">
            <Button size="sm" variant="ghost" type="button" onClick={() => setIdentityOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="secondary"
              type="submit"
              disabled={!consent || name.trim().length === 0 || email.trim().length === 0 || busy}
            >
              Save identity
            </Button>
          </div>
          <p className="text-[11px] text-ink-faint">
            Or run <span className="font-mono">git config --global user.name &quot;…&quot;</span> in
            a terminal to set it for every repository.
          </p>
        </form>
      ) : null}

      {replaceOpen ? (
        <ConfirmDialog
          open
          tone="accent"
          title="Replace the current commit message?"
          description="The generated message replaces the draft you have typed; the draft is not kept."
          confirmLabel="Replace draft"
          onConfirm={() => {
            setReplaceOpen(false);
            void runGeneration();
          }}
          onCancel={() => setReplaceOpen(false)}
        />
      ) : null}
    </div>
  );
}
