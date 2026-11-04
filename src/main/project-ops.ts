/**
 * Creating and cloning projects (plan step 10).
 *
 * Filesystem and `git` access go through injected ports (`FsPort`,
 * `CommandRunner`), so this module is unit-testable with an in-memory filesystem
 * and no `git` on the machine — the same discipline the Office backend uses.
 *
 * Every operation validates *before* it touches the disk: a bad project name is
 * rejected without creating anything, and a clone that fails leaves no half-made
 * folder registered as a project.
 */

import { join as nodeJoin } from "node:path";
import type {
  CloneProjectInput,
  CreateProjectInput,
  ProjectAction,
  ProjectOpResult,
} from "../shared/projects";
import type { FsPort } from "./fs-port";
import type { CommandRunner } from "./office/exec";

/** How long `git clone` may run before it is abandoned. */
export const CLONE_TIMEOUT_MS = 10 * 60_000;

/** Longest accepted project folder name. */
export const MAX_PROJECT_NAME_LENGTH = 100;

/** The folder created inside the OS Documents folder for default projects. */
export const DEFAULT_PROJECT_ROOT_NAME = "Pi-Desktop";

/** How many `-2`, `-3`, … suffixes a default project folder name may try. */
export const MAX_DEFAULT_PROJECT_ATTEMPTS = 100;

/**
 * The folder name a default project gets: local date and time with a `T`
 * separator and dashes in the time (`2026-11-03T10-15-42`). Colons are invalid
 * in Windows folder names, and a space would need quoting in a shell.
 */
export function defaultProjectFolderName(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  );
}

export interface ProjectOpsDeps {
  fs: FsPort;
  runner: CommandRunner;
  /** Reveals a path in the OS file manager. */
  reveal(target: string): boolean;
  /** Opens an external terminal rooted at the path. */
  openTerminal(target: string): Promise<boolean>;
  /** Copies text to the system clipboard. */
  copyText(text: string): Promise<boolean>;
  /** Platform-correct path join; injected so tests run on any OS. */
  join?: (...parts: string[]) => string;
  /**
   * The OS Documents folder, resolved lazily when the user acts (main builds
   * this service before `app.whenReady`). Null/empty means "unavailable".
   */
  documentsDir?: () => string | null;
  /** Clock for the dated folder name; injected so tests are deterministic. */
  now?: () => number;
}

export interface ProjectOps {
  /** One-click dated folder inside `<Documents>/Pi-Desktop`. */
  createDefault(): Promise<ProjectOpResult>;
  createBlank(input: CreateProjectInput): Promise<ProjectOpResult>;
  cloneRepo(input: CloneProjectInput): Promise<ProjectOpResult>;
  action(path: string, action: ProjectAction): Promise<boolean>;
}

function failed(error: string): ProjectOpResult {
  return { ok: false, path: null, error };
}

/**
 * A project name is a single path segment: no separators, no `.`/`..`, no
 * characters Windows rejects, and short enough to be a folder name.
 */
export function validateProjectName(value: string): string | null {
  const name = value.trim();
  if (name.length === 0) return "a project name is required";
  if (name.length > MAX_PROJECT_NAME_LENGTH) {
    return `a project name may be at most ${MAX_PROJECT_NAME_LENGTH} characters`;
  }
  if (name === "." || name === "..") return `"${name}" is not a valid project name`;
  if (/[\\/]/.test(name)) return "a project name cannot contain a path separator";
  if (/[<>:"|?*]/.test(name)) {
    return 'a project name cannot contain < > : " | ? *';
  }
  // Control characters (including NUL); written without a control-char regex.
  if ([...name].some((character) => character.charCodeAt(0) < 32)) {
    return "a project name cannot contain control characters";
  }
  if (/[. ]$/.test(name)) return "a project name cannot end with a dot or a space";
  return null;
}

/** Derives the folder name a git URL implies (`repo`, not `repo.git`). */
export function repoNameFromUrl(url: string): string {
  const cleaned = url
    .trim()
    .replace(/[/\\]+$/, "")
    .replace(/\.git$/i, "");
  const parts = cleaned.split(/[/\\:]+/);
  return parts[parts.length - 1] ?? "";
}

function isSafeGitUrl(url: string): boolean {
  const trimmed = url.trim();
  if (trimmed.length === 0) return false;
  // A leading dash would be read as a `git clone` option.
  if (trimmed.startsWith("-")) return false;
  return /^(https?:\/\/|git:\/\/|ssh:\/\/|git@|file:\/\/|\/|[a-zA-Z]:[\\/])/.test(trimmed);
}

export function createProjectOps(deps: ProjectOpsDeps): ProjectOps {
  const join = deps.join ?? nodeJoin;
  const now = deps.now ?? ((): number => Date.now());

  const requireDirectory = async (target: string, label: string): Promise<string | null> => {
    const kind = await deps.fs.pathKind(target);
    if (kind !== "directory") return `${label} is not an existing folder`;
    return null;
  };

  return {
    async createDefault() {
      const documents = deps.documentsDir?.()?.trim() ?? "";
      if (documents.length === 0) return failed("the Documents folder is unavailable");
      const root = join(documents, DEFAULT_PROJECT_ROOT_NAME);
      const base = defaultProjectFolderName(new Date(now()));

      try {
        const rootKind = await deps.fs.pathKind(root);
        if (rootKind === "file") return failed(`${root} exists but is not a folder`);
        if (rootKind === null) await deps.fs.ensureDir(root);

        // A timestamp plus a bounded suffix is the uniqueness rule: never reuse
        // an existing project folder, so two clicks in one second stay separate.
        let attempt = 1;
        let target = join(root, base);
        while ((await deps.fs.pathKind(target)) !== null) {
          attempt += 1;
          if (attempt > MAX_DEFAULT_PROJECT_ATTEMPTS) {
            return failed(`could not find a free project folder in ${root}`);
          }
          target = join(root, `${base}-${attempt}`);
        }

        await deps.fs.ensureDir(target);
        return { ok: true, path: target };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return failed(`the default project could not be created: ${message}`);
      }
    },

    async createBlank(input) {
      const parent = input.parentDir?.trim() ?? "";
      if (parent.length === 0) return failed("a parent folder is required");
      const parentError = await requireDirectory(parent, "the parent folder");
      if (parentError) return failed(parentError);

      const nameError = validateProjectName(input.name ?? "");
      if (nameError) return failed(nameError);
      const target = join(parent, input.name.trim());

      if ((await deps.fs.pathKind(target)) !== null) {
        return failed(`${target} already exists`);
      }

      // Check `git` before creating anything, so a missing binary cannot leave a
      // created-but-uninitialised project behind.
      if (input.gitInit) {
        const probe = await deps.runner.run("git", ["--version"]);
        if (probe.missing)
          return failed("git is not installed, so the repository cannot be created");
      }

      await deps.fs.ensureDir(target);
      if (input.gitInit) {
        const init = await deps.runner.run("git", ["init"], { cwd: target });
        if (init.code !== 0) {
          return failed(`git init failed: ${firstLine(init.stderr) || `exit code ${init.code}`}`);
        }
      }
      return { ok: true, path: target };
    },

    async cloneRepo(input) {
      const parent = input.parentDir?.trim() ?? "";
      if (parent.length === 0) return failed("a destination folder is required");
      const parentError = await requireDirectory(parent, "the destination folder");
      if (parentError) return failed(parentError);

      const url = input.url?.trim() ?? "";
      if (!isSafeGitUrl(url)) {
        return failed("enter a git URL (https://, git@…, ssh://) or a local repository path");
      }

      const requested = input.name?.trim() ?? "";
      const name = requested.length > 0 ? requested : repoNameFromUrl(url);
      const nameError = validateProjectName(name);
      if (nameError) return failed(nameError);
      const target = join(parent, name);

      if ((await deps.fs.pathKind(target)) !== null) {
        return failed(`${target} already exists`);
      }

      const clone = await deps.runner.run("git", ["clone", url, target], {
        cwd: parent,
        timeoutMs: CLONE_TIMEOUT_MS,
      });
      if (clone.missing) return failed("git is not installed, so the repository cannot be cloned");
      if (clone.code !== 0) {
        return failed(`git clone failed: ${firstLine(clone.stderr) || `exit code ${clone.code}`}`);
      }
      return { ok: true, path: target };
    },

    async action(path, action) {
      const target = path?.trim() ?? "";
      if (target.length === 0) return false;
      if (action === "copy-path") return deps.copyText(target);
      if (action === "reveal") return deps.reveal(target);
      if (action === "terminal") return deps.openTerminal(target);
      return false;
    },
  };
}

/** First non-empty line of command output, for a readable error. */
function firstLine(text: string | undefined): string {
  if (!text) return "";
  const line = text
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  return line ?? "";
}
