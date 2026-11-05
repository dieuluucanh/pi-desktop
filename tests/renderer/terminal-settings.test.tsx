import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { TerminalSettingsCard } from "../../src/renderer/src/settings/TerminalSettings";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import type { TerminalProfileSnapshot } from "../../src/shared/terminal-profiles";
import { installBridge, type BridgeHandles } from "./fixtures";

const GIT_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";
const WINDOWS_POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

const PROFILES: TerminalProfileSnapshot = {
  profiles: [
    {
      id: "windows-powershell",
      label: "Windows PowerShell",
      kind: "windows-powershell",
      shellPath: WINDOWS_POWERSHELL,
      args: [],
      isDefault: true,
    },
    {
      id: "git-bash",
      label: "Git Bash",
      kind: "git-bash",
      shellPath: GIT_BASH,
      args: ["--login", "-i"],
    },
  ],
  defaultProfileId: "windows-powershell",
  problems: [],
};

let handles: BridgeHandles;

beforeEach(() => {
  handles = installBridge({ terminalProfiles: PROFILES });
  useAppStore.setState({
    prefs: { ...DEFAULT_PREFS, terminal: { ...DEFAULT_PREFS.terminal } },
    info: null,
  });
});

describe("TerminalSettingsCard", () => {
  it("lists detected shells and saves a new default profile", async () => {
    render(<TerminalSettingsCard />);

    const select = await screen.findByLabelText("Default terminal profile");
    await screen.findByRole("option", { name: "Git Bash" });
    await userEvent.selectOptions(select, "git-bash");

    await waitFor(() =>
      expect(useAppStore.getState().prefs.terminal.defaultProfile).toBe("git-bash"),
    );
    expect(handles.prefs.terminal.defaultProfile).toBe("git-bash");
  });

  it("saves a custom absolute shell path and rejects a relative one", async () => {
    render(<TerminalSettingsCard />);
    const select = await screen.findByLabelText("Default terminal profile");
    await userEvent.selectOptions(select, "custom");

    const input = screen.getByLabelText("Custom shell executable");
    await userEvent.type(input, "bash.exe");
    await userEvent.click(screen.getByRole("button", { name: "Use this path" }));
    expect(screen.getByText("Enter an absolute path to a shell executable.")).toBeInTheDocument();
    expect(useAppStore.getState().prefs.terminal.shellPath).toBeNull();

    await userEvent.clear(input);
    await userEvent.type(input, GIT_BASH);
    await userEvent.click(screen.getByRole("button", { name: "Use this path" }));
    await waitFor(() => expect(useAppStore.getState().prefs.terminal.shellPath).toBe(GIT_BASH));
  });

  it("persists font size, cursor, scrollback and switches", async () => {
    render(<TerminalSettingsCard />);
    const fontSize = screen.getByLabelText("Terminal font size");
    fireEvent.change(fontSize, { target: { value: "18" } });
    fireEvent.blur(fontSize);
    await waitFor(() => expect(useAppStore.getState().prefs.terminal.fontSize).toBe(18));

    const scrollback = screen.getByLabelText("Terminal scrollback lines");
    fireEvent.change(scrollback, { target: { value: "20000" } });
    fireEvent.blur(scrollback);
    await waitFor(() => expect(useAppStore.getState().prefs.terminal.scrollback).toBe(20_000));

    await userEvent.click(screen.getByLabelText("Copy terminal selection automatically"));
    await waitFor(() => expect(useAppStore.getState().prefs.terminal.copyOnSelection).toBe(true));
    await userEvent.click(screen.getByLabelText("Flash the terminal on BEL"));
    await waitFor(() => expect(useAppStore.getState().prefs.terminal.enableBell).toBe(true));
    expect(screen.getByTestId("terminal-font-preview")).toHaveStyle({ fontSize: "18px" });
  });

  it("accepts a valid custom font family and rejects CSS structural characters", async () => {
    render(<TerminalSettingsCard />);
    const input = screen.getByLabelText("Terminal font family");

    fireEvent.change(input, { target: { value: "Consolas; } body { color: red" } });
    fireEvent.blur(input);
    expect(screen.getByText(/without braces or semicolons/)).toBeInTheDocument();
    expect(useAppStore.getState().prefs.terminal.fontFamily).toBeNull();

    await userEvent.clear(input);
    await userEvent.type(input, "Consolas, monospace");
    fireEvent.blur(input);
    await waitFor(() =>
      expect(useAppStore.getState().prefs.terminal.fontFamily).toBe("Consolas, monospace"),
    );
  });
});
