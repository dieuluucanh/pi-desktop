import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EditorSettingsCard } from "../../src/renderer/src/settings/EditorSettings";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import { installBridge, type BridgeHandles } from "./fixtures";

let handles: BridgeHandles;

beforeEach(() => {
  const editor = {
    ...DEFAULT_PREFS.editor,
    fontSize: 16,
    wordWrap: "always" as const,
    width: "compact" as const,
    widthColumns: 140,
  };
  handles = installBridge({ prefs: { editor } });
  useAppStore.setState({
    prefs: { ...DEFAULT_PREFS, editor: { ...editor } },
    info: null,
  });
});

describe("EditorSettingsCard", () => {
  it("renders every persisted editor default", () => {
    render(<EditorSettingsCard />);

    expect(screen.getByTestId("settings-editor")).toBeInTheDocument();
    expect(screen.getByLabelText("Editor font size")).toHaveValue(16);
    expect(screen.getByLabelText("Default word wrap")).toHaveValue("always");
    expect(screen.getByLabelText("Default editor width")).toHaveValue("compact");
    expect(screen.getByLabelText("Reading column width")).toHaveValue(140);
    expect(screen.getByText(/never shows a horizontal scrollbar/)).toBeInTheDocument();
  });

  it("writes font size, wrap, width and column through prefs.set", async () => {
    const set = vi.spyOn(window.pi.prefs, "set");
    render(<EditorSettingsCard />);

    const fontSize = screen.getByLabelText("Editor font size");
    fireEvent.change(fontSize, { target: { value: "18" } });
    fireEvent.blur(fontSize);
    await waitFor(() =>
      expect(set).toHaveBeenCalledWith({
        editor: expect.objectContaining({ fontSize: 18 }),
      }),
    );

    await userEvent.selectOptions(screen.getByLabelText("Default word wrap"), "never");
    await waitFor(() =>
      expect(set).toHaveBeenCalledWith({
        editor: expect.objectContaining({ wordWrap: "never" }),
      }),
    );

    await userEvent.selectOptions(screen.getByLabelText("Default editor width"), "full");
    await waitFor(() =>
      expect(set).toHaveBeenCalledWith({
        editor: expect.objectContaining({ width: "full" }),
      }),
    );

    const columns = screen.getByLabelText("Reading column width");
    fireEvent.change(columns, { target: { value: "150" } });
    fireEvent.blur(columns);
    await waitFor(() =>
      expect(set).toHaveBeenCalledWith({
        editor: expect.objectContaining({ widthColumns: 150 }),
      }),
    );
    await waitFor(() => expect(handles.prefs.editor.widthColumns).toBe(150));
  });

  it("clamps the reading column to 60..200", async () => {
    render(<EditorSettingsCard />);
    const columns = screen.getByLabelText("Reading column width");

    fireEvent.change(columns, { target: { value: "10" } });
    fireEvent.blur(columns);
    await waitFor(() => expect(useAppStore.getState().prefs.editor.widthColumns).toBe(60));
    expect(handles.prefs.editor.widthColumns).toBe(60);

    fireEvent.change(columns, { target: { value: "500" } });
    fireEvent.blur(columns);
    await waitFor(() => expect(useAppStore.getState().prefs.editor.widthColumns).toBe(200));
    expect(handles.prefs.editor.widthColumns).toBe(200);
  });

  it("shows an error line when the write rejects", async () => {
    vi.spyOn(window.pi.prefs, "set").mockRejectedValueOnce(new Error("disk is full"));
    render(<EditorSettingsCard />);

    const fontSize = screen.getByLabelText("Editor font size");
    fireEvent.change(fontSize, { target: { value: "17" } });
    fireEvent.blur(fontSize);

    expect(await screen.findByText(/Could not save the editor preference/)).toBeInTheDocument();
  });
});
