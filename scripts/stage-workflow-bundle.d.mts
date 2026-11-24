/** Types for `scripts/stage-workflow-bundle.mjs` (plan step 26). */

export interface StageOptions {
  root: string;
  tarball: string | null;
  release: boolean;
  offline: boolean;
  updateLock: boolean;
  sourceKind: "release" | "tarball";
  sourcePath: string | null;
  releaseUrl: string | null;
  tag: string | null;
  dev: boolean;
  keepOld: boolean;
  json: boolean;
  help: boolean;
}

export function parseArgs(argv?: string[]): StageOptions;
export function main(): Promise<number>;
