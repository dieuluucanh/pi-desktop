/**
 * Terminal shell profiles (2026-11-05 native-terminal plan, step 2).
 *
 * Pure, platform-aware data and rules only: the filesystem probes and process
 * lookups live in `src/main/terminal-profiles.ts`, so every ordering decision
 * here is testable without a real Windows or macOS machine.
 *
 * A profile is a *suggestion*. Main validates the resolved executable before
 * forking and the renderer can never supply a shell path.
 */

export type TerminalPlatform = "win32" | "darwin" | "linux";

export type TerminalProfileKind =
  "auto" | "powershell7" | "windows-powershell" | "cmd" | "git-bash" | "wsl" | "posix" | "custom";

export interface TerminalProfile {
  id: string;
  label: string;
  kind: TerminalProfileKind;
  /** Absolute executable. `null` for `auto`, which is resolved at spawn time. */
  shellPath: string | null;
  args: string[];
  /** WSL only: the distro name (`null` means the default distro). */
  distro?: string;
  /** The platform default the profile picker preselects. */
  isDefault?: boolean;
}

/** The user's shell preferences, as detection and resolution need them. */
export interface TerminalProfilePreferences {
  /** Profile id the user chose; `auto` or missing means "the platform default". */
  defaultProfile?: string;
  /** An explicit shell path, which overrides the profile list. */
  shellPath?: string | null;
}

/** The detected profiles plus the selection and any non-fatal problems. */
export interface TerminalProfileSnapshot {
  profiles: TerminalProfile[];
  defaultProfileId: string | null;
  /** Diagnostics notes (a configured path that is missing, a failed probe, …). */
  problems: string[];
}

export const AUTO_TERMINAL_PROFILE_ID = "auto";
export const CUSTOM_TERMINAL_PROFILE_ID = "custom";
export const WSL_TERMINAL_PROFILE_ID = "wsl";

/** Windows environment variables are case-insensitive; plain objects are not. */
export function readTerminalEnvironmentValue(
  env: Record<string, string | undefined>,
  name: string,
): string | undefined {
  const exact = env[name];
  if (exact !== undefined) return exact;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === lower && value !== undefined) return value;
  }
  return undefined;
}

const readEnv = readTerminalEnvironmentValue;

function joinWindows(root: string, ...segments: string[]): string {
  const base = root.replace(/[\\/]+$/, "");
  return [base, ...segments].join("\\");
}

/** Program Files roots, most specific first, without duplicates. */
export function programFilesRoots(env: Record<string, string | undefined>): string[] {
  const localAppData = readEnv(env, "LOCALAPPDATA");
  const roots = [
    readEnv(env, "ProgramFiles"),
    readEnv(env, "ProgramFiles(x86)"),
    localAppData ? joinWindows(localAppData, "Programs") : undefined,
  ];
  return dedupePaths(roots);
}

export function dedupePaths(values: Array<string | undefined | null>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value) continue;
    const trimmed = value.trim();
    if (trimmed.length === 0) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

/** `pwsh.exe` installs: PowerShell 7 and the preview channel. */
export function powershell7Candidates(env: Record<string, string | undefined>): string[] {
  const candidates: string[] = [];
  for (const root of programFilesRoots(env)) {
    candidates.push(joinWindows(root, "PowerShell", "7", "pwsh.exe"));
    candidates.push(joinWindows(root, "PowerShell", "7-preview", "pwsh.exe"));
  }
  return dedupePaths(candidates);
}

/** Git for Windows ships `bash.exe` in both `bin/` and `usr/bin/`. */
export function gitBashCandidates(env: Record<string, string | undefined>): string[] {
  const candidates: string[] = [];
  for (const root of programFilesRoots(env)) {
    candidates.push(joinWindows(root, "Git", "bin", "bash.exe"));
    candidates.push(joinWindows(root, "Git", "usr", "bin", "bash.exe"));
  }
  return dedupePaths(candidates);
}

function windowsDirname(value: string): string {
  const normalized = value.replace(/[\\/]+$/, "");
  const index = Math.max(normalized.lastIndexOf("\\"), normalized.lastIndexOf("/"));
  return index > 0 ? normalized.slice(0, index) : "";
}

/**
 * Derives Git Bash candidates from a `git.exe` found on PATH. A per-user,
 * Chocolatey or PATH-only install often lives outside Program Files, so `where
 * git` is a better root than a static list. The caller still checks each
 * candidate with the filesystem port before adding a profile.
 */
export function gitBashCandidatesFromGitPath(gitPath: string): string[] {
  const trimmed = gitPath.trim();
  if (trimmed.length === 0) return [];
  const executableDir = windowsDirname(trimmed);
  if (executableDir.length === 0) return [];
  const gitRoot = windowsDirname(executableDir);
  if (gitRoot.length === 0) return [];
  return dedupePaths([
    joinWindows(gitRoot, "bin", "bash.exe"),
    joinWindows(gitRoot, "usr", "bin", "bash.exe"),
    /(?:^|[\\/])bash\.exe$/i.test(trimmed) ? trimmed : undefined,
  ]);
}

/** True for the two conventional Git for Windows `bash.exe` locations. */
export function isGitBashShellPath(shellPath: string): boolean {
  return /[\\/]Git[\\/](?:usr[\\/]bin|bin)[\\/]bash\.exe$/i.test(shellPath.trim());
}

/** A custom path with the launch arguments its conventional layout implies. */
export function customTerminalProfile(shellPath: string): TerminalProfile {
  const trimmed = shellPath.trim();
  const gitBash = isGitBashShellPath(trimmed);
  return {
    id: CUSTOM_TERMINAL_PROFILE_ID,
    label: "Custom shell",
    kind: gitBash ? "git-bash" : "custom",
    shellPath: trimmed,
    args: gitBash ? gitBashArgs() : [],
    isDefault: false,
  };
}

/** Windows PowerShell 5.1, which is present on every supported Windows. */
export function windowsPowerShellPath(env: Record<string, string | undefined>): string {
  const systemRoot = readEnv(env, "SystemRoot") ?? "C:\\Windows";
  return joinWindows(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

export function cmdPath(env: Record<string, string | undefined>): string {
  const comspec = readEnv(env, "COMSPEC");
  if (comspec && comspec.trim().length > 0) return comspec.trim();
  const systemRoot = readEnv(env, "SystemRoot") ?? "C:\\Windows";
  return joinWindows(systemRoot, "System32", "cmd.exe");
}

/** `$SHELL` first, then the platform's conventional login shells. */
export function posixShellCandidates(
  env: Record<string, string | undefined>,
  platform: TerminalPlatform,
): string[] {
  const fromEnv = readEnv(env, "SHELL");
  const preferred = platform === "darwin" ? "/bin/zsh" : "/bin/bash";
  return dedupePaths([fromEnv, preferred, "/bin/bash", "/bin/sh"]);
}

/**
 * A Windows project path as WSL sees it (`C:\work\app` → `/mnt/c/work/app`).
 * Returns null for a UNC path or a relative path, where there is no faithful
 * mapping: the caller starts the distro in its home directory instead.
 */
export function wslCwdFromWindowsPath(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(trimmed);
  if (drive) {
    const letter = (drive[1] ?? "").toLowerCase();
    const rest = (drive[2] ?? "").replace(/\\/g, "/").replace(/\/+/g, "/");
    const segments = rest.split("/").filter((segment) => segment.length > 0);
    const suffix = segments.length > 0 ? `/${segments.join("/")}` : "";
    return `/mnt/${letter}${suffix}`;
  }
  // Already a WSL/Linux path (e.g. a project opened through `\\wsl$`).
  return trimmed.startsWith("/") ? trimmed : null;
}

/**
 * `wsl.exe` arguments for a profile: pick the distro, then map the initial cwd
 * with `--cd` (an argv element, so spaces need no quoting). With no mapping the
 * distro opens in its home directory.
 */
export function wslLaunchArgs(profile: TerminalProfile, windowsCwd: string): string[] {
  const args: string[] = [];
  if (profile.distro) args.push("-d", profile.distro);
  const linuxCwd = wslCwdFromWindowsPath(windowsCwd);
  if (linuxCwd) args.push("--cd", linuxCwd);
  return args;
}

/** Git Bash needs a login, interactive shell to read the user's profile. */
export function gitBashArgs(): string[] {
  return ["--login", "-i"];
}

/**
 * The profile to launch: an explicit custom shell wins, then the user's chosen
 * profile id, then the platform default, then the first profile that has an
 * executable. Null means "nothing runnable", which main surfaces as an error.
 */
export function resolveTerminalProfile(
  profiles: readonly TerminalProfile[],
  options: { profileId?: string | null; shellPath?: string | null } = {},
): TerminalProfile | null {
  const shellPath = options.shellPath?.trim();
  if (shellPath && shellPath.length > 0) return customTerminalProfile(shellPath);
  const wanted = options.profileId;
  if (wanted) {
    const selected = profiles.find((profile) => profile.id === wanted);
    if (selected?.shellPath) return selected;
  }
  const byDefault = profiles.find((profile) => profile.isDefault && profile.shellPath);
  if (byDefault) return byDefault;
  return profiles.find((profile) => profile.shellPath) ?? null;
}
