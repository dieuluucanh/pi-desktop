import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { InlineRename } from "../../src/renderer/src/ui/inline-rename";

function renderRename() {
  const onCommit = vi.fn();
  const onCancel = vi.fn();
  render(
    <InlineRename
      value="old name"
      ariaLabel="Session name"
      onCommit={onCommit}
      onCancel={onCancel}
    />,
  );
  return { onCommit, onCancel, input: screen.getByRole("textbox", { name: "Session name" }) };
}

describe("InlineRename", () => {
  it("commits a trimmed value on Enter", async () => {
    const user = userEvent.setup();
    const { onCommit, input } = renderRename();
    await user.clear(input);
    await user.type(input, "  new name  {Enter}");
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("new name");
  });

  it("commits on blur", async () => {
    const user = userEvent.setup();
    const { onCommit, input } = renderRename();
    await user.clear(input);
    await user.type(input, "blurred name");
    await user.tab();
    expect(onCommit).toHaveBeenCalledWith("blurred name");
  });

  it("cancels on Escape without committing", async () => {
    const user = userEvent.setup();
    const { onCommit, onCancel, input } = renderRename();
    await user.clear(input);
    await user.type(input, "discard me{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("cancels an empty value and does not double-commit", async () => {
    const user = userEvent.setup();
    const { onCommit, onCancel, input } = renderRename();
    await user.clear(input);
    await user.tab();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
  });
});
