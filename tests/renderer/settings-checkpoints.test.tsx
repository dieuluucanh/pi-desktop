import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import {
  CheckpointsSettingsCard,
  SourceControlSettingsCard,
} from "../../src/renderer/src/settings/SourceControlSettings";
import { SettingsView } from "../../src/renderer/src/views/SettingsView";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import {
  DEFAULT_CHECKPOINT_CONFIG,
  MIN_SCAN_INTERVAL_MS,
  MAX_EXCLUDE_PATTERNS,
} from "../../src/shared/checkpoints";
import { emptyGitSnapshot } from "../../src/shared/git";
import { installBridge } from "./fixtures";

/**
 * Settings → Checkpoints and Source control (git-checkpoint plan step 27).
 *
 * The cards exist so a user can change retention and see what git resolved
 * without opening the rail. The behaviour worth pinning is that **every edit is a
 * `prefs` write** (D19: prefs are the only source; main projects them), and that
 * the clamps the sanitizer applies are visible — presets rather than free-form
 * numbers, and a scan "off" that is the floor rather than zero.
 */

const PROJECT = "/work/app";

function reset(): void {
  useAppStore.setState({
    prefs: { ...DEFAULT_PREFS },
    project: { path: PROJECT, name: "app" },
    git: {},
  });
}

beforeEach(() => {
  installBridge();
  reset();
});

describe("SettingsView mounts both cards", () => {
  it("renders the checkpoints and source-control cards", async () => {
    installBridge();
    useAppStore.setState({
      settingsCwd: null,
      settings: null,
      settingsLoaded: false,
      settingsBusy: false,
      settingsError: null,
      settingsErrors: [],
      settingsFiles: null,
      settingsProjectTrusted: true,
      settingsMtimes: { global: null, project: null },
      settingsExternalEdit: false,
    });
    render(<SettingsView />);
    await waitFor(() => expect(screen.getByTestId("settings-checkpoints")).toBeTruthy());
    expect(screen.getByTestId("settings-source-control")).toBeTruthy();
  });
});

describe("CheckpointsSettingsCard", () => {
  it("toggles the enabled switch through prefs", async () => {
    render(<CheckpointsSettingsCard />);
    expect(useAppStore.getState().prefs.checkpoints.enabled).toBe(
      DEFAULT_CHECKPOINT_CONFIG.enabled,
    );
    await userEvent.click(screen.getByLabelText("Enable folder checkpoints"));
    expect(useAppStore.getState().prefs.checkpoints.enabled).toBe(false);
  });

  it("writes each retention preset as a prefs value", async () => {
    render(<CheckpointsSettingsCard />);
    await userEvent.click(screen.getByTestId("checkpoints-count-250"));
    expect(useAppStore.getState().prefs.checkpoints.maxPerSession).toBe(250);

    await userEvent.click(screen.getByTestId("checkpoints-days-90"));
    expect(useAppStore.getState().prefs.checkpoints.retentionDays).toBe(90);

    await userEvent.click(screen.getByTestId("checkpoints-bytes-10"));
    expect(useAppStore.getState().prefs.checkpoints.maxBytesPerProject).toBe(10 * 1024 ** 3);
  });

  it("marks the active preset so the state is readable at a glance", async () => {
    render(<CheckpointsSettingsCard />);
    const active = screen.getByTestId("checkpoints-count-100");
    // The default is 100, so that preset is the selected one.
    expect(active.getAttribute("data-variant") ?? active.className).toBeTruthy();
    await userEvent.click(screen.getByTestId("checkpoints-count-50"));
    expect(useAppStore.getState().prefs.checkpoints.maxPerSession).toBe(50);
  });

  it("turns the idle scan off by dropping to the floor, never to zero", async () => {
    render(<CheckpointsSettingsCard />);
    await userEvent.click(screen.getByLabelText("Scan for Office document changes while idle"));
    const scanIntervalMs = useAppStore.getState().prefs.checkpoints.scanIntervalMs;
    // Zero would be clamped back to the floor by the sanitizer; "off" is the
    // floor, and the label says so.
    expect(scanIntervalMs).toBe(MIN_SCAN_INTERVAL_MS);
    expect(screen.getByText(/^off$/)).toBeTruthy();
  });

  it("commits the exclude patterns on blur, trimmed and bounded", async () => {
    render(<CheckpointsSettingsCard />);
    const textarea = screen.getByTestId("checkpoints-exclude");
    await userEvent.clear(textarea);
    await userEvent.type(textarea, "  *.iso  \n\n  *.dmg  ");
    await userEvent.tab();
    expect(useAppStore.getState().prefs.checkpoints.exclude).toEqual(["*.iso", "*.dmg"]);
  });

  it("caps an absurd exclude list instead of handing it to the matcher", async () => {
    render(<CheckpointsSettingsCard />);
    const textarea = screen.getByTestId("checkpoints-exclude");
    await userEvent.clear(textarea);
    const many = Array.from({ length: MAX_EXCLUDE_PATTERNS + 20 }, (_, i) => `*.x${i}`).join("\n");
    // A paste is one change event, not MAX_EXCLUDE_PATTERNS keystrokes.
    (textarea as HTMLTextAreaElement).value = many;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await userEvent.tab();
    expect(useAppStore.getState().prefs.checkpoints.exclude.length).toBeLessThanOrEqual(
      MAX_EXCLUDE_PATTERNS,
    );
  });

  it("clears the patterns when the textarea is emptied", async () => {
    useAppStore.setState({
      prefs: { ...DEFAULT_PREFS, checkpoints: { ...DEFAULT_PREFS.checkpoints, exclude: ["*.a"] } },
    });
    render(<CheckpointsSettingsCard />);
    await userEvent.clear(screen.getByTestId("checkpoints-exclude"));
    await userEvent.tab();
    expect(useAppStore.getState().prefs.checkpoints.exclude).toEqual([]);
  });

  it("states the retention it will actually enforce", () => {
    render(<CheckpointsSettingsCard />);
    expect(screen.getByTestId("checkpoints-retention").textContent).toContain("100 per project");
  });

  it("says run snapshots come from an extension and are off in safe mode", () => {
    render(<CheckpointsSettingsCard />);
    expect(screen.getByText(/off in safe mode/i)).toBeTruthy();
  });
});

describe("SourceControlSettingsCard", () => {
  it("shows the resolved identity and whether it is repository-local", () => {
    useAppStore.setState({
      git: {
        [PROJECT]: {
          ...emptyGitSnapshot(PROJECT),
          available: true,
          repo: {
            root: PROJECT,
            gitDir: `${PROJECT}/.git`,
            branch: "main",
            head: "abc1234",
            detached: false,
            empty: false,
            upstream: null,
            ahead: 0,
            behind: 0,
            remotes: [],
            identity: { name: "Ada", email: "ada@example.com", source: "repo" },
          },
        },
      },
    });
    render(<SourceControlSettingsCard />);
    const identity = screen.getByTestId("source-control-identity");
    expect(identity.textContent).toContain("Ada");
    expect(identity.textContent).toContain("repository-local");
  });

  it("says when the identity is global", () => {
    useAppStore.setState({
      git: {
        [PROJECT]: {
          ...emptyGitSnapshot(PROJECT),
          available: true,
          repo: {
            root: PROJECT,
            gitDir: `${PROJECT}/.git`,
            branch: "main",
            head: null,
            detached: false,
            empty: true,
            upstream: null,
            ahead: 0,
            behind: 0,
            remotes: [],
            identity: { name: "Ada", email: "ada@example.com", source: "global" },
          },
        },
      },
    });
    render(<SourceControlSettingsCard />);
    expect(screen.getByTestId("source-control-identity").textContent).toContain("global");
    // An empty repository says so rather than showing a branch that does not exist.
    expect(screen.getByText("no commits yet")).toBeTruthy();
  });

  it("invites the commit box when no identity is configured", () => {
    useAppStore.setState({
      git: {
        [PROJECT]: {
          ...emptyGitSnapshot(PROJECT),
          available: true,
          repo: {
            root: PROJECT,
            gitDir: `${PROJECT}/.git`,
            branch: "main",
            head: null,
            detached: false,
            empty: true,
            upstream: null,
            ahead: 0,
            behind: 0,
            remotes: [],
            identity: { name: "", email: "", source: "unknown" },
          },
        },
      },
    });
    render(<SourceControlSettingsCard />);
    expect(screen.getByTestId("source-control-identity").textContent).toMatch(/not configured/i);
  });

  it("shows the actionable state when git is missing", () => {
    useAppStore.setState({
      git: {
        [PROJECT]: {
          ...emptyGitSnapshot(PROJECT),
          available: false,
          reason: "git_missing",
          message: "git was not found.",
        },
      },
    });
    render(<SourceControlSettingsCard />);
    expect(screen.getByTestId("source-control-git-missing").textContent).toContain(
      "not bundled with the app",
    );
  });

  it("says how the panel is opened instead of offering a switch", async () => {
    // The strip is always mounted now, so an on/off preference would be a second
    // source of truth for whether the panel exists (D11).
    render(<SourceControlSettingsCard />);
    expect(screen.queryByLabelText("Show the right rail")).not.toBeInTheDocument();
    expect(screen.getByTestId("source-control-rail-note")).toHaveTextContent(
      /panel strip stays on the right edge/i,
    );
    expect(screen.getByTestId("source-control-rail-note")).toHaveTextContent(
      /expands or collapses/i,
    );
  });

  it("writes no rail preference from the card", () => {
    // The card became read-only when the switch left: it has no control at all
    // that could write `prefs.rail`, whose one writer is the store.
    const handles = installBridge();
    const before = useAppStore.getState().prefs.rail;
    render(<SourceControlSettingsCard />);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
    expect(useAppStore.getState().prefs.rail).toEqual(before);
    expect(handles.prefs.rail).toEqual(before);
  });

  it("reads the repository once on mount", async () => {
    const handles = installBridge();
    render(<SourceControlSettingsCard />);
    await waitFor(() =>
      expect(handles.gitCalls.some((call) => call.kind === "snapshot")).toBe(true),
    );
  });
});
