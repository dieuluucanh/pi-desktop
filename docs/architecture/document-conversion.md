# Document conversion (milestone B) — contracts and dependency record

**Status:** step 17 landed the versioned contracts, the fixture inventory and the
dependency/security assessment. **No converter is shipped yet**, so PDF/Office/
OpenDocument attachments remain visibly blocked (`conversion_required` /
"local conversion is unavailable") until steps 18–24 and the milestone-B release
gate are complete.

## Contracts

`src/shared/extraction.ts` is the browser-safe agreement between the main
planner, the extraction worker (step 18), the proposal/approval store (step 19)
and the review UI (step 24):

- formats: PDF, DOCX/ODT, XLSX/ODS, PPTX/ODP;
- selectors: PDF page ranges (≤200 pages), Word table/header/comment/hidden-text
  options, spreadsheet sheet/range/formula-cache/hidden/`maxCells` options,
  presentation slide/notes/hidden options;
- explicit per-file `ConversionConsent` bound to the original digest, selection
  digest and policy digest (an inventory that parses contents also needs consent);
- inventory (`units`, hidden counts, notes/comments/macros, warnings, digest) and
  immutable proposal (`chunks`, `coverage`, `omitted` counts, warnings,
  provenance with converter/contract/source/selection/output digests);
- closed failure codes (`invalid_container`, `encrypted_document`,
  `macro_enabled`, `limit_exceeded`, `output_too_large`, `timeout`, `cancelled`,
  `network_rejected`, …) and warning/omission codes;
- output above the cap is a failure, never a silent truncation;
- `ExtractorPort` is the worker surface (`inventory`, `extract`, `cancel`).

`tests/fixtures/documents/manifest.json` is the reviewable fixture inventory:
every format has representative fixtures, and hostile classes cover encrypted
files, macro-enabled packages, traversal/duplicate ZIP entries, expansion bombs,
external entities/relationships, formula injection, cell/page limits and
malformed containers. Binary fixtures are added by the owning steps; the
inventory is validated now.

## Dependency assessment (assessed 2026-11-21)

| Dependency   | Exact version        | License      | Native?                                     | Decision                                                            |
| ------------ | -------------------- | ------------ | ------------------------------------------- | ------------------------------------------------------------------- |
| `pdfjs-dist` | **6.5.438**          | Apache-2.0   | No (optional `@napi-rs/canvas` is not used) | **Select for PDF text extraction**, pin exactly                     |
| `fflate`     | **0.8.3**            | MIT          | No                                          | Existing ZIP helper (bundles); **not** trusted for document parsing |
| `saxes`      | **6.0.0**            | ISC          | No                                          | Streaming XML tokens for OOXML/ODF                                  |
| `node:zlib`  | bundled Node 24.22.2 | Node license | Built-in                                    | Bounded `inflateRawSync` behind the existing audited ZIP parser     |

Rejected/avoided: LibreOffice/Python/FFmpeg or any external converter; stale
spreadsheet packages; `unzipSync`/`unzip` on untrusted documents; native canvas
for text-only extraction; runtime downloads.

### PDF spike evidence

The spike ran in a temp directory (nothing added to `package.json`) with the
**bundled** runtime:

```text
resources/runtime/node/win32-x64/node.exe --version   -> v24.22.2
npm pack pdfjs-dist@6.5.438                            -> 8.8 MB tarball, 38 MB unpacked
import pdfjs-dist/legacy/build/pdf.mjs
getDocument({ data, useWorkerFetch: false, isEvalSupported: false, disableFontFace: true })
page.getTextContent()                                  -> "Hello PDF spike"
```

Result: text extraction works on the bundled Node without `@napi-rs/canvas`.
The only messages were non-fatal warnings about missing canvas/`DOMMatrix`/
`Path2D` (rendering only) and a missing `standardFontDataUrl`. Packaging must
include `standard_fonts/` (and `cmaps/` for CID fonts) and point
`standardFontDataUrl` at the packaged directory; rendering is out of scope.

`pdfjs-dist` 6.x is ESM (`legacy/build/pdf.mjs`) and requires Node ≥22.13 or ≥24
(bundled runtime satisfies it). The package has no required dependencies.
Packaging should include only `legacy/build`, `standard_fonts`, `cmaps`,
`LICENSE` and the needed metadata, and prune the rest; the worker module is
packaged but the extraction child owns it (no renderer/network worker).

## Resource budgets

From `EXTRACTION_BUDGETS` (step 18 enforces them):

| Control                                | Value                                                     |
| -------------------------------------- | --------------------------------------------------------- |
| Global jobs                            | 2                                                         |
| Wall clock                             | 30 s                                                      |
| V8 heap limit                          | 256 MiB                                                   |
| **Total process RSS**                  | 768 MiB (separate from the heap flag; supervisor-checked) |
| Output                                 | 2 MiB (failure above, never truncate)                     |
| Temporary space                        | 512 MiB                                                   |
| ZIP entries / actual expansion / ratio | 5,000 / 100 MiB / 100:1                                   |
| PDF pages                              | 200                                                       |
| Spreadsheet materialized cells         | 100,000                                                   |
| Output chunk                           | 256 KiB, ≤8,192 chunks                                    |

## Security rules

- No network, eval, font-face loading, external entities or relationship
  fetching. XML is parsed with DTD/entity resolution disabled; relationships are
  never followed.
- ZIP parsing uses the existing bounds (entry names, duplicates, case folding,
  traversal, ZIP64 refusal, encryption/macro detection, actual expansion and
  ratio). `fflate`'s unbounded helpers are not used on untrusted documents.
- Macros are never executed; macro-enabled/encrypted files are refused with a
  specific code.
- The worker is a resource boundary, not an OS sandbox; residual risk is
  documented in the worker step.
- Conversion is per-file, opt-in, and approval is bound to the exact proposal
  digest. Model/context changes invalidate the delivery plan without silently
  changing approved content.

## Update policy

- Pin exact versions; no floating ranges for parsers.
- Re-run the fixture suite, license check and packaged-worker smoke on every
  upgrade.
- Watch the pdfjs-dist advisories and the Node runtime baseline; a required
  capability that cannot be packaged blocks that format instead of being
  replaced with an external tool.

## Open items before milestone B

- Step 18: worker/supervisor, packaging assets, measured RSS/heap/output limits.
- Steps 20–23: real extractors and the binary fixtures from the inventory.
- Step 25: adversarial packaged-worker verification.
- Step 26: cross-platform/provider release sign-off.
