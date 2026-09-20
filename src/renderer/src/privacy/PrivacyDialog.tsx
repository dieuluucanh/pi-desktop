import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { Switch } from "../ui/switch";
import { useAppStore } from "../state/app-store";

/**
 * First-run privacy opt-in (plan step 23).
 *
 * Pi's install telemetry is an anonymous install/update ping plus provider
 * attribution headers. The app forces it **off** for every host it spawns
 * (`PI_TELEMETRY=0`) and shows this screen so turning it on is a deliberate,
 * informed choice — never a default the user has to discover and undo. The
 * choice is an app preference; it does not rewrite Pi's shared `settings.json`,
 * so terminal Pi keeps its own setting.
 */
export function PrivacyDialog() {
  const prefsLoaded = useAppStore((state) => state.prefsLoaded);
  const acknowledged = useAppStore((state) => state.prefs.privacyAcknowledged);
  const setPrefs = useAppStore((state) => state.setPrefs);
  const [share, setShare] = useState(false);

  if (!prefsLoaded || acknowledged) return null;

  const finish = (telemetryEnabled: boolean): void => {
    setPrefs({ telemetryEnabled, privacyAcknowledged: true });
  };

  return (
    <Dialog open>
      <DialogContent aria-label="Privacy" className="max-w-lg">
        <div className="flex items-start gap-3 px-4 pt-4">
          <ShieldCheck className="mt-0.5 size-5 shrink-0 text-accent" aria-hidden />
          <div className="min-w-0">
            <DialogTitle className="px-0 pt-0">Your data stays on this machine</DialogTitle>
            <DialogDescription className="px-0">
              Pi Desktop keeps your projects, sessions and credentials in your own Pi profile and
              sends no usage data of its own. Pi itself can send one anonymous install/update ping
              and a provider attribution header; this app keeps that{" "}
              <span className="font-medium text-ink">off</span> unless you opt in below.
            </DialogDescription>
          </div>
        </div>

        <label className="mx-4 mt-4 flex items-start justify-between gap-4 rounded-md border border-line bg-raised px-3 py-2.5">
          <span className="min-w-0">
            <span className="block text-sm font-medium">Share anonymous install telemetry</span>
            <span className="block text-xs text-ink-muted">
              Sent by Pi when a session starts. No prompts, files or session content are included.
              Changing this applies to sessions started from now on.
            </span>
          </span>
          <Switch
            checked={share}
            onCheckedChange={setShare}
            aria-label="Share anonymous install telemetry"
            className="mt-0.5"
          />
        </label>

        <div className="mt-4 flex items-center justify-end gap-2 border-t border-line px-4 py-3">
          <Button variant="ghost" onClick={() => finish(false)}>
            Keep telemetry off
          </Button>
          <Button variant="primary" onClick={() => finish(share)}>
            {share ? "Allow and continue" : "Continue"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
