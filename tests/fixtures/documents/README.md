# Document-extraction fixture inventory (milestone B)

This directory is the **planned** fixture inventory for plan step 17. Binary
documents are added by the owning implementation steps (18, 20–23); this
manifest is the reviewable contract that says what must exist, which selector or
hostile condition it covers and what the extractor must report.

Rules for every fixture:

- no real personal data, credentials or customer documents;
- deterministic bytes, small enough to review (a bomb fixture is generated in a
  test rather than stored expanded);
- the expected outcome is one of the closed failure/warning codes in
  `src/shared/extraction.ts`;
- a fixture whose parser is unavailable blocks that format rather than being
  silently skipped.

`manifest.json` is checked by `tests/shared/extraction-fixtures.test.ts`.
