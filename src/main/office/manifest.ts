/**
 * Office add-in manifest parsing.
 *
 * The app never trusts file names: sideload detection reads the manifest and
 * matches on the add-in `<Id>` (or on the task-pane source location), so a
 * renamed manifest or an unrelated add-in is classified correctly.
 */

import { PI_FOR_OFFICE } from "../../shared/office";

export interface ParsedManifest {
  id: string | null;
  displayName: string | null;
  version: string | null;
  providerName: string | null;
  sourceLocations: string[];
  hosts: string[];
}

const ID_RE = /<Id>\s*([^<\s]+)\s*<\/Id>/i;
const VERSION_RE = /<Version>\s*([^<\s]+)\s*<\/Version>/i;
const DISPLAY_NAME_RE = /<DisplayName[^>]*\bDefaultValue="([^"]*)"/i;
const PROVIDER_NAME_RE = /<ProviderName>\s*([^<]*?)\s*<\/ProviderName>/i;
const SOURCE_LOCATION_RE = /<SourceLocation[^>]*\bDefaultValue="([^"]+)"/gi;
const BT_URL_RE = /<bt:Url[^>]*\bDefaultValue="([^"]+)"/gi;
const HOST_RE = /<Host\s+Name="([^"]+)"/gi;

function collect(xml: string, re: RegExp): string[] {
  const out: string[] = [];
  re.lastIndex = 0;
  let match = re.exec(xml);
  while (match) {
    const value = match[1];
    if (typeof value === "string" && value.trim().length > 0) out.push(value.trim());
    match = re.exec(xml);
  }
  return out;
}

export function parseManifest(xml: string): ParsedManifest {
  const sourceLocations = [...collect(xml, SOURCE_LOCATION_RE), ...collect(xml, BT_URL_RE)];
  return {
    id: ID_RE.exec(xml)?.[1]?.trim() ?? null,
    displayName: DISPLAY_NAME_RE.exec(xml)?.[1]?.trim() ?? null,
    version: VERSION_RE.exec(xml)?.[1]?.trim() ?? null,
    providerName: PROVIDER_NAME_RE.exec(xml)?.[1]?.trim() ?? null,
    sourceLocations: [...new Set(sourceLocations)],
    hosts: [...new Set(collect(xml, HOST_RE))],
  };
}

function normalizeId(id: string | null): string {
  return (id ?? "").replace(/[{}]/g, "").trim().toUpperCase();
}

/** True when the manifest is the Pi for Office add-in (id match, or one of its URLs). */
export function manifestMatchesPiForOffice(manifest: ParsedManifest): boolean {
  if (normalizeId(manifest.id) === normalizeId(PI_FOR_OFFICE.addInId)) return true;
  return manifest.sourceLocations.some((url) => sourceLocationMatchesPiForOffice(url));
}

/**
 * True when the manifest loads the *currently hosted* Pi for Office task pane.
 * Used to tell a stale/dev sideload apart from an up-to-date one.
 */
export function manifestSourceMatchesProd(manifest: ParsedManifest): boolean {
  return manifest.sourceLocations.some((url) => sourceLocationMatchesHostedProd(url));
}

/**
 * Loose match: the URL serves the Pi for Office task pane, or is a local/dev
 * copy of it (the add-in's Vite dev server runs on http://localhost:3141 with a
 * `/pi-for-office/...` path).
 */
export function sourceLocationMatchesPiForOffice(url: string): boolean {
  if (sourceLocationMatchesHostedProd(url)) return true;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!PI_FOR_OFFICE.sourceHosts.includes(parsed.hostname)) return false;
  return parsed.pathname.toLowerCase().includes("pi-for-office");
}

/** Strict match: the URL is the hosted task pane declared in PI_FOR_OFFICE. */
export function sourceLocationMatchesHostedProd(url: string): boolean {
  let parsed: URL;
  let expected: URL;
  try {
    parsed = new URL(url);
    expected = new URL(PI_FOR_OFFICE.sourceLocation);
  } catch {
    return false;
  }
  return parsed.origin === expected.origin && parsed.pathname === expected.pathname;
}

/** Best-effort host list in the order Excel, Word, PowerPoint. */
export function manifestHostsToOfficeHosts(manifest: ParsedManifest): Array<"excel" | "word" | "powerpoint"> {
  const out: Array<"excel" | "word" | "powerpoint"> = [];
  const normalized = manifest.hosts.map((host) => host.toLowerCase());
  if (normalized.some((host) => host.includes("workbook"))) out.push("excel");
  if (normalized.some((host) => host.includes("document"))) out.push("word");
  if (normalized.some((host) => host.includes("presentation"))) out.push("powerpoint");
  return out;
}
