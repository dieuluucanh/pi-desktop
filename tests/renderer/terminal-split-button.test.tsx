import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { TerminalSplitButton } from "../../src/renderer/src/layout/TerminalSplitButton";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import type { TerminalProfileSnapshot } from "../../src/shared/terminal-profiles";
import { installBridge } from "./fixtures";

const PROFILES: TerminalProfileSnapshot = {
  profiles: [
    {
      id: "git-bash",
      label: "Git Bash",
      kind: "git-bash",
      shellPath: "C:\\Program Files\\Git\\bin\\bash.exe",
      args: ["--login", "-i"],
      isDefault: true,
    },
  ],
  defaultProfileId: "git-bash",
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

describe("TerminalSplitButton", () => {
  it("keeps the default and profile actions in one labelled group", () => {
    render(<TerminalSplitButton />);

    const group = screen.getByRole("group", { name: "Terminal actions" });
    expect(group).toContainElement(screen.getByRole("button", { name: "New terminal" }));
    expect(group).toContainElement(screen.getByRole("button", { name: "Terminal profiles" }));
  });

  it("creates a default-shell terminal from the main segment", async () => {
    const handles = installBridge({ terminalProfiles: PROFILES });
    render(<TerminalSplitButton />);

    await userEvent.click(screen.getByRole("button", { name: "New terminal" }));

    await waitFor(() => expect(handles.sessionCreateCalls[0]).toMatchObject({ kind: "terminal" }));
    expect(handles.sessionCreateCalls[0]).not.toHaveProperty("profileId");
  });

  it("keeps the chevron as a separate, accessible trigger", () => {
    render(<TerminalSplitButton />);

    const trigger = screen.getByTestId("terminal-profile-menu");
    expect(trigger).toHaveAttribute("aria-label", "Terminal profiles");
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
  });
});
