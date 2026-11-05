/**
 * Terminal shell detection in main (2026-11-05 native-terminal plan, step 6).
 *
 * All OS probing goes through the injected `FsPort` and `CommandRunner`, so the
 * Windows-only rules (PowerShell 7, Git Bash, WSL distros) are testable on any
 * host. The renderer never calls this: it selects a profile id, and main
 * resolves the executable again right before spawning.
 *
 * WSL's `wsl.exe -l -q` output is UTF-16LE. `CommandRunner` decodes UTF-8, which
 * for ASCII names leaves `char` + NUL pairs; stripping the NULs recovers the
 * list. A non-ASCII distro name would be mangled, so it is reported as a
 * problem rather than silently producing a profile that cannot start.
 */

import type { FsPort } from "./fs-port";
import type { CommandRunner } from "./office/exec";
import {
  cmdPath,
  customTerminalProfile,
  dedupePaths,
  gitBashArgs,
  gitBashCandidates,
  gitBashCandidatesFromGitPath,
  posixShellCandidates,
  powershell7Candidates,
  readTerminalEnvironmentValue,
  windowsPowerShellPath,
  type TerminalPlatform,
  type TerminalProfile,
  type TerminalProfilePreferences,
  type TerminalProfileSnapshot,
} from "../shared/terminal-profiles";

export type { TerminalProfilePreferences, TerminalProfileSnapshot };

export interface TerminalProfileInput {
  platform: TerminalPlatform;
  env: Record<string, string | undefined>;
  fs: FsPort;
  runner: CommandRunner;
  preferences?: TerminalProfilePreferences;
}

function firstLine(text: string): string | null {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? null
  );
}

function slug(value: string): string {
  const slugged = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slugged.length > 0 ? slugged : "profile";
}

function shellName(path: string): string {
  const parts = path.split(/[\\/]/);
  return (parts[parts.length - 1] ?? "shell").replace(/\.exe$/i, "");
}

/**
 * Decodes `wsl.exe -l -q`. Accepts the NUL-interleaved UTF-8 view of a UTF-16LE
 * stream, drops the legacy header and any line that is a warning/notice.
 */
export function decodeWslDistroList(stdout: string): string[] {
  return stdout
    .replace(/\0/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        !line.startsWith("Windows Subsystem for Linux") &&
        // A distro name cannot contain a colon; the header and `wsl: …` notices do.
        !line.includes(":") &&
        !line.includes("\uFFFD"),
    );
}

async function detectWindows(
  input: TerminalProfileInput,
  add: (profile: TerminalProfile) => Promise<boolean>,
  problems: string[],
): Promise<void> {
  const { env, fs, runner } = input;

  const where = await runner.run("where.exe", ["pwsh.exe"], { timeoutMs: 3000 });
  const pwshFromPath = where.code === 0 && !where.missing ? firstLine(where.stdout) : null;
  let sawPwsh = false;
  if (pwshFromPath) {
    sawPwsh = await add({
      id: "powershell7",
      label: "PowerShell 7",
      kind: "powershell7",
      shellPath: pwshFromPath,
      args: [],
    });
  }
  if (!sawPwsh) {
    for (const candidate of powershell7Candidates(env)) {
      const added = await add({
        id: "powershell7",
        label: "PowerShell 7",
        kind: "powershell7",
        shellPath: candidate,
        args: [],
      });
      if (added) break;
    }
  }

  await add({
    id: "windows-powershell",
    label: "Windows PowerShell",
    kind: "windows-powershell",
    shellPath: windowsPowerShellPath(env),
    args: [],
  });
  await add({
    id: "cmd",
    label: "Command Prompt",
    kind: "cmd",
    shellPath: cmdPath(env),
    args: [],
  });

  const gitWhere = await runner.run("where.exe", ["git.exe"], { timeoutMs: 3000 });
  const gitFromPath = gitWhere.code === 0 && !gitWhere.missing ? firstLine(gitWhere.stdout) : null;
  const gitCandidates = dedupePaths([
    ...(gitFromPath ? gitBashCandidatesFromGitPath(gitFromPath) : []),
    ...gitBashCandidates(env),
  ]);
  for (const candidate of gitCandidates) {
    const added = await add({
      id: "git-bash",
      label: "Git Bash",
      kind: "git-bash",
      shellPath: candidate,
      args: gitBashArgs(),
    });
    if (added) break;
  }

  const systemRoot = readTerminalEnvironmentValue(env, "SystemRoot") ?? "C:\\Windows";
  const wslPath = `${systemRoot.replace(/[\\/]+$/, "")}\\System32\\wsl.exe`;
  const wslInstalled = (await fs.pathKind(wslPath)) === "file";
  if (!wslInstalled) return;

  const listing = await runner.run("wsl.exe", ["-l", "-q"], { timeoutMs: 4000 });
  if (listing.missing) return;
  if (listing.code !== 0) {
    problems.push(`wsl.exe -l -q failed: ${firstLine(listing.stderr) ?? `code ${listing.code}`}`);
    return;
  }
  const distros = decodeWslDistroList(listing.stdout);
  if (distros.length === 0 && listing.stdout.trim().length > 0) {
    problems.push("no WSL distributions could be decoded from wsl.exe -l -q");
  }
  for (const distro of distros) {
    await add({
      id: `wsl-${slug(distro)}`,
      label: `WSL: ${distro}`,
      kind: "wsl",
      shellPath: wslPath,
      args: [],
      distro,
    });
  }
}

async function detectPosix(
  input: TerminalProfileInput,
  add: (profile: TerminalProfile) => Promise<boolean>,
): Promise<void> {
  for (const candidate of posixShellCandidates(input.env, input.platform)) {
    const name = shellName(candidate);
    await add({
      id: `posix-${slug(name)}`,
      label: name,
      kind: "posix",
      shellPath: candidate,
      args: [],
    });
  }
}

/** Probes the platform once and returns the launchable profiles. */
export async function detectTerminalProfiles(
  input: TerminalProfileInput,
): Promise<TerminalProfileSnapshot> {
  const problems: string[] = [];
  const profiles: TerminalProfile[] = [];
  const seen = new Set<string>();

  const add = async (profile: TerminalProfile): Promise<boolean> => {
    if (!profile.shellPath) return false;
    if ((await input.fs.pathKind(profile.shellPath)) !== "file") return false;
    const key = `${profile.kind}:${profile.shellPath.toLowerCase()}:${profile.distro ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    profiles.push(profile);
    return true;
  };

  if (input.platform === "win32") await detectWindows(input, add, problems);
  else await detectPosix(input, add);

  const customPath = input.preferences?.shellPath?.trim();
  if (customPath && customPath.length > 0) {
    if ((await input.fs.pathKind(customPath)) === "file") {
      profiles.unshift(customTerminalProfile(customPath));
    } else {
      problems.push(`the configured terminal shell does not exist: ${customPath}`);
    }
  }

  const wanted = input.preferences?.defaultProfile;
  let defaultProfileId: string | null = null;
  if (profiles[0]?.id === "custom") {
    // A custom path is the user's explicit override; it wins over an id.
    defaultProfileId = "custom";
  } else if (wanted && wanted !== "auto") {
    const match = profiles.find((profile) => profile.id === wanted);
    if (match) defaultProfileId = match.id;
    else problems.push(`configured terminal profile "${wanted}" is not available`);
  }
  defaultProfileId ??= profiles.find((profile) => profile.shellPath !== null)?.id ?? null;
  for (const profile of profiles) profile.isDefault = profile.id === defaultProfileId;

  return { profiles, defaultProfileId, problems };
}

/**
 * Memoised detector. Detection spawns `where.exe`/`wsl.exe`, so the service asks
 * once per app run; `list(true)` is the explicit refresh (after installing a
 * shell, or a settings change).
 */
export function createTerminalProfileDetector(input: TerminalProfileInput): {
  list(force?: boolean): Promise<TerminalProfileSnapshot>;
} {
  let cached: Promise<TerminalProfileSnapshot> | null = null;
  return {
    list(force = false) {
      if (force || cached === null) {
        cached = detectTerminalProfiles(input).catch((error: unknown) => {
          cached = null;
          throw error;
        });
      }
      return cached;
    },
  };
}
