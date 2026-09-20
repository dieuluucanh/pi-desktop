import { ShieldAlert, ShieldCheck } from "lucide-react";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";

/**
 * "What extensions can do" (plan step 23).
 *
 * The app's other trust boundaries are structural (a sandboxed renderer, a web
 * tab with no preload, path-guarded file handlers), but an extension is ordinary
 * Node code running with the user's privileges — that is Pi's model, and
 * pretending otherwise would be the dangerous kind of documentation. This page
 * states it plainly and lists the gates the app *does* put in front of loading
 * or installing third-party code.
 */

export interface ExtensionCapabilitiesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ExtensionCapabilitiesDialog({
  open,
  onOpenChange,
}: ExtensionCapabilitiesDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-label="What extensions can do" className="max-w-xl">
        <div className="flex items-start gap-3 px-4 pt-4">
          <ShieldAlert className="mt-0.5 size-5 shrink-0 text-warn" aria-hidden />
          <div className="min-w-0">
            <DialogTitle className="px-0 pt-0">What extensions can do</DialogTitle>
            <DialogDescription className="px-0">
              Extensions and packages are Node.js programs. Pi loads them into the same host process
              as your session, so they run with <strong>your full privileges</strong> — the same
              access your own shell has. Pi Desktop does not sandbox them.
            </DialogDescription>
          </div>
        </div>

        <div className="mx-4 mt-3 grid gap-3 text-xs sm:grid-cols-2">
          <section className="rounded-md border border-line bg-raised p-3">
            <h3 className="mb-1 font-semibold text-ink">An installed extension can</h3>
            <ul className="list-disc space-y-1 pl-4 text-ink-muted">
              <li>read and write any file you can, anywhere on disk</li>
              <li>run commands and spawn processes</li>
              <li>make network requests, including with your credentials</li>
              <li>register tools, commands, shortcuts and UI that the agent can call</li>
              <li>change what a session sends to your model provider</li>
            </ul>
          </section>
          <section className="rounded-md border border-line bg-raised p-3">
            <h3 className="mb-1 font-semibold text-ink">What the app gates for you</h3>
            <ul className="list-disc space-y-1 pl-4 text-ink-muted">
              <li>
                a <strong>project trust prompt</strong> before a project&rsquo;s own extensions,
                skills or packages load
              </li>
              <li>
                an <strong>install consent dialog</strong> naming the exact source before anything
                is installed
              </li>
              <li>
                <strong>safe mode</strong> (<code className="font-mono">--safe-mode</code>), which
                loads no third-party code at all
              </li>
              <li>
                the app&rsquo;s own window is sandboxed and its file access is path-guarded — but an
                extension is not
              </li>
            </ul>
          </section>
        </div>

        <div className="mx-4 mt-3 flex items-start gap-2 rounded-md border border-line p-3 text-xs text-ink-muted">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
          <p>
            Install only from sources you trust, and read a project&rsquo;s{" "}
            <code className="font-mono">.pi/</code> folder before you trust it. If something breaks,
            restart with <code className="font-mono">--safe-mode</code> and disable the extension
            here.
          </p>
        </div>

        <div className="mt-4 flex items-center justify-end border-t border-line px-4 py-3">
          <Button variant="primary" onClick={() => onOpenChange(false)}>
            Got it
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
