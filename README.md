# Office Swiss Army Knife

A local-first Windows desktop suite that combines an office package (Writer, Calc,
Impress), local productivity tools (Notes, Planner, Data, Draw, Templates) and the
complete PDF toolkit this project started from.

Everything runs on your machine. Documents are never uploaded, there is no
telemetry, and the app stays useful without an internet connection. Macros and
embedded scripts in office files are never executed.

> Product name: **Office Swiss Army Knife** · Version **1.4.0** · Platform: Windows
> (Tauri also supports Linux/macOS, but only Windows is verified here).

## Features

### Writer (word processor)
- DOCX, ODT, RTF, TXT, Markdown and HTML import/export, PDF export, lossless `.oswk` unit format
- Rich text: styles (Title, Subtitle, Heading 1–6, Quote, Caption, Code), fonts, sizes, bold/italic/underline/strikethrough, text colour, highlight, alignment, line/paragraph spacing, indents
- Bullet and numbered lists, multilevel lists, tables (add/delete row and column, cell shading, borders), images with resize/caption/alignment, hyperlinks, page breaks, horizontal rules
- Page setup: A4/A5/Letter/Legal/A3, portrait/landscape, Normal/Narrow/Wide/custom margins, columns, real headers and footers with `{{page}}` / `{{pages}}` page numbers
- Find & replace (case sensitive, whole word), comments sidebar, word/character/page count, zoom, print, export PDF with selectable text

### Calc (spreadsheet)
- XLSX, ODS and CSV/TSV import/export, XLS import (via calamine), PDF export
- Virtualised grid for large sheets, formula bar with name box, multi-sheet workbooks with tabs
- Formula engine with ~70 functions (SUM, AVERAGE, MIN, MAX, COUNT, COUNTA, IF, IFS, AND, OR, NOT, ROUND/UP/DOWN, ABS, PRODUCT, SUMIF(S), COUNTIF(S), AVERAGEIF, VLOOKUP, HLOOKUP, XLOOKUP, INDEX, MATCH, CONCAT, TEXTJOIN, LEFT, RIGHT, MID, LEN, TRIM, UPPER, LOWER, TODAY, NOW, DATE, YEAR/MONTH/DAY, RANK, LARGE, SMALL, SUMPRODUCT, …)
- Explicit error reporting: `#NAME?`, `#VALUE!`, `#REF!`, `#DIV/0!`, `#N/A`, `#NUM!` and circular-reference detection
- Cell formatting (font, colour, fill, borders, alignment, wrap, number formats), sorting, filtering, freeze panes, conditional formatting (greater/less/between/equal/text/duplicates/top-N/data bars), data validation
- Column/row insert/delete/resize, SVG charts from cell ranges (column, bar, line, pie, area)

### Impress (presentations)
- PPTX and ODP import/export, PDF export, lossless `.oswk`
- Slide thumbnails with reorder, drag/resize/rotate canvas, z-order, align, group/ungroup
- Objects: text, image, rectangle, rounded rectangle, circle, line, arrow, table, chart placeholder
- Layouts (Title, Title + content, Two columns, Image + text, Section, Blank, Quote, Comparison), six original themes, transitions (fade, slide, push, wipe) and a full-screen slideshow
- Speaker notes

### Productivity tools
- **Notes**: folders, tags, search, pin, favourite, archive, colour
- **Planner**: monthly calendar, tasks with priority and deadlines
- **Data**: simple local tables with CSV/JSON import/export
- **Draw**: shapes, lines, arrows, text and freehand pen with SVG, PNG and PDF export
- **Templates**: 24 original templates (CV, Resume, Invoice, Letter, Report, Meeting notes, Contract, To-do list, Budget, Expense tracker, Inventory, Project tracker, Calendar, Personal finance, Business, Pitch, Education, Photo, Project deck, …)
- **Universal Converter**: office-format conversions with batch support and honest unsupported-target messages
- **Document Cleaner**: metadata removal, comment removal, embedded image optimisation for OOXML/ODF
- **PDF Forms**: add standard AcroForm text fields, checkboxes, radios and dropdowns

### PDF module (preserved from v1.x, unchanged)
Merge, Split, Organize, Compress, OCR (Tesseract), Protect/Unlock (AES-256), Watermark,
Annotate, Metadata, Page tools (extract/delete/rotate/resize/crop/numbering), PDF → JPG/PNG,
JPG/PNG → PDF, Batch processing, Info, Reader with text search, AI assistant (opt-in, DeepSeek).

### Workspace
- Document tabs for Writer/Calc/Impress with dirty indicators
- Autosave (15 s / 30 s / 1 min / 5 min / off) with crash recovery
- Local version history (up to 25 snapshots per document, restore from the editor)
- Favourites/pinned files, global search foundations, Light/Dark/System/Midnight/Paper themes
- English and Turkish UI

## Supported formats

Only genuinely working combinations are marked. “–” means not supported.

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

## Screenshots

The repository contains a screenshot gallery of the PDF module in `docs/`. Screenshots
of the new office modules still need to be captured on a running build; they are not
included yet, so no image is claimed here.

## Architecture

```
crates/officecore   Document model + DOCX/ODT/ODS/ODP/RTF/XLSX/CSV/PPTX engines,
                    hardened ZIP + XML layers, PDF layout/render, cleaner
crates/pdfcore      Existing PDF engine: render, merge, split, compress, OCR,
                    security, watermark, annotations, metadata, page layout
crates/aicore       Optional DeepSeek client (only used when the user opts in)
src-tauri           Tauri shell: PDF commands (unchanged) + office commands,
                    JSON stores, version history, recovery
src/                React 19 + TypeScript + Tailwind 4 frontend
  src/office        Writer, Calc (with the formula engine), Impress, Tools screens
  src/screens       Original PDF screens (kept working)
```

The document model (`crates/officecore/src/model.rs`) is the single source of truth
shared by the Rust engines and the TypeScript editors. File formats are import/export
targets; the native `.oswk` format keeps everything the suite understands, including
features that a given file format cannot represent.

## Build

Requirements: Node.js 20+, Rust 1.82+, Visual Studio Build Tools (Windows), and the
bundled engines for PDF/OCR.

```bash
npm install
npm run engines:fetch      # pdfium, qpdf, tesseract, fonts (skipped if present)
npm run build              # type-check + frontend production build
npm run test:rust          # cargo test --workspace
npm run app:build          # Tauri release build (needs network for NSIS on first run)
npm run package            # NSIS installer + portable ZIP into release-artifacts/
```

Development: `npm run app:dev`.

## Usage

1. **Home** offers Create New (Document, Spreadsheet, Presentation, Note, Drawing) and recent files.
2. The office workspace opens documents in tabs. `Ctrl+N`/toolbar buttons create new documents;
   the Save button writes DOCX/ODT/RTF/TXT/MD/HTML, XLSX/ODS/CSV, PPTX/ODP or PDF depending on
   the chosen extension; `.oswk` is the lossless native format.
3. The PDF module works exactly as before: pick a tool, choose files, run.
4. The Convert screen batches office conversions; PDF ↔ image conversion lives in the PDF module.
5. Security/Privacy settings are local: no cloud, no telemetry, AI features are opt-in.

## Privacy

- No cloud upload, no telemetry, no document content collection.
- Only `aicore` performs network requests, and only after the user explicitly enables the assistant.
- Passwords are never logged or persisted. API keys are stored with Windows DPAPI.
- Recovery snapshots and version history live in the app data directory on your machine.

## Security

- Macros and embedded scripts are never executed; documents always open with macros disabled.
- ZIP extraction is bounded (entry count, size, compression ratio) to resist ZIP bombs.
- XML parsing is depth-limited and does not expand external entities.
- Writes are atomic (temp sibling + rename) so a crash cannot leave a half-written file.
- Unsupported constructs are reported in the UI instead of being silently dropped.

## Third-party libraries

Apache-2.0/MIT licensed only: Tauri 2, React 19, TypeScript, Tailwind CSS 4, Vite, zustand,
lucide-react; Rust crates including lopdf, pdfium-render, calamine, quick-xml, flate2, image,
ab_glyph, base64, uuid, tempfile, thiserror. Bundled PDF/OCR binaries keep their own licenses
(pdfium BSD-3, qpdf Apache-2.0, Tesseract Apache-2.0); the bundled PT Sans font is OFL.

## Known limitations

- Writer uses a continuous page view with page-break markers; the page setup, headers,
  footers and printed/exported PDF are page-accurate, but the on-screen canvas is not a
  full WYSIWYG pager.
- XLSX export keeps values, formulas, styles, number formats, merges, widths, freeze panes
  and gridline settings, but does not embed charts or conditional-formatting rules (they are
  kept in `.oswk`). Comments in imported files are not read.
- PPTX export does not embed charts; animations and SmartArt are not imported.
- DOCX import simplifies text boxes, SmartArt, equations, tracked changes and fields and
  reports each case in the import warnings.
- SVG images are stored as media but cannot be rasterised into exported PDFs.
- XLS files can be opened but not saved back to XLS (use XLSX/ODS/CSV).
- macOS/Linux and the frontend unit-test suite are not verified in this version.

## Roadmap

- True paginated Writer canvas
- XLSX chart and conditional-formatting export
- PowerPoint chart import/export
- Frontend (vitest) test suite and office screenshot gallery
- Optional AI assistant actions for office documents (summarise, rewrite, suggest formulas)

## License

MIT. See [LICENSE](LICENSE). Third-party components remain under their own licenses.
