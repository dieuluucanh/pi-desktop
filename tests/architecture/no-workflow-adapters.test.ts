import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Architecture guard (orchestrator plan step 11).
 *
 * Desktop used to understand one extension: it parsed Workflow's status glyphs,
 * inferred a Review phase from prose, dispatched `/review-*`, and read the
 * `workflow-todos` widget/status. That compatibility layer is gone. The app now
 * consumes the generic contribution contract and nothing else.
 *
 * This guard fails if the parser, its magic keys or its command names come back
 * into active source. Comments may still name an extension (they explain the
 * contract); code may not branch on one.
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

const SOURCE_ROOTS = ["src"] as const;

/** The retired Workflow adapters: their modules and their consumer symbols. */
const RETIRED_MODULES = ["src/shared/workflow-mode.ts", "src/shared/workflow-todos.ts"];

const FORBIDDEN: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "workflow parser module", pattern: /workflow-(?:mode|todos)/ },
  {
    label: "workflow parser symbol",
    pattern:
      /\b(?:parseWorkflowStatus|resolveTodoPanel|todoPanelActions|todoPanelToggle|TODO_PANEL_ACTIONS|WORKFLOW_REVIEW_STATUS_KEY|reviewLineText)\b/,
  },
  {
    label: "review command dispatch",
    pattern: /["'`]review-(?:pause|resume|abort|status)["'`]/,
  },
  {
    label: "todo menu command id",
    pattern: /["'`]todos-(?:auto|expand|collapse|hide|toggle)["'`]/,
  },
  { label: "workflow status key read", pattern: /statuses\s*\??\.\s*workflow\b/ },
  { label: "workflow-todos key", pattern: /["'`]workflow-todos["'`]/ },
];

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(join(repoRoot, dir), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (/\.(?:ts|tsx)$/.test(entry.name)) files.push(path);
  }
  return files;
}

describe("no Workflow-specific Desktop adapters", () => {
  it("deleted the retired parser modules", () => {
    for (const path of RETIRED_MODULES) {
      expect(existsSync(join(repoRoot, path)), path).toBe(false);
    }
  });

  it("active source never imports or re-implements them", async () => {
    const hits: string[] = [];
    for (const root of SOURCE_ROOTS) {
      for (const file of await sourceFiles(root)) {
        const text = await readFile(join(repoRoot, file), "utf8");
        for (const rule of FORBIDDEN) {
          if (rule.pattern.test(text)) hits.push(`${relative(repoRoot, file)}: ${rule.label}`);
        }
      }
    }
    expect(hits, hits.join("\n")).toEqual([]);
  });
});
