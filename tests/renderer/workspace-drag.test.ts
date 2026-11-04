import { describe, expect, it } from "vitest";

import {
  WORKSPACE_PATH_DRAG_MIME,
  WORKSPACE_PATH_DRAG_VERSION,
  type WorkspaceDragPayload,
} from "../../src/shared/workspace-drag";
import {
  isExternalFileDrag,
  isWorkspaceDrag,
  readWorkspaceDrop,
  writeWorkspaceDrag,
} from "../../src/renderer/src/files/workspace-drag";

class FakeTransfer {
  readonly data = new Map<string, string>();
  readonly types: string[] = [];
  effectAllowed = "none";

  setData(type: string, value: string): void {
    this.data.set(type, value);
    if (!this.types.includes(type)) this.types.push(type);
  }

  getData(type: string): string {
    return this.data.get(type) ?? "";
  }
}

const payload: WorkspaceDragPayload = {
  version: WORKSPACE_PATH_DRAG_VERSION,
  projectPath: "C:/work/app",
  path: "src/App.tsx",
  kind: "file",
};

describe("renderer workspace drag helpers", () => {
  it("writes the typed payload and a plain-path fallback", () => {
    const transfer = new FakeTransfer();
    writeWorkspaceDrag(transfer, payload);
    expect(transfer.getData(WORKSPACE_PATH_DRAG_MIME)).toContain('"path":"src/App.tsx"');
    expect(transfer.getData("text/plain")).toBe("src/App.tsx");
    expect(transfer.effectAllowed).toBe("copy");
    expect(transfer.types).toEqual([WORKSPACE_PATH_DRAG_MIME, "text/plain"]);
  });

  it("detects workspace and external file drags", () => {
    const workspace = new FakeTransfer();
    writeWorkspaceDrag(workspace, payload);
    expect(isWorkspaceDrag(workspace)).toBe(true);
    expect(isExternalFileDrag(workspace)).toBe(false);

    expect(isWorkspaceDrag({ types: ["text/plain"] })).toBe(false);
    expect(isExternalFileDrag({ types: ["Files"] })).toBe(true);
    expect(isExternalFileDrag({ types: [] })).toBe(false);
  });

  it("reads only the typed payload", () => {
    const transfer = new FakeTransfer();
    writeWorkspaceDrag(transfer, payload);
    expect(readWorkspaceDrop(transfer)).toEqual(payload);

    const plainOnly = new FakeTransfer();
    plainOnly.setData("text/plain", "src/App.tsx");
    expect(readWorkspaceDrop(plainOnly)).toBeNull();

    const malformed = new FakeTransfer();
    malformed.setData(WORKSPACE_PATH_DRAG_MIME, "{not json");
    expect(readWorkspaceDrop(malformed)).toBeNull();
  });
});
