import { describe, expect, it } from "vitest";
import {
  cmdPath,
  customTerminalProfile,
  dedupePaths,
  gitBashArgs,
  gitBashCandidates,
  gitBashCandidatesFromGitPath,
  isGitBashShellPath,
  posixShellCandidates,
  powershell7Candidates,
  programFilesRoots,
  resolveTerminalProfile,
  windowsPowerShellPath,
  wslCwdFromWindowsPath,
  wslLaunchArgs,
  type TerminalProfile,
} from "../../src/shared/terminal-profiles";

const WINDOWS_ENV = {
  ProgramFiles: "C:\\Program Files",
  "ProgramFiles(x86)": "C:\\Program Files (x86)",
  LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
  SystemRoot: "C:\\Windows",
  COMSPEC: "C:\\Windows\\System32\\cmd.exe",
};

describe("Windows shell candidates", () => {
  it("reads environment names case-insensitively", () => {
    expect(programFilesRoots({ PROGRAMFILES: "D:\\Apps" })).toEqual(["D:\\Apps"]);
    expect(programFilesRoots({ programfiles: "D:\\Apps" })).toEqual(["D:\\Apps"]);
  });

  it("orders Program Files, Program Files (x86), then the user's Programs", () => {
    expect(programFilesRoots(WINDOWS_ENV)).toEqual([
      "C:\\Program Files",
      "C:\\Program Files (x86)",
      "C:\\Users\\me\\AppData\\Local\\Programs",
    ]);
    expect(programFilesRoots({})).toEqual([]);
  });

  it("lists PowerShell 7 in both install roots, stable and preview first", () => {
    const candidates = powershell7Candidates({
      ProgramFiles: "C:\\Program Files",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
    });
    expect(candidates).toEqual([
      "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      "C:\\Program Files\\PowerShell\\7-preview\\pwsh.exe",
      "C:\\Program Files (x86)\\PowerShell\\7\\pwsh.exe",
      "C:\\Program Files (x86)\\PowerShell\\7-preview\\pwsh.exe",
    ]);
  });

  it("finds Git Bash in both Git layouts under each Program Files root", () => {
    expect(gitBashCandidates(WINDOWS_ENV)).toEqual([
      "C:\\Program Files\\Git\\bin\\bash.exe",
      "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
      "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
      "C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe",
      "C:\\Users\\me\\AppData\\Local\\Programs\\Git\\bin\\bash.exe",
      "C:\\Users\\me\\AppData\\Local\\Programs\\Git\\usr\\bin\\bash.exe",
    ]);
  });

  it("derives the Git Bash candidates from a where.exe git path", () => {
    expect(gitBashCandidatesFromGitPath("C:\\Tools\\Git\\cmd\\git.exe")).toEqual([
      "C:\\Tools\\Git\\bin\\bash.exe",
      "C:\\Tools\\Git\\usr\\bin\\bash.exe",
    ]);
    expect(gitBashCandidatesFromGitPath("C:\\Tools\\Git\\bin\\git.exe")).toEqual([
      "C:\\Tools\\Git\\bin\\bash.exe",
      "C:\\Tools\\Git\\usr\\bin\\bash.exe",
    ]);
    expect(gitBashCandidatesFromGitPath("git.exe")).toEqual([]);
  });

  it("resolves Windows PowerShell and cmd from the environment", () => {
    expect(windowsPowerShellPath(WINDOWS_ENV)).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(windowsPowerShellPath({})).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(cmdPath(WINDOWS_ENV)).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(cmdPath({})).toBe("C:\\Windows\\System32\\cmd.exe");
  });

  it("trims a COMSPEC with trailing whitespace", () => {
    expect(cmdPath({ COMSPEC: "  C:\\Windows\\System32\\cmd.exe  " })).toBe(
      "C:\\Windows\\System32\\cmd.exe",
    );
    expect(cmdPath({ COMSPEC: "   " })).toBe("C:\\Windows\\System32\\cmd.exe");
  });
});

describe("POSIX shell candidates", () => {
  it("prefers $SHELL, then the platform default, then the fallbacks", () => {
    expect(posixShellCandidates({ SHELL: "/usr/bin/fish" }, "linux")).toEqual([
      "/usr/bin/fish",
      "/bin/bash",
      "/bin/sh",
    ]);
    expect(posixShellCandidates({}, "darwin")).toEqual(["/bin/zsh", "/bin/bash", "/bin/sh"]);
  });

  it("dedupes and trims", () => {
    expect(dedupePaths([" /bin/bash ", "/bin/bash", "", undefined, "/bin/sh", "/BIN/SH"])).toEqual([
      "/bin/bash",
      "/bin/sh",
    ]);
  });
});

describe("WSL", () => {
  it("maps a drive path and preserves spaces", () => {
    expect(wslCwdFromWindowsPath("C:\\work\\app")).toBe("/mnt/c/work/app");
    expect(wslCwdFromWindowsPath("D:/work/app")).toBe("/mnt/d/work/app");
    expect(wslCwdFromWindowsPath("C:\\work\\my app\\src")).toBe("/mnt/c/work/my app/src");
    expect(wslCwdFromWindowsPath("C:\\")).toBe("/mnt/c");
  });

  it("returns null for UNC and relative paths, and passes a POSIX path through", () => {
    expect(wslCwdFromWindowsPath("\\\\server\\share\\x")).toBeNull();
    expect(wslCwdFromWindowsPath("work\\app")).toBeNull();
    expect(wslCwdFromWindowsPath("")).toBeNull();
    expect(wslCwdFromWindowsPath("/home/me/app")).toBe("/home/me/app");
  });

  it("builds wsl.exe arguments with the distro and the mapped cwd", () => {
    const profile: TerminalProfile = {
      id: "wsl-ubuntu",
      label: "Ubuntu",
      kind: "wsl",
      shellPath: "C:\\Windows\\System32\\wsl.exe",
      args: [],
      distro: "Ubuntu-24.04",
    };
    expect(wslLaunchArgs(profile, "C:\\work\\app")).toEqual([
      "-d",
      "Ubuntu-24.04",
      "--cd",
      "/mnt/c/work/app",
    ]);
    expect(wslLaunchArgs({ ...profile, distro: undefined }, "C:\\work\\app")).toEqual([
      "--cd",
      "/mnt/c/work/app",
    ]);
    expect(wslLaunchArgs(profile, "\\\\server\\share")).toEqual(["-d", "Ubuntu-24.04"]);
  });
});

describe("Git Bash", () => {
  it("launches an interactive login shell", () => {
    expect(gitBashArgs()).toEqual(["--login", "-i"]);
  });

  it("recognises both conventional Git Bash paths and infers their arguments", () => {
    expect(isGitBashShellPath("C:\\Program Files\\Git\\bin\\bash.exe")).toBe(true);
    expect(isGitBashShellPath("C:\\Program Files\\Git\\usr\\bin\\bash.exe")).toBe(true);
    expect(isGitBashShellPath("/bin/bash")).toBe(false);

    expect(customTerminalProfile("C:\\Program Files\\Git\\bin\\bash.exe")).toEqual({
      id: "custom",
      label: "Custom shell",
      kind: "git-bash",
      shellPath: "C:\\Program Files\\Git\\bin\\bash.exe",
      args: ["--login", "-i"],
      isDefault: false,
    });
    expect(customTerminalProfile("D:\\Shells\\nu.exe")).toMatchObject({
      kind: "custom",
      args: [],
    });
  });
});

describe("resolveTerminalProfile", () => {
  const profiles: TerminalProfile[] = [
    {
      id: "auto",
      label: "PowerShell 7",
      kind: "powershell7",
      shellPath: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      args: [],
      isDefault: true,
    },
    {
      id: "windows-powershell",
      label: "Windows PowerShell",
      kind: "windows-powershell",
      shellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      args: [],
    },
    { id: "broken", label: "Missing", kind: "posix", shellPath: null, args: [] },
  ];

  it("lets an explicit shell path win", () => {
    expect(resolveTerminalProfile(profiles, { shellPath: "/bin/fish", profileId: "auto" })).toEqual(
      {
        id: "custom",
        label: "Custom shell",
        kind: "custom",
        shellPath: "/bin/fish",
        args: [],
        isDefault: false,
      },
    );
  });

  it("keeps Git Bash login arguments for a custom path", () => {
    expect(
      resolveTerminalProfile(profiles, {
        shellPath: "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
      }),
    ).toMatchObject({ kind: "git-bash", args: ["--login", "-i"] });
  });

  it("uses the selected profile, then the default, then the first runnable", () => {
    expect(resolveTerminalProfile(profiles, { profileId: "windows-powershell" })?.id).toBe(
      "windows-powershell",
    );
    expect(resolveTerminalProfile(profiles)?.id).toBe("auto");
    expect(resolveTerminalProfile(profiles, { profileId: "missing" })?.id).toBe("auto");
    expect(
      resolveTerminalProfile(
        [{ id: "broken", label: "Missing", kind: "posix", shellPath: null, args: [] }],
        { profileId: "broken" },
      ),
    ).toBeNull();
  });

  it("ignores a blank shell path and a blank profile id", () => {
    expect(resolveTerminalProfile(profiles, { shellPath: "   " })?.id).toBe("auto");
    expect(resolveTerminalProfile(profiles, { profileId: "" })?.id).toBe("auto");
  });
});
