import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { TerminalProfileMenu } from "../../src/renderer/src/layout/TerminalProfileMenu";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import type { TerminalProfileSnapshot } from "../../src/shared/terminal-profiles";
import { installBridge } from "./fixtures";

const PROFILES: TerminalProfileSnapshot = {
  profiles: [
    {
      id: "windows-powershell",
      label: "Windows PowerShell",
      kind: "windows-powershell",
      shellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      args: [],
      isDefault: true,
    },
    {
      id: "git-bash",
      label: "Git Bash",
      kind: "git-bash",
      shellPath: "C:\\Program Files\\Git\\bin\\bash.exe",
      args: ["--login", "-i"],
    },
  ],
  defaultProfileId: "windows-powershell",
  problems: [],
};

beforeEach(() => {
  installBridge({ terminalProfiles: PROFILES });
  useAppStore.setState({
    view: "session",
    project: { path: "C:/work/app", name: "app" },
    prefs: { ...DEFAULT_PREFS },
    hint: null,
  });
});

describe("TerminalProfileMenu", () => {
  it("opens a one-off terminal with the chosen detected profile", async () => {
    const handles = installBridge({ terminalProfiles: PROFILES });
    render(<TerminalProfileMenu />);

    await userEvent.click(screen.getByRole("button", { name: "Terminal profiles" }));
    expect(
      await screen.findByRole("menuitem", { name: "Select default profile…" }),
    ).toBeInTheDocument();
    await userEvent.click(await screen.findByRole("menuitem", { name: "Git Bash" }));

    await waitFor(() =>
      expect(handles.sessionCreateCalls[0]).toMatchObject({
        kind: "terminal",
        profileId: "git-bash",
      }),
    );
  });

  it("routes the configure action at the Terminal settings card", () => {
    useAppStore.getState().openTerminalSettings();
    expect(useAppStore.getState().view).toBe("settings");
    expect(useAppStore.getState().settingsFocus).toBe("terminal");
  });
});
