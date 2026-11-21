# Attachments

Attach a file to the next message with the paperclip, a paste, or a drop from
Explorer/Finder. The app snapshots the file at import time; later edits to the
source file do not change what was sent, and the source file is never modified.

## What can be attached

| Content                                                          | Behaviour                                                             |
| ---------------------------------------------------------------- | --------------------------------------------------------------------- |
| Plain text/code/CSV/TSV/Markdown/JSON/XML/HTML (UTF-8)           | Sent as ordinary prompt text, framed as untrusted data                |
| PNG/JPEG/GIF/WebP (BMP is converted)                             | Prepared, re-encoded and sent as a native Pi image block              |
| PDF, DOCX/ODT, XLSX/ODS, PPTX/ODP                                | **Not converted yet**: the tray says local conversion is unavailable  |
| Audio/video, legacy/macro/encrypted Office, archives/executables | Refused with a specific reason; no hidden decode, OCR or external app |

Limits are application ceilings, not provider promises: 10 files per draft,
5 MiB per text file, 12 MiB/40 MP per image, 200 KiB of text per file, 512 KiB
combined and at most ~32k estimated attachment tokens in the available context.
A lower model/provider limit always wins.

## `@`, `#` and the paperclip are different

- **`@file`** inserts a project path reference for the agent's tools; it is not
  an attachment snapshot.
- **`#document`** references an Office document through the optional live
  Office integration.
- **Paperclip/paste/drop** attaches an immutable copy to the next turn.

## Sending rules

- Managed attachment turns are **idle-only**. Stop/steering/follow-up still work
  normally for attachment-free messages; files are never queued and replayed.
- Commands, skills, templates and shell commands do not consume selected files.
  Send is blocked (with the reason) instead of sending text-only.
- If any selected file is unsupported, importing, over budget or not ready, Send
  stays blocked. The app explains which file and why; it never silently drops a
  file or fabricates an assistant reply.

## Acceptance is not provider delivery

A successful send means Pi preflight accepted the turn and the exact user entry
and association were persisted in the session. It does **not** prove that a
provider retained or that a model understood every image. Images may be
normalized/resized by Pi or the app; preparation warnings are shown in the tray
and on the transcript card. Trusted extensions can rewrite prompt content, so
the card labels the persisted content as what Pi stored, not as a byte-exact
provider payload.

## Transcript cards

A sent attachment turn shows a card with the approved original → prepared
provenance, coverage, warnings and an explicit **Show submitted text/image**
action. Submitted text is inert and preview-bounded; the full text can be
copied. The card reads only what Pi persisted, never the project or source path.

## Storage and privacy

- Imported files live in the app's profile data, outside the project and its
  `.git`.
- Deleting a session keeps its attachment copies recoverable for **30 days**;
  incomplete imports are cleaned after **24 hours** and unowned copies after
  **7 days**. Referenced copies are never evicted.
- **Settings → Attachments** reports usage/quota/free space and offers an
  explicit "Reclaim space" action for unreferenced copies. Local removal does
  not delete Pi conversation history or provider-retained data.
- `/share` and bug reports exclude attachment files, inline images, managed file
  text, names and descriptors by default. Assistant answers or ordinary prose
  may still quote attachment details; there is no semantic-redaction promise.
- Native HTML/JSONL exports are truthful and include what was sent. The export
  dialog says so first; use the separately labeled **sanitized transcript**
  export when a file will be shared. It is not a Pi session and cannot be
  reimported.
- Optional local bundles contain provenance only by default; original contents
  are included only when explicitly selected. Imported bundles are validated and
  get new app ids; they are not attached to a conversation automatically.

## Troubleshooting

| Symptom                                                    | What it means                                                                                                 |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| "Restart the app/session tab to update attachments"        | The tab's host predates the negotiated attachment protocol; main refuses before staging any bytes.            |
| "Not enabled in this build yet"                            | Packaged milestone-A gate is off (development builds enable it via `PI_DESKTOP_ATTACHMENTS`).                 |
| "Local conversion is not available yet"                    | PDF/Office/OpenDocument extraction is milestone B.                                                            |
| "Desktop attachment storage is full of unresolved records" | Protected journal records fill the cap; open Settings → Attachments and review before retrying.               |
| Image rejected before Pi sees it                           | The image exceeds the decode/preparation ceiling or uses an unsupported container; the tray names the reason. |
| Sent but no card                                           | The session predates card metadata or the association is ambiguous; the raw Pi message remains readable.      |
