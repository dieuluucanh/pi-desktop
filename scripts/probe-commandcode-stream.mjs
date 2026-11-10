#!/usr/bin/env node
/**
 * Probe Command Code's Chat Completions and Responses wires with the same long,
 * review-like prompt and print a timing/terminal-reason table.
 *
 * This sends paid requests. It is gated behind `PI_COMMANDCODE_PROBE=1` so a
 * normal `node scripts/...` invocation cannot spend credit by accident.
 *
 * Usage:
 *   PI_COMMANDCODE_PROBE=1 node scripts/probe-commandcode-stream.mjs
 *   PI_COMMANDCODE_PROBE=1 node scripts/probe-commandcode-stream.mjs \
 *     --wire both --thinking high,max --max-tokens 32768,65536
 *   node scripts/probe-commandcode-stream.mjs --dry-run
 *
 * The API key is read from COMMAND_CODE_API_KEY / COMMANDCODE_API_KEY, else
 * `<profile>/auth.json` (`command-code`, `commandcode` or `command_code`). It is
 * never printed, and it is not part of `--json` output.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_BASE_URL,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODEL,
  DEFAULT_THINKING,
  DEFAULT_TIMEOUT_MS,
  PROBE_WIRES,
  buildBody,
  commandCodeKeyFromAuth,
  defaultReviewPrompt,
  formatProbeTable,
  probeUrl,
  runProbeMatrix,
} from "./lib/commandcode-probe.mjs";

const HELP = `Command Code wire probe (paid requests)

Usage:
  PI_COMMANDCODE_PROBE=1 node scripts/probe-commandcode-stream.mjs [options]

Options:
  --wire <chat|responses|both>   Wire(s) to probe (default: both)
  --thinking <a,b>               Reasoning effort(s) (default: ${DEFAULT_THINKING})
  --max-tokens <a,b>             Output cap(s) (default: ${DEFAULT_MAX_TOKENS})
  --runs <n>                     Repeats per cell, 1-5 (default: 1)
  --model <id>                   Model id (default: ${DEFAULT_MODEL})
  --base-url <url>               Provider API base (default: ${DEFAULT_BASE_URL})
  --plan-file <path>             Use this plan as the review input
  --prompt-file <path>           Use this complete user prompt instead
  --timeout-ms <n>               Per-request timeout (default: ${DEFAULT_TIMEOUT_MS})
  --auth-file <path>             Read the key from this auth.json
  --json                         Print machine-readable results
  --dry-run                      Print request bodies; sends nothing
  --help                         Show this help

Environment:
  PI_COMMANDCODE_PROBE=1         Required for a live run
  COMMAND_CODE_API_KEY           Key override
  COMMANDCODE_API_KEY            Key override
  PI_CODING_AGENT_DIR            Profile directory for auth.json
`;

function parseList(value) {
  return String(value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseArgs(argv) {
  const values = {
    wire: "both",
    thinking: DEFAULT_THINKING,
    maxTokens: String(DEFAULT_MAX_TOKENS),
    runs: "1",
    model: DEFAULT_MODEL,
    baseUrl: DEFAULT_BASE_URL,
    planFile: null,
    promptFile: null,
    timeoutMs: String(DEFAULT_TIMEOUT_MS),
    authFile: null,
    json: false,
    dryRun: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      values.help = true;
      continue;
    }
    if (arg === "--json") {
      values.json = true;
      continue;
    }
    if (arg === "--dry-run") {
      values.dryRun = true;
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined) throw new Error(`${arg} requires a value`);
    index += 1;
    switch (arg) {
      case "--wire":
        values.wire = next;
        break;
      case "--thinking":
        values.thinking = next;
        break;
      case "--max-tokens":
        values.maxTokens = next;
        break;
      case "--runs":
        values.runs = next;
        break;
      case "--model":
        values.model = next;
        break;
      case "--base-url":
        values.baseUrl = next;
        break;
      case "--plan-file":
        values.planFile = next;
        break;
      case "--prompt-file":
        values.promptFile = next;
        break;
      case "--timeout-ms":
        values.timeoutMs = next;
        break;
      case "--auth-file":
        values.authFile = next;
        break;
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }
  return values;
}

function parsePositiveInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function authPath(values) {
  if (values.authFile) return values.authFile;
  const profile = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
  return join(profile, "auth.json");
}

function resolveKey(values) {
  const envKey =
    process.env.COMMAND_CODE_API_KEY?.trim() || process.env.COMMANDCODE_API_KEY?.trim();
  if (envKey) return envKey;
  const path = authPath(values);
  let auth;
  try {
    auth = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `no API key found (COMMAND_CODE_API_KEY / COMMANDCODE_API_KEY unset and ${path} is unreadable): ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
  const key = commandCodeKeyFromAuth(auth);
  if (!key) {
    throw new Error(
      `no Command Code API key found in ${path} (expected command-code, commandcode or command_code)`,
    );
  }
  return key;
}

function readOptional(path) {
  if (!path) return undefined;
  return readFileSync(path, "utf8");
}

function wiresFor(value) {
  if (value === "both") return PROBE_WIRES;
  if (value === "chat" || value === "responses") return [value];
  throw new Error(`--wire must be chat, responses or both (got ${value})`);
}

function bodyForWire(wire, values, prompt) {
  return buildBody(wire, {
    model: values.model,
    prompt,
    thinking: parseList(values.thinking)[0] ?? DEFAULT_THINKING,
    maxTokens: parsePositiveInt(values.maxTokens, DEFAULT_MAX_TOKENS, 1, 200_000),
  });
}

async function main(argv) {
  const values = parseArgs(argv);
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const planText = readOptional(values.planFile);
  const prompt = readOptional(values.promptFile) ?? defaultReviewPrompt(planText);
  if (values.dryRun) {
    const bodies = wiresFor(values.wire).map((wire) => ({
      wire,
      url: probeUrl(values.baseUrl, wire),
      body: bodyForWire(wire, values, prompt),
    }));
    process.stdout.write(`${JSON.stringify(bodies, null, 2)}\n`);
    return 0;
  }
  if (process.env.PI_COMMANDCODE_PROBE !== "1") {
    process.stderr.write(
      "Refusing to send paid requests. Set PI_COMMANDCODE_PROBE=1 to enable the live probe " +
        "(or use --dry-run).\n",
    );
    return 2;
  }
  const apiKey = resolveKey(values);
  const thinkings = parseList(values.thinking);
  const maxTokensList = parseList(values.maxTokens).map((entry) =>
    parsePositiveInt(entry, DEFAULT_MAX_TOKENS, 1, 200_000),
  );
  const results = await runProbeMatrix({
    wire: "chat",
    wires: wiresFor(values.wire),
    thinkings: thinkings.length > 0 ? thinkings : [DEFAULT_THINKING],
    maxTokensList: maxTokensList.length > 0 ? maxTokensList : [DEFAULT_MAX_TOKENS],
    runs: parsePositiveInt(values.runs, 1, 1, 5),
    model: values.model,
    baseUrl: values.baseUrl,
    prompt,
    apiKey,
    timeoutMs: parsePositiveInt(values.timeoutMs, DEFAULT_TIMEOUT_MS, 1, 600_000),
  });
  if (values.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          model: values.model,
          baseUrl: values.baseUrl,
          runs: results.map((result) => ({
            ...result,
            apiKey: undefined,
          })),
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write(
      [
        `model: ${values.model}`,
        `base URL: ${values.baseUrl}`,
        `key: (not printed)`,
        "",
        formatProbeTable(results),
        "",
      ].join("\n"),
    );
  }
  return results.every((result) => result.outcome === "ERROR") ? 1 : 0;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(
      `probe-commandcode-stream: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
