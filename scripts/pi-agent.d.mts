/**
 * Types for `scripts/pi-agent.mjs` (2026-11-15 update-channels plan).
 *
 * Same convention as `scripts/extension-package.d.mts`: the CLI is plain ESM so
 * `prepare` can run it without `npm ci`, and the tests still type-check.
 */

import type { PiAgentStatus, TargetPins } from "./pi-agent-package.mjs";

export interface CliOptions {
  command: "status" | "check" | "update";
  json: boolean;
  dryRun: boolean;
  force: boolean;
  major: boolean;
  install: boolean;
  root: string;
  registryFile: string | null;
  help: boolean;
}

export interface RegistryFacts {
  latest: string;
  dependencies: Record<string, unknown>;
  /** The SDK's `engines.node`, or null when it declares none. */
  engines: string | null;
}

export interface PiAgentReport {
  current: string | null;
  latest: string;
  status: PiAgentStatus;
  pins: Record<string, string | null>;
  typebox: { current: string | null; latest: string | null };
  targets: TargetPins | null;
  targetError: string | null;
  bundledNode: string | null;
  engines: string | null;
  enginesOk: boolean | null;
}

export function parseArgs(argv: string[]): CliOptions;
export function npmInvocation(
  platform?: NodeJS.Platform,
  env?: Record<string, string | undefined>,
): { cmd: string; args: string[] };
export function readRegistry(input: { root: string; registryFile: string | null }): RegistryFacts;
export function bundledNodeVersion(root: string): string | null;
export function buildReport(input: { root: string; registry: RegistryFacts }): PiAgentReport;
export function checkExitCode(report: { status: string }, options: { major: boolean }): number;
export function main(argv?: string[]): number;
