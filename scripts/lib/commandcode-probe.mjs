/**
 * Command Code wire probe.
 *
 * Review Mode's reviewer can die with `Stream ended without finish_reason` after
 * a long Command Code generation. This module sends the same long, review-like
 * prompt to the Provider API's Chat Completions and Responses wires and records
 * what actually happened: HTTP status, first event, longest gap, total time,
 * terminal reason, content size and the exact error.
 *
 * It is deliberately dependency-free and injectable (`fetchImpl`, `now`,
 * `signal`) so the unit suite can exercise both the happy path and the
 * stream-cut path against a loopback mock server. The CLI wrapper is
 * `scripts/probe-commandcode-stream.mjs`; it never prints the API key.
 */

export const PROBE_WIRES = ["chat", "responses"];
export const DEFAULT_BASE_URL = "https://api.commandcode.ai/provider/v1";
export const DEFAULT_MODEL = "deepseek/deepseek-v4.1-flash";
export const DEFAULT_THINKING = "high";
export const DEFAULT_MAX_TOKENS = 32_768;
export const DEFAULT_TIMEOUT_MS = 240_000;
export const CUT_ERROR = "Stream ended without finish_reason";

const SYSTEM_PROMPT =
  "You are auditing and rewriting a software plan. Return the complete revised markdown plan, " +
  "preserving every heading and requirement. Do not summarize, do not omit sections, and do not " +
  "stop early. Output only the plan.";

const THINKING_FIELDS = ["reasoning_content", "reasoning", "reasoning_text"];

function clampInt(value, fallback, min, max) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** The synthetic plan used when the caller does not pass `--plan-file`. */
export function defaultPlanText() {
  const sections = [];
  for (let index = 1; index <= 36; index += 1) {
    sections.push(
      [
        `### ${index}. Area ${index}: provider and session boundary`,
        "",
        `Deliverable: make the ${index === 1 ? "first" : "next"} slice of the review path explicit, ` +
          "with a pure module, an injected port and a test that fails on the old behaviour.",
        `Done when: the ${index}th invariant is covered, the failure message names the model and ` +
          "elapsed time, and the gate passes.",
        "",
        "Acceptance checks:",
        "- The path is exercised without a live provider.",
        "- The state transition is observable in the transcript.",
        "- A provider cut cannot hand over an unreviewed plan silently.",
        "",
      ].join("\n"),
    );
  }
  return [
    "# Plan: review path hardening",
    "",
    "## Context",
    "",
    "This plan exists to exercise a long rewrite through an OpenAI-compatible gateway. " +
      "It intentionally repeats a realistic section shape.",
    "",
    "## Steps",
    "",
    ...sections,
    "## Verification",
    "",
    "Run the unit suite, the host integration suite and one real review. " +
      "Record the provider, model, thinking level, wire and elapsed time.",
    "",
  ].join("\n");
}

/** The user prompt for a review-like rewrite. */
export function defaultReviewPrompt(planText = defaultPlanText()) {
  return [
    "Audit the plan below and rewrite it completely. Preserve every heading and requirement.",
    "Add only changes that are justified by the repository context. Do not omit sections.",
    "",
    "## Plan under review",
    "",
    "```markdown",
    planText,
    "```",
    "",
    "Return the complete revised plan now.",
  ].join("\n");
}

/** Chat Completions request body. */
export function buildChatBody(input) {
  const body = {
    model: input.model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: input.prompt },
    ],
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: input.maxTokens,
  };
  if (input.thinking && input.thinking !== "off") body.reasoning_effort = input.thinking;
  return body;
}

/** Responses request body. */
export function buildResponsesBody(input) {
  const body = {
    model: input.model,
    instructions: SYSTEM_PROMPT,
    input: [{ role: "user", content: input.prompt }],
    stream: true,
    store: false,
    max_output_tokens: input.maxTokens,
  };
  if (input.thinking && input.thinking !== "off") {
    body.reasoning = { effort: input.thinking, summary: "auto" };
    body.include = ["reasoning.encrypted_content"];
  }
  return body;
}

/** Build the body for one wire. */
export function buildBody(wire, input) {
  if (wire === "chat") return buildChatBody(input);
  if (wire === "responses") return buildResponsesBody(input);
  throw new Error(`unknown Command Code probe wire: ${String(wire)}`);
}

/** The Provider API URL for one wire. */
export function probeUrl(baseUrl, wire) {
  const root = String(baseUrl ?? "").replace(/\/+$/, "");
  if (!root) throw new Error("a Command Code base URL is required");
  return `${root}/${wire === "chat" ? "chat/completions" : "responses"}`;
}

/**
 * Read an API key from Pi's `auth.json` shape without interpreting anything
 * else. Returns the key, never logs it.
 */
export function commandCodeKeyFromAuth(auth) {
  if (!auth || typeof auth !== "object") return undefined;
  for (const id of ["command-code", "commandcode", "command_code"]) {
    const entry = auth[id];
    if (typeof entry === "string" && entry.trim()) return entry.trim();
    if (entry && typeof entry === "object") {
      for (const key of ["key", "apiKey", "api_key", "access"]) {
        const value = entry[key];
        if (typeof value === "string" && value.trim()) return value.trim();
      }
    }
  }
  if (typeof auth.apiKey === "string" && auth.apiKey.trim()) return auth.apiKey.trim();
  return undefined;
}

function errorMessage(error) {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || /aborted|timed out/i.test(error.message)) {
      return error.message;
    }
    return error.message;
  }
  return String(error);
}

function truncate(value, max = 240) {
  const string = String(value ?? "");
  return string.length > max ? `${string.slice(0, max)}…` : string;
}

function finishState(state, wire, now) {
  state.endedAt = now();
  const completed =
    wire === "chat" ? state.finishReason !== null : state.responseCompleted === true;
  const incomplete = wire === "responses" && state.responseIncomplete === true;
  const outcome = state.error
    ? "ERROR"
    : state.streamCut
      ? "CUT"
      : incomplete
        ? "INCOMPLETE"
        : !completed
          ? "CUT"
          : state.finishReason === "length"
            ? "LENGTH"
            : "OK";
  return {
    ...state,
    completed,
    incomplete,
    outcome,
    ok: outcome === "OK",
    cut: outcome === "CUT",
    diagnostic: state.streamCut ? CUT_ERROR : state.error,
    durationMs: state.endedAt - state.startedAt,
    terminalMs: state.terminalAt === null ? null : Math.max(0, state.terminalAt - state.startedAt),
  };
}

function createState(input, now) {
  return {
    wire: input.wire,
    model: input.model,
    thinking: input.thinking,
    maxTokens: input.maxTokens,
    url: input.url,
    startedAt: now(),
    headersAt: null,
    firstEventAt: null,
    lastChunkAt: null,
    terminalAt: null,
    endedAt: null,
    longestGapMs: 0,
    status: null,
    statusText: "",
    chunks: 0,
    bytes: 0,
    events: 0,
    parseErrors: 0,
    contentChars: 0,
    thinkingChars: 0,
    toolCallChars: 0,
    finishReason: null,
    rawStopReason: null,
    responseId: null,
    usage: null,
    doneMarker: false,
    responseCompleted: false,
    responseIncomplete: false,
    streamCut: false,
    error: null,
  };
}

function handleChatPayload(payload, state, now) {
  const choice = Array.isArray(payload.choices) ? payload.choices[0] : undefined;
  if (payload.usage) state.usage = payload.usage;
  if (choice?.finish_reason) {
    state.finishReason = choice.finish_reason;
    state.rawStopReason = choice.finish_reason;
    state.terminalAt = now();
  }
  const delta = choice?.delta;
  if (delta) {
    if (typeof delta.content === "string" && delta.content.length > 0) {
      state.contentChars += delta.content.length;
    }
    for (const field of THINKING_FIELDS) {
      const value = delta[field];
      if (typeof value === "string" && value.length > 0) {
        state.thinkingChars += value.length;
        break;
      }
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const call of delta.tool_calls) {
        const args = call?.function?.arguments;
        if (typeof args === "string") state.toolCallChars += args.length;
      }
    }
  }
}

function handleResponsesPayload(payload, state, now) {
  const type = typeof payload.type === "string" ? payload.type : "";
  if (type === "response.created" && payload.response?.id) {
    state.responseId = payload.response.id;
  }
  if (
    (type === "response.output_text.delta" || type === "response.refusal.delta") &&
    typeof payload.delta === "string"
  ) {
    state.contentChars += payload.delta.length;
  }
  if (
    (type === "response.reasoning_summary_text.delta" ||
      type === "response.reasoning_text.delta" ||
      type === "response.reasoning.delta") &&
    typeof payload.delta === "string"
  ) {
    state.thinkingChars += payload.delta.length;
  }
  if (type === "response.output_item.done" && payload.item?.type === "function_call") {
    const args = payload.item.arguments;
    state.toolCallChars +=
      typeof args === "string" ? args.length : JSON.stringify(args ?? "").length;
  }
  if (type === "response.completed") {
    state.responseCompleted = true;
    state.terminalAt = now();
    state.finishReason = payload.response?.status ?? "completed";
    state.responseId = payload.response?.id ?? state.responseId;
    if (payload.response?.usage) state.usage = payload.response.usage;
  }
  if (type === "response.incomplete") {
    state.responseIncomplete = true;
    state.terminalAt = now();
    state.finishReason = payload.response?.incomplete_details?.reason ?? "incomplete";
    state.responseId = payload.response?.id ?? state.responseId;
    if (payload.response?.usage) state.usage = payload.response.usage;
  }
  if (type === "response.failed") {
    state.terminalAt = now();
    state.error = payload.response?.error?.message ?? "response.failed";
    state.responseId = payload.response?.id ?? state.responseId;
  }
}

function handleData(data, wire, state, now) {
  if (data === "[DONE]") {
    state.doneMarker = true;
    return;
  }
  let payload;
  try {
    payload = JSON.parse(data);
  } catch {
    state.parseErrors += 1;
    return;
  }
  state.events += 1;
  if (wire === "chat") handleChatPayload(payload, state, now);
  else handleResponsesPayload(payload, state, now);
}

function handleLine(line, wire, state, now) {
  const trimmed = line.replace(/\r$/, "");
  if (!trimmed || trimmed.startsWith(":") || trimmed.startsWith("event:")) return;
  if (!trimmed.startsWith("data:")) return;
  handleData(trimmed.slice(5).trimStart(), wire, state, now);
}

async function consumeSse(body, wire, state, now) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const readChunk = async () => {
    const { done, value } = await reader.read();
    if (done || !value) return false;
    const at = now();
    state.chunks += 1;
    state.bytes += value.byteLength;
    if (state.firstEventAt === null) state.firstEventAt = at;
    if (state.lastChunkAt !== null) {
      const gap = at - state.lastChunkAt;
      state.longestGapMs = Math.max(state.longestGapMs ?? 0, gap);
    }
    state.lastChunkAt = at;
    buffer += decoder.decode(value, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 1);
      handleLine(line, wire, state, now);
    }
    return true;
  };
  try {
    for (;;) {
      if (!(await readChunk())) break;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // A closed/aborted stream may reject cancel; the metrics are still valid.
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) handleLine(buffer, wire, state, now);
}

/** Run one probe. Never throws for an HTTP/network/stream problem; returns it. */
export async function runProbe(options) {
  const input = {
    wire: options.wire,
    model: options.model ?? DEFAULT_MODEL,
    thinking: options.thinking ?? DEFAULT_THINKING,
    maxTokens: clampInt(options.maxTokens, DEFAULT_MAX_TOKENS, 1, 200_000),
    prompt: options.prompt ?? defaultReviewPrompt(),
    baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
    apiKey: options.apiKey,
    timeoutMs: clampInt(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1, 600_000),
    fetchImpl: options.fetchImpl ?? fetch,
    now: options.now ?? Date.now,
    ...(options.signal ? { signal: options.signal } : {}),
  };
  if (!input.apiKey) throw new Error("a Command Code API key is required");
  input.url = probeUrl(input.baseUrl, input.wire);
  const body = buildBody(input.wire, input);
  const state = createState(input, input.now);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("probe timed out")), input.timeoutMs);
  const signal = input.signal
    ? AbortSignal.any([input.signal, controller.signal])
    : controller.signal;
  try {
    let response;
    try {
      response = await input.fetchImpl(input.url, {
        method: "POST",
        headers: {
          accept: "text/event-stream",
          "content-type": "application/json",
          authorization: `Bearer ${input.apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      state.error = truncate(errorMessage(error));
      state.endedAt = input.now();
      state.terminalAt = state.endedAt;
      return finishState(state, input.wire, input.now);
    }
    state.headersAt = input.now();
    state.status = response.status;
    state.statusText = response.statusText;
    if (!response.ok) {
      state.error = truncate(`HTTP ${response.status}: ${await response.text().catch(() => "")}`);
      state.endedAt = input.now();
      state.terminalAt = state.endedAt;
      return finishState(state, input.wire, input.now);
    }
    if (!response.body) {
      state.error = "response has no body";
      return finishState(state, input.wire, input.now);
    }
    try {
      await consumeSse(response.body, input.wire, state, input.now);
    } catch (error) {
      state.error = truncate(errorMessage(error));
    }
    if (state.doneMarker && input.wire === "chat" && state.finishReason === null) {
      state.streamCut = true;
    }
    if (
      input.wire === "responses" &&
      !state.responseCompleted &&
      !state.responseIncomplete &&
      state.error === null
    ) {
      state.streamCut = true;
    }
    return finishState(state, input.wire, input.now);
  } finally {
    clearTimeout(timeout);
  }
}

/** Run the wire × thinking × max-token matrix sequentially. */
export async function runProbeMatrix(options) {
  const results = [];
  const wires = options.wires ?? PROBE_WIRES;
  const thinkings = options.thinkings ?? [DEFAULT_THINKING];
  const maxTokensList = options.maxTokensList ?? [DEFAULT_MAX_TOKENS];
  const runs = clampInt(options.runs, 1, 1, 5);
  for (const wire of wires) {
    for (const thinking of thinkings) {
      for (const maxTokens of maxTokensList) {
        for (let run = 1; run <= runs; run += 1) {
          const result = await runProbe({ ...options, wire, thinking, maxTokens });
          results.push({ ...result, run });
        }
      }
    }
  }
  return results;
}

function seconds(value) {
  if (value === null || value === undefined) return "—";
  return value < 1000 ? `${value}ms` : `${(value / 1000).toFixed(1)}s`;
}

function pad(value, width) {
  return String(value).padEnd(width, " ");
}

/** Render the probe matrix as a readable table. */
export function formatProbeTable(results) {
  const rows = results.map((result) => [
    result.wire,
    result.thinking,
    String(result.maxTokens),
    String(result.status ?? "—"),
    seconds(result.firstEventAt === null ? null : result.firstEventAt - result.startedAt),
    seconds(result.longestGapMs ?? 0),
    seconds(result.durationMs),
    result.outcome,
    result.finishReason ?? "—",
    String(result.contentChars),
    String(result.thinkingChars),
    result.diagnostic ? truncate(result.diagnostic, 60) : "",
  ]);
  const headers = [
    "wire",
    "thinking",
    "max",
    "HTTP",
    "first",
    "gap",
    "total",
    "outcome",
    "finish",
    "content",
    "think",
    "error",
  ];
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  const line = (cells) =>
    cells
      .map((cell, index) => pad(cell, widths[index]))
      .join(" | ")
      .trimEnd();
  const separator = widths.map((width) => "-".repeat(width)).join("-+-");
  return [line(headers), separator, ...rows.map(line)].join("\n");
}
