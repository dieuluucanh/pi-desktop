import { useState } from "react";
import { useAppStore } from "../state/app-store";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";

/**
 * Provider sign-in dialog (plan step 9, slice 3).
 *
 * Pi owns the OAuth flow; this surface only shows what Pi reported — the auth
 * URL (already opened in the system browser), a device code, or a prompt — and
 * answers the prompt through `oi.respond`. Cancel aborts the flow, so closing
 * the dialog never leaves a login running.
 *
 * The credential the flow ends with is written by Pi and is never sent here.
 */
export function ProviderLoginDialog() {
  const login = useAppStore((state) => state.providerLogin);
  const answer = useAppStore((state) => state.answerProviderLogin);
  const dismiss = useAppStore((state) => state.dismissProviderLogin);
  const [value, setValue] = useState("");

  if (!login) return null;

  const providerLabel = login.providerId;
  const prompt = login.prompt;

  const submit = (): void => {
    if (!prompt) return;
    void answer(value);
    setValue("");
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : dismiss())}>
      <DialogContent aria-label={`Sign in to ${providerLabel}`} data-testid="provider-login">
        <DialogTitle>Sign in to {providerLabel}</DialogTitle>
        <DialogDescription>
          {login.status === "running"
            ? "Finish the sign-in in your browser. The credential is stored by Pi in auth.json and is shared with terminal Pi."
            : login.status === "done"
              ? "Signed in. The provider is now available in every session."
              : (login.message ?? "The sign-in did not complete.")}
        </DialogDescription>

        <div className="flex flex-col gap-3 px-4 pb-4">
          {login.message && login.status === "running" ? (
            <p className="text-xs text-ink-muted" data-testid="provider-login-status">
              {login.message}
            </p>
          ) : null}

          {login.url ? (
            <div className="flex items-center gap-2">
              <code
                className="min-w-0 flex-1 truncate text-[11px] text-ink-faint"
                title={login.url}
              >
                {login.url}
              </code>
              <Button size="sm" onClick={() => void window.pi?.openExternal(login.url ?? "")}>
                Open link
              </Button>
            </div>
          ) : null}

          {login.deviceCode ? (
            <div className="rounded-sm border border-line px-3 py-2 text-xs">
              <div>
                Code:{" "}
                <code className="font-mono text-sm text-ink" data-testid="provider-login-code">
                  {login.deviceCode.userCode}
                </code>
              </div>
              <div className="text-ink-faint">
                Verify at{" "}
                <button
                  type="button"
                  className="underline"
                  onClick={() =>
                    void window.pi?.openExternal(login.deviceCode?.verificationUri ?? "")
                  }
                >
                  {login.deviceCode.verificationUri}
                </button>
              </div>
            </div>
          ) : null}

          {prompt ? (
            <form
              className="flex flex-col gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                submit();
              }}
            >
              <label className="text-xs text-ink-muted">{prompt.prompt.message}</label>
              {prompt.prompt.type === "select" ? (
                <div className="flex flex-col gap-1" data-testid="provider-login-select">
                  {prompt.prompt.options.map((option) => (
                    <Button
                      key={option.id}
                      size="sm"
                      type="button"
                      onClick={() => void answer(option.id)}
                    >
                      {option.label}
                      {option.description ? (
                        <span className="text-ink-faint"> — {option.description}</span>
                      ) : null}
                    </Button>
                  ))}
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <input
                    autoFocus
                    aria-label={prompt.prompt.message}
                    type={prompt.prompt.type === "secret" ? "password" : "text"}
                    value={value}
                    placeholder={prompt.prompt.placeholder ?? ""}
                    onChange={(event) => setValue(event.target.value)}
                    className="min-w-0 flex-1 rounded-sm border border-line bg-transparent px-2 py-1 text-xs text-ink outline-none"
                  />
                  <Button size="sm" variant="primary" type="submit" disabled={value.length === 0}>
                    Submit
                  </Button>
                </div>
              )}
            </form>
          ) : null}

          <div className="flex justify-end gap-2 pt-1">
            {login.status === "running" ? (
              <Button size="sm" variant="danger" onClick={dismiss}>
                Cancel
              </Button>
            ) : (
              <Button size="sm" variant="primary" onClick={dismiss}>
                Close
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
