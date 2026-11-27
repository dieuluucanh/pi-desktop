import { describe, expect, it } from "vitest";
import { createMemoryFsPort } from "../../src/main/fs-port";
import { createFakeCommandRunner } from "../../src/main/office/exec";
import {
  createTerminalProfileDetector,
  decodeWslDistroList,
  detectTerminalProfiles,
  type TerminalProfileInput,
} from "../../src/main/terminal-profiles";

const WINDOWS_ENV = {
  ProgramFiles: "C:\\Program Files",
  "ProgramFiles(x86)": "C:\\Program Files (x86)",
  LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
  SystemRoot: "C:\\Windows",
  COMSPEC: "C:\\Windows\\System32\\cmd.exe",
};

const PWSH = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
const WINDOWS_POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const CMD = "C:\\Windows\\System32\\cmd.exe";
const GIT_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";
const WSL = "C:\\Windows\\System32\\wsl.exe";

/** `wsl.exe -l -q` as a UTF-8 decoder sees UTF-16LE ASCII. */
function utf16AsUtf8(names: readonly string[]): string {
  return names.map((name) => `${[...name].join("\0")}\0\r\n`).join("");
}

function windowsInput(
  overrides: Partial<TerminalProfileInput> & {
    files?: readonly string[];
    wsl?: { stdout?: string; code?: number; missing?: boolean };
    where?: string | null;
    git?: string | null;
  } = {},
) {
  const files = overrides.files ?? [PWSH, WINDOWS_POWERSHELL, CMD, GIT_BASH, WSL];
  const fs = createMemoryFsPort({
    files: Object.fromEntries(files.map((path) => [path, ""])),
  });
  const runner = createFakeCommandRunner([
    {
      command: "where.exe",
      args: ["pwsh.exe"],
      ...(overrides.where ? { stdout: `${overrides.where}\r\n` } : { code: 1, missing: true }),
    },
    {
      command: "where.exe",
      args: ["git.exe"],
      ...(overrides.git ? { stdout: `${overrides.git}\r\n` } : { code: 1, missing: true }),
    },
    {
      command: "wsl.exe",
      args: ["-l", "-q"],
      stdout: overrides.wsl?.stdout ?? utf16AsUtf8(["Ubuntu", "Debian"]),
      code: overrides.wsl?.code ?? 0,
      missing: overrides.wsl?.missing ?? false,
    },
  ]);
  return {
    input: {
      platform: "win32" as const,
      env: WINDOWS_ENV,
      fs,
      runner,
      ...overrides,
      // Keep the concrete ports last so `overrides` cannot drop them by accident.
      ...(overrides.fs ? {} : { fs }),
      ...(overrides.runner ? {} : { runner }),
    } satisfies TerminalProfileInput,
    runner,
  };
}

describe("Windows profile detection", () => {
  it("lists PowerShell 7, Windows PowerShell, cmd, Git Bash and WSL distros", async () => {
    const { input } = windowsInput({ where: PWSH });
    const snapshot = await detectTerminalProfiles(input);

    expect(snapshot.profiles.map((profile) => profile.id)).toEqual([
      "powershell7",
      "windows-powershell",
      "cmd",
      "git-bash",
      "wsl-ubuntu",
      "wsl-debian",
    ]);
    expect(snapshot.profiles[0]?.shellPath).toBe(PWSH);
    expect(snapshot.profiles.find((profile) => profile.id === "git-bash")?.args).toEqual([
      "--login",
      "-i",
    ]);
    expect(snapshot.profiles.find((profile) => profile.id === "wsl-ubuntu")).toMatchObject({
      shellPath: WSL,
      distro: "Ubuntu",
      label: "WSL: Ubuntu",
    });
    expect(snapshot.defaultProfileId).toBe("powershell7");
    expect(snapshot.profiles.find((profile) => profile.id === "powershell7")?.isDefault).toBe(true);
    expect(snapshot.problems).toEqual([]);
  });

  it("finds Git Bash from where.exe git when it is installed outside Program Files", async () => {
    const gitDir = "D:\\Tools\\Git";
    const customGit = `${gitDir}\\bin\\bash.exe`;
    const { input } = windowsInput({
      where: null,
      git: `${gitDir}\\cmd\\git.exe`,
      files: [CMD, customGit],
      wsl: { missing: true },
    });
    const snapshot = await detectTerminalProfiles(input);

    expect(snapshot.profiles.find((profile) => profile.id === "git-bash")).toMatchObject({
      shellPath: customGit,
      args: ["--login", "-i"],
    });
    expect(snapshot.profiles.filter((profile) => profile.id === "git-bash")).toHaveLength(1);
  });

  it("prefers a pwsh.exe found on PATH over the Program Files copy", async () => {
    const onPath = "D:\\Tools\\pwsh.exe";
    const { input } = windowsInput({ where: onPath, files: [onPath, PWSH, CMD] });
    const snapshot = await detectTerminalProfiles(input);
    expect(snapshot.profiles[0]).toMatchObject({ id: "powershell7", shellPath: onPath });
    expect(snapshot.profiles.filter((profile) => profile.kind === "powershell7")).toHaveLength(1);
  });

  it("falls back to Program Files when `where` names a path that is not a file", async () => {
    const { input } = windowsInput({ where: "D:\\Ghost\\pwsh.exe", files: [PWSH, CMD] });
    const snapshot = await detectTerminalProfiles(input);
    expect(snapshot.profiles[0]).toMatchObject({ id: "powershell7", shellPath: PWSH });
  });

  it("drops shells that are not installed", async () => {
    const { input } = windowsInput({ files: [CMD], where: null, wsl: { missing: true } });
    const snapshot = await detectTerminalProfiles(input);
    expect(snapshot.profiles.map((profile) => profile.id)).toEqual(["cmd"]);
    expect(snapshot.defaultProfileId).toBe("cmd");
  });

  it("records a WSL listing failure but still returns the other shells", async () => {
    const { input } = windowsInput({
      files: [CMD, WSL],
      where: null,
      wsl: { code: 1, stdout: "" },
    });
    const snapshot = await detectTerminalProfiles(input);
    expect(snapshot.profiles.map((profile) => profile.id)).toEqual(["cmd"]);
    expect(snapshot.problems.join(" ")).toContain("wsl.exe -l -q failed");
  });

  it("does not probe WSL when wsl.exe is absent", async () => {
    const { input, runner } = windowsInput({ files: [CMD], where: null });
    const snapshot = await detectTerminalProfiles(input);
    expect(snapshot.profiles.map((profile) => profile.id)).toEqual(["cmd"]);
    expect(runner.calls.some((call) => call.command === "wsl.exe")).toBe(false);
  });

  it("filters the legacy WSL header and notices", async () => {
    const stdout = [
      "Windows Subsystem for Linux Distributions:\r\n",
      ...["Ubuntu\r\n", "Debian\r\n"],
      "\r\n",
      "wsl: A localhost proxy configuration was detected.\r\n",
    ]
      .map((entry) => `${[...entry].join("\0")}\0`)
      .join("");
    const { input } = windowsInput({ where: null, wsl: { stdout } });
    const snapshot = await detectTerminalProfiles(input);
    expect(snapshot.profiles.map((profile) => profile.id)).toEqual([
      "powershell7",
      "windows-powershell",
      "cmd",
      "git-bash",
      "wsl-ubuntu",
      "wsl-debian",
    ]);
  });
});

describe("POSIX profile detection", () => {
  function posixInput(
    files: readonly string[],
    env: Record<string, string | undefined>,
    platform: "darwin" | "linux" = "linux",
  ) {
    return {
      platform,
      env,
      fs: createMemoryFsPort({ files: Object.fromEntries(files.map((path) => [path, ""])) }),
      runner: createFakeCommandRunner([]),
    } satisfies TerminalProfileInput;
  }

  it("prefers $SHELL and keeps the platform fallbacks that exist", async () => {
    const snapshot = await detectTerminalProfiles(
      posixInput(["/usr/bin/fish", "/bin/bash"], { SHELL: "/usr/bin/fish" }, "darwin"),
    );
    expect(snapshot.profiles.map((profile) => profile.id)).toEqual(["posix-fish", "posix-bash"]);
    expect(snapshot.profiles[0]?.label).toBe("fish");
    expect(snapshot.defaultProfileId).toBe("posix-fish");
  });

  it("returns an empty list and no default when nothing is installed", async () => {
    const snapshot = await detectTerminalProfiles(posixInput([], {}));
    expect(snapshot.profiles).toEqual([]);
    expect(snapshot.defaultProfileId).toBeNull();
  });

  it("uses /bin/zsh as the macOS fallback", async () => {
    const snapshot = await detectTerminalProfiles(posixInput(["/bin/zsh"], {}, "darwin"));
    expect(snapshot.profiles.map((profile) => profile.id)).toEqual(["posix-zsh"]);
  });
});

describe("profile preferences", () => {
  it("marks the chosen profile as the default", async () => {
    const { input } = windowsInput({
      where: PWSH,
      preferences: { defaultProfile: "cmd" },
    });
    const snapshot = await detectTerminalProfiles(input);
    expect(snapshot.defaultProfileId).toBe("cmd");
    expect(
      snapshot.profiles.filter((profile) => profile.isDefault).map((profile) => profile.id),
    ).toEqual(["cmd"]);
  });

  it("reports an unavailable chosen profile and falls back to the first", async () => {
    const { input } = windowsInput({
      where: PWSH,
      preferences: { defaultProfile: "nope" },
    });
    const snapshot = await detectTerminalProfiles(input);
    expect(snapshot.defaultProfileId).toBe("powershell7");
    expect(snapshot.problems.join(" ")).toContain('"nope" is not available');
  });

  it("lets a valid custom shell path win and puts it first", async () => {
    const custom = "D:\\Shells\\nu.exe";
    const { input } = windowsInput({
      where: PWSH,
      files: [PWSH, CMD, custom],
      preferences: { shellPath: custom, defaultProfile: "cmd" },
    });
    const snapshot = await detectTerminalProfiles(input);
    expect(snapshot.profiles[0]).toMatchObject({ id: "custom", shellPath: custom });
    expect(snapshot.defaultProfileId).toBe("custom");
  });

  it("reports a custom shell path that does not exist", async () => {
    const { input } = windowsInput({
      where: PWSH,
      preferences: { shellPath: "D:\\Nope\\shell.exe" },
    });
    const snapshot = await detectTerminalProfiles(input);
    expect(snapshot.profiles.some((profile) => profile.id === "custom")).toBe(false);
    expect(snapshot.problems.join(" ")).toContain("does not exist");
  });
});

describe("createTerminalProfileDetector", () => {
  it("caches the probe until a forced refresh", async () => {
    const { input, runner } = windowsInput({ where: PWSH });
    const detector = createTerminalProfileDetector(input);

    await detector.list();
    await detector.list();
    // One pwsh.exe probe and one git.exe probe per detection.
    expect(runner.calls.filter((call) => call.command === "where.exe")).toHaveLength(2);

    await detector.list(true);
    expect(runner.calls.filter((call) => call.command === "where.exe")).toHaveLength(4);
  });

  it("does not cache a rejection", async () => {
    const fs = createMemoryFsPort();
    const input: TerminalProfileInput = {
      platform: "linux",
      env: {},
      fs: {
        ...fs,
        pathKind: async () => {
          throw new Error("boom");
        },
      },
      runner: createFakeCommandRunner([]),
    };
    const detector = createTerminalProfileDetector(input);
    await expect(detector.list()).rejects.toThrow("boom");
    await expect(detector.list()).rejects.toThrow("boom");
  });
});

describe("decodeWslDistroList", () => {
  it("strips NULs, CRs, the header and notices", () => {
    expect(
      decodeWslDistroList(
        "Windows Subsystem for Linux Distributions:\0\r\nU\0b\0u\0n\0t\0u\0\r\n\r\nUbuntu-24.04\r\n",
      ),
    ).toEqual(["Ubuntu", "Ubuntu-24.04"]);
  });

  it("returns an empty list for an empty stream", () => {
    expect(decodeWslDistroList("")).toEqual([]);
  });
});
