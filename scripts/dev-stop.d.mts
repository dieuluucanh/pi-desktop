/** Types for `scripts/dev-stop.mjs` (unit tested by `tests/packaging/dev-stop.test.ts`). */

/** The fields `stopChild` needs from a spawned child; `ChildProcess` satisfies it. */
export interface StoppableChild {
  pid?: number;
  exitCode: number | null;
  killed: boolean;
}

export interface StopPlan {
  command: string;
  args: string[];
}

export interface StopDeps {
  spawnSync: (
    command: string,
    args: readonly string[],
    options: { stdio: "ignore"; windowsHide: boolean },
  ) => unknown;
  kill: (child: StoppableChild) => unknown;
}

export function stopCommand(pid: number | undefined, platform: string): StopPlan | null;

export function stopChild(
  child: StoppableChild | null | undefined,
  platform: string,
  deps?: StopDeps,
): boolean;
