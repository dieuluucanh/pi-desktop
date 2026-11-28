/**
 * SDK-side ports for the composer-transform operation host (row 14).
 *
 * The operation registry is SDK-free. This adapter is the only place that
 * touches the live `ExtensionRunner`: it forwards `getRegisteredCommands()`
 * provenance, runs the resolved companion's **existing string handler** with a
 * real `createCommandContext()`, and supplies Node's CSPRNG.
 *
 * No SDK method is added or monkey-patched. The companion receives only the
 * grant-only bootstrap string; the typed operation port travels through the
 * private in-process EventBus rendezvous.
 */

import { randomBytes as nodeRandomBytes } from "node:crypto";
import type {
  ComposerTransformBus,
  ComposerTransformClock,
  ComposerTransformControlPort,
  ComposerTransformHost,
  ComposerTransformHostOptions,
} from "../composer-transform";
import { createComposerTransformHost } from "../composer-transform";
import { runCommand, type CommandRunner } from "../commands";
import type {
  ComposerCommandRegistration,
  ComposerCommandSourceInfo,
} from "../../shared/composer-transform";

/** The narrow live `ExtensionRunner` surface the adapter reads. */
export interface SdkComposerTransformRunner {
  getRegisteredCommands?(): readonly unknown[];
}

export interface SdkComposerTransformOptions {
  bus?: ComposerTransformBus | null;
  /** Live raw registrations (`getRegisteredCommands()`), recomputed per call. */
  registrations(): readonly unknown[];
  /** The live command runner (string handler + real command context). */
  commands(): CommandRunner | null;
  /** The host contribution registry resolver (owner/control/revision). */
  controls: ComposerTransformControlPort;
  binding(): { sessionId: string | null; epoch: number };
  emit?(event: string, payload?: unknown, sessionId?: string): void;
  onError?(error: unknown): void;
  log?(line: string): void;
  clock?: ComposerTransformClock;
  /** Deterministic in tests; production uses Node's CSPRNG. */
  randomBytes?: (size: number) => Uint8Array;
  ttlMs?: number;
  receiptTtlMs?: number;
  maxRetained?: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function sourceInfoOf(value: unknown): ComposerCommandSourceInfo | undefined {
  const record = asRecord(value);
  const path = typeof record.path === "string" ? record.path : undefined;
  const source = typeof record.source === "string" ? record.source : undefined;
  const scope = typeof record.scope === "string" ? record.scope : undefined;
  if (path === undefined && source === undefined && scope === undefined) return undefined;
  return {
    ...(path === undefined ? {} : { path }),
    ...(source === undefined ? {} : { source }),
    ...(scope === undefined ? {} : { scope }),
  };
}

/** Projects live SDK registrations into the provenance-only contract. */
export function composerCommandRegistrations(
  registrations: readonly unknown[],
): ComposerCommandRegistration[] {
  const out: ComposerCommandRegistration[] = [];
  for (const raw of registrations) {
    const record = asRecord(raw);
    const name = typeof record.name === "string" ? record.name : "";
    if (name.length === 0) continue;
    const sourceInfo = sourceInfoOf(record.sourceInfo);
    out.push({ name, ...(sourceInfo === undefined ? {} : { sourceInfo }) });
  }
  return out;
}

/** Node CSPRNG behind the injected-port boundary. */
export function nodeComposerRandomBytes(size: number): Uint8Array {
  return new Uint8Array(nodeRandomBytes(size));
}

export function createSdkComposerTransformHost(
  options: SdkComposerTransformOptions,
): ComposerTransformHost {
  const randomBytes = options.randomBytes ?? nodeComposerRandomBytes;
  const hostOptions: ComposerTransformHostOptions = {
    controls: options.controls,
    bus: options.bus ?? null,
    binding: options.binding,
    randomBytes,
    commands: {
      list: () => composerCommandRegistrations(options.registrations()),
    },
    companion: {
      async invoke(name, args) {
        const runner = options.commands();
        if (!runner) {
          return { ran: false, error: "no live extension command runner" };
        }
        const result = await runCommand(runner, name, args, (report) => {
          try {
            options.onError?.(report);
          } catch {
            /* reporting must not change the command outcome */
          }
        });
        return {
          ran: result.ran,
          ...(result.error === undefined ? {} : { error: result.error }),
        };
      },
    },
    ...(options.emit ? { emit: options.emit } : {}),
    ...(options.onError ? { onError: options.onError } : {}),
    ...(options.log ? { log: options.log } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
    ...(options.receiptTtlMs === undefined ? {} : { receiptTtlMs: options.receiptTtlMs }),
    ...(options.maxRetained === undefined ? {} : { maxRetained: options.maxRetained }),
  };
  return createComposerTransformHost(hostOptions);
}
