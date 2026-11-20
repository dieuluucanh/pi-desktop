/** Early refusal is a convenience, never authoritative content classification. */
const UNSUPPORTED_EXTENSIONS = new Set([
  "mp3",
  "wav",
  "m4a",
  "aac",
  "flac",
  "ogg",
  "mp4",
  "mov",
  "webm",
  "avi",
  "mkv",
  "doc",
  "xls",
  "ppt",
  "docm",
  "dotm",
  "xlsm",
  "xlsb",
  "xlam",
  "pptm",
  "ppsm",
  "zip",
  "rar",
  "7z",
  "tar",
  "gz",
  "exe",
  "dll",
  "so",
  "dylib",
  "wasm",
  "class",
]);

export function attachmentSuffix(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function isKnownUnsupportedAttachment(name: string, mimeType: string): boolean {
  const mime = mimeType.toLowerCase().split(";", 1)[0]?.trim() ?? "";
  return (
    mime.startsWith("audio/") ||
    mime.startsWith("video/") ||
    UNSUPPORTED_EXTENSIONS.has(attachmentSuffix(name))
  );
}
