# PDF Swiss Army Knife

**All your PDF tools in one place — a local-first Windows desktop toolkit for PDFs.**
Merge, split, organize, compress, OCR, watermark, protect and convert documents without uploading anything anywhere.

[![License: MIT](https://img.shields.io/badge/License-MIT-informational.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-0078d4)
![Version](https://img.shields.io/badge/version-1.0.0-success)

> **Privacy first:** every operation runs on your machine. There is no cloud upload, no telemetry and no analytics. Passwords are never logged or stored. See [Privacy & security](#privacy--security).

---

## Screenshots

| Home | Page organizer |
| --- | --- |
| ![Home](docs/screenshots/01-home.png) | ![Organize pages](docs/screenshots/02-organize.png) |

| Merge | Compress |
| --- | --- |
| ![Merge](docs/screenshots/03-merge.png) | ![Compress](docs/screenshots/04-compress.png) |

| OCR | Watermark |
| --- | --- |
| ![OCR](docs/screenshots/05-ocr.png) | ![Watermark](docs/screenshots/06-watermark.png) |

| Password protect | Batch processing |
| --- | --- |
| ![Protect](docs/screenshots/07-protect.png) | ![Batch](docs/screenshots/09-batch.png) |

| Page tools | Settings |
| --- | --- |
| ![Page tools](docs/screenshots/08-pagetools.png) | ![Settings](docs/screenshots/10-settings.png) |

---

## Features

### PDF tools
- **Merge** – combine any number of PDFs in a drag-and-order list, keeping the first document's metadata.
- **Organize pages** – thumbnail grid with drag-to-reorder (pointer based, works on Windows), rotate 90/180/270°, duplicate, delete, extract, undo/redo and full keyboard support.
- **Split** – by page ranges, every N pages, individual pages, or cut points.
- **Extract / delete pages** – accepts selections such as `1,3,5-8,12`.
- **Rotate pages** – single page, selection or whole document.
- **Page size / resize** – A3/A4/A5/Letter/Legal/custom with fit or stretch scaling.
- **Crop** – draw the area on a live preview; stored as a proper PDF CropBox.
- **Page numbers** – six positions, `1` / `Page 1` / `1 / 20` / `Page 1 of 20`, start value and margins.
- **Metadata editor** – title, author, subject, keywords, creator, producer, dates, plus "remove all metadata" (including XMP).
- **Add text / images / shapes** – text stamps (full Unicode), image stamps, rectangles, highlights and lines, placed by clicking the preview.
- **Document info** – pages, size, PDF version, encryption, text-layer detection, image count, page-size summary.

### Compression
- **Lossless** – recompress streams, prune objects, strip metadata; text stays text.
- **Strong (re-render)** – re-render pages as JPEG at a chosen DPI/quality, optional grayscale; the mode that reaches the big reductions on scans.
- **Real estimates** – the "Analyze" step renders actual sample pages at the chosen settings, so the reported size is not a guess. Example from validation: a 1.44 MB 300-DPI scan → **150.9 KB (−89.8 %)**.

### OCR (offline, Tesseract 5)
- Searchable PDF, plain text or Markdown output.
- English, Turkish, German, Dutch, French, Spanish, Italian, Bulgarian (bundled `tessdata_fast`) and a documented path for more languages.
- Image cleanup: auto-orientation (OSD), deskew, contrast, denoise, binarize, grayscale.
- Skips pages that already have a text layer, per-page progress and cancellation.

### Security
- **Password protect** – AES-256 (PDF 2.0 / revision 6) with user + owner passwords and permissions (print, copy, edit, comment).
- **Unlock** – remove protection with a known password (no cracking or brute force anywhere in the product).
- The original page size, text layer and metadata are preserved.

### Conversion
- **PDF → JPG/PNG** at 72–450 DPI, grayscale option, `page_001.jpg` naming.
- **Images → PDF** from JPG/PNG/WEBP/BMP/TIFF with page size, orientation, fit/cover/actual size, margins and per-image rotation.

### Batch processing
- Apply one operation (compress, watermark, OCR, protect, rotate, PDF→images) to many files with per-file status: pending, processing, completed, failed, cancelled.

### Application
- Modern dark/light/system theme, English + Turkish UI, resizable layout that adapts to the window.
- Drag & drop files from Explorer anywhere in the window; the home screen suggests the right tool.
- Recent files (paths + timestamps only), keyboard shortcuts, cancel-able long operations, friendly error messages with stable error codes.
- Windows installer (NSIS) and portable ZIP.

---

## Tech stack

| Layer | Technology |
| --- | --- |
| Shell | [Tauri 2](https://tauri.app/) (Rust) + WebView2 |
| Frontend | React 19, TypeScript, Vite 6, Tailwind CSS 4, lucide-react icons, zustand |
| PDF core | Rust crate `pdfcore` built on [lopdf](https://github.com/J-F-Liu/lopdf) |
| Rendering | [pdfium](https://pdfium.googlesource.com/pdfium/) via `pdfium-render` (bundled `pdfium.dll`) |
| OCR | [Tesseract 5](https://github.com/tesseract-ocr/tesseract) (bundled) + `tessdata_fast` models |
| Security engine | lopdf standard security handler; [qpdf](https://qpdf.readthedocs.io/) bundled for advanced structural work |
| Text rendering | `ab_glyph` + bundled PT Sans (SIL OFL) |

## Architecture

```
pdf-swiss-army-knife/
├── crates/pdfcore/          # all PDF logic, no Tauri dependency (unit + integration tested)
│   ├── src/                 # merge, organize, split, security, metadata, info,
│   │                        # render (pdfium), images, compress, ocr, watermark,
│   │                        # numbering, annotate, pagelayout, textimg, engines
│   └── tests/               # 62 integration tests + synthetic sample generators
├── src-tauri/               # Tauri shell: commands, job registry (progress/cancel),
│   └── resources/engines/   # bundled pdfium.dll, qpdf.exe, tesseract (fetched, gitignored)
├── src/                     # React UI (screens, components, i18n, state)
├── scripts/                 # engine fetch, icon, packaging, UI validation helpers
├── samples/                 # generated synthetic test documents (no personal data)
└── docs/screenshots/
```

Design notes:
- **`pdfcore` is UI-agnostic.** Operations take plain parameters and a `CancelToken` + progress callback, which makes them directly testable without a GUI.
- **Everything heavy runs off the UI thread.** Tauri commands are async and hand work to the blocking pool; progress is streamed back as `job:progress` events, cancellation flips an atomic flag that loops and child processes observe.
- **No shell interpolation.** External engines (tesseract, qpdf) are always spawned with argument arrays and a hardened environment; temporary files live in per-job directories that are deleted on drop (including on cancel/failure).
- **Atomic writes.** Outputs are written to a temporary sibling file and renamed, so a failed or cancelled run never leaves a half-written PDF.

---

## Installation

### End users
1. Download `PDF-Swiss-Army-Knife-Setup-1.0.0.exe` from the [latest release](../../releases/latest).
2. Run it (no admin rights required for the per-user install) and launch **PDF Swiss Army Knife**.
3. All native engines are included — no extra downloads, no runtime setup.

Prefer no installer? Grab `PDF-Swiss-Army-Knife-Portable-1.0.0.zip`, extract anywhere and run `PDF-Swiss-Army-Knife.exe`. The `resources` folder next to the executable must stay next to it.

**Requirements:** Windows 10/11 x64, WebView2 runtime (preinstalled on current Windows 10/11).

### Development

Prerequisites:
- Node.js 20+
- Rust stable (MSVC toolchain) + Visual Studio Build Tools (C++ workload)
- WebView2 runtime (comes with Windows 11)

```powershell
git clone https://github.com/ozanstn1-stack/pdf-swiss-army-knife.git
cd pdf-swiss-army-knife

# 1. Native engines (pdfium, qpdf, tesseract + language data, PT Sans font)
npm run engines:fetch

# 2. Frontend dependencies
npm install

# 3. Run the app in development (hot reload)
npm run app:dev
```

`npm run engines:fetch` downloads the pinned engine versions into `src-tauri/resources/engines/` and the OFL font into `crates/pdfcore/assets/fonts/`. Both paths are gitignored; the fetch script is the reproducible source of truth. Engines can also be searched via `PDFSAK_ENGINES_DIR` or the system `PATH`.

### Tests

```powershell
npm run test:rust          # or: cargo test --workspace
```

The suite covers merge, split, extract, delete, reorder/duplicate/rotate plans, compression (lossless + raster), PDF↔image conversion, watermarking, AES-256 protect/unlock, metadata, annotations, page numbering, resize/crop, OCR (searchable PDF, text, Markdown, noisy scans, single-page documents), batch stability, the IPC wire format and a dedicated hostile-input suite (empty, corrupt, locked, oversized, wrong-password, out-of-range, cancellation).

### Build & release

```powershell
npm run app:build          # release build + NSIS installer + resources
npm run package            # release-artifacts/: installer, portable ZIP, SHA256SUMS.txt
```

`npm run package` produces:
- `release-artifacts/PDF-Swiss-Army-Knife-Setup-<version>.exe`
- `release-artifacts/PDF-Swiss-Army-Knife-Portable-<version>.zip`
- `release-artifacts/SHA256SUMS.txt`

### Development helpers

| Script | Purpose |
| --- | --- |
| `cargo run -p pdfcore --example make-samples -- samples` | regenerate the synthetic sample documents |
| `cargo run -p pdfcore --release --example inspect -- <file.pdf>` | print page count, text layer, metadata for any PDF |
| `cargo run -p pdfcore --release --example ocr-file -- in.pdf out.pdf eng` | run the OCR pipeline from the CLI |
| `scripts/capture-screen.ps1`, `scripts/ui-flow.ps1` | automated UI screenshots/validation (uses `PDFSAK_START_SCREEN`, `PDFSAK_DEV_FILES`, `PDFSAK_DEV_RUN`, `PDFSAK_ALWAYS_ON_TOP`) |

---

## Supported platforms

| Platform | Status |
| --- | --- |
| Windows 10/11 x64 | **Supported and shipped** (v1.0.0) |
| macOS / Linux | Architecture is portable (`pdfcore` has no Tauri dependency and engine paths are resolved at runtime) but not built or tested yet. Tracking in the roadmap. |

---

## Privacy & security

**No cloud upload.** The application never sends documents anywhere; there is no networking code in the product, no telemetry and no analytics.

- **Passwords** are used in memory only, never written to disk or logs, and cleared from UI state after the operation.
- **Recent files** store only the path, file name, tool and timestamp. They can be cleared at any time and are skipped when the setting is disabled.
- **Logs** contain error codes/timestamps and engine diagnostics only — never document content, text or credentials.
- **Temporary files** live in per-job directories under the system temp folder and are deleted when the job ends (including cancellation and failures).
- **Command execution** always uses argument arrays with explicit environments; no shell string interpolation. Paths coming from Windows APIs have their `\\?\` prefix stripped before being handed to external tools.
- **Malicious input** is treated defensively: page selections are validated, output paths are resolved before writing, and locked files produce a controlled error instead of a partial write.

## Third-party licenses

This project is MIT licensed. The bundled engines keep their own licenses:

| Component | Version | License | Notes |
| --- | --- | --- | --- |
| [pdfium](https://pdfium.googlesource.com/pdfium/) (prebuilt by [bblanchon/pdfium-binaries](https://github.com/bblanchon/pdfium-binaries)) | chromium/8057 | BSD-3-Clause | `pdfium.dll`, page rendering |
| [qpdf](https://github.com/qpdf/qpdf) | 12.4.1 | Apache-2.0 | structural engine, `qpdf.exe` |
| [Tesseract OCR](https://github.com/tesseract-ocr/tesseract) (build: [UB Mannheim](https://github.com/UB-Mannheim/tesseract)) | 5.4.0 | Apache-2.0 | OCR engine |
| [tessdata_fast](https://github.com/tesseract-ocr/tessdata_fast) language models | current | Apache-2.0 | eng, tur, deu, nld, fra, spa, ita, bul, osd |
| [PT Sans](https://github.com/google/fonts/tree/main/ofl/ptsans) | 2.003 | SIL OFL 1.1 | text stamp/watermark rendering (`crates/pdfcore/assets/fonts/OFL.txt`) |
| [lopdf](https://github.com/J-F-Liu/lopdf), [pdfium-render](https://github.com/ajrcarey/pdfium-render), [image](https://github.com/image-rs/image), [ab_glyph](https://github.com/alexheretic/ab-glyph), [tempfile](https://github.com/Stebalien/tempfile), [uuid](https://github.com/uuid-rs/uuid), [thiserror](https://github.com/dtolnay/thiserror), [serde](https://github.com/serde-rs/serde), [base64](https://github.com/marshallpierce/rust-base64) | — | MIT / Apache-2.0 | Rust crates |
| [Tauri](https://github.com/tauri-apps/tauri), [React](https://github.com/facebook/react), [Vite](https://github.com/vitejs/vite), [Tailwind CSS](https://github.com/tailwindlabs/tailwindcss), [lucide-react](https://github.com/lucide-icons/lucide) | — | MIT / Apache-2.0 / ISC | application stack |

The engine download script (`scripts/fetch-engines.ps1`) pins the exact versions above and downloads them from their official release channels.

## Known limitations

Honest list of what v1.0.0 does **not** do:

- **Merge does not carry over bookmarks/outlines.** Document metadata is preserved (optional), outlines are not merged yet.
- **"Strong" compression is lossy.** Pages are re-rendered as JPEG; text becomes part of the image. The UI says so explicitly and the lossless mode is available for text documents.
- **OCR searchable PDFs are larger than the input** for image-heavy scans (tesseract embeds the page images). The extracted text layer is correct; size optimization of OCR output isn't implemented yet.
- **Crop stores a CropBox** (non-destructive, as most editors do) rather than rewriting page content.
- **Annotations are flattened** into page content — they cannot be edited later as PDF annotation objects.
- **Text stamps/watermarks are rasterized** at high resolution (instead of embedding subset fonts), which keeps Unicode support simple at the cost of file size.
- **No printing** from the application (export and open in your reader).
- **Watermark "tile" uses a fixed grid**, not a user-defined spacing.
- **Page numbering uses the standard Helvetica font**, so the label text itself is ASCII (numbers, "Page", "/").
- Only a single window/instance is supported; there is no plugin system.
- macOS/Linux are not built yet.

## Roadmap

- [ ] Bookmark/outline merging and preservation.
- [ ] OCR output optimization (JBIG2/JPEG XObject compression for scanned pages).
- [ ] WYSIWYG editor for existing flattened annotations (real PDF annotation objects).
- [ ] Print support with page range selection.
- [ ] Additional OCR language packs via an in-app manager.
- [ ] macOS/Linux builds (the core is already platform-agnostic).
- [ ] Signed builds and MSIX packaging.

## License

[MIT](LICENSE) © 2026 PDF Swiss Army Knife contributors.
