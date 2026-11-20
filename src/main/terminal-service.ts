/**
 * Terminal service (2026-11-05 native-terminal plan, step 7).
 *
 * The Electron-free policy layer between the IPC surface and one `TerminalHost`
 * per window. It owns the tab→terminal mapping, the trust gate, profile
 * resolution, the initial cwd and the shell environment. The renderer names a
 * tab; it never supplies a shell path, an argv or an environment.
 *
 * Lifecycle rules:
 * - `create` is idempotent per tab (reattach, never a second shell);
 * - a tab that disappears from the table closes its PTY (`syncTabs`);
 * - a host crash fails every mapped terminal and clears the map, so the next
 *   `create` starts a fresh host instead of silently respawning shells.
 */

import {
  MAX_TERMINALS_PER_WINDOW,
  isTerminalSize,
  type TerminalAttachResult,
  type TerminalErrorCode,
  type TerminalEventFrame,
  type TerminalHostInfo,
  type TerminalInfo,
  type TerminalMethod,
  type TerminalSpawnSpec,
} from "../shared/terminal-protocol";
import type { TerminalCreateInput, TerminalCreateOutcome } from "../shared/terminal-ipc";
import {
  resolveTerminalProfile,
  wslLaunchArgs,
  type TerminalProfile,
  type TerminalProfilePreferences,
  type TerminalProfileSnapshot,
} from "../shared/terminal-profiles";
import type { TabRecord } from "../shared/session-ipc";
import { TerminalHostRpcError, type TerminalHostDiagnostics } from "./terminal-host";
import { stripAppImageLibraryPaths } from "./runtime/child-env";

/** The supervisor surface the service needs; tests provide a fake. */
export interface TerminalHostLike {
  request<T>(method: TerminalMethod, params?: unknown): Promise<T>;
  dispose(): Promise<void>;
  /** Optional so a minimal test double does not need to model the supervisor. */
  diagnostics?(): TerminalHostDiagnostics;
}

/** What the Diagnostics view and a failed create can say about one window. */
export interface TerminalServiceDiagnostics {
  host: TerminalHostDiagnostics | null;
  /** The last `terminal.info` report, when the host answered one. */
  info: TerminalHostInfo | null;
  logFile: string | null;
}

export interface TerminalServiceOptions {
  host: TerminalHostLike;
  /** Current tab table; a terminal tab's `cwd` is always a project folder. */
  tabs: () => readonly Pick<TabRecord, "id" | "kind" | "cwd" | "lastCwd" | "profileId">[];
  /** The trust store main already uses for sessions. */
  isProjectTrusted: (cwd: string) => boolean | Promise<boolean>;
  /** Current terminal preferences (profile id and optional custom shell path). */
  preferences: () => TerminalProfilePreferences;
  /** Probes the platform; the service caches by preference key. */
  detectProfiles: (preferences: TerminalProfilePreferences) => Promise<TerminalProfileSnapshot>;
  /** True for an existing directory; used to fall back from a stale `lastCwd`. */
  isDirectory: (path: string) => Promise<boolean>;
  emit: (frame: TerminalEventFrame) => void;
  env?: Record<string, string | undefined>;
  platform?: string;
  profileDir: string;
  termProgramVersion?: string;
  /** `<profile>/logs/terminal.log`, shown in an error's details. */
  logFile?: string;
  log?: (line: string) => void;
}

export class TerminalServiceError extends Error {
  readonly code: TerminalErrorCode;

  constructor(message: string, code: TerminalErrorCode) {
    super(message);
    this.name = "TerminalServiceError";
    this.code = code;
  }
}

interface LiveTerminal {
  tabId: string;
  info: TerminalInfo;
}

const XTERM_NAME = "xterm-256color";

export class TerminalService {
  private readonly byTab = new Map<string, string>();
  private readonly byId = new Map<string, LiveTerminal>();
  private profileCache: { key: string; value: Promise<TerminalProfileSnapshot> } | null = null;
  private hostInfo: TerminalHostInfo | null = null;

  constructor(private readonly options: TerminalServiceOptions) {}

  /** Creates the terminal for a tab, or reattaches to the live one. */
  async create(input: TerminalCreateInput): Promise<TerminalCreateOutcome> {
    if (!isTerminalSize(input.cols, input.rows)) {
      return { kind: "error", code: "bad_request", message: "invalid terminal size" };
    }
    const tab = this.options.tabs().find((entry) => entry.id === input.tabId);
    if (!tab || tab.kind !== "terminal") {
      return { kind: "error", code: "not_found", message: "unknown terminal tab" };
    }

    const existing = this.byTab.get(tab.id);
    if (existing) {
      const live = this.byId.get(existing);
      const replay = await this.options.host.request<TerminalAttachResult | null>(
        "terminal.attach",
        { terminalId: existing },
      );
      if (live && replay) return { kind: "ok", terminal: live.info, replay };
      // The host forgot it (a crash between calls): fall through and re-create.
      this.byTab.delete(tab.id);
      this.byId.delete(existing);
    }

    const trust = await this.trustOutcome(tab, input);
    if (trust) return trust;

    if (this.byTab.size >= MAX_TERMINALS_PER_WINDOW) {
      return {
        kind: "error",
        code: "limit",
        message: `the terminal limit (${MAX_TERMINALS_PER_WINDOW}) has been reached`,
      };
    }

    const preferences = this.options.preferences();
    const snapshot = await this.profiles();
    if (snapshot.profiles.length === 0) {
      return {
        kind: "unavailable",
        message: "No terminal shell was found on this system.",
        profiles: [],
      };
    }
    const profile = resolveTerminalProfile(snapshot.profiles, {
      profileId: input.profileId ?? tab.profileId ?? preferences.defaultProfile,
      shellPath: preferences.shellPath,
    });
    if (!profile?.shellPath) {
      return {
        kind: "unavailable",
        message: "The selected shell profile is not available.",
        profiles: snapshot.profiles,
      };
    }

    const spec = await this.spawnSpec(tab, profile, input.cols, input.rows);
    // Ask the host what it is before forking anything: a native-module failure
    // is answered here (the host stays alive), and its per-candidate errors are
    // what the failure details need.
    const info = await this.probeHostInfo();
    try {
      const terminal = await this.options.host.request<TerminalInfo>("terminal.open", { spec });
      const replay = await this.options.host.request<TerminalAttachResult | null>(
        "terminal.attach",
        { terminalId: terminal.id },
      );
      this.byTab.set(tab.id, terminal.id);
      this.byId.set(terminal.id, { tabId: tab.id, info: terminal });
      return {
        kind: "ok",
        terminal,
        replay: replay ?? { data: "", bytes: 0, seq: 0 },
      };
    } catch (error) {
      return this.failure(error, "the shell could not be started", info);
    }
  }

  async attach(terminalId: string): Promise<TerminalAttachResult | null> {
    if (!this.byId.has(terminalId)) return null;
    return this.options.host.request<TerminalAttachResult | null>("terminal.attach", {
      terminalId,
    });
  }

  async write(terminalId: string, data: string): Promise<void> {
    this.require(terminalId);
    try {
      await this.options.host.request("terminal.write", { terminalId, data });
    } catch (error) {
      throw this.toServiceError(error);
    }
  }

  async resize(terminalId: string, cols: number, rows: number): Promise<void> {
    this.require(terminalId);
    if (!isTerminalSize(cols, rows)) {
      throw new TerminalServiceError("invalid terminal size", "bad_request");
    }
    try {
      await this.options.host.request("terminal.resize", { terminalId, cols, rows });
    } catch (error) {
      throw this.toServiceError(error);
    }
  }

  /** Fire-and-forget credit: a terminal that closed meanwhile is not an error. */
  ack(terminalId: string, bytes: number): void {
    if (!this.byId.has(terminalId) || !Number.isFinite(bytes) || bytes <= 0) return;
    void this.options.host
      .request("terminal.ack", { terminalId, bytes })
      .catch((error: unknown) => this.options.log?.(`terminal ack failed: ${String(error)}`));
  }

  async close(terminalId: string): Promise<boolean> {
    const live = this.byId.get(terminalId);
    if (!live) return false;
    this.forget(terminalId);
    try {
      const result = await this.options.host.request<{ closed?: boolean }>("terminal.close", {
        terminalId,
        force: true,
      });
      return result?.closed === true;
    } catch (error) {
      this.options.log?.(`terminal close failed: ${String(error)}`);
      return false;
    }
  }

  /** Live terminals whose tab still exists, in creation order. */
  list(): TerminalInfo[] {
    this.syncTabs();
    return [...this.byId.values()].map((live) => live.info);
  }

  /** Closes PTYs whose tab disappeared (close, close-others, close-project…). */
  syncTabs(): void {
    const liveTabs = new Set(
      this.options
        .tabs()
        .filter((tab) => tab.kind === "terminal")
        .map((tab) => tab.id),
    );
    for (const [tabId, terminalId] of [...this.byTab]) {
      if (liveTabs.has(tabId)) continue;
      this.forget(terminalId);
      void this.options.host
        .request("terminal.close", { terminalId, force: true })
        .catch(() => undefined);
    }
  }

  /** The host died: fail every mapped terminal and let the next create restart it. */
  handleHostExit(): void {
    this.hostInfo = null;
    for (const live of this.byId.values()) {
      this.options.emit({
        event: "terminal.error",
        payload: {
          terminalId: live.info.id,
          code: "closed",
          message: "the terminal host exited",
        },
      });
    }
    this.byTab.clear();
    this.byId.clear();
  }

  async profiles(force = false): Promise<TerminalProfileSnapshot> {
    const preferences = this.options.preferences();
    const key = `${preferences.defaultProfile ?? ""}|${preferences.shellPath ?? ""}`;
    if (force || !this.profileCache || this.profileCache.key !== key) {
      this.profileCache = {
        key,
        value: this.options.detectProfiles(preferences).catch((error: unknown) => {
          this.profileCache = null;
          throw error;
        }),
      };
    }
    return this.profileCache.value;
  }

  async dispose(): Promise<void> {
    this.byTab.clear();
    this.byId.clear();
    this.profileCache = null;
    this.hostInfo = null;
    await this.options.host.dispose();
  }

  /** One window's terminal backend, for the Diagnostics view. */
  diagnostics(): TerminalServiceDiagnostics {
    return {
      host: this.options.host.diagnostics?.() ?? null,
      info: this.hostInfo,
      logFile: this.options.logFile ?? null,
    };
  }

  /** `terminal.info`, cached per host; a probe failure is not fatal. */
  private async probeHostInfo(): Promise<TerminalHostInfo | null> {
    if (this.hostInfo) return this.hostInfo;
    try {
      this.hostInfo = await this.options.host.request<TerminalHostInfo>("terminal.info");
      return this.hostInfo;
    } catch (error) {
      this.options.log?.(`terminal info probe failed: ${String(error)}`);
      return null;
    }
  }

  private async trustOutcome(
    tab: Pick<TabRecord, "cwd">,
    input: TerminalCreateInput,
  ): Promise<TerminalCreateOutcome | null> {
    if (await this.options.isProjectTrusted(tab.cwd)) return null;
    if (input.trust === "never") {
      return {
        kind: "error",
        code: "closed",
        message: "this project is marked as never trusted",
      };
    }
    if (input.trust === "session" || input.trust === "trust") return null;
    return { kind: "needs-trust", cwd: tab.cwd };
  }

  private async spawnSpec(
    tab: Pick<TabRecord, "id" | "cwd" | "lastCwd">,
    profile: TerminalProfile,
    cols: number,
    rows: number,
  ): Promise<TerminalSpawnSpec> {
    if (!profile.shellPath) {
      throw new TerminalServiceError("the profile has no shell path", "spawn_failed");
    }
    const initial = tab.lastCwd ?? tab.cwd;
    const cwd = (await this.options.isDirectory(initial)) ? initial : tab.cwd;
    // WSL starts in a Windows directory and maps the project through `--cd`;
    // every other profile starts directly in the project folder.
    const isWsl = profile.kind === "wsl";
    return {
      cwd: isWsl ? tab.cwd : cwd,
      shell: profile.shellPath,
      args: [...profile.args, ...(isWsl ? wslLaunchArgs(profile, cwd) : [])],
      env: this.shellEnv(profile),
      cols,
      rows,
      name: XTERM_NAME,
    };
  }

  /** The shell environment: the app's, plus the terminal conventions. */
  shellEnv(profile: TerminalProfile): Record<string, string> {
    const platform = this.options.platform ?? process.platform;
    const base = this.options.env ?? process.env;
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(base)) {
      if (typeof value === "string" && value.length > 0) env[key] = value;
    }
    delete env.ELECTRON_RUN_AS_NODE;
    env.TERM = XTERM_NAME;
    env.COLORTERM = "truecolor";
    env.TERM_PROGRAM = "PiDesktop";
    if (this.options.termProgramVersion) env.TERM_PROGRAM_VERSION = this.options.termProgramVersion;
    env.PI_CODING_AGENT_DIR = this.options.profileDir;
    env.PI_DESKTOP = "1";
    if (platform !== "win32" && !env.LANG) env.LANG = "en_US.UTF-8";
    // Git Bash otherwise cds to $HOME before running the user's profile.
    if (profile.kind === "git-bash") env.CHERE_INVOKING = "1";
    // The AppImage's AppRun points LD_LIBRARY_PATH at its own mount; a shell
    // must not inherit that (2026-11-08 linux-terminal plan, step 9).
    return stripAppImageLibraryPaths(env);
  }

  private require(terminalId: string): LiveTerminal {
    const live = this.byId.get(terminalId);
    if (!live) throw new TerminalServiceError("terminal not found", "not_found");
    return live;
  }

  private forget(terminalId: string): void {
    const live = this.byId.get(terminalId);
    this.byId.delete(terminalId);
    if (live) this.byTab.delete(live.tabId);
  }

  private toServiceError(error: unknown): TerminalServiceError {
    if (error instanceof TerminalServiceError) return error;
    if (error instanceof TerminalHostRpcError)
      return new TerminalServiceError(error.message, error.code);
    return new TerminalServiceError(
      error instanceof Error ? error.message : String(error),
      "spawn_failed",
    );
  }

  private failure(
    error: unknown,
    fallback: string,
    info: TerminalHostInfo | null = null,
  ): TerminalCreateOutcome {
    const serviceError = this.toServiceError(error);
    const message =
      serviceError.code === "native_unavailable"
        ? `The terminal backend could not start: ${serviceError.message}`
        : serviceError.message || fallback;
    const details = this.failureDetails(info);
    return {
      kind: "error",
      code: serviceError.code,
      message,
      ...(details ? { details } : {}),
    };
  }

  /**
   * The report behind the banner's Details disclosure: what the host told us
   * about the native module, what the supervisor saw, and where the log lives.
   * This is what turns "the terminal host exited (1)" into `GLIBC_2.42`.
   */
  private failureDetails(info: TerminalHostInfo | null): string | undefined {
    const host = this.options.host.diagnostics?.() ?? null;
    const lines: string[] = [];
    if (info) {
      lines.push(
        `platform: ${info.platform} ${info.arch} · node ${info.node} · terminal protocol ${info.protocol}`,
      );
      if (info.pty.loaded) {
        lines.push(`node-pty: loaded${info.pty.path ? ` (${info.pty.path})` : ""}`);
      } else {
        lines.push(`node-pty: not loaded${info.pty.error ? ` — ${info.pty.error}` : ""}`);
        for (const candidate of info.pty.candidates) {
          if (candidate.error) lines.push(`  ${candidate.path}: ${candidate.error}`);
        }
      }
    }
    if (host) {
      const exit = host.lastExit
        ? ` · last exit ${host.lastExit.code}${host.lastExit.signal ? ` (${host.lastExit.signal})` : ""}`
        : "";
      lines.push(`host: ${host.running ? "running" : "stopped"}${exit}`);
      if (host.lastError) lines.push(`last error: ${host.lastError}`);
      if (host.stderrTail.trim().length > 0) lines.push(`stderr:\n${host.stderrTail.trim()}`);
    }
    if (this.options.logFile) lines.push(`log: ${this.options.logFile}`);
    return lines.length > 0 ? lines.join("\n") : undefined;
  }
}

export function createTerminalService(options: TerminalServiceOptions): TerminalService {
  return new TerminalService(options);
}
