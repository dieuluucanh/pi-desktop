/**
 * Pure file-mutation engines for the explorer.
 *
 * Four operations share one containment rule:
 *
 * - create a file/directory;
 * - rename an entry within its existing parent;
 * - move an entry to the OS Recycle Bin/Trash;
 * - copy or move entries inside or across projects.
 *
 * Existing sources are resolved with `resolveEntryInsideRoot` (the parent is
 * contained, the final component is not followed), so deleting or renaming a
 * symlink acts on the link itself. Copy/move never follow symlinks and refuse
 * an outside-pointing link; a safe internal link is copied as a link.
 *
 * The filesystem and trash are injected ports. This module is deliberately
 * Electron-free and is unit tested with an in-memory tree.
 */

import { randomUUID } from "node:crypto";

import {
  MAX_TRANSFER_BYTES,
  MAX_TRANSFER_ENTRIES,
  MAX_TRANSFER_SOURCES,
  isWorkspaceEntryName,
  isWorkspaceRelativePath,
  workspaceBasename,
  workspaceDirname,
  workspaceJoin,
  type WorkspaceCreateInput,
  type WorkspaceDeleteInput,
  type WorkspaceMutationResult,
  type WorkspaceRenameInput,
  type WorkspaceTransferInput,
  type WorkspaceTransferResult,
} from "../shared/workspace";
import { writeWorkspaceContent, type FileContentIo } from "./file-content";
import { isPathInside, resolveEntryInsideRoot, resolveInsideRoot } from "./path-guard";
import type { TreeDirectoryEntry, TreeStat } from "./tree";

/** The filesystem surface a mutation needs; all methods are injected. */
export interface WorkspaceMutationIo extends FileContentIo {
  stat(target: string): Promise<TreeStat | null>;
  readDirectory(target: string): Promise<TreeDirectoryEntry[]>;
  readTextFile(target: string): Promise<string | null>;
  ensureDir(target: string): Promise<void>;
  /** Non-recursive; an existing directory is an error. */
  mkdir(target: string): Promise<void>;
  rename(source: string, target: string): Promise<void>;
  /** Recursive, exclusive, symlink-preserving copy. */
  copy(source: string, target: string): Promise<void>;
  /** Moves an entry to the OS Recycle Bin/Trash. */
  trash(target: string): Promise<boolean>;
  remove(target: string): Promise<boolean>;
}

export type WorkspaceMutationErrorCode =
  "bad_request" | "forbidden" | "not_found" | "conflict" | "too_large" | "unavailable";

export class WorkspaceMutationError extends Error {
  readonly code: WorkspaceMutationErrorCode;

  constructor(message: string, code: WorkspaceMutationErrorCode) {
    super(message);
    this.name = "WorkspaceMutationError";
    this.code = code;
  }
}

function fail(message: string, code: WorkspaceMutationErrorCode): never {
  throw new WorkspaceMutationError(message, code);
}

function hasGitSegment(path: string): boolean {
  return path.split("/").some((segment) => segment.toLowerCase() === ".git");
}

function assertRelative(path: unknown, label: string): asserts path is string {
  if (!isWorkspaceRelativePath(path)) fail(`${label} is not inside the project`, "forbidden");
  if (hasGitSegment(path)) fail("the .git directory is not editable", "forbidden");
}

function assertEntryName(path: string): void {
  if (!isWorkspaceEntryName(workspaceBasename(path))) {
    fail(`"${workspaceBasename(path)}" is not a valid name`, "bad_request");
  }
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

async function realRootOf(io: WorkspaceMutationIo, root: string): Promise<string> {
  return (await io.realpath(root).catch(() => null)) ?? root;
}

/** A symlink is outside when its resolved target escapes the source root. */
async function isOutsideLink(
  io: WorkspaceMutationIo,
  root: string,
  absolute: string,
  stat: TreeStat,
): Promise<boolean> {
  if (!stat.symlink) return false;
  const real = await io.realpath(absolute).catch(() => null);
  if (real === null) return false;
  return !isPathInside(await realRootOf(io, root), real);
}

interface WalkTotals {
  entries: number;
  bytes: number;
}

/** Preflights a source tree for caps and outside-pointing links. */
async function inspectSource(
  io: WorkspaceMutationIo,
  root: string,
  absolute: string,
  totals: WalkTotals,
): Promise<TreeStat> {
  const stat = await io.stat(absolute).catch(() => null);
  if (stat === null) fail(`no such entry: ${absolute}`, "not_found");

  totals.entries += 1;
  if (totals.entries > MAX_TRANSFER_ENTRIES) {
    fail(`copying more than ${MAX_TRANSFER_ENTRIES} entries is not supported`, "too_large");
  }
  totals.bytes += stat.kind === "file" ? stat.size : 0;
  if (totals.bytes > MAX_TRANSFER_BYTES) {
    fail("the selected files are too large to copy", "too_large");
  }

  if (stat.symlink) {
    if (await isOutsideLink(io, root, absolute, stat)) {
      fail("a link points outside the project and cannot be copied or moved", "forbidden");
    }
    return stat;
  }

  if (stat.kind === "directory") {
    for (const child of await io.readDirectory(absolute)) {
      const childAbsolute = `${absolute}/${child.name}`.replace(/\\/g, "/");
      await inspectSource(io, root, childAbsolute, totals);
    }
  }
  return stat;
}

function targetAbsoluteFor(targetDirectoryAbsolute: string, sourcePath: string): string {
  return `${targetDirectoryAbsolute.replace(/[\\/]+$/, "")}/${workspaceBasename(sourcePath)}`;
}

function stagingAbsolute(targetAbsolutePath: string): string {
  const slash = Math.max(targetAbsolutePath.lastIndexOf("/"), targetAbsolutePath.lastIndexOf("\\"));
  const parent = slash === -1 ? "" : targetAbsolutePath.slice(0, slash);
  const name = `.pi-transfer-${randomUUID()}.tmp`;
  return parent.length === 0 ? name : `${parent}/${name}`;
}

async function cleanup(io: WorkspaceMutationIo, target: string): Promise<void> {
  await io.remove(target).catch(() => false);
}

async function resolveTargetDirectory(
  io: WorkspaceMutationIo,
  root: string,
  targetDirectory: string,
): Promise<string> {
  if (targetDirectory.length === 0) {
    const stat = await io.stat(root).catch(() => null);
    if (stat?.kind !== "directory") fail("the project folder is missing", "not_found");
    return root;
  }
  assertRelative(targetDirectory, "the target folder");
  const absolute = await resolveInsideRoot(io, root, targetDirectory);
  if (absolute === null) fail("the target folder is outside the project", "forbidden");
  const stat = await io.stat(absolute).catch(() => null);
  if (stat?.kind !== "directory") fail(`not a directory: ${targetDirectory}`, "bad_request");
  return absolute;
}

/** Creates one file or directory without overwriting an existing entry. */
export async function createWorkspaceEntry(
  io: WorkspaceMutationIo,
  root: string,
  input: Omit<WorkspaceCreateInput, "projectPath">,
): Promise<WorkspaceMutationResult> {
  assertRelative(input.path, "the new path");
  assertEntryName(input.path);
  if (input.kind !== "file" && input.kind !== "directory") {
    fail("a new entry must be a file or a directory", "bad_request");
  }

  const parentPath = workspaceDirname(input.path);
  const parentAbsolute =
    parentPath.length === 0 ? root : await resolveInsideRoot(io, root, parentPath);
  if (parentAbsolute === null) fail("the parent folder is outside the project", "forbidden");
  const parentStat = await io.stat(parentAbsolute).catch(() => null);
  if (parentStat?.kind !== "directory") fail("the parent folder does not exist", "not_found");

  const target = await resolveInsideRoot(io, root, input.path);
  if (target === null) fail("the new path is outside the project", "forbidden");

  if (input.kind === "file") {
    await writeWorkspaceContent(io, root, {
      path: input.path,
      text: "",
      expectedMtimeMs: null,
    });
  } else {
    try {
      await io.mkdir(target);
    } catch (error) {
      if (errorCode(error) === "EEXIST") {
        fail(`an entry already exists at ${input.path}`, "conflict");
      }
      fail(`could not create ${input.path}`, "unavailable");
    }
  }

  return {
    path: input.path,
    absolutePath: target,
    kind: input.kind,
  };
}

/** Renames an entry without changing its parent. */
export async function renameWorkspaceEntry(
  io: WorkspaceMutationIo,
  root: string,
  input: Omit<WorkspaceRenameInput, "projectPath">,
): Promise<WorkspaceMutationResult> {
  assertRelative(input.path, "the source path");
  assertRelative(input.toPath, "the new path");
  assertEntryName(input.toPath);
  if (workspaceDirname(input.path) !== workspaceDirname(input.toPath)) {
    fail("rename cannot move an entry to another folder", "bad_request");
  }

  const source = await resolveEntryInsideRoot(io, root, input.path);
  if (source === null) fail("the source is outside the project", "forbidden");
  const sourceStat = await io.stat(source).catch(() => null);
  if (sourceStat === null) fail(`no such entry: ${input.path}`, "not_found");

  const target = await resolveEntryInsideRoot(io, root, input.toPath);
  if (target === null) fail("the new path is outside the project", "forbidden");
  const targetStat = await io.stat(target).catch(() => null);
  if (targetStat !== null) {
    const [realSource, realTarget] = await Promise.all([
      io.realpath(source).catch(() => null),
      io.realpath(target).catch(() => null),
    ]);
    const sameEntry = realSource !== null && realTarget !== null && realSource === realTarget;
    if (!sameEntry) fail(`an entry already exists at ${input.toPath}`, "conflict");
  }

  try {
    await io.rename(source, target);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") fail(`no such entry: ${input.path}`, "not_found");
    if (code === "EACCES" || code === "EPERM") {
      fail(`could not rename ${input.path}`, "forbidden");
    }
    fail(`could not rename ${input.path}`, "unavailable");
  }

  return {
    path: input.toPath,
    absolutePath: target,
    kind: sourceStat.kind,
    previousPath: input.path,
  };
}

/** Moves one entry to the OS Recycle Bin/Trash. */
export async function deleteWorkspaceEntry(
  io: WorkspaceMutationIo,
  root: string,
  input: Omit<WorkspaceDeleteInput, "projectPath">,
): Promise<WorkspaceMutationResult> {
  assertRelative(input.path, "the path");
  const target = await resolveEntryInsideRoot(io, root, input.path);
  if (target === null) fail("that path is outside the project", "forbidden");
  const targetStat = await io.stat(target).catch(() => null);
  if (targetStat === null) fail(`no such entry: ${input.path}`, "not_found");

  const trashed = await io.trash(target).catch(() => false);
  if (!trashed) {
    fail("the OS Recycle Bin/Trash is not available for this entry", "unavailable");
  }
  return {
    path: input.path,
    absolutePath: target,
    kind: targetStat.kind,
  };
}

interface TransferPlanItem {
  sourcePath: string;
  sourceAbsolute: string;
  targetPath: string;
  targetAbsolute: string;
  targetDirectoryAbsolute: string;
  stat: TreeStat;
}

/** Copies or moves one or more entries into a target folder. */
export async function transferWorkspaceEntries(
  io: WorkspaceMutationIo,
  input: WorkspaceTransferInput,
): Promise<WorkspaceTransferResult> {
  if (input.operation !== "copy" && input.operation !== "move") {
    fail("a transfer must be copy or move", "bad_request");
  }
  if (!Array.isArray(input.sources) || input.sources.length === 0) {
    fail("choose at least one entry to paste", "bad_request");
  }
  if (input.sources.length > MAX_TRANSFER_SOURCES) {
    fail(`paste supports at most ${MAX_TRANSFER_SOURCES} entries at once`, "bad_request");
  }
  if (input.targetDirectory.length > 0 && !isWorkspaceRelativePath(input.targetDirectory)) {
    fail("the target folder is outside the project", "forbidden");
  }

  const targetDirectoryAbsolute = await resolveTargetDirectory(
    io,
    input.targetProjectPath,
    input.targetDirectory,
  );

  const totals: WalkTotals = { entries: 0, bytes: 0 };
  const plans: TransferPlanItem[] = [];
  const seenTargets = new Set<string>();

  for (const sourcePath of input.sources) {
    assertRelative(sourcePath, "the source path");
    const sourceAbsolute = await resolveEntryInsideRoot(io, input.sourceProjectPath, sourcePath);
    if (sourceAbsolute === null)
      fail(`the source is outside the project: ${sourcePath}`, "forbidden");
    const stat = await inspectSource(io, input.sourceProjectPath, sourceAbsolute, totals);
    const targetPath = workspaceJoin(input.targetDirectory, workspaceBasename(sourcePath));
    if (targetPath.length === 0) fail("the target path is empty", "bad_request");
    const targetAbsolute = targetAbsoluteFor(targetDirectoryAbsolute, sourcePath);

    const existing = await io.stat(targetAbsolute).catch(() => null);
    if (existing !== null) fail(`an entry already exists at ${targetPath}`, "conflict");
    if (seenTargets.has(targetAbsolute.toLowerCase())) {
      fail(`two sources would paste to the same place: ${targetPath}`, "conflict");
    }
    seenTargets.add(targetAbsolute.toLowerCase());
    if (stat.kind === "directory") {
      const sourceReal = (await io.realpath(sourceAbsolute).catch(() => null)) ?? sourceAbsolute;
      const targetRealish =
        (await io.realpath(targetDirectoryAbsolute).catch(() => null)) ?? targetDirectoryAbsolute;
      if (isPathInside(sourceReal, targetRealish)) {
        fail("cannot paste a folder inside itself", "conflict");
      }
    }

    plans.push({
      sourcePath,
      sourceAbsolute,
      targetPath,
      targetAbsolute,
      targetDirectoryAbsolute,
      stat,
    });
  }

  const transferred: WorkspaceTransferResult["transferred"] = [];
  for (const plan of plans) {
    if (input.operation === "move") {
      try {
        await io.rename(plan.sourceAbsolute, plan.targetAbsolute);
        transferred.push({
          sourcePath: plan.sourcePath,
          targetPath: plan.targetPath,
          kind: plan.stat.kind,
        });
        continue;
      } catch (error) {
        if (errorCode(error) !== "EXDEV") {
          fail(`could not move ${plan.sourcePath}`, "unavailable");
        }
        // Cross-device move: copy into a staging sibling, rename into place,
        // then trash the source. If the trash step fails the copy is kept and
        // the error names both sides, so the user can see what happened.
        await copyIntoPlace(io, plan);
        const trashed = await io.trash(plan.sourceAbsolute).catch(() => false);
        if (!trashed) {
          fail(
            `copied ${plan.sourcePath} to ${plan.targetPath}, but could not remove the source`,
            "unavailable",
          );
        }
        transferred.push({
          sourcePath: plan.sourcePath,
          targetPath: plan.targetPath,
          kind: plan.stat.kind,
        });
        continue;
      }
    }

    await copyIntoPlace(io, plan);
    transferred.push({
      sourcePath: plan.sourcePath,
      targetPath: plan.targetPath,
      kind: plan.stat.kind,
    });
  }

  return { operation: input.operation, transferred };
}

async function copyIntoPlace(io: WorkspaceMutationIo, plan: TransferPlanItem): Promise<void> {
  await io.ensureDir(plan.targetDirectoryAbsolute).catch(() => undefined);
  const staging = stagingAbsolute(plan.targetAbsolute);
  try {
    await io.copy(plan.sourceAbsolute, staging);
    const existing = await io.stat(plan.targetAbsolute).catch(() => null);
    if (existing !== null) fail(`an entry already exists at ${plan.targetPath}`, "conflict");
    await io.rename(staging, plan.targetAbsolute);
  } catch (error) {
    await cleanup(io, staging);
    if (error instanceof WorkspaceMutationError) throw error;
    fail(`could not copy ${plan.sourcePath}`, "unavailable");
  }
}
