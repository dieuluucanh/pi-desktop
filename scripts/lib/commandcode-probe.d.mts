/**
 * Types for `scripts/lib/commandcode-probe.mjs`.
 *
 * `tsconfig.node.json` typechecks `tests/**` but not `scripts/**`, so the
 * probe's unit test needs this declaration (same convention as
 * `node-pty-artifact.d.mts`). Keep it in step with the implementation.
 */

export type ProbeWire = "chat" | "responses";

export type ProbeOutcome = "OK" | "CUT" | "INCOMPLETE" | "LENGTH" | "ERROR";

export const PROBE_WIRES: readonly ProbeWire[];
export const DEFAULT_BASE_URL: string;
export const DEFAULT_MODEL: string;
export const DEFAULT_THINKING: string;
export const DEFAULT_MAX_TOKENS: number;
export const DEFAULT_TIMEOUT_MS: number;
export const CUT_ERROR: string;

export interface ProbeBuildInput {
  model: string;
  prompt: string;
  thinking: string;
  maxTokens: number;
}

export interface ProbeOptions {
  wire: ProbeWire;
  apiKey: string;
  model?: string;
  thinking?: string;
  maxTokens?: number;
  prompt?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  signal?: AbortSignal;
}

export interface ProbeMatrixOptions extends ProbeOptions {
  wires?: readonly ProbeWire[];
  thinkings?: readonly string[];
  maxTokensList?: readonly number[];
  runs?: number;
}

export interface ProbeResult {
  wire: ProbeWire;
  model: string;
  thinking: string;
  maxTokens: number;
  url: string;
  startedAt: number;
  headersAt: number | null;
  firstEventAt: number | null;
  lastChunkAt: number | null;
  terminalAt: number | null;
  endedAt: number;
  longestGapMs: number;
  status: number | null;
  statusText: string;
  chunks: number;
  bytes: number;
  events: number;
  parseErrors: number;
  contentChars: number;
  thinkingChars: number;
  toolCallChars: number;
  finishReason: string | null;
  rawStopReason: string | null;
  responseId: string | null;
  usage: unknown;
  doneMarker: boolean;
  responseCompleted: boolean;
  responseIncomplete: boolean;
  streamCut: boolean;
  error: string | null;
  completed: boolean;
  incomplete: boolean;
  outcome: ProbeOutcome;
  ok: boolean;
  cut: boolean;
  diagnostic: string | null;
  durationMs: number;
  terminalMs: number | null;
  /** Present only on `runProbeMatrix` results. */
  run?: number;
}

export function defaultPlanText(): string;

export function defaultReviewPrompt(planText?: string): string;

export function buildChatBody(input: ProbeBuildInput): Record<string, unknown>;

export function buildResponsesBody(input: ProbeBuildInput): Record<string, unknown>;

export function buildBody(wire: ProbeWire, input: ProbeBuildInput): Record<string, unknown>;

export function probeUrl(baseUrl: string, wire: ProbeWire): string;

export function commandCodeKeyFromAuth(auth: unknown): string | undefined;

export function runProbe(options: ProbeOptions): Promise<ProbeResult>;

export function runProbeMatrix(options: ProbeMatrixOptions): Promise<ProbeResult[]>;

export function formatProbeTable(results: readonly ProbeResult[]): string;
