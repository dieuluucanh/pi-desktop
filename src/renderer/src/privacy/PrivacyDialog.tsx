import { ShieldCheck } from "lucide-react";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { useAppStore } from "../state/app-store";

/**
 * First-run privacy notice (plan step 23).
 *
 * Pi 1.7.0 removed its install telemetry and the `PI_TELEMETRY` switch. The app
 * keeps no install-telemetry preference; this screen is the one-time local-data
 * notice and acknowledges it.
 */
export function PrivacyDialog() {
  const prefsLoaded = useAppStore((state) => state.prefsLoaded);
  const acknowledged = useAppStore((state) => state.prefs.privacyAcknowledged);
  const setPrefs = useAppStore((state) => state.setPrefs);

  if (!prefsLoaded || acknowledged) return null;

  return (
    <Dialog open>
      <DialogContent aria-label="Privacy" className="max-w-lg">
        <div className="flex items-start gap-3 px-4 pt-4">
          <ShieldCheck className="mt-0.5 size-5 shrink-0 text-accent" aria-hidden />
          <div className="min-w-0">
            <DialogTitle className="px-0 pt-0">Your data stays on this machine</DialogTitle>
            <DialogDescription className="px-0">
              Pi Desktop keeps your projects, sessions and credentials in your own Pi profile and
              sends no usage data of its own. Pi 1.7.0 removed its install telemetry, so there is no
              anonymous install/update ping to opt into.
            </DialogDescription>
          </div>
        </div>

        <div className="mt-4 flex items-center justify-end gap-2 border-t border-line px-4 py-3">
          <Button variant="primary" onClick={() => setPrefs({ privacyAcknowledged: true })}>
            Continue
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
