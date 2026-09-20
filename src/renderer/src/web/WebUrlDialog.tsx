import { useState } from "react";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { useAppStore } from "../state/app-store";
import { isLoopbackUrl, sanitizeWebUrl } from "../../../shared/web-tabs";

/**
 * The manual "Open URL in a tab…" action (plan step 21) — the escape hatch when
 * no extension notified a URL, or when the user wants an arbitrary localhost UI.
 */
export function WebUrlDialog() {
  const open = useAppStore((store) => store.webUrlDialogOpen);
  const close = useAppStore((store) => store.closeWebUrlDialog);
  const openWebTab = useAppStore((store) => store.openWebTab);
  const setHint = useAppStore((store) => store.setHint);
  const [value, setValue] = useState("");

  if (!open) return null;

  const submit = (): void => {
    const url = sanitizeWebUrl(value.trim());
    if (!url) {
      setHint("Enter an http:// or https:// URL.");
      return;
    }
    setValue("");
    close();
    void openWebTab({ url });
  };

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : close())}>
      <DialogContent aria-describedby={undefined} className="w-[min(480px,92vw)]">
        <DialogTitle>Open URL in a tab</DialogTitle>
        <DialogDescription>
          Load a localhost UI or any page inside the app. {""}
          <span className="text-ink-muted">
            A loopback page opens directly; anything else may ask before it leaves the page.
          </span>
        </DialogDescription>
        <form
          className="flex flex-col gap-3 px-4 pb-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <input
            aria-label="URL"
            autoFocus
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="http://127.0.0.1:19432/review"
            spellCheck={false}
            className="rounded-sm border border-line bg-raised px-2 py-1.5 font-mono text-xs text-ink outline-none"
          />
          {value.trim().length > 0 && !isLoopbackUrl(value.trim()) ? (
            <p className="text-[11px] text-ink-faint">
              That is not a loopback address; it will still open in a tab.
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" variant="primary">
              Open
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
