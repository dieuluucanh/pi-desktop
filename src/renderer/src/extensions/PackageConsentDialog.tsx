import { ShieldAlert } from "lucide-react";
import { useAppStore } from "../state/app-store";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";

/**
 * The package install/update consent dialog (plan step 14).
 *
 * Installing a package runs third-party code with the user's full system access,
 * so nothing is installed until the user confirms. The dialog shows the exact
 * normalised source; confirming echoes it back and the host refuses anything
 * that does not match.
 */
export function PackageConsentDialog() {
  const consent = useAppStore((state) => state.packageConsent);
  const busy = useAppStore((state) => state.packagesBusy);
  const confirm = useAppStore((state) => state.confirmPackageConsent);
  const cancel = useAppStore((state) => state.cancelPackageConsent);

  if (!consent) return null;
  const updating = consent.kind === "update";

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) cancel();
      }}
    >
      <DialogContent
        aria-label="Package consent"
        className="max-w-lg"
        data-testid="package-consent"
      >
        <div className="flex items-start gap-3 px-4 pt-4">
          <ShieldAlert className="mt-0.5 size-5 shrink-0 text-warn" aria-hidden />
          <div className="min-w-0">
            <DialogTitle className="px-0 pt-0">
              {updating ? "Update packages?" : "Install this package?"}
            </DialogTitle>
            <DialogDescription className="px-0">
              Packages can ship extensions, skills and tools. They run with the same{" "}
              <strong className="text-ink">full system access</strong> as your own commands — they
              can read and write your files and run programs.
            </DialogDescription>
          </div>
        </div>

        <div className="mx-4 mt-3 flex flex-col gap-1 rounded-sm border border-line bg-raised px-3 py-2">
          <span className="flex items-center gap-1.5">
            <span className="text-[11px] uppercase tracking-wide text-ink-faint">Source</span>
            <Badge tone={consent.scope === "project" ? "accent" : "neutral"}>{consent.scope}</Badge>
          </span>
          <code className="break-all font-mono text-xs text-ink" data-testid="consent-source">
            {consent.source}
          </code>
        </div>

        <div className="mt-4 flex items-center justify-end gap-2 border-t border-line px-4 py-3">
          <Button variant="ghost" disabled={busy} onClick={cancel}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy}
            data-testid="consent-confirm"
            onClick={() => void confirm()}
          >
            {updating ? "Update" : "Install"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
