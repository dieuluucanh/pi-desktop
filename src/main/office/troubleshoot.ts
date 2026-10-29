/**
 * Step 5 of the Pi for Office setup wizard: troubleshooting + diagnostics.
 *
 * `buildTroubleshooting` turns the wizard state into ranked, actionable items
 * (port in use, Office missing, add-in not appearing, WSL/remote, version skew).
 * `buildDiagnosticsBundle` produces the text behind the "Copy diagnostics"
 * button — always passed through secret redaction, so it is safe to paste into
 * an issue.
 */

import { PI_FOR_OFFICE, PI_OFFICE_BRIDGE, officeHostLabel } from "../../shared/office";
import { DIAGNOSTIC_ENV_KEYS } from "../../shared/diagnostics";
import type { OfficeDetectionResult, OfficeOs } from "./types";
import type { BridgeInstallResult } from "./bridge-install";
import type { SideloadResult } from "./sideload";
import type { BridgeHealthCheck, BridgePane, ChecklistStep } from "./verify";

export type TroubleshootSeverity = "error" | "warning" | "info";

export interface TroubleshootItem {
  id: string;
  severity: TroubleshootSeverity;
  title: string;
  detail: string;
  actions: string[];
}

export interface TroubleshootInput {
  platform: OfficeOs;
  isWsl: boolean;
  detection: OfficeDetectionResult | null;
  bridge: BridgeInstallResult | null;
  sideload: SideloadResult | null;
  health: BridgeHealthCheck | null;
  panes: readonly BridgePane[];
  port: number;
}

export function buildTroubleshooting(input: TroubleshootInput): TroubleshootItem[] {
  const items: TroubleshootItem[] = [];
  const detection = input.detection;
  const port = input.port;

  if (!detection) {
    items.push({
      id: "no-detection",
      severity: "info",
      title: "Environment not inspected yet",
      detail: "Run the setup wizard to detect Office on this machine.",
      actions: [],
    });
  } else if (!detection.supported) {
    items.push({
      id: "platform-unsupported",
      severity: "info",
      title: "Desktop Office is unavailable on this platform",
      detail:
        "The Pi for Office add-in and the local bridge need a desktop Office host (Windows or macOS).",
      actions: [
        `Open Office on the web instead: ${PI_FOR_OFFICE.officeOnTheWebUrl}`,
        "In Office on the web: Insert → Add-ins → More Add-ins → My Add-ins → Upload My Add-in, then pick the manifest.",
      ],
    });
  } else if (!detection.anyAppInstalled) {
    items.push({
      id: "office-not-installed",
      severity: "warning",
      title: "Microsoft Office was not found",
      detail:
        "No Excel, Word, or PowerPoint installation was detected. The add-in can still run in Office on the web.",
      actions: [
        `Install Office, or use Office on the web: ${PI_FOR_OFFICE.officeOnTheWebUrl}`,
        "After installing Office, re-run detection.",
      ],
    });
  }

  if (input.isWsl) {
    items.push({
      id: "wsl",
      severity: "warning",
      title: "WSL detected",
      detail:
        "Office runs on the Windows host, so it must reach the bridge at 127.0.0.1 on Windows. A bridge running inside WSL is not reachable from Office.",
      actions: [
        "Run Pi Desktop (and therefore the bridge) on Windows, not inside WSL.",
        `Or forward the port explicitly and point the add-in at it (${PI_OFFICE_BRIDGE.envPort}).`,
      ],
    });
  }

  if (input.bridge?.status === "failed") {
    items.push({
      id: "bridge-install-failed",
      severity: "error",
      title: `Could not install ${PI_OFFICE_BRIDGE.packageName}`,
      detail: input.bridge.error ?? "The package install failed.",
      actions: [
        "Check your network, proxy, or npm registry access and retry.",
        `Install manually if needed: npm install ${PI_OFFICE_BRIDGE.packageName}`,
      ],
    });
  }

  if (input.sideload) {
    const stale =
      input.sideload.verification?.sideload.entries.filter((entry) => !entry.manifestExists) ?? [];
    if (stale.length > 0) {
      items.push({
        id: "sideload-stale",
        severity: "warning",
        title: "A sideload entry points at a missing manifest",
        detail: stale.map((entry) => entry.manifestPath).join("\n"),
        actions: ["Re-run the sideload step (it rewrites the entry and the copy)."],
      });
    }

    const ours =
      input.sideload.verification?.sideload.entries.filter((entry) => entry.matchesPiForOffice) ??
      [];
    if (ours.length > 0 && ours.every((entry) => !entry.matchesProdSource)) {
      items.push({
        id: "sideload-outdated",
        severity: "warning",
        title: "The sideloaded manifest is not the current hosted add-in",
        detail:
          "The registered manifest points at a local/dev task pane, so Office will load a development build.",
        actions: [
          "Re-run the sideload step to register the hosted manifest.",
          `Or upload it manually: Insert → My Add-ins → Upload My Add-in… (${PI_FOR_OFFICE.sourceLocation}).`,
        ],
      });
    }
  }

  if (input.health?.portConflict) {
    const findCommand =
      input.platform === "windows"
        ? `netstat -ano | findstr :${port}`
        : `lsof -nP -iTCP:${port} -sTCP:LISTEN`;
    items.push({
      id: "port-in-use",
      severity: "error",
      title: `Port ${port} is already in use`,
      detail:
        input.health.error ??
        `Another program owns port ${port}, so the bridge cannot listen and the add-in cannot connect.`,
      actions: [
        `Find the process: ${findCommand}`,
        "Close that program, then restart the Pi for Office session.",
        `Or run the Office session on another port by setting ${PI_OFFICE_BRIDGE.envPort} (then update the add-in's bridge URL).`,
      ],
    });
  }

  if (input.health && input.health.status === "unreachable") {
    items.push({
      id: "bridge-not-listening",
      severity: input.panes.length > 0 ? "info" : "warning",
      title: "The bridge is not listening yet",
      detail:
        "No Pi session is hosting the Office bridge on this port, so the add-in has nothing to connect to.",
      actions: [
        "Start (or restart) the Pi for Office session — the session process hosts the bridge.",
        `Confirm with: curl http://127.0.0.1:${port}${PI_OFFICE_BRIDGE.healthPath}`,
      ],
    });
  }

  const sideloadOk = input.sideload?.verified ?? false;
  if (sideloadOk && input.panes.length === 0 && input.health?.status === "ok") {
    items.push({
      id: "pane-not-attached",
      severity: "warning",
      title: "The add-in is not connected yet",
      detail:
        "The manifest is registered and the bridge is listening, but no task pane has attached.",
      actions: [
        "In Office: Insert → My Add-ins → Pi for Office (or the Add-ins button on the Home ribbon).",
        "Fully quit and reopen the Office app so the manifest is re-read.",
        "If Pi for Office is missing from My Add-ins, use Insert → My Add-ins → Upload My Add-in… with the manifest file.",
      ],
    });
  }

  const health = input.health?.health;
  if (health?.protocolVersion !== null && health?.protocolVersion !== undefined) {
    const protocol = health.protocolVersion;
    const known = PI_OFFICE_BRIDGE.knownProtocolVersion;
    if (protocol > known) {
      // Additive protocol changes keep old clients working, so a newer bridge is
      // informational: it may simply offer features this app does not use yet.
      items.push({
        id: "bridge-newer",
        severity: "info",
        title: "The bridge is newer than this app",
        detail: `Bridge protocol v${protocol}; this app targets v${known}. Additive changes stay compatible, so everything keeps working.`,
        actions: [],
      });
    } else if (protocol < 2) {
      items.push({
        id: "bridge-version-skew",
        severity: "error",
        title: "The bridge is too old to connect",
        detail: `Bridge protocol v${protocol} — this app speaks v2 or newer, so the add-in handshake is rejected with protocol_mismatch.`,
        actions: [`Update the bridge: npm install ${PI_OFFICE_BRIDGE.packageName}@latest`],
      });
    } else if (protocol < known) {
      items.push({
        id: "bridge-version-skew",
        severity: "warning",
        title: "The bridge uses an older protocol",
        detail: `Bridge protocol v${protocol}; this app targets v${known}. The bridge still connects, but replies arrive only as a single final message — no streamed text while the agent works, and the add-in cannot stop a run from the task pane.`,
        actions: [
          `Update the bridge for streaming replies: npm install ${PI_OFFICE_BRIDGE.packageName}@latest`,
          "Restart the Office session afterwards so the extension reloads.",
        ],
      });
    }
    if (
      health.catalogVersion !== null &&
      health.catalogVersion < PI_OFFICE_BRIDGE.knownCatalogVersion
    ) {
      items.push({
        id: "catalog-version-skew",
        severity: "info",
        title: "The bridge exposes an older tool catalog",
        detail: `Catalog v${health.catalogVersion} (v${PI_OFFICE_BRIDGE.knownCatalogVersion} is expected). Newer office_* tools may be missing.`,
        actions: ["Update the bridge package to get the full tool set."],
      });
    }
  }

  const foreign = (detection?.sideload.entries ?? []).filter(
    (entry) => entry.manifestExists && !entry.matchesPiForOffice,
  );
  if (foreign.length > 0) {
    items.push({
      id: "other-addins",
      severity: "info",
      title: `${foreign.length} other sideloaded add-in${foreign.length === 1 ? "" : "s"} found`,
      detail: foreign
        .map((entry) => `${entry.manifestDisplayName ?? entry.manifestPath}`)
        .join("\n"),
      actions: ["Pi Desktop never modifies other add-ins; they are listed for context only."],
    });
  }

  if (input.panes.length > 0) {
    const hosts = [
      ...new Set(input.panes.map((pane) => (pane.host ? officeHostLabel(pane.host) : "Office"))),
    ];
    items.push({
      id: "connected",
      severity: "info",
      title: `Connected to ${hosts.join(", ")}`,
      detail: input.panes
        .map(
          (pane) =>
            `${pane.host ? officeHostLabel(pane.host) : "Office"} · ${pane.documentName ?? pane.documentId ?? "document"}`,
        )
        .join("\n"),
      actions: ["You can close this wizard; the Office session keeps the bridge alive."],
    });
  }

  const rank: Record<TroubleshootSeverity, number> = { error: 0, warning: 1, info: 2 };
  return items.sort((left, right) => rank[left.severity] - rank[right.severity]);
}

/* -------------------------------------------------------------- redaction */

const SECRET_PATTERNS: ReadonlyArray<{ name: string; re: RegExp; replace: string }> = [
  { name: "anthropic-key", re: /sk-ant-[A-Za-z0-9_-]{8,}/g, replace: "sk-ant-***REDACTED***" },
  { name: "openai-key", re: /sk-[A-Za-z0-9_-]{16,}/g, replace: "sk-***REDACTED***" },
  { name: "github-pat", re: /github_pat_[A-Za-z0-9_]{20,}/g, replace: "github_pat_***REDACTED***" },
  { name: "github-token", re: /gh[pousr]_[A-Za-z0-9]{20,}/g, replace: "gh***_REDACTED***" },
  { name: "slack-token", re: /xox[abprs]-[A-Za-z0-9-]{10,}/g, replace: "xox*-***REDACTED***" },
  { name: "aws-key", re: /AKIA[0-9A-Z]{16}/g, replace: "AKIA***REDACTED***" },
  { name: "bearer", re: /(Bearer\s+)[A-Za-z0-9\-._~+/]{12,}=*/gi, replace: "$1***REDACTED***" },
  {
    name: "inline-secret",
    re: /("?(?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|secret)"?\s*[:=]\s*"?)([A-Za-z0-9\-._~+/]{8,})/gi,
    replace: "$1***REDACTED***",
  },
  {
    // The address inside an identity (`Name <ada@example.com>`). The rail shows
    // it in full — that is the user's own machine, and the identity is what the
    // commit box edits — but a support bundle pasted into a public issue must not
    // carry it. Every other pattern here is key- or prefix-shaped and would never
    // match a bare address, so this needs its own rule (git-checkpoint step 28).
    // The display name is kept: it identifies the author without leaking a
    // contact address.
    name: "email-in-identity",
    re: /<[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}>/g,
    replace: "<***@***>",
  },
  {
    // A bare address (`user.email` output, a hint line in the rail's copy).
    name: "bare-email",
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    replace: "***@***",
  },
];

export interface RedactionResult {
  text: string;
  redactions: number;
}

export function redactSecrets(text: string): RedactionResult {
  let output = text;
  let redactions = 0;
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern.re, (...args: unknown[]) => {
      redactions += 1;
      const replacement = pattern.replace;
      if (replacement.includes("$1")) {
        const groups = args.slice(1, -2) as string[];
        return replacement.replace("$1", groups[0] ?? "");
      }
      return replacement;
    });
  }
  return { text: output, redactions };
}

/* ------------------------------------------------------------- diagnostics */

export interface DiagnosticsInput {
  app: {
    name: string;
    version: string;
    electron: string | null;
    node: string | null;
    chrome?: string | null;
    platform: string;
    arch: string;
    osRelease: string | null;
    isWsl: boolean;
  };
  profile: {
    agentDir: string;
    cwd: string;
    settingsPath: string;
    npmRoot: string;
  };
  port: number;
  detection: OfficeDetectionResult | null;
  bridge: BridgeInstallResult | null;
  sideload: SideloadResult | null;
  health: BridgeHealthCheck | null;
  panes: readonly BridgePane[];
  checklist: readonly ChecklistStep[];
  troubleshooting: readonly TroubleshootItem[];
  env?: Record<string, string | undefined>;
  extra?: Record<string, string>;
  now?: () => Date;
}

export function buildDiagnosticsBundle(input: DiagnosticsInput): {
  text: string;
  generatedAt: string;
  redactions: number;
} {
  const generatedAt = (input.now?.() ?? new Date()).toISOString();
  const lines: string[] = [];

  lines.push("Pi Desktop — diagnostics bundle");
  lines.push(`generated: ${generatedAt}`);
  lines.push("");
  lines.push("## App");
  lines.push(`name: ${input.app.name} ${input.app.version}`);
  lines.push(
    `electron: ${input.app.electron ?? "?"} · node: ${input.app.node ?? "?"} · chrome: ${input.app.chrome ?? "?"}`,
  );
  lines.push(
    `os: ${input.app.platform} ${input.app.arch}${input.app.isWsl ? " (WSL)" : ""}${input.app.osRelease ? ` · ${input.app.osRelease}` : ""}`,
  );
  lines.push("");
  lines.push("## Profile");
  lines.push(`agentDir: ${input.profile.agentDir}`);
  lines.push(`cwd: ${input.profile.cwd}`);
  lines.push(`settings: ${input.profile.settingsPath}`);
  lines.push(`npmRoot: ${input.profile.npmRoot}`);
  lines.push(`bridgePort: ${input.port}`);
  lines.push("");
  lines.push("## Environment");
  for (const key of DIAGNOSTIC_ENV_KEYS) {
    const value = input.env?.[key];
    if (value === undefined) continue;
    lines.push(`${key}=${value}`);
  }
  if (input.extra) {
    for (const [key, value] of Object.entries(input.extra)) lines.push(`${key}=${value}`);
  }
  lines.push("");

  lines.push("## Office detection");
  if (input.detection) {
    lines.push(formatDetectionSection(input.detection));
  } else {
    lines.push("(not run)");
  }
  lines.push("");

  lines.push("## Bridge package");
  if (input.bridge) {
    lines.push(`status: ${input.bridge.status}`);
    lines.push(`spec: ${input.bridge.spec}`);
    if (input.bridge.previousSpec) lines.push(`previous: ${input.bridge.previousSpec}`);
    lines.push(
      `installed: ${input.bridge.state.installed ? "yes" : "no"}${input.bridge.state.version ? ` v${input.bridge.state.version}` : ""}`,
    );
    if (input.bridge.state.extensionEntry)
      lines.push(`extension: ${input.bridge.state.extensionEntry}`);
    for (const step of input.bridge.steps)
      lines.push(`  - ${step.name}: ${step.ok ? "ok" : "FAILED"} — ${step.detail}`);
    if (input.bridge.error) lines.push(`error: ${input.bridge.error}`);
    if (input.bridge.installLog) lines.push(`install log (tail):\n${input.bridge.installLog}`);
  } else {
    lines.push("(not run)");
  }
  lines.push("");

  lines.push("## Sideload");
  if (input.sideload) {
    lines.push(`ok: ${input.sideload.ok} · verified: ${input.sideload.verified}`);
    lines.push(`manifest: ${input.sideload.manifestPath} (id ${input.sideload.manifestId ?? "?"})`);
    for (const note of input.sideload.plan.notes) lines.push(`  plan: ${note}`);
    for (const action of input.sideload.actions) {
      lines.push(
        `  - ${action.kind} ${action.target}: ${action.ok ? "ok" : "FAILED"} — ${action.detail}`,
      );
    }
    if (input.sideload.error) lines.push(`error: ${input.sideload.error}`);
  } else {
    lines.push("(not run)");
  }
  lines.push("");

  lines.push("## Bridge health");
  if (input.health) {
    lines.push(`url: ${input.health.url}`);
    lines.push(
      `status: ${input.health.status} · http: ${input.health.httpStatus ?? "?"} · portConflict: ${input.health.portConflict}`,
    );
    if (input.health.health) {
      const health = input.health.health;
      lines.push(
        `server: ${health.serverName} ${health.serverVersion ?? "?"} · pi ${health.piVersion ?? "?"}`,
      );
      lines.push(
        `protocol: v${health.protocolVersion ?? "?"} · catalog: v${health.catalogVersion ?? "?"}`,
      );
      lines.push(`capabilities: ${health.capabilities.join(", ") || "(none)"}`);
    }
    if (input.health.error) lines.push(`error: ${input.health.error}`);
  } else {
    lines.push("(not checked)");
  }
  lines.push("");

  lines.push(`## Attached panes (${input.panes.length})`);
  for (const pane of input.panes) {
    const host = pane.host ? officeHostLabel(pane.host) : "unknown";
    lines.push(
      `- ${host} · ${pane.documentName ?? "(unnamed)"} · id=${pane.documentId ?? "?"} · focused=${pane.focused} · visible=${pane.visible} · windows=${pane.windows} · ops=${pane.ops}`,
    );
  }
  if (input.panes.length === 0) lines.push("(none)");
  lines.push("");

  lines.push("## Checklist");
  for (const step of input.checklist)
    lines.push(`- [${step.status}] ${step.title}: ${step.detail}`);
  lines.push("");

  lines.push("## Troubleshooting");
  for (const item of input.troubleshooting) {
    lines.push(`- (${item.severity}) ${item.title}: ${item.detail}`);
    for (const action of item.actions) lines.push(`    action: ${action}`);
  }
  if (input.troubleshooting.length === 0) lines.push("(nothing to report)");

  const redacted = redactSecrets(lines.join("\n"));
  return { text: redacted.text, generatedAt, redactions: redacted.redactions };
}

function formatDetectionSection(detection: OfficeDetectionResult): string {
  const lines: string[] = [];
  lines.push(
    `os: ${detection.os}${detection.isWsl ? " (WSL)" : ""} · supported: ${detection.supported}`,
  );
  lines.push(
    `office: ${detection.office.version ?? "unknown"}${detection.office.platform ? ` (${detection.office.platform})` : ""}${
      detection.office.source ? ` via ${detection.office.source}` : ""
    }`,
  );
  if (detection.office.products.length > 0)
    lines.push(`products: ${detection.office.products.join(", ")}`);
  lines.push(
    `apps: ${detection.apps
      .map(
        (app) =>
          `${app.label}=${app.installed ? (app.executablePath ?? app.evidence ?? "yes") : "no"}`,
      )
      .join(", ")}`,
  );
  lines.push(`sideloaded: ${detection.sideload.installed ? "yes" : "no"}`);
  for (const entry of detection.sideload.entries) {
    lines.push(
      `  - ${entry.channel} ${entry.location}${entry.slot ? ` [${entry.slot}]` : ""} · id=${entry.manifestId ?? "?"} · prod=${entry.matchesProdSource} · exists=${entry.manifestExists}`,
    );
  }
  for (const problem of detection.sideload.problems) lines.push(`  problem: ${problem}`);
  for (const note of detection.notes) lines.push(`  note: ${note}`);
  return lines.join("\n");
}
