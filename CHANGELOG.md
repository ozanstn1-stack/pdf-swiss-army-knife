# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.2.0]

A reliability release: no new screens, but the editors, the formula engine and
the file formats were gone through with tests that reproduce the reported
problems. Detailed release notes: [docs/release-notes-v2.2.0.md](docs/release-notes-v2.2.0.md).

### Added

- **XLSX chart export** - column, bar, line, pie and area charts are written as
  real ChartML parts (`xl/charts/chartN.xml`) anchored to their cells through a
  drawing part, with titles, series names/colours, legends, axis titles and
  data labels. Chart kinds the exporter cannot represent are kept in `.oswk`
  and reported in the save warnings.
- **XLSX conditional-formatting export for every editor rule kind**: data bars
  now export (`type="dataBar"` with min/max colour scale), text-contains rules
  carry the required `text` attribute, top/bottom rules use `rank`, and the
  `textContains` / `duplicate` kind strings the editor writes are mapped -
  previously those two rules silently exported nothing.
- `WEEKNUM` (Excel types 1, 2, 11-17 and ISO type 21), sharing its ISO
  implementation with `ISOWEEKNUM`.
- Component regression tests that drive the real Calc and Writer editors with
  `@testing-library/user-event` and assert model state after keyboard flows.
- XLSX round-trip suite (`crates/officecore/tests/xlsx_roundtrip_test.rs`)
  against a 100-row, multi-sheet golden workbook with formulas, number formats,
  merges, widths, heights, freeze panes, a filter, list + numeric validation,
  conditional formatting and two charts.

### Fixed

- **Calc: consecutive typing after `Enter` is now reliable.** The grid keydown
  handler closed over the `editing` *state*, so the first keystroke after a
  commit was rejected by the previous render's closure; and focus was restored
  in a passive effect, which runs after paint, so the keystroke could be
  dispatched to `<body>` first. The handler reads the editor through a ref and
  focus is restored in the same event. Blur commits no longer pull focus back
  from the formula bar, and IME composition is ignored by the shortcut handler.
- **Writer: structural edits can no longer be undone by the blur handler.**
  A focused `contentEditable` is not re-rendered by React, so after Enter /
  Backspace / Delete the element still held the pre-edit text; moving focus
  fired `blur`, which read that stale DOM and wrote it back into the model
  (paragraphs duplicated on Enter, merges resurrected the removed paragraph).
  Affected paragraphs are repainted before focus moves, Shift+Enter restores
  the caret after the line break, and the caret for structural edits is placed
  in the same commit instead of a `setTimeout`.
- **Formula engine: silent wrong answers removed.** Lowercase references and
  sheet names (`=a1`, `=sheet1!a1`) were read as empty cells and are now
  case-insensitive like Excel; malformed references (`=A0+1`,
  `=SUM(A0:A3)`) now fail with `#REF!` instead of silently evaluating.
- **XLSX: `[Content_Types].xml` is well-formed again.** Comment and chart
  overrides were appended after the closing `</Types>` tag, which made the
  package unreadable for other office suites; an independent reader (openpyxl)
  catches this and the package structure now has a regression test.
- **XLSX: chart references are XML-escaped**, so sheet names containing `&` or
  `<` no longer produce a malformed chart part.
- **XLSX: empty headers no longer emit an unparseable `headerFooter`** - the
  element is omitted when the header is empty, which openpyxl previously
  warned about.
- Error messages shown to the user now go through the shared `errorMessage()`
  helper (localized by code) instead of raw `String(error)` output in the
  office workspace, the launcher and the batch/converter screens.
- The office `Dialog` exposes `role="dialog"` / `aria-modal` for assistive
  technology and tests.

### Improved

- **Formula engine reliability**: the A1/mixed/absolute/cross-sheet/quoted-sheet
  reference matrix and the malformed-reference cases are pinned down by tests;
  `a1`-style case-insensitivity now matches Excel.
- **Data bars in Calc** scale against the maximum of their range (like every
  spreadsheet) instead of an absolute percentage of the raw value, and the
  chosen colour is used.
- **XLSX writer** escapes chart titles/series names, validates chart ranges and
  reports each chart that could not be exported, instead of one blanket
  "charts are not embedded" warning.
- **README/tests documentation** updated to the real test counts and the real
  state of XLSX chart/conditional-format export.

### Security

- No new macro or script execution path was added. Chart and conditional
  formatting XML is escaped against package corruption; the ZIP, XML and
  redaction hardening from 2.1.0 is unchanged and still covered by its tests.

### Compatibility

- `.oswk` remains the lossless format; old files keep opening. XLSX export
  gained parts; XLSX import support is unchanged (values and formulas).
- `WEEKNUM` follows Excel's numbering schemes; `TODAY`/`NOW` unaffected.

### Tests

- Rust: 240 tests across the workspace (was 223); new XLSX structure tests for
  charts and conditional formatting, plus the 5-test round-trip suite.
- Frontend: 325 tests (was 303), including 12 new editor component tests that
  type Enter/Backspace/Shift+Enter and assert caret and model behaviour.

## [2.1.0]

### Added

- **Redact** (`nav.redact`) — permanent redaction. Text under a box is removed
  from the PDF content stream rather than covered. Detection for e-mail
  addresses, card numbers (Luhn), IBANs (mod-97), phone numbers and
  passport/ID numbers, with per-item selection. Image areas can be painted out
  or have their pixels removed. Optional metadata stripping. Cancellable, with
  progress. Verified by tests that re-extract the text and assert it is gone.
- **Compare** (`nav.compare`) — two documents compared page by page. A text
  pass classifies pages as added, removed or changed; an optional pixel pass
  with adjustable resolution and tolerance marks visual changes on a
  side-by-side diff. Per-document passwords, cancellable, with progress.
- **Inspect** (`nav.inspect`) — read-only document report: page geometry,
  fonts with embedded/base-14 distinction, images with dimensions, colour
  space and bit depth, form fields with labels and options, outline, links,
  annotations, encryption, linearization and metadata. Findings carry a
  severity and a plain-language explanation; accessibility conformance is
  derived from them.
- Tauri commands `redact_pdf`, `detect_sensitive_text`, `compare_pdfs` and
  `inspect_document`, all wired to the existing job registry for progress and
  cancellation.
- `docutil::page_xobjects` — resolves a page's image XObjects across inline,
  referenced and inherited `/Resources`. The inspector, the compressor and
  redaction all previously saw zero images for documents whose page resources
  are inline rather than inherited.
- Formula engine: ~70 additional functions (array literals, `LET`, named
  ranges, financial, date, lookup, statistical and matrix functions),
  extracted from a single file into `src/office/calc/functions/`.
- XLSX export: defined names, autofilter, hyperlinks, comments, conditional
  formatting, sheet tab colour and print settings.
- Version history screen: browse and restore local snapshots.
- 825 previously missing Turkish translations; the i18n audit now reports
  zero missing and zero extra keys in both directions.

### Fixed

- Calc: a double commit when pressing `Enter` after a formula edit, and focus
  moving off the grid instead of to the next cell.
- Calc: circular references no longer loop forever; they raise a readable
  error.
- Calc: formulas are now evaluated against the new workbook rather than the
  pre-edit one, so a formula that references a cell edited in the same action
  gets the right value.
- Writer: `font-size` values were being treated as pixels where they are
  points, and `font-family` was lost on DOM round-trip.
- 47 mojibake sequences in the English translation table.
- `settings.enginePdfium` had been appended to the end of an unrelated line
  and orphaned in the Turkish block, so the pdfium engine label never rendered.

### Changed

- Writer, Calc and Impress keyboard editing (Enter, Shift+Enter, Backspace,
  Delete, Tab/Shift+Tab, edge arrows, Home/End, PageUp/PageDown) is handled
  against a real model, and the pure run/caret logic has been extracted into
  `src/office/writer/` with tests.
- Document close now warns about unsaved changes, `Ctrl+W` works, and
  autosave flushes pending changes before a recovery prompt.

### Known limitations

These are real and unchanged by this release:

- Redaction removes text from the content stream and pixels from images, but it
  does not rewrite incremental-update history. If a document already carries
  an earlier revision containing the same text, that earlier revision can still
  contain it. Remove incremental updates before redacting if that matters.
- Accessibility conformance is a check of the properties this application can
  read (tagging, language, title, form labels, embedded fonts). It is not a
  certified WCAG or PDF/UA validation.
- The document inspector reports facts; it does not repair a document.
- Comparison renders both documents for the visual pass, which is
  meaningfully slower than the text pass on large files. `max_pages` bounds
  the work.
