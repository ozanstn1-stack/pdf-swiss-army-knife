# Office Swiss Army Knife

A local-first Windows desktop productivity suite: a word processor (Writer), a
spreadsheet (Calc), a presentation editor (Impress), local productivity tools
(Notes, Planner, Data, Draw, Templates, PDF Forms) and the complete PDF toolkit
this project started from.

Everything runs on your machine. Documents are never uploaded, there is no
telemetry, and the app stays useful without an internet connection. Macros and
embedded scripts in office files are never executed.

**Version 2.2.0** · Platform: Windows (Tauri also targets Linux/macOS, but only
Windows is built and verified here) · UI languages: English, Turkish.

## What's new in 2.2.0

- **Calc keyboard entry is fixed for real.** After committing a cell with
  `Enter`, the next cell accepts typing immediately - the focus/commit race is
  closed at the root (same-event focus restore, no stale editor state) and
  covered by component tests.
- **Writer structural editing no longer rewrites stale text.** Enter, Backspace
  merge, Delete merge and Shift+Enter repaint the paragraph before focus moves,
  so the on-screen text and the document model can no longer disagree.
- **XLSX export now embeds charts** (column, bar, line, pie, area) as real
  ChartML parts anchored to their cells, and writes conditional formatting for
  every rule kind the editor offers - including data bars. Unsupported cases
  are reported instead of vanishing.
- **Hardened formula engine**: lowercase references and sheet names resolve
  case-insensitively, malformed references fail with `#REF!` instead of
  reading an empty cell, and `WEEKNUM` is available.
- Chart and conditional-format XLSX packages were validated with an
  independent reader (openpyxl) as well as the in-repo round-trip suite.

## Screenshots

| Writer — typing on the page | Calc — cells and formulas |
|---|---|
| ![Writer](docs/screenshots/office-writer-typing.png) | ![Calc](docs/screenshots/office-calc-formula.png) |

| Calc — opening a 100-row XLSX with live formulas | Impress — PPTX with slides, shapes and images |
|---|---|
| ![XLSX](docs/screenshots/office-calc-xlsx.png) | ![Impress](docs/screenshots/office-impress-pptx.png) |

All screenshots come from the running application (`scripts/ui-flow.ps1`
automation). The PDF module screenshots live in `docs/` from earlier releases.

## What is verified working

These workflows were exercised on the built application and with automated tests:

- **Writer**: click anywhere on the page → caret appears → typing updates the
  document model (screenshot above). Round-trip tests cover DOCX/ODT/RTF with
  headings, bold/italic/underline, bullet and numbered lists, tables, images,
  page breaks and a header/footer with real `PAGE` / `NUMPAGES` fields.
- **Calc**: click a cell → type a value → `Enter` commits and moves on → keep
  typing without clicking; `Tab`/`Shift+Tab`, `F2`, the formula bar and arrow
  navigation all work and are covered by component tests that reproduce the
  former Enter race. Opening the 100-row sample XLSX computes `=SUM(...)`,
  `=AVERAGE(...)`, `=MAX(...)` and per-row `=B*C` correctly (screenshot above).
- **Impress**: opening the sample PPTX loads five slides with text, bullets,
  images, shapes, a table, speaker notes and transitions (screenshot above).
- **PDF**: every tool from v1.x is unchanged and still covered by its tests.
- **Redaction**: text under a redaction box is *deleted from the content
  stream*, not covered with a black rectangle. Integration tests extract the
  text back out of the redacted file and assert the string is gone, which is
  the only way to prove it cannot be recovered.
- **Compare**: a document compared against a revision reports which pages were
  added, removed or changed; with the picture pass on, changed pixels are
  marked on a side-by-side render.
- **Inspect**: reports page geometry, fonts (and whether they are embedded),
  images, form fields, outline, encryption and metadata, then lists findings
  with a severity and an explanation. Accessibility conformance is derived from
  those findings rather than asserted.

## Modules

### Writer (word processor)
- DOCX, ODT, RTF, TXT, Markdown, HTML import/export · PDF export · lossless `.oswk` unit format
- Styles (Normal, Title, Subtitle, Heading 1–6, Quote, Caption, Code), fonts, sizes,
  bold/italic/underline/strikethrough, superscript/subscript, text colour, highlight
- Alignment, line spacing, space before/after, indents (including first-line and hanging)
- Bullet, numbered and multilevel lists; tables (insert, add/delete row and column, shading, borders);
  images (insert, resize, caption, alignment); hyperlinks; page breaks; horizontal rules
- Page setup: A4/A5/A3/Letter/Legal, portrait/landscape, Normal/Narrow/Wide/custom margins, columns
- Headers and footers with automatic `{{page}}` / `{{pages}}` numbers (written as real fields in DOCX)
- Find & replace (case sensitive, whole word), comments sidebar, word/character/page count,
  zoom, print, export PDF with selectable text

### Calc (spreadsheet)
- XLSX, ODS, CSV/TSV import/export · XLS import (read-only) · PDF export
- Virtualised grid, name box and formula bar, multi-sheet workbooks (add, rename, delete)
- Formula engine with 160+ functions: SUM, AVERAGE, MIN, MAX, COUNT, COUNTA, COUNTBLANK, MEDIAN,
  STDEV, IF, IFS, IFERROR, AND, OR, NOT, ROUND/ROUNDUP/ROUNDDOWN, ABS, PRODUCT, SQRT, POWER, MOD,
  INT, CEILING, FLOOR, SUMIF(S), COUNTIF(S), AVERAGEIF, VLOOKUP, HLOOKUP, XLOOKUP, INDEX, MATCH,
  CONCAT, TEXTJOIN, TEXTBEFORE/AFTER/SPLIT, LEFT, RIGHT, MID, LEN, TRIM, UPPER, LOWER, PROPER,
  SUBSTITUTE, REPT, TEXT, VALUE, TODAY, NOW, DATE, YEAR, MONTH, DAY, HOUR, MINUTE, WEEKDAY,
  WEEKNUM, ISOWEEKNUM, EDATE, EOMONTH, WORKDAY, NETWORKDAYS, LARGE, SMALL, RANK, SUMPRODUCT,
  ISNUMBER, ISTEXT, ISBLANK, ISERROR, PI, RAND, RANDBETWEEN, financial and matrix functions,
  `LET`, named ranges and inline array literals `{1,2;3,4}`
  (A1, `$A$1`, mixed anchors and cross-sheet references such as `=SUM(Data!D2:D101)` all work)
- Explicit errors instead of silent wrong answers: `#NAME?`, `#VALUE!`, `#REF!`, `#DIV/0!`, `#N/A`, `#NUM!`,
  circular-reference detection, and invalid references (`=A0`) fail rather than reading an empty cell
- Cell formatting (font, colour, fill, borders, alignment, wrap), number formats
  (General, Number, Currency, Percentage, Date, Time, Accounting), sorting, filtering,
  freeze panes, conditional formatting (greater/less/between/equal/text/duplicates/top-N/data bars),
  data validation (list and number range), row/column insert, delete and resize
- SVG charts fed from cell ranges (column, bar, line, pie, area) that refresh with the data
  and export to XLSX as real charts; conditional formatting exports as real `cfRule`s

### Impress (presentations)
- PPTX and ODP import/export · PDF export · lossless `.oswk`
- Slide thumbnails with reorder, canvas with drag/resize/rotate, z-order, align, group/ungroup
- Text, image, rectangle, rounded rectangle, circle, line, arrow, table, chart objects
- Eight layouts, six original themes, transitions (fade, slide, push, wipe), full-screen slideshow,
  speaker notes

### Productivity tools
- **Notes** (folders, tags, search, pin, favourite, archive) · **Planner** (month view, tasks,
  priorities, deadlines) · **Data** (local tables with CSV/JSON import/export) ·
  **Draw** (shapes, lines, arrows, text, freehand; SVG/PNG/PDF export) ·
  **Templates** (24 original documents, spreadsheets and decks) ·
  **Converter** (batch office conversions with honest unsupported-target messages) ·
  **Document Cleaner** (metadata/comments removal, embedded image optimisation) ·
  **PDF Forms** (standard AcroForm text, checkbox, radio and dropdown fields)

### PDF module
Reader with search, Merge, Split, Organize, Compress, OCR (Tesseract), Protect (AES-256),
Unlock, Watermark, Annotate, Metadata, Page tools (extract/delete/rotate/resize/crop/numbering),
PDF → JPG/PNG, JPG/PNG → PDF, Batch processing, Info, optional offline AI assistant.

Added in 2.1.0:

- **Redact** — remove text and pixels permanently. Drag over the page, or let
  the detector find e-mail addresses, card numbers, IBANs, passport numbers
  and phone numbers, then deselect anything to keep. Image areas can be
  painted out or have their pixels removed (better for scans). Author and
  document metadata can be stripped in the same pass.
  Detection: e-mail (RFC-shaped), card numbers (Luhn-checked), IBANs (mod-97),
  phone numbers, passport/ID numbers (check digits where the country uses
  them).
- **Compare** — two documents, page by page. A text pass classifies each page
  as added, removed or changed; an optional pixel pass catches changes that
  leave the text alone (stamps, signatures, scans). Both documents stay local
  and are never modified.
- **Inspect** — a read-only report of what a PDF really contains, including
  what is wrong with it: unembedded fonts, missing language, untagged
  structure, unlabelled form fields, JavaScript, image colour spaces and
  total image pixels, with a finding and a severity for each.

### Workspace
- Document tabs for Writer/Calc/Impress, dirty indicators
- Autosave (15 s / 30 s / 1 min / 5 min / off) with crash recovery and a recovery banner
- Local version history (up to 25 snapshots per document)
- Favourites and pinned files, Light/Dark/System/Midnight/Paper themes
- Open documents from the toolbar, `Ctrl+O`, drag & drop, recent files, or Windows
  file associations (double-click)

## Supported formats

Only combinations that actually work are marked. “–” means not supported.

| Format | Open | Edit | Save | PDF export |
|---|---|---|---|---|
| DOCX | ✓ | ✓ | ✓ | ✓ |
| DOC | – | – | – | – |
| ODT | ✓ | ✓ | ✓ | ✓ |
| RTF | ✓ | ✓ | ✓ (basic formatting, tables, images) | ✓ |
| TXT / Markdown / HTML | ✓ | ✓ | ✓ | ✓ (via Writer) |
| XLSX | ✓ | ✓ | ✓ | ✓ |
| XLS | ✓ | – | – | – |
| ODS | ✓ | ✓ | ✓ | ✓ |
| CSV / TSV | ✓ | ✓ | ✓ | – |
| PPTX | ✓ | ✓ | ✓ | ✓ |
| PPT | – | – | – | – |
| ODP | ✓ | ✓ | ✓ | ✓ |
| PDF | ✓ | ✓ (existing tools) | ✓ | – |
| JPG / PNG / BMP / GIF / WebP | ✓ | ✓ (as images) | ✓ | ✓ (images → PDF) |
| SVG | ✓ (inserted as image) | ✓ | ✓ (media in DOCX/ODT) | ✗ (not rasterised) |
| `.oswk` unit | ✓ | ✓ | ✓ | ✓ |

## Sample documents

`samples/` contains documents generated by the suite itself (no personal data):
`test-document.docx`, `test-document.odt`, `test-document.rtf`,
`test-spreadsheet.xlsx`, `test-spreadsheet.ods`, `test-spreadsheet.csv`,
`test-presentation.pptx`, `test-presentation.odp`.

Regenerate them with:

```bash
cargo run -p officecore --example make-office-samples
```

## Architecture

```
crates/officecore   Document model + DOCX/ODT/ODS/ODP/RTF/XLSX/CSV/PPTX engines,
                    hardened ZIP (ZIP-bomb limits) and XML layers, PDF layout and
                    rendering with an embedded OFL font, document cleaner
crates/pdfcore      The original PDF engine (render, merge, split, compress, OCR,
                    security, watermark, annotations, metadata, page layout)
crates/aicore       Optional assistant client, only used after the user opts in
src-tauri           Tauri shell: PDF commands (untouched) + office commands,
                    JSON stores, version history, recovery, file associations
src/                React 19 + TypeScript + Tailwind 4 frontend
  src/office        Writer, Calc (with the formula engine), Impress, tool screens
  src/screens       Original PDF screens (kept working)
```

The document model (`crates/officecore/src/model.rs`) is the single source of truth
shared by the Rust engines and the TypeScript editors. File formats are import/export
targets; the native `.oswk` format preserves everything the suite understands,
including features a given file format cannot represent.

## Build

Requirements: Node.js 20+, Rust 1.82+, Visual Studio Build Tools (Windows).

```bash
npm install
npm run engines:fetch      # pdfium, qpdf, tesseract and fonts (skipped if present)
npm run build              # type-check + frontend production build
npm run test:rust          # cargo test --workspace
npm run app:build          # Tauri release build (first run downloads NSIS)
npm run package            # NSIS installer + portable ZIP into release-artifacts/
```

Development: `npm run app:dev`.

## Tests

```bash
cargo test --workspace
npm test
npx tsc --noEmit
```

241 Rust tests and 325 frontend tests pass.

- `pdfcore`: 60 unit tests plus integration suites for merge, split, page
  tools, compression, OCR, security, metadata, watermark, annotation,
  redaction, comparison and inspection
- `officecore`: 71 unit tests (model, ZIP limits, XML, DOCX/ODT/ODS/ODP/RTF/XLSX/CSV/PPTX,
  PDF layout, cleaner) + 8 round-trip tests against the sample documents and a
  5-test XLSX round-trip suite (100-row golden workbook, cross-sheet formulas,
  styles/merges/layout structure, validation + conditional formatting + charts,
  and an explicit measurement of what a plain XLSX round trip drops)
- `aicore`: 18 tests, `src-tauri`: 10 tests
- Frontend: 325 tests covering the formula engine, writer runs and caret
  logic, cell maths, i18n parity, redaction geometry and component tests that
  drive the real Calc and Writer editors with the keyboard, with a strict
  TypeScript type check on top

The XLSX chart and conditional-format packages are also opened with an
independent reader (openpyxl) during development; the repository tests keep
the structural checks so the package cannot silently regress.

The redaction tests are the ones worth knowing about: they run the redaction,
re-extract the text from the result and assert the target string is no longer
present. A black rectangle would pass a visual check and fail this one.

## Privacy and security

- No cloud upload, no telemetry, no document content collection, no mandatory account.
- Only `aicore` performs network requests, and only after the user explicitly enables the assistant.
- Macros and embedded scripts are never executed; documents always open with macros disabled.
- ZIP extraction is bounded (entry count, size, compression ratio) to resist ZIP bombs.
- XML parsing is depth-limited and does not expand external entities.
- Writes are atomic (temp sibling + rename); passwords are never logged or persisted.
- Recovery snapshots and version history stay in the app data directory on your machine.

## Known limitations

- Writer uses a continuous page view with page-break markers; page setup, headers,
  footers, print and the exported PDF are page-accurate, but the on-screen canvas is not
  a full WYSIWYG pager.
- XLSX export writes values, formulas, styles, number formats, merges, column widths, row
  heights, freeze panes, data validation, conditional formatting and charts (column, bar,
  line, pie, area). XLSX import reads values and formulas only, so formatting, layout,
  validation, conditional rules and charts are not read back from an imported file; the
  native `.oswk` format keeps everything. Cell comments are exported but not imported.
- Exported charts are functional but use default styling beyond the properties the editor
  stores (title, series names/colours, legend, axis titles, data labels); Excel themes and
  fine-grained chart formatting are not written.
- PPTX export does not embed charts; animations, SmartArt and grouped shapes are not imported.
- DOCX import simplifies text boxes, SmartArt, equations, tracked changes and non page-number
  fields, and reports each case in the import warnings shown after opening.
- SVG images are stored as media but cannot be rasterised into exported PDFs.
- XLS files can be opened but not saved back to XLS (use XLSX/ODS/CSV).
- Interoperability with Microsoft Office/LibreOffice was validated structurally (package parts,
  content types, relationships) rather than by launching those applications.
- macOS/Linux builds are not produced here.

## Roadmap

Planned for the next stages (V2.5 / V3.0); deliberately out of scope for 2.2.0:

- True paginated Writer canvas with live layout
- Track changes, footnotes and a full Writer layout engine
- PPTX chart import/export; SmartArt and grouped-shape import
- Pivot tables, dynamic arrays and a dependency-graph recalculation engine
- Master slides and a presentation animation engine
- Optional AI assistant actions for office documents (summarise, rewrite, suggest formulas)

## License

MIT. See [LICENSE](LICENSE). Third-party components keep their own licenses
(Tauri, React, Tailwind, lopdf, pdfium, qpdf, Tesseract, PT Sans/OFL, …).
