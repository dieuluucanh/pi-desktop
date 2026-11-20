import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { TodoPanelSnapshot } from "../../src/shared/workflow-todos";
import { TodoPanelBar } from "../../src/renderer/src/session/TodoPanelBar";

function panel(over: Partial<TodoPanelSnapshot> = {}): TodoPanelSnapshot {
  return {
    present: true,
    state: "expanded",
    done: 3,
    total: 12,
    cancelled: 0,
    settled: false,
    stale: false,
    source: "frame",
    ...over,
  };
}

describe("TodoPanelBar", () => {
  it("shows progress and toggles an expanded panel to collapse", async () => {
    const onAction = vi.fn();
    render(<TodoPanelBar panel={panel()} onAction={onAction} />);

    expect(screen.getByTestId("todo-panel-bar")).toHaveTextContent("Todos");
    expect(screen.getByTestId("todo-panel-bar")).toHaveTextContent("3/12");
    expect(screen.getByTestId("todo-panel-bar")).toHaveTextContent("Expanded");
    expect(screen.getByTestId("todo-panel-bar-toggle")).toHaveTextContent("Collapse");

    fireEvent.click(screen.getByTestId("todo-panel-bar-toggle"));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith("collapse"));
  });

  it("toggles a collapsed or hidden panel to expand", async () => {
    const collapsed = vi.fn();
    const { rerender } = render(
      <TodoPanelBar panel={panel({ state: "collapsed" })} onAction={collapsed} />,
    );
    expect(screen.getByTestId("todo-panel-bar-toggle")).toHaveTextContent("Expand");
    fireEvent.click(screen.getByTestId("todo-panel-bar-toggle"));
    await waitFor(() => expect(collapsed).toHaveBeenCalledWith("expand"));

    const hidden = vi.fn();
    rerender(<TodoPanelBar panel={panel({ state: "hidden" })} onAction={hidden} />);
    expect(screen.getByTestId("todo-panel-bar")).toHaveTextContent("Hidden");
    expect(screen.getByTestId("todo-panel-bar-toggle")).toHaveTextContent("Expand");
    fireEvent.click(screen.getByTestId("todo-panel-bar-toggle"));
    await waitFor(() => expect(hidden).toHaveBeenCalledWith("expand"));
  });

  it("keeps the bar visible when the list is hidden and only progress is known", () => {
    render(
      <TodoPanelBar
        panel={panel({ state: "hidden", done: null, total: null, settled: null })}
        onAction={() => {}}
      />,
    );
    expect(screen.getByTestId("todo-panel-bar")).toHaveAttribute("data-state", "hidden");
    expect(screen.getByTestId("todo-panel-bar")).toHaveTextContent("Hidden");
    expect(screen.getByTestId("todo-panel-bar")).not.toHaveTextContent("3/12");
  });

  it("marks a settled list and keeps the cancelled/stale counts", () => {
    const { rerender } = render(
      <TodoPanelBar
        panel={panel({ state: "collapsed", done: 1, total: 2, cancelled: 1, settled: true })}
        onAction={() => {}}
      />,
    );
    const bar = screen.getByTestId("todo-panel-bar");
    expect(bar).toHaveTextContent("1/2");
    expect(bar).toHaveTextContent("1 cancelled");
    expect(bar).toHaveTextContent("all done");
    expect(bar).toHaveAttribute("data-settled", "true");

    rerender(<TodoPanelBar panel={panel({ state: "hidden", stale: true })} onAction={() => {}} />);
    expect(screen.getByTestId("todo-panel-bar")).toHaveAttribute("data-stale", "true");
    expect(screen.getByTestId("todo-panel-bar")).toHaveTextContent("⚠");
  });

  it("opens the menu and dispatches the explicit actions", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(<TodoPanelBar panel={panel()} onAction={onAction} />);

    await user.click(screen.getByTestId("todo-panel-bar-menu"));
    expect(await screen.findByText("Hide panel")).toBeInTheDocument();
    expect(screen.getByText("Automatic")).toBeInTheDocument();

    await user.click(screen.getByTestId("todo-panel-action-hide"));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith("hide"));
  });

  it("guards a second action while the first is still pending", async () => {
    const onAction = vi.fn(() => new Promise<void>(() => {}));
    render(<TodoPanelBar panel={panel()} onAction={onAction} />);

    const toggle = screen.getByTestId("todo-panel-bar-toggle");
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    await waitFor(() => expect(onAction).toHaveBeenCalledTimes(1));
    expect(toggle).toBeDisabled();
  });
});
