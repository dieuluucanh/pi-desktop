/**
 * The commit box (git-checkpoint plan step 12).
 *
 * A message, an amend switch, the account the commit will be attributed to, and
 * one button. The three rules that keep it honest:
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

import { useState } from "react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { useAppStore } from "../state/app-store";
import { commitReadiness, identitySummary, messageCount, primaryActionLabel } from "./commit-view";

export interface CommitBoxProps {
  /** The folder the rail is showing. */
  projectPath: string;
}

export function CommitBox({ projectPath }: CommitBoxProps) {
  const snapshot = useAppStore((state) => state.git[projectPath]);
  const performGitAction = useAppStore((state) => state.performGitAction);
  const loadHeadCommitMessage = useAppStore((state) => state.loadHeadCommitMessage);

  const [message, setMessage] = useState("");
  const [amend, setAmend] = useState(false);
  const [busy, setBusy] = useState(false);
  const [identityOpen, setIdentityOpen] = useState(false);
  const [consent, setConsent] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");

  // Nothing to commit from a folder git cannot serve.
  if (!snapshot?.available) return null;

  const identity = snapshot.repo?.identity ?? null;
  const readiness = commitReadiness(snapshot, message, identity);
  const count = messageCount(message);
  const label = primaryActionLabel(snapshot, amend);
  const summary = identity ? identitySummary(identity) : null;

  const submit = async (): Promise<void> => {
    if (busy || !readiness.canCommit) return;
    setBusy(true);
    try {
      // The label promised to stage first when nothing was staged yet.
      if (snapshot.staged.length === 0 && snapshot.changed.length > 0) {
        const staged = await performGitAction(projectPath, {
          kind: "stage",
          paths: snapshot.changed.map((file) => file.path),
        });
        // Null means the write is waiting for consent: stop here rather than
        // committing a half-applied intention.
        if (staged === null || !staged.ok) return;
      }
      const result = await performGitAction(projectPath, { kind: "commit", message, amend });
      if (result?.ok) {
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
    if (!next) return;
    const head = await loadHeadCommitMessage(projectPath);
    if (head !== null) setMessage(head);
  };

  const saveIdentity = async (): Promise<void> => {
    if (!consent || busy) return;
    setBusy(true);
    try {
      const result = await performGitAction(projectPath, {
        kind: "set-identity",
        name: name.trim(),
        email: email.trim(),
      });
      if (result?.ok) {
        setIdentityOpen(false);
        setConsent(false);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5 px-3 pt-2" data-testid="commit-box">
      <textarea
        aria-label="Commit message"
        placeholder="Commit message"
        rows={3}
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
        className="w-full resize-y rounded-sm border border-line bg-sunken px-2 py-1 text-xs text-ink outline-none focus:border-accent"
      />

      <div className="flex items-center gap-2 text-[11px] text-ink-faint">
        <span data-testid="commit-counter" className={count.over ? "text-danger" : undefined}>
          {count.text}
        </span>
        <label className="ml-auto flex items-center gap-1">
          <Switch
            checked={amend}
            onCheckedChange={(next) => void onAmendChange(next)}
            aria-label="Amend last commit"
          />
          Amend
        </label>
      </div>

      {summary ? (
        <div
          className="flex items-center gap-1 text-[11px] text-ink-faint"
          data-testid="commit-identity"
        >
          <span className="min-w-0 flex-1 truncate" title={summary.label}>
            {summary.label}
          </span>
          <Badge tone={summary.local ? "accent" : "neutral"}>{summary.sourceLabel}</Badge>
          <button
            type="button"
            className="text-ink-faint underline hover:text-ink"
            onClick={() => setIdentityOpen((open) => !open)}
          >
            Change
          </button>
        </div>
      ) : null}

      {readiness.reason ? (
        <p className="text-[11px] text-warn" data-testid="commit-reason">
          {readiness.reason}
          {!identity && !identityOpen ? (
            <>
              {" "}
              <button
                type="button"
                className="underline hover:text-ink"
                onClick={() => setIdentityOpen(true)}
              >
                Set identity
              </button>
            </>
          ) : null}
        </p>
      ) : null}

      <Button
        size="sm"
        variant="primary"
        disabled={!readiness.canCommit || busy || count.over}
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
    </div>
  );
}
