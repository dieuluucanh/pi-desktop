/** Types for `scripts/verify-workflow-bundle.mjs` (plan step 26). */

import type { WorkflowLock } from "./workflow-bundle.mjs";

export interface VerifyOptions {
  root: string;
  tarball: string | null;
  offline: boolean;
  requireDev: boolean;
  node: string | null;
  json: boolean;
  help: boolean;
}

export interface VerifyReport {
  errors: string[];
  lock: WorkflowLock | null;
  targets: string[];
  nodePath?: string;
}

export interface LoadProbeOptions {
  stageDir: string;
  files: string[];
  nodePath: string;
  root: string;
  timeoutMs?: number;
}

export interface StagedCopyOptions {
  root: string;
  lock: WorkflowLock;
  stageDir: string;
  label: string;
  nodePath: string;
  requireLoad?: boolean;
}

export function parseArgs(argv?: string[]): VerifyOptions;
export function bundledNodePath(root: string): string | null;
export function probeOfflineLoad(options: LoadProbeOptions): Promise<string[]>;
export function verifyStagedCopy(options: StagedCopyOptions): Promise<string[]>;
export function verifyBundle(
  options?: Partial<VerifyOptions> & { load?: boolean },
): Promise<VerifyReport>;
export function main(): Promise<number>;
