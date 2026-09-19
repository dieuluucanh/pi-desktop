/**
 * Minimal Windows registry access via `reg.exe`.
 *
 * No native modules: the app shells out to `reg.exe` (present on every
 * supported Windows version), which keeps packaged builds simple and makes the
 * probing fully unit-testable through the injected CommandRunner.
 */

import type { CommandRunner, CommandResult } from "./exec";

export const REG_EXE = "reg.exe";

/** `reg.exe` echoes the long hive name even when addressed with the short form. */
const HIVE_ALIASES: Record<string, string> = {
  HKLM: "HKEY_LOCAL_MACHINE",
  HKCU: "HKEY_CURRENT_USER",
  HKCR: "HKEY_CLASSES_ROOT",
  HKU: "HKEY_USERS",
  HKCC: "HKEY_CURRENT_CONFIG",
};

/** Expands a hive alias and upper-cases a key path for comparison. */
export function normalizeRegistryPath(key: string): string {
  const trimmed = key.trim();
  const match = /^(HK[A-Z_]+)(\\.*)?$/i.exec(trimmed);
  if (!match) return trimmed.toUpperCase();
  const hive = (match[1] ?? "").toUpperCase();
  const rest = match[2] ?? "";
  return `${HIVE_ALIASES[hive] ?? hive}${rest}`.toUpperCase();
}

export interface RegistryValue {
  name: string;
  type: string;
  data: string;
}

export interface RegistryKey {
  path: string;
  values: RegistryValue[];
}

/**
 * `reg.exe` separates columns with four spaces. The data column may be absent
 * entirely (real output emits `    ScenarioCulture    REG_SZ` with nothing after
 * the type), which must not be mistaken for a wrapped continuation line.
 */
const VALUE_LINE_RE = /^\s+(.*?)\s{4}(REG_[A-Z_]+)(?:\s{4}(.*))?$/;
/**
 * Key header lines: `reg.exe` echoes the hive exactly as it was addressed, so
 * both `HKEY_LOCAL_MACHINE\...` and the abbreviated `HKLM\...` forms appear.
 */
const KEY_LINE_RE = /^(HK[A-Z_]+(?:\\[^\r\n]*)?)$/;
const CONTINUATION_RE = /^\s+\S/;

/**
 * Parses `reg query` / `reg query /s` output into keys with their values.
 *
 * Handles: empty keys, `(Default)` values, `(value not set)`, subkey headers and
 * continuation lines emitted when a value is longer than the console width.
 */
export function parseRegQueryOutput(output: string): RegistryKey[] {
  const keys: RegistryKey[] = [];
  let current: RegistryKey | undefined;
  let lastValue: RegistryValue | undefined;

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, "");
    if (line.length === 0) {
      lastValue = undefined;
      continue;
    }

    const keyMatch = KEY_LINE_RE.exec(line);
    if (keyMatch?.[1]) {
      current = { path: keyMatch[1], values: [] };
      keys.push(current);
      lastValue = undefined;
      continue;
    }

    if (!current) continue;

    const valueMatch = VALUE_LINE_RE.exec(line);
    if (valueMatch) {
      const value: RegistryValue = {
        name: (valueMatch[1] ?? "").trim(),
        type: valueMatch[2] ?? "",
        data: (valueMatch[3] ?? "").trim(),
      };
      current.values.push(value);
      lastValue = value;
      continue;
    }

    if (lastValue && CONTINUATION_RE.test(line)) {
      lastValue.data = `${lastValue.data}${line.trim()}`;
    }
  }

  return keys;
}

/** Reads one key (values only, no recursion). Returns null when it does not exist. */
export async function queryRegistryKey(
  runner: CommandRunner,
  key: string,
  options?: { timeoutMs?: number },
): Promise<RegistryKey | null> {
  const result = await runner.run(REG_EXE, ["query", key], options);
  if (result.code !== 0) return null;
  const keys = parseRegQueryOutput(result.stdout);
  const wanted = normalizeRegistryPath(key);
  return (
    keys.find((candidate) => normalizeRegistryPath(candidate.path) === wanted) ?? keys[0] ?? null
  );
}

/** Reads a key and all of its subkeys (`reg query <key> /s`). */
export async function queryRegistryTree(
  runner: CommandRunner,
  key: string,
  options?: { timeoutMs?: number },
): Promise<RegistryKey[]> {
  const result = await runner.run(REG_EXE, ["query", key, "/s"], options);
  if (result.code !== 0) return [];
  return parseRegQueryOutput(result.stdout);
}

export function readRegistryValue(key: RegistryKey | null, valueName: string): string | null {
  if (!key) return null;
  const wanted = valueName.toUpperCase();
  const value = key.values.find((candidate) => candidate.name.toUpperCase() === wanted);
  if (!value) return null;
  const data = value.data.trim();
  if (data.length === 0 || data === "(value not set)") return null;
  return data;
}

/** Lists subkey paths directly below `key`. */
export async function listRegistrySubkeys(
  runner: CommandRunner,
  key: string,
  options?: { timeoutMs?: number },
): Promise<string[]> {
  const result = await runner.run(REG_EXE, ["query", key], options);
  if (result.code !== 0) return [];
  const wanted = normalizeRegistryPath(key);
  return parseRegQueryOutput(result.stdout)
    .map((candidate) => candidate.path)
    .filter((candidate) => normalizeRegistryPath(candidate) !== wanted);
}

/** Writes a value, creating the key when needed (`/f` overwrites). */
export async function addRegistryValue(
  runner: CommandRunner,
  key: string,
  name: string,
  data: string,
  type = "REG_SZ",
): Promise<CommandResult> {
  return runner.run(REG_EXE, ["add", key, "/v", name, "/t", type, "/d", data, "/f"]);
}

/** Deletes a single value. Succeeds silently when it is already gone. */
export async function deleteRegistryValue(
  runner: CommandRunner,
  key: string,
  name: string,
): Promise<CommandResult> {
  return runner.run(REG_EXE, ["delete", key, "/v", name, "/f"]);
}
