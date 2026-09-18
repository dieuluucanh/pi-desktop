/**
 * A stateful `reg.exe` test double.
 *
 * Mirrors the behaviour the app depends on: hives are echoed in long form,
 * `query /s` walks descendants, values with empty data omit the last column, and
 * a missing key exits non-zero. This lets the sideload/verify/troubleshoot tests
 * exercise the real read-after-write path instead of canned output.
 */

import type { CommandRunner, CommandResult } from "../../src/main/office/exec";
import { normalizeRegistryPath } from "../../src/main/office/registry";

interface StoredValue {
  type: string;
  data: string;
}

export interface StatefulRegistryFake extends CommandRunner {
  keys: Map<string, Map<string, StoredValue>>;
  calls: Array<{ command: string; args: readonly string[] }>;
}

const HIVE_LONG_FORM: Record<string, string> = {
  HKEY_LOCAL_MACHINE: "HKEY_LOCAL_MACHINE",
  HKEY_CURRENT_USER: "HKEY_CURRENT_USER",
  HKEY_CLASSES_ROOT: "HKEY_CLASSES_ROOT",
  HKEY_USERS: "HKEY_USERS",
  HKEY_CURRENT_CONFIG: "HKEY_CURRENT_CONFIG",
};

function displayPath(normalized: string): string {
  const [hive, ...rest] = normalized.split("\\");
  const longHive = HIVE_LONG_FORM[hive ?? ""] ?? hive ?? "";
  return [longHive, ...rest].join("\\");
}

export function createStatefulRegistryFake(
  initial?: Record<string, Record<string, string>>,
): StatefulRegistryFake {
  const keys = new Map<string, Map<string, StoredValue>>();
  const calls: Array<{ command: string; args: readonly string[] }> = [];

  const ensureKey = (path: string): Map<string, StoredValue> => {
    const normalized = normalizeRegistryPath(path);
    let values = keys.get(normalized);
    if (!values) {
      values = new Map();
      keys.set(normalized, values);
    }
    return values;
  };

  for (const [keyPath, values] of Object.entries(initial ?? {})) {
    const target = ensureKey(keyPath);
    for (const [name, data] of Object.entries(values)) {
      target.set(name, { type: "REG_SZ", data });
    }
  }

  const respond = (args: readonly string[], code: number, stdout = "", stderr = ""): CommandResult => ({
    command: "reg.exe",
    args: [...args],
    code,
    stdout,
    stderr,
    missing: false,
  });

  return {
    keys,
    calls,
    run(_command, args) {
      calls.push({ command: "reg.exe", args: [...args] });
      const [verb, keyPath] = args;

      if (verb === "query" && keyPath) {
        const normalized = normalizeRegistryPath(keyPath);
        const recursive = args.includes("/s");
        if (!keys.has(normalized)) {
          return Promise.resolve(
            respond(args, 1, "", "ERROR: The system was unable to find the specified registry key or value."),
          );
        }

        const targets = [...keys.keys()].filter(
          (candidate) =>
            candidate === normalized ||
            (recursive && candidate.startsWith(`${normalized}\\`)),
        );
        const lines: string[] = [];
        for (const target of targets) {
          lines.push(displayPath(target));
          for (const [name, value] of keys.get(target) ?? []) {
            lines.push(
              value.data.length > 0
                ? `    ${name}    ${value.type}    ${value.data}`
                : `    ${name}    ${value.type}`,
            );
          }
          lines.push("");
        }
        return Promise.resolve(respond(args, 0, `${lines.join("\r\n")}\r\n`));
      }

      if (verb === "add" && keyPath) {
        const nameIndex = args.indexOf("/v");
        const dataIndex = args.indexOf("/d");
        const typeIndex = args.indexOf("/t");
        const name = nameIndex >= 0 ? args[nameIndex + 1] : undefined;
        const data = dataIndex >= 0 ? (args[dataIndex + 1] ?? "") : "";
        const type = typeIndex >= 0 ? (args[typeIndex + 1] ?? "REG_SZ") : "REG_SZ";
        if (name === undefined) {
          return Promise.resolve(respond(args, 1, "", "ERROR: Invalid syntax."));
        }
        ensureKey(keyPath).set(name, { type, data });
        return Promise.resolve(respond(args, 0, "The operation completed successfully.\r\n"));
      }

      if (verb === "delete" && keyPath) {
        const nameIndex = args.indexOf("/v");
        const name = nameIndex >= 0 ? args[nameIndex + 1] : undefined;
        const normalized = normalizeRegistryPath(keyPath);
        const values = keys.get(normalized);
        if (!values || (name !== undefined && !values.has(name))) {
          return Promise.resolve(respond(args, 1, "", "ERROR: The system was unable to find the specified registry key or value."));
        }
        if (name !== undefined) values.delete(name);
        else keys.delete(normalized);
        return Promise.resolve(respond(args, 0, "The operation completed successfully.\r\n"));
      }

      return Promise.resolve(respond(args, 1, "", `ERROR: unsupported reg.exe invocation: ${args.join(" ")}`));
    },
  };
}
