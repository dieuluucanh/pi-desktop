import { UnsupportedAttachmentError, type AttachmentService } from "./attachment-service";
import {
  ATTACHMENT_LIMITS,
  type AttachmentDraftGrant,
  type AttachmentPickResult,
} from "../shared/attachments";

/** The native picker supplies these handles; paths never cross the IPC bridge. */
export interface SelectedAttachment {
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
  read(offset: number, maxBytes: number): Promise<Uint8Array>;
  verifyUnchanged(): Promise<void>;
  close(): Promise<void>;
}

export const ATTACHMENT_FILE_DIALOG_FILTERS = [
  {
    name: "Text and raster images",
    extensions: [
      "txt",
      "md",
      "markdown",
      "mdx",
      "json",
      "jsonl",
      "ndjson",
      "yaml",
      "yml",
      "toml",
      "xml",
      "html",
      "htm",
      "css",
      "csv",
      "tsv",
      "log",
      "c",
      "h",
      "cc",
      "cpp",
      "hpp",
      "rs",
      "go",
      "py",
      "rb",
      "php",
      "java",
      "kt",
      "kts",
      "swift",
      "cs",
      "fs",
      "js",
      "jsx",
      "mjs",
      "cjs",
      "ts",
      "tsx",
      "vue",
      "svelte",
      "sql",
      "sh",
      "bash",
      "zsh",
      "ps1",
      "bat",
      "cmd",
      "ini",
      "conf",
      "env",
      "png",
      "jpg",
      "jpeg",
      "gif",
      "webp",
      "bmp",
    ],
  },
  {
    name: "Documents (local conversion not available yet)",
    extensions: ["pdf", "docx", "xlsx", "pptx", "odt", "ods", "odp"],
  },
  { name: "All files", extensions: ["*"] },
] as const;

export interface AttachmentPickerDeps {
  service: AttachmentService;
  /** Main-owned native dialog; null means the user cancelled. */
  select(): Promise<readonly string[] | null>;
  /** Only paths returned by select() are passed to this port. */
  openSelected(path: string): Promise<SelectedAttachment>;
}

function safeDisplayName(name: string): string {
  return name.length > 0 &&
    name.length <= 255 &&
    !name.includes("/") &&
    !name.includes("\\") &&
    Array.from(name).every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
    ? name
    : "Selected file";
}

/** Import exactly the snapshots selected by the user, not renderer-supplied paths. */
export async function pickAttachments(
  deps: AttachmentPickerDeps,
  senderId: number,
  draft: AttachmentDraftGrant,
): Promise<readonly AttachmentPickResult[] | null> {
  // Validate before opening a native dialog and again after it yields.
  await deps.service.list(senderId, draft);
  const selected = await deps.select();
  if (selected === null) return null;
  await deps.service.list(senderId, draft);
  const results: AttachmentPickResult[] = [];
  for (let index = 0; index < selected.length; index++) {
    const path = selected[index];
    if (path === undefined) continue;
    if (index >= ATTACHMENT_LIMITS.filesPerDraft) {
      results.push({ ok: false, name: "Selected file", reason: "too_many_files" });
      continue;
    }
    await deps.service.list(senderId, draft);
    let source: SelectedAttachment | null = null;
    let token: string | null = null;
    let attachmentId: string | null = null;
    let committing = false;
    let name = "Selected file";
    try {
      source = await deps.openSelected(path);
      name = safeDisplayName(source.name);
      const grant = await deps.service.begin(senderId, {
        draft,
        name: source.name,
        mimeType: source.mimeType,
        size: source.size,
      });
      token = grant.token;
      attachmentId = grant.attachmentId;
      let offset = 0;
      while (offset < source.size) {
        const remaining = source.size - offset;
        const chunk = await source.read(
          offset,
          Math.min(remaining, ATTACHMENT_LIMITS.importChunkBytes),
        );
        if (
          !(chunk instanceof Uint8Array) ||
          chunk.byteLength === 0 ||
          chunk.byteLength > remaining ||
          chunk.byteLength > ATTACHMENT_LIMITS.importChunkBytes
        ) {
          throw new Error("invalid selected-file read");
        }
        offset = await deps.service.append(senderId, draft, token, offset, chunk);
      }
      await source.verifyUnchanged();
      committing = true;
      const attachment = await deps.service.commit(senderId, draft, token);
      token = null;
      results.push({ ok: true, attachment });
    } catch (cause) {
      if (committing && attachmentId) {
        results.push({ ok: false, name, reason: "uncertain", attachmentId });
        continue;
      }
      if (token) await deps.service.cancel(senderId, draft, token).catch(() => undefined);
      // OS error messages can contain the source path; never return them.
      const reason =
        cause instanceof UnsupportedAttachmentError
          ? "unsupported_format"
          : source
            ? "import_failed"
            : "not_regular";
      results.push({ ok: false, name, reason });
    } finally {
      await source?.close().catch(() => undefined);
    }
  }
  return results;
}
