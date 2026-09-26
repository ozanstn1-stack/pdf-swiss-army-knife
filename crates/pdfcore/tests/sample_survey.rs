//! Reports which sample documents carry which features, so the inspection
//! contract fixture can be captured from a file that is actually interesting.

use pdfcore::inspect::inspect_document;

#[test]
fn survey_samples() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../samples");
    let mut entries: Vec<_> = std::fs::read_dir(&dir)
        .expect("samples dir")
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "pdf"))
        .collect();
    entries.sort();
    for path in entries {
        let Ok(report) = inspect_document(&path, None) else {
            println!("{}: unreadable", path.file_name().unwrap().to_string_lossy());
            continue;
        };
        println!(
            "{:28} pages={:<4} fonts={:<3} images={:<3} outline={:<3} formfields={:<3} findings={:<3} pdfa={}",
            path.file_name().unwrap().to_string_lossy(),
            report.page_count,
            report.fonts.len(),
            report.images.len(),
            report.outline.len(),
            report.form_fields.len(),
            report.findings.len(),
            report.accessibility_conformance,
        );
    }
}
