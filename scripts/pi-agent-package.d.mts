/**
 * Types for `scripts/pi-agent-package.mjs` (2026-11-15 update-channels plan).
 *
 * The module is dependency-free so the release `prepare` job can run it before
 * `npm ci`; this declaration keeps the tests that exercise it type-checked.
 */

export const PI_AGENT_PACKAGE: string;
export const PI_AGENT_FAMILY: readonly string[];
export const TYPEBOX_PACKAGE: string;

export class PiAgentError extends Error {
  constructor(message: string);
}

export interface PiPins {
  family: Record<string, string | null>;
  typebox: string | null;
}

export interface TargetPins {
  family: Record<string, string>;
  typebox: string;
}

export interface PinChange {
  name: string;
  from: string | null;
  to: string;
}

export type PiAgentStatus =
  "in-sync" | "behind" | "major-behind" | "local-ahead" | "registry-error";

export interface EnginesFloor {
  operator: ">=" | ">" | "^" | "~" | "=";
  version: string;
}

export interface AppManifest {
  dependencies?: Record<string, unknown>;
  [key: string]: unknown;
}

/** The shape `rewritePiPins` returns: a manifest that still has its deps. */
export interface RewrittenManifest extends AppManifest {
  dependencies: Record<string, unknown>;
}

export function isExactVersion(value: unknown): boolean;
export function majorOf(version: string | null | undefined): number | null;
export function readPiPins(manifest: unknown): PiPins;
export function classifyPiStatus(
  current: string | null | undefined,
  latest: string | null | undefined,
): PiAgentStatus;
export function resolveTargetPins(input: {
  sdkVersion: string;
  /** Validated at runtime: a missing/array value is a deliberate refusal. */
  sdkDependencies?: unknown;
}): TargetPins;
export function rewritePiPins(
  manifest: AppManifest,
  pins: TargetPins,
): { manifest: RewrittenManifest; changed: PinChange[] };
export function renderVersionsDoc(text: string, pins: TargetPins): string;
export function enginesFloor(range: unknown): EnginesFloor | null;
export function satisfiesFloor(nodeVersion: unknown, range: unknown): boolean | null;
