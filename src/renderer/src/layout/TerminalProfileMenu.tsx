/**
 * One-off terminal profiles for the strip (2026-11-05 terminal follow-up plan).
 *
 * The New Terminal button itself opens the default shell; this chevron is the
 * VSCode-style escape hatch for opening a terminal with another detected shell
 * without changing the default. Detection is loaded on first open, never at
 * import time, and the menu always has an explicit loading/empty state.
 */

import { Check, ChevronDown } from "lucide-react";

import { useTerminalProfiles } from "../terminal/use-terminal-profiles";
import { useAppStore } from "../state/app-store";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";

export function TerminalProfileMenu(): React.JSX.Element {
  const prefs = useAppStore((state) => state.prefs.terminal);
  const createSessionTab = useAppStore((state) => state.createSessionTab);
  const openTerminalSettings = useAppStore((state) => state.openTerminalSettings);
  const { snapshot, loading, error, refresh } = useTerminalProfiles(false);

  const profiles = (snapshot?.profiles ?? []).filter((profile) => profile.id !== "custom");
  const resolvedDefault =
    prefs.defaultProfile === "auto" ? snapshot?.defaultProfileId : prefs.defaultProfile;

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open && !snapshot && !loading) void refresh(false);
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Terminal profiles"
          title="New terminal with a profile"
          data-testid="terminal-profile-menu"
        >
          <ChevronDown className="size-3.5" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuLabel>New terminal with</DropdownMenuLabel>
        {loading ? (
          <DropdownMenuItem disabled>Detecting shells…</DropdownMenuItem>
        ) : profiles.length === 0 ? (
          <DropdownMenuItem disabled>No shells detected</DropdownMenuItem>
        ) : (
          profiles.map((profile) => (
            <DropdownMenuItem
              key={profile.id}
              data-testid={`terminal-profile-${profile.id}`}
              onSelect={() => void createSessionTab("terminal", { profileId: profile.id })}
            >
              <span className="min-w-0 flex-1 truncate">{profile.label}</span>
              {profile.id === resolvedDefault ? (
                <Check className="size-3.5 shrink-0 text-accent" aria-hidden />
              ) : null}
            </DropdownMenuItem>
          ))
        )}
        {error ? <p className="px-2 py-1 text-xs text-danger">{error}</p> : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void refresh(true)} disabled={loading}>
          Refresh shells
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={openTerminalSettings}>Select default profile…</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
