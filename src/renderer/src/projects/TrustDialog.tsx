import { ShieldAlert, ShieldCheck, ShieldX } from "lucide-react";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { useAppStore } from "../state/app-store";

/**
 * The project trust prompt (plan step 10).
 *
 * A project can ship resources that run with the user's full privileges
 * (`<cwd>/.pi/settings.json`, extensions, skills, prompts, themes, packages), so
 * the app asks before loading them. The four answers mirror `TrustAnswer`: trust
 * once (this run), trust and remember, never, and ignore (leave it untrusted but
 * keep the session failed rather than deciding now).
 */

export function TrustDialog() {
  const prompt = useAppStore((state) => state.trustPrompt);
  const busy = useAppStore((state) => state.trustBusy);
  const answerTrust = useAppStore((state) => state.answerTrust);
  const dismissTrust = useAppStore((state) => state.dismissTrust);
  const inspection = useAppStore((state) =>
    prompt ? state.projectInspections[prompt.cwd] : undefined,
  );

  if (!prompt) return null;
  const resources = inspection?.resources;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) dismissTrust();
      }}
    >
      <DialogContent aria-label="Project trust" className="max-w-lg">
        <div className="flex items-start gap-3 px-4 pt-4">
          <ShieldAlert className="mt-0.5 size-5 shrink-0 text-warn" aria-hidden />
          <div className="min-w-0">
            <DialogTitle className="px-0 pt-0">Trust this project?</DialogTitle>
            <DialogDescription className="px-0">
              <span className="font-mono">{prompt.cwd}</span> ships project-level Pi resources. They
              run with the same full system access as your own commands, exactly as they do in
              terminal Pi.
            </DialogDescription>
          </div>
        </div>

        {resources ? (
          <ul className="mx-4 mt-3 flex flex-wrap gap-1.5 text-[11px] text-ink-muted">
            {resources.settings ? <Chip>.pi/settings.json</Chip> : null}
            {resources.extensions ? <Chip>.pi/extensions</Chip> : null}
            {resources.skills ? <Chip>.pi/skills</Chip> : null}
            {resources.prompts ? <Chip>.pi/prompts</Chip> : null}
            {resources.themes ? <Chip>.pi/themes</Chip> : null}
            {resources.packages ? <Chip>.pi/npm</Chip> : null}
            {resources.agentsMd ? <Chip>AGENTS.md</Chip> : null}
          </ul>
        ) : null}

        <div className="mt-4 flex flex-wrap items-center justify-end gap-2 border-t border-line px-4 py-3">
          <Button variant="ghost" disabled={busy} onClick={dismissTrust}>
            Ignore
          </Button>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => void answerTrust("never")}
            title="Project resources stay disabled"
          >
            <ShieldX className="size-4" aria-hidden />
            Never
          </Button>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => void answerTrust("session")}
            title="Trusted until the app closes; nothing is written"
          >
            <ShieldCheck className="size-4" aria-hidden />
            Trust once
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void answerTrust("trust")}>
            <ShieldCheck className="size-4" aria-hidden />
            Trust &amp; remember
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <li className="rounded-sm border border-line bg-raised px-1.5 py-0.5 font-mono">{children}</li>
  );
}
