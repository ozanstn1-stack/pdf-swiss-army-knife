//! Round-trip tests against the real sample documents in `samples/`.
//!
//! These cover the workflow the user performs by hand:
//!   open a file -> verify content -> save it again -> reopen -> verify again.

use officecore::{docx, odf, pptx, rtf, xlsx};
use std::path::{Path, PathBuf};

fn samples_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("samples")
}

fn require(path: &Path) -> PathBuf {
    assert!(
        path.exists(),
        "sample {} is missing - run `cargo run -p officecore --example make-office-samples`",
        path.display()
    );
    path.to_path_buf()
}

fn temp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join("osak-roundtrip");
    std::fs::create_dir_all(&dir).unwrap();
    dir.join(name)
}

#[test]
fn docx_open_edit_save_reopen() {
    let source = require(&samples_dir().join("test-document.docx"));
    let first = docx::read_docx_file(&source).unwrap();
    assert!(first.document.plain_text().contains("Test document"));
    assert!(first.document.plain_text().contains("Second page"));
    assert_eq!(first.document.header.len(), 1);
    assert_eq!(first.document.footer.len(), 1);
    let tables = first.document.blocks.iter().filter(|block| matches!(block, officecore::model::Block::Table { .. })).count();
    assert_eq!(tables, 1, "the sample document must contain one table");
    let images = first.document.blocks.iter().filter(|block| matches!(block, officecore::model::Block::Image { .. })).count();
    assert_eq!(images, 1, "the sample document must contain one image");

    // Edit: append a paragraph, then save and reopen.
    let mut edited = first.document;
    edited.blocks.push(officecore::model::Block::paragraph("Round trip marker"));
    let target = temp("roundtrip-document.docx");
    docx::write_docx_file(&target, &edited).unwrap();
    let second = docx::read_docx_file(&target).unwrap();
    assert!(second.document.plain_text().contains("Round trip marker"));
    assert!(second.document.plain_text().contains("Test document"));
    assert_eq!(second.document.header.len(), 1);
    assert_eq!(second.document.footer.len(), 1);
}

#[test]
fn docx_package_can_be_read_by_other_office_suites() {
    // Structural checks that Word/LibreOffice rely on.
    let source = require(&samples_dir().join("test-document.docx"));
    let bytes = std::fs::read(&source).unwrap();
    let reader = officecore::zip::ZipReader::open(bytes).unwrap();
    for part in ["[Content_Types].xml", "_rels/.rels", "word/document.xml", "word/styles.xml", "word/numbering.xml", "word/header1.xml", "word/footer1.xml"] {
        assert!(reader.contains(part), "missing package part {part}");
    }
    let document = reader.read_text("word/document.xml").unwrap();
    assert!(document.contains("<w:tbl>"), "table markup missing");
    assert!(document.contains("<w:drawing>"), "image markup missing");
    assert!(document.contains("<w:sectPr"), "section properties missing");
}

#[test]
fn odt_and_rtf_roundtrip() {
    let odt_source = require(&samples_dir().join("test-document.odt"));
    let odt = odf::read_odt_file(&odt_source).unwrap();
    assert!(odt.document.plain_text().contains("Test document"));
    let odt_target = temp("roundtrip-document.odt");
    std::fs::write(&odt_target, odf::write_odt(&odt.document).unwrap()).unwrap();
    let odt_again = odf::read_odt_file(&odt_target).unwrap();
    assert!(odt_again.document.plain_text().contains("Test document"));

    let rtf_source = require(&samples_dir().join("test-document.rtf"));
    let rtf = rtf::read_rtf_file(&rtf_source).unwrap();
    assert!(rtf.document.plain_text().contains("Test document"));
}

#[test]
fn xlsx_open_edit_save_reopen() {
    let source = require(&samples_dir().join("test-spreadsheet.xlsx"));
    let first = xlsx::read_workbook_file(&source).unwrap();
    assert_eq!(first.workbook.sheets.len(), 2);
    let data = &first.workbook.sheets[0];
    assert!(data.cells.len() > 300, "the sample workbook should contain 100 data rows");
    assert_eq!(data.get("A2").map(|cell| cell.value.clone()), Some(officecore::model::CellValue::Text("Item 1".into())));
    let formula = data.get("D2").and_then(|cell| cell.formula.clone());
    assert_eq!(formula.as_deref(), Some("=B2*C2"));

    let mut edited = first.workbook;
    edited.sheets[0].set("A1", officecore::model::Cell {
        value: officecore::model::CellValue::Text("Edited header".into()),
        ..Default::default()
    });
    let target = temp("roundtrip-spreadsheet.xlsx");
    xlsx::write_xlsx_file(&target, &edited).unwrap();
    let second = xlsx::read_workbook_file(&target).unwrap();
    assert_eq!(second.workbook.sheets.len(), 2);
    assert_eq!(
        second.workbook.sheets[0].get("A1").map(|cell| cell.value.clone()),
        Some(officecore::model::CellValue::Text("Edited header".into()))
    );
    assert_eq!(
        second.workbook.sheets[1].get("B4").and_then(|cell| cell.formula.clone()).as_deref(),
        Some("=SUM(Data!D2:D101)")
    );
}

#[test]
fn ods_roundtrip() {
    let source = require(&samples_dir().join("test-spreadsheet.ods"));
    let first = odf::read_ods_file(&source).unwrap();
    assert_eq!(first.workbook.sheets.len(), 2);
    assert!(first.workbook.sheets[0].cells.len() > 300);
    let target = temp("roundtrip-spreadsheet.ods");
    std::fs::write(&target, odf::write_ods(&first.workbook).unwrap()).unwrap();
    let second = odf::read_ods_file(&target).unwrap();
    assert_eq!(second.workbook.sheets.len(), 2);
    assert!(second.workbook.sheets[0].plain_text_probe());
}

trait SheetProbe {
    fn plain_text_probe(&self) -> bool;
}

impl SheetProbe for officecore::model::Sheet {
    fn plain_text_probe(&self) -> bool {
        self.cells.values().any(|cell| matches!(&cell.value, officecore::model::CellValue::Text(text) if text == "Item 1"))
    }
}

#[test]
fn pptx_open_edit_save_reopen() {
    let source = require(&samples_dir().join("test-presentation.pptx"));
    let first = pptx::read_pptx_file(&source).unwrap();
    assert_eq!(first.deck.slides.len(), 5, "the sample deck must have five slides");
    let texts: Vec<String> = first.deck.slides.iter().flat_map(|slide| slide.objects.iter()).filter_map(|object| object.text.as_ref().map(|frame| frame.plain())).collect();
    assert!(texts.iter().any(|text| text.contains("Slide 1 title")));
    assert!(first.deck.slides.iter().any(|slide| slide.objects.iter().any(|object| object.image.is_some())));
    assert!(first.deck.slides.iter().any(|slide| slide.objects.iter().any(|object| object.kind == "rect" || object.kind == "ellipse")));

    let mut edited = first.deck;
    edited.slides[0].notes = "Edited notes".into();
    let target = temp("roundtrip-presentation.pptx");
    pptx::write_pptx_file(&target, &edited).unwrap();
    let second = pptx::read_pptx_file(&target).unwrap();
    assert_eq!(second.deck.slides.len(), 5);
    assert!(second.deck.slides[0].notes.contains("Edited notes"));
}

#[test]
fn odp_roundtrip() {
    let source = require(&samples_dir().join("test-presentation.odp"));
    let first = odf::read_odp_file(&source).unwrap();
    assert_eq!(first.deck.slides.len(), 5);
    let target = temp("roundtrip-presentation.odp");
    std::fs::write(&target, odf::write_odp(&first.deck).unwrap()).unwrap();
    let second = odf::read_odp_file(&target).unwrap();
    assert_eq!(second.deck.slides.len(), 5);
}

#[test]
fn csv_sample_imports() {
    let source = require(&samples_dir().join("test-spreadsheet.csv"));
    let bytes = std::fs::read(&source).unwrap();
    let read = officecore::csvio::parse_csv(&bytes, &officecore::csvio::CsvOptions::default()).unwrap();
    assert!(read.workbook.sheets[0].cells.len() > 300);
}
