//! Writes the inspection payload for real documents to committed fixtures.
//!
//! The frontend has to read this JSON field for field, and the failure mode when
//! it does not is a blank window rather than a type error:
//! `DocumentInspection` derives `rename_all = "camelCase"`, so a snake_case
//! property in the frontend is `undefined` at runtime. The frontend test
//! `src/screens/contract.test.ts` reads these fixtures and checks the inspector
//! against them, so a new field cannot be added and then quietly ignored.
//!
//! Two samples are captured because no single one exercises everything: the
//! text samples carry fonts, the scanned samples carry images.
//!
//! Regenerate with:
//!   cargo test -p pdfcore --test inspection_contract -- --nocapture

use pdfcore::inspect::inspect_document;

#[test]
fn write_inspection_fixtures() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let out = root.join("tests/fixtures");
    std::fs::create_dir_all(&out).expect("fixture dir");
    for sample in ["sample-2.pdf", "sample-images.pdf"] {
        let path = root.join("../../samples").join(sample);
        let report = inspect_document(&path, None).unwrap_or_else(|error| panic!("{sample}: {error}"));
        let json = serde_json::to_string_pretty(&report).expect("serialize");
        let target = out.join(format!("inspection-{sample}.json"));
        std::fs::write(&target, json.as_bytes()).expect("write fixture");
        println!(
            "wrote {} (pages={} fonts={} images={} findings={})",
            target.display(),
            report.page_count,
            report.fonts.len(),
            report.images.len(),
            report.findings.len(),
        );
    }
}
