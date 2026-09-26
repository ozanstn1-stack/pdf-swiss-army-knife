//! WordprocessingML (DOCX) import and export.
//!
//! The writer produces a self-contained OOXML package (styles, numbering,
//! headers/footers, tables, images, hyperlinks, page setup) that opens in Word,
//! LibreOffice and OnlyOffice. The reader is deliberately tolerant: unknown
//! constructs are skipped with a user-facing warning instead of failing, and
//! macros/embedded scripts are never executed or imported.

use crate::error::{OfficeError, OfficeResult};
use crate::io::{bare_hex, normalize_hex};
use crate::model::*;
use crate::xml::{parse_xml, XmlNode, XmlWriter};
use crate::zip::{ZipReader, ZipWriter};
use std::collections::HashMap;
use std::path::Path;

const NS_DECL: &str = concat!(
    "xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\" ",
    "xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" ",
    "xmlns:wp=\"http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing\" ",
    "xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" ",
    "xmlns:pic=\"http://schemas.openxmlformats.org/drawingml/2006/picture\" ",
    "xmlns:mc=\"http://schemas.openxmlformats.org/markup-compatibility/2006\""
);

fn twips(points: f64) -> i64 {
    (points * 20.0).round() as i64
}

fn half_points(points: f64) -> i64 {
    (points * 2.0).round() as i64
}

fn emu(points: f64) -> i64 {
    (points * 12700.0).round() as i64
}

#[derive(Debug, Clone)]
pub struct DocxRead {
    pub document: TextDocument,
    pub warnings: Vec<String>,
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

#[derive(Default)]
struct Relationships {
    next_id: usize,
    entries: Vec<(String, String, bool)>,
}

impl Relationships {
    fn new(start: usize) -> Self {
        Self { next_id: start, entries: Vec::new() }
    }

    fn add(&mut self, kind: &str, target: &str, external: bool) -> String {
        let id = format!("rId{}", self.next_id);
        self.next_id += 1;
        self.entries.push((id.clone(), format!("{kind}|{target}"), external));
        id
    }

    fn xml(&self) -> String {
        let mut writer = XmlWriter::new();
        writer.declaration();
        writer.open(
            "Relationships",
            &[("xmlns", "http://schemas.openxmlformats.org/package/2006/relationships")],
        );
        for (id, payload, external) in &self.entries {
            let (kind, target) = payload.split_once('|').unwrap_or(("", ""));
            let mut attrs: Vec<(&str, &str)> = vec![("Id", id), ("Type", kind), ("Target", target)];
            if *external {
                attrs.push(("TargetMode", "External"));
            }
            writer.empty("Relationship", &attrs);
        }
        writer.close("Relationships");
        writer.finish()
    }
}

const REL_IMAGE: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";
const REL_HYPERLINK: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink";

#[derive(Default)]
struct Media {
    entries: Vec<(String, Vec<u8>)>,
    index: usize,
}

impl Media {
    fn add(&mut self, image: &ImageData) -> Option<String> {
        if image.is_empty() {
            return None;
        }
        self.index += 1;
        let path = format!("media/image{}.{}", self.index, image.extension());
        self.entries.push((path.clone(), image.bytes()));
        Some(path)
    }
}

fn content_types(has_header: bool, has_footer: bool) -> String {
    let mut writer = XmlWriter::new();
    writer.declaration();
    writer.open("Types", &[("xmlns", "http://schemas.openxmlformats.org/package/2006/content-types")]);
    writer.empty("Default", &[("Extension", "rels"), ("ContentType", "application/vnd.openxmlformats-package.relationships+xml")]);
    writer.empty("Default", &[("Extension", "xml"), ("ContentType", "application/xml")]);
    for (extension, mime) in [
        ("png", "image/png"),
        ("jpg", "image/jpeg"),
        ("jpeg", "image/jpeg"),
        ("gif", "image/gif"),
        ("bmp", "image/bmp"),
        ("webp", "image/webp"),
        ("tiff", "image/tiff"),
    ] {
        writer.empty("Default", &[("Extension", extension), ("ContentType", mime)]);
    }
    let overrides = [
        ("/word/document.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"),
        ("/word/styles.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"),
        ("/word/numbering.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"),
        ("/word/settings.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"),
        ("/word/header1.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"),
        ("/word/footer1.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"),
        ("/docProps/core.xml", "application/vnd.openxmlformats-package.core-properties+xml"),
        ("/docProps/app.xml", "application/vnd.openxmlformats-officedocument.extended-properties+xml"),
    ];
    for (part, mime) in overrides {
        if part.ends_with("header1.xml") && !has_header {
            continue;
        }
        if part.ends_with("footer1.xml") && !has_footer {
            continue;
        }
        writer.empty("Override", &[("PartName", part), ("ContentType", mime)]);
    }
    writer.close("Types");
    writer.finish()
}

fn root_relationships() -> String {
    let mut writer = XmlWriter::new();
    writer.declaration();
    writer.open("Relationships", &[("xmlns", "http://schemas.openxmlformats.org/package/2006/relationships")]);
    writer.empty("Relationship", &[("Id", "rId1"), ("Type", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"), ("Target", "word/document.xml")]);
    writer.empty("Relationship", &[("Id", "rId2"), ("Type", "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties"), ("Target", "docProps/core.xml")]);
    writer.empty("Relationship", &[("Id", "rId3"), ("Type", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties"), ("Target", "docProps/app.xml")]);
    writer.close("Relationships");
    writer.finish()
}

fn core_properties(document: &TextDocument) -> String {
    let created = if document.metadata.created.is_empty() { "1970-01-01T00:00:00Z".to_string() } else { document.metadata.created.clone() };
    let modified = if document.metadata.modified.is_empty() { created.clone() } else { document.metadata.modified.clone() };
    let mut writer = XmlWriter::new();
    writer.declaration();
    writer.open(
        "cp:coreProperties",
        &[
            ("xmlns:cp", "http://schemas.openxmlformats.org/package/2006/metadata/core-properties"),
            ("xmlns:dc", "http://purl.org/dc/elements/1.1/"),
            ("xmlns:dcterms", "http://purl.org/dc/terms/"),
            ("xmlns:dcmitype", "http://purl.org/dc/dcmitype/"),
            ("xmlns:xsi", "http://www.w3.org/2001/XMLSchema-instance"),
        ],
    );
    writer.open("dc:title", &[]).text(&document.title).close("dc:title");
    writer.open("dc:creator", &[]).text(&document.metadata.author).close("dc:creator");
    writer.open("dc:subject", &[]).text(&document.metadata.subject).close("dc:subject");
    writer.open("cp:keywords", &[]).text(&document.metadata.keywords).close("cp:keywords");
    writer.open("cp:lastModifiedBy", &[]).text(&document.metadata.last_modified_by).close("cp:lastModifiedBy");
    writer.open("dcterms:created", &[("xsi:type", "dcterms:W3CDTF")]).text(&created).close("dcterms:created");
    writer.open("dcterms:modified", &[("xsi:type", "dcterms:W3CDTF")]).text(&modified).close("dcterms:modified");
    writer.close("cp:coreProperties");
    writer.finish()
}

fn app_properties(document: &TextDocument) -> String {
    let words = document.word_count();
    let mut writer = XmlWriter::new();
    writer.declaration();
    writer.open(
        "Properties",
        &[
            ("xmlns", "http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"),
            ("xmlns:vt", "http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"),
        ],
    );
    writer.open("Application", &[]).text("Office Swiss Army Knife").close("Application");
    writer.open("AppVersion", &[]).text("2.0000").close("AppVersion");
    writer.open("Words", &[]).text(&words.to_string()).close("Words");
    writer.open("Paragraphs", &[]).text(&document.blocks.len().to_string()).close("Paragraphs");
    writer.close("Properties");
    writer.finish()
}

fn write_paragraph_properties(writer: &mut XmlWriter, props: &ParaProps) {
    let mut children: Vec<String> = Vec::new();
    if !props.style.is_empty() && props.style != "Normal" {
        children.push(format!("<w:pStyle w:val=\"{}\"/>", crate::xml::escape_attr(&props.style)));
    }
    if props.keep_with_next {
        children.push("<w:keepNext/>".into());
    }
    if props.keep_together {
        children.push("<w:keepLines/>".into());
    }
    if props.page_break_before {
        children.push("<w:pageBreakBefore/>".into());
    }
    match props.align.as_str() {
        "center" => children.push("<w:jc w:val=\"center\"/>".into()),
        "right" => children.push("<w:jc w:val=\"right\"/>".into()),
        "justify" => children.push("<w:jc w:val=\"both\"/>".into()),
        _ => {}
    }
    if props.space_before_pt != 0.0 || props.space_after_pt != 0.0 {
        children.push(format!(
            "<w:spacing w:before=\"{}\" w:after=\"{}\"/>",
            twips(props.space_before_pt.max(0.0)),
            twips(props.space_after_pt.max(0.0))
        ));
    }
    if props.line_spacing > 0.0 {
        children.push(format!("<w:spacing w:line=\"{}\" w:lineRule=\"auto\"/>", (props.line_spacing * 240.0).round() as i64));
    }
    if props.indent_left_pt != 0.0 || props.indent_right_pt != 0.0 || props.first_line_pt != 0.0 {
        let mut attrs = String::new();
        if props.indent_left_pt != 0.0 {
            attrs.push_str(&format!(" w:left=\"{}\"", twips(props.indent_left_pt)));
        }
        if props.indent_right_pt != 0.0 {
            attrs.push_str(&format!(" w:right=\"{}\"", twips(props.indent_right_pt)));
        }
        if props.first_line_pt > 0.0 {
            attrs.push_str(&format!(" w:firstLine=\"{}\"", twips(props.first_line_pt)));
        } else if props.first_line_pt < 0.0 {
            attrs.push_str(&format!(" w:hanging=\"{}\"", twips(-props.first_line_pt)));
        }
        children.push(format!("<w:ind{attrs}/>"));
    }
    if let Some(list) = &props.list {
        let num_id = if list.kind == "number" { 2 } else { 1 };
        children.push(format!(
            "<w:numPr><w:ilvl w:val=\"{}\"/><w:numId w:val=\"{}\"/></w:numPr>",
            list.level.min(8),
            num_id
        ));
    }
    if !children.is_empty() {
        writer.raw("<w:pPr>");
        for child in children {
            writer.raw(&child);
        }
        writer.raw("</w:pPr>");
    }
}

const HIGHLIGHTS: [&str; 16] = [
    "yellow", "green", "cyan", "magenta", "blue", "red", "darkBlue", "darkGreen", "darkRed", "darkYellow", "gray",
    "lightGray", "black", "white", "darkGray", "none",
];

fn highlight_value(color: &str) -> String {
    let normalized = color.to_ascii_lowercase();
    let simple = normalized.trim_start_matches('#');
    for name in HIGHLIGHTS {
        if name.to_ascii_lowercase() == simple {
            return name.to_string();
        }
    }
    // Map hex colours onto the closest Word highlight bucket.
    match simple {
        "ffff00" => "yellow".into(),
        "00ff00" => "green".into(),
        "00ffff" => "cyan".into(),
        "ff00ff" => "magenta".into(),
        "0000ff" => "blue".into(),
        "ff0000" => "red".into(),
        "" => "none".into(),
        _ => "yellow".into(),
    }
}

fn write_run_properties(writer: &mut XmlWriter, run: &Run) {
    let mut children: Vec<String> = Vec::new();
    if let Some(font) = &run.font {
        let escaped = crate::xml::escape_attr(font);
        children.push(format!("<w:rFonts w:ascii=\"{escaped}\" w:hAnsi=\"{escaped}\" w:cs=\"{escaped}\"/>"));
    }
    if run.bold {
        children.push("<w:b/>".into());
    }
    if run.italic {
        children.push("<w:i/>".into());
    }
    if run.underline {
        children.push("<w:u w:val=\"single\"/>".into());
    }
    if run.strike {
        children.push("<w:strike/>".into());
    }
    if let Some(color) = run.color.as_deref().and_then(bare_hex) {
        children.push(format!("<w:color w:val=\"{color}\"/>"));
    }
    if let Some(highlight) = &run.highlight {
        children.push(format!("<w:highlight w:val=\"{}\"/>", highlight_value(highlight)));
    }
    if let Some(size) = run.size_pt {
        children.push(format!("<w:sz w:val=\"{}\"/><w:szCs w:val=\"{}\"/>", half_points(size), half_points(size)));
    }
    if run.superscript {
        children.push("<w:vertAlign w:val=\"superscript\"/>".into());
    } else if run.subscript {
        children.push("<w:vertAlign w:val=\"subscript\"/>".into());
    }
    if !children.is_empty() {
        writer.raw("<w:rPr>");
        for child in children {
            writer.raw(&child);
        }
        writer.raw("</w:rPr>");
    }
}

fn write_text_run(writer: &mut XmlWriter, run: &Run) {
    // `{{page}}` / `{{pages}}` become real PAGE/NUMPAGES fields so Word and
    // LibreOffice keep them up to date instead of showing a static number.
    if run.text.contains("{{page}}") || run.text.contains("{{pages}}") {
        let mut remaining = run.text.as_str();
        while !remaining.is_empty() {
            let next_page = remaining.find("{{page}}");
            let next_pages = remaining.find("{{pages}}");
            let (index, token) = match (next_page, next_pages) {
                (Some(a), Some(b)) => if a < b { (a, "{{page}}") } else { (b, "{{pages}}") },
                (Some(a), None) => (a, "{{page}}"),
                (None, Some(b)) => (b, "{{pages}}"),
                (None, None) => {
                    write_plain_run(writer, run, remaining);
                    break;
                }
            };
            if index > 0 {
                write_plain_run(writer, run, &remaining[..index]);
            }
            write_field_run(writer, run, token == "{{pages}}");
            remaining = &remaining[index + token.len()..];
        }
        return;
    }
    write_plain_run(writer, run, &run.text);
}

fn write_plain_run(writer: &mut XmlWriter, run: &Run, text: &str) {
    if text.is_empty() {
        return;
    }
    writer.raw("<w:r>");
    write_run_properties(writer, run);
    let mut parts = text.split('\n').peekable();
    while let Some(part) = parts.next() {
        writer.raw("<w:t xml:space=\"preserve\">");
        writer.text(part);
        writer.raw("</w:t>");
        if parts.peek().is_some() {
            writer.raw("<w:br/>");
        }
    }
    writer.raw("</w:r>");
}

fn write_field_run(writer: &mut XmlWriter, run: &Run, total_pages: bool) {
    let instruction = if total_pages { "NUMPAGES" } else { "PAGE" };
    for (payload, is_field) in [
        ("<w:fldChar w:fldCharType=\"begin\"/>".to_string(), false),
        (format!("<w:instrText xml:space=\"preserve\"> {instruction} </w:instrText>"), false),
        ("<w:fldChar w:fldCharType=\"separate\"/>".to_string(), false),
        ("<w:t>1</w:t>".to_string(), true),
        ("<w:fldChar w:fldCharType=\"end\"/>".to_string(), false),
    ] {
        writer.raw("<w:r>");
        write_run_properties(writer, run);
        writer.raw(&payload);
        writer.raw("</w:r>");
        let _ = is_field;
    }
}

fn write_paragraph(writer: &mut XmlWriter, props: &ParaProps, runs: &[Run], rels: &mut Relationships) {
    writer.raw("<w:p>");
    write_paragraph_properties(writer, props);
    for run in runs {
        if let Some(url) = &run.link {
            let id = rels.add(REL_HYPERLINK, url, true);
            writer.raw(&format!("<w:hyperlink r:id=\"{id}\">"));
            write_text_run(writer, run);
            writer.raw("</w:hyperlink>");
        } else {
            write_text_run(writer, run);
        }
    }
    writer.raw("</w:p>");
}

fn write_image(writer: &mut XmlWriter, image: &ImageData, width_pt: f64, height_pt: f64, rels: &mut Relationships, media: &mut Media, id_counter: &mut usize) {
    let Some(target) = media.add(image) else {
        return;
    };
    let id = rels.add(REL_IMAGE, &target, false);
    *id_counter += 1;
    let name = if image.name.is_empty() { format!("Image {}", id_counter) } else { image.name.clone() };
    let width = if width_pt > 1.0 { width_pt } else { 320.0 };
    let height = if height_pt > 1.0 { height_pt } else { 200.0 };
    writer.raw("<w:p><w:r><w:drawing>");
    writer.raw(&format!(
        "<wp:inline distT=\"0\" distB=\"0\" distL=\"0\" distR=\"0\"><wp:extent cx=\"{}\" cy=\"{}\"/>",
        emu(width),
        emu(height)
    ));
    writer.raw(&format!(
        "<wp:docPr id=\"{}\" name=\"{}\" descr=\"{}\"/>",
        id_counter,
        crate::xml::escape_attr(&name),
        crate::xml::escape_attr(&image.alt)
    ));
    writer.raw("<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" noChangeAspect=\"1\"/></wp:cNvGraphicFramePr>");
    writer.raw("<a:graphic xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\">");
    writer.raw("<a:graphicData uri=\"http://schemas.openxmlformats.org/drawingml/2006/picture\">");
    writer.raw("<pic:pic xmlns:pic=\"http://schemas.openxmlformats.org/drawingml/2006/picture\">");
    writer.raw(&format!("<pic:nvPicPr><pic:cNvPr id=\"{id_counter}\" name=\"{}\"/><pic:cNvPicPr/></pic:nvPicPr>", crate::xml::escape_attr(&name)));
    writer.raw(&format!(
        "<pic:blipFill><a:blip r:embed=\"{id}\"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>",
    ));
    writer.raw(&format!(
        "<pic:spPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"{}\" cy=\"{}\"/></a:xfrm><a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></pic:spPr>",
        emu(width),
        emu(height)
    ));
    writer.raw("</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>");
}

fn write_table(writer: &mut XmlWriter, table: &TableData, rels: &mut Relationships, media: &mut Media, id_counter: &mut usize, depth: usize) {
    if depth > 4 {
        return;
    }
    writer.raw("<w:tbl>");
    writer.raw("<w:tblPr>");
    let total: f64 = if table.column_widths_pt.is_empty() {
        9360.0
    } else {
        table.column_widths_pt.iter().sum::<f64>().max(100.0)
    };
    writer.raw(&format!("<w:tblW w:w=\"{}\" w:type=\"dxa\"/>", twips(total)));
    if table.borders {
        let color = bare_hex(&table.border_color).unwrap_or_else(|| "94A3B8".into());
        writer.raw(&format!(
            "<w:tblBorders><w:top w:val=\"single\" w:sz=\"4\" w:color=\"{color}\"/><w:left w:val=\"single\" w:sz=\"4\" w:color=\"{color}\"/><w:bottom w:val=\"single\" w:sz=\"4\" w:color=\"{color}\"/><w:right w:val=\"single\" w:sz=\"4\" w:color=\"{color}\"/><w:insideH w:val=\"single\" w:sz=\"4\" w:color=\"{color}\"/><w:insideV w:val=\"single\" w:sz=\"4\" w:color=\"{color}\"/></w:tblBorders>"
        ));
    }
    match table.align.as_str() {
        "center" => {
            writer.raw("<w:jc w:val=\"center\"/>");
        }
        "right" => {
            writer.raw("<w:jc w:val=\"right\"/>");
        }
        _ => {}
    }
    writer.raw("</w:tblPr>");
    writer.raw("<w:tblGrid>");
    if table.column_widths_pt.is_empty() {
        writer.raw("<w:gridCol w:w=\"3120\"/>");
    } else {
        for width in &table.column_widths_pt {
            writer.raw(&format!("<w:gridCol w:w=\"{}\"/>", twips(*width)));
        }
    }
    writer.raw("</w:tblGrid>");
    for row in &table.rows {
        writer.raw("<w:tr>");
        if row.header {
            writer.raw("<w:trPr><w:tblHeader/></w:trPr>");
        }
        if let Some(height) = row.height_pt {
            writer.raw(&format!("<w:trPr><w:trHeight w:val=\"{}\"/></w:trPr>", twips(height)));
        }
        for cell in &row.cells {
            writer.raw("<w:tc><w:tcPr>");
            if let Some(width) = cell.width_pt {
                writer.raw(&format!("<w:tcW w:w=\"{}\" w:type=\"dxa\"/>", twips(width)));
            }
            if cell.colspan > 1 {
                writer.raw(&format!("<w:gridSpan w:val=\"{}\"/>", cell.colspan));
            }
            if cell.rowspan > 1 {
                writer.raw("<w:vMerge w:val=\"restart\"/>");
            }
            if let Some(background) = cell.background.as_deref().and_then(bare_hex) {
                writer.raw(&format!("<w:shd w:val=\"clear\" w:fill=\"{background}\"/>"));
            }
            match cell.valign.as_str() {
                "center" => {
                    writer.raw("<w:vAlign w:val=\"center\"/>");
                }
                "bottom" => {
                    writer.raw("<w:vAlign w:val=\"bottom\"/>");
                }
                _ => {}
            }
            writer.raw("</w:tcPr>");
            if cell.blocks.is_empty() {
                write_paragraph(writer, &ParaProps::default(), &[], rels);
            } else {
                for block in &cell.blocks {
                    write_block(writer, block, rels, media, id_counter, depth + 1);
                }
            }
            writer.raw("</w:tc>");
        }
        writer.raw("</w:tr>");
    }
    writer.raw("</w:tbl>");
    // Word requires a paragraph after a table.
    writer.raw("<w:p/>");
}

fn write_block(writer: &mut XmlWriter, block: &Block, rels: &mut Relationships, media: &mut Media, id_counter: &mut usize, depth: usize) {
    match block {
        Block::Paragraph { props, runs } => write_paragraph(writer, props, runs, rels),
        Block::Table { table } => write_table(writer, table, rels, media, id_counter, depth),
        Block::Image { image, width_pt, height_pt, .. } => write_image(writer, image, *width_pt, *height_pt, rels, media, id_counter),
        Block::PageBreak => {
            writer.raw("<w:p><w:r><w:br w:type=\"page\"/></w:r></w:p>");
        }
        Block::Rule => {
            writer.raw("<w:p><w:pPr><w:pBdr><w:bottom w:val=\"single\" w:sz=\"6\" w:space=\"1\" w:color=\"94A3B8\"/></w:pBdr></w:pPr></w:p>");
        }
        Block::Toc { entries } => {
            // Static lines with the page numbers from the last update in the
            // editor; Word will not refresh them, which the export warns about.
            for entry in entries {
                let (props, runs) = crate::layout::toc_entry_line(entry);
                write_paragraph(writer, &props, &runs, rels);
            }
        }
    }
}

fn write_head_foot(blocks: &[Block], rels: &mut Relationships, media: &mut Media, id_counter: &mut usize) -> String {
    let mut writer = XmlWriter::new();
    writer.declaration();
    writer.raw(&format!("<w:hdr {NS_DECL}>"));
    if blocks.is_empty() {
        writer.raw("<w:p/>");
    }
    for block in blocks {
        write_block(&mut writer, block, rels, media, id_counter, 0);
    }
    writer.raw("</w:hdr>");
    writer.finish()
}

fn write_footer(blocks: &[Block], rels: &mut Relationships, media: &mut Media, id_counter: &mut usize) -> String {
    let mut writer = XmlWriter::new();
    writer.declaration();
    writer.raw(&format!("<w:ftr {NS_DECL}>"));
    for block in blocks {
        write_block(&mut writer, block, rels, media, id_counter, 0);
    }
    writer.raw("</w:ftr>");
    writer.finish()
}

fn write_styles(document: &TextDocument) -> String {
    let mut writer = XmlWriter::new();
    writer.declaration();
    writer.raw(&format!("<w:styles {NS_DECL}>"));
    let normal = document.styles.iter().find(|style| style.id == "Normal").cloned().unwrap_or_default();
    writer.raw("<w:docDefaults><w:rPrDefault><w:rPr>");
    if let Some(font) = &normal.font {
        let escaped = crate::xml::escape_attr(font);
        writer.raw(&format!("<w:rFonts w:ascii=\"{escaped}\" w:hAnsi=\"{escaped}\" w:cs=\"{escaped}\"/>"));
    }
    writer.raw(&format!("<w:sz w:val=\"{}\"/>", half_points(normal.size_pt.unwrap_or(11.0))));
    writer.raw("</w:rPr></w:rPrDefault>");
    writer.raw(&format!("<w:pPrDefault><w:pPr><w:spacing w:after=\"{}\" w:line=\"{}\" w:lineRule=\"auto\"/></w:pPr></w:pPrDefault>", twips(8.0), (1.15 * 240.0) as i64));
    writer.raw("</w:docDefaults>");
    for style in &document.styles {
        let is_default = style.id == "Normal";
        writer.raw(&format!(
            "<w:style w:type=\"paragraph\" w:styleId=\"{}\"{}>",
            crate::xml::escape_attr(&style.id),
            if is_default { " w:default=\"1\"" } else { "" }
        ));
        writer.raw(&format!("<w:name w:val=\"{}\"/>", crate::xml::escape_attr(&style.name)));
        if let Some(based) = &style.based_on {
            writer.raw(&format!("<w:basedOn w:val=\"{}\"/>", crate::xml::escape_attr(based)));
        }
        if let Some(next) = &style.next {
            writer.raw(&format!("<w:next w:val=\"{}\"/>", crate::xml::escape_attr(next)));
        }
        writer.raw("<w:qFormat/>");
        writer.raw("<w:pPr>");
        if style.keep_with_next == Some(true) {
            writer.raw("<w:keepNext/>");
        }
        if style.page_break_before == Some(true) {
            writer.raw("<w:pageBreakBefore/>");
        }
        if let Some(align) = &style.align {
            let value = match align.as_str() {
                "center" => "center",
                "right" => "right",
                "justify" => "both",
                _ => "left",
            };
            writer.raw(&format!("<w:jc w:val=\"{value}\"/>"));
        }
        if style.space_before_pt.is_some() || style.space_after_pt.is_some() {
            writer.raw(&format!(
                "<w:spacing w:before=\"{}\" w:after=\"{}\"/>",
                twips(style.space_before_pt.unwrap_or(0.0)),
                twips(style.space_after_pt.unwrap_or(0.0))
            ));
        }
        if let Some(spacing) = style.line_spacing {
            writer.raw(&format!("<w:spacing w:line=\"{}\" w:lineRule=\"auto\"/>", (spacing * 240.0).round() as i64));
        }
        if style.indent_left_pt.is_some() || style.indent_right_pt.is_some() || style.first_line_pt.is_some() {
            let mut attrs = String::new();
            if let Some(value) = style.indent_left_pt {
                attrs.push_str(&format!(" w:left=\"{}\"", twips(value)));
            }
            if let Some(value) = style.indent_right_pt {
                attrs.push_str(&format!(" w:right=\"{}\"", twips(value)));
            }
            if let Some(value) = style.first_line_pt {
                let attribute = if value < 0.0 { "w:hanging" } else { "w:firstLine" };
                attrs.push_str(&format!(" {attribute}=\"{}\"", twips(value.abs())));
            }
            writer.raw(&format!("<w:ind{attrs}/>"));
        }
        if let Some(level) = style.outline_level {
            writer.raw(&format!("<w:outlineLvl w:val=\"{}\"/>", level.min(8)));
        }
        writer.raw("</w:pPr><w:rPr>");
        if let Some(font) = &style.font {
            let escaped = crate::xml::escape_attr(font);
            writer.raw(&format!("<w:rFonts w:ascii=\"{escaped}\" w:hAnsi=\"{escaped}\" w:cs=\"{escaped}\"/>"));
        }
        if style.bold == Some(true) {
            writer.raw("<w:b/>");
        }
        if style.italic == Some(true) {
            writer.raw("<w:i/>");
        }
        if style.underline == Some(true) {
            writer.raw("<w:u w:val=\"single\"/>");
        }
        if let Some(color) = style.color.as_deref().and_then(bare_hex) {
            writer.raw(&format!("<w:color w:val=\"{color}\"/>"));
        }
        if let Some(size) = style.size_pt {
            writer.raw(&format!("<w:sz w:val=\"{}\"/>", half_points(size)));
        }
        writer.raw("</w:rPr></w:style>");
    }
    writer.raw("</w:styles>");
    writer.finish()
}

fn write_numbering() -> String {
    let mut writer = XmlWriter::new();
    writer.declaration();
    writer.raw(&format!("<w:numbering {NS_DECL}>"));
    writer.raw("<w:abstractNum w:abstractNumId=\"0\">");
    for level in 0..9u32 {
        let marker = match level % 3 {
            0 => "•",
            1 => "○",
            _ => "▪",
        };
        writer.raw(&format!(
            "<w:lvl w:ilvl=\"{level}\"><w:start w:val=\"1\"/><w:numFmt w:val=\"bullet\"/><w:lvlText w:val=\"{marker}\"/><w:lvlJc w:val=\"left\"/><w:pPr><w:ind w:left=\"{}\" w:hanging=\"360\"/></w:pPr><w:rPr><w:rFonts w:ascii=\"Calibri\" w:hAnsi=\"Calibri\"/></w:rPr></w:lvl>",
            (level + 1) * 720
        ));
    }
    writer.raw("</w:abstractNum>");
    writer.raw("<w:abstractNum w:abstractNumId=\"1\">");
    for level in 0..9u32 {
        let format = ["decimal", "lowerLetter", "lowerRoman"][(level % 3) as usize];
        writer.raw(&format!(
            "<w:lvl w:ilvl=\"{level}\"><w:start w:val=\"1\"/><w:numFmt w:val=\"{format}\"/><w:lvlText w:val=\"%{}.\"/><w:lvlJc w:val=\"left\"/><w:pPr><w:ind w:left=\"{}\" w:hanging=\"360\"/></w:pPr></w:lvl>",
            level + 1,
            (level + 1) * 720
        ));
    }
    writer.raw("</w:abstractNum>");
    writer.raw("<w:num w:numId=\"1\"><w:abstractNumId w:val=\"0\"/></w:num>");
    writer.raw("<w:num w:numId=\"2\"><w:abstractNumId w:val=\"1\"/></w:num>");
    writer.raw("</w:numbering>");
    writer.finish()
}

fn write_settings() -> String {
    let mut writer = XmlWriter::new();
    writer.declaration();
    writer.raw(&format!("<w:settings {NS_DECL}>"));
    writer.raw("<w:zoom w:percent=\"100\"/><w:defaultTabStop w:val=\"708\"/><w:compat/>");
    writer.raw("</w:settings>");
    writer.finish()
}

pub fn write_docx(document: &TextDocument) -> OfficeResult<Vec<u8>> {
    let mut rels = Relationships::new(4);
    let mut media = Media::default();
    let mut id_counter = 0usize;

    let has_header = !document.header.is_empty();
    let has_footer = true; // page-number footer is always written
    let header_id = if has_header { Some(rels.add("http://schemas.openxmlformats.org/officeDocument/2006/relationships/header", "header1.xml", false)) } else { None };
    let footer_id = Some(rels.add("http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer", "footer1.xml", false));

    let header_xml = if has_header { Some(write_head_foot(&document.header, &mut rels, &mut media, &mut id_counter)) } else { None };
    let footer_xml = Some(write_footer(&document.footer, &mut rels, &mut media, &mut id_counter));

    let mut body = XmlWriter::new();
    for block in &document.blocks {
        write_block(&mut body, block, &mut rels, &mut media, &mut id_counter, 0);
    }

    let page = &document.page;
    let mut sect = String::new();
    if let Some(id) = &header_id {
        sect.push_str(&format!("<w:headerReference w:type=\"default\" r:id=\"{id}\"/>"));
    }
    if let Some(id) = &footer_id {
        sect.push_str(&format!("<w:footerReference w:type=\"default\" r:id=\"{id}\"/>"));
    }
    if page.different_first_page {
        sect.push_str("<w:titlePg/>");
    }
    sect.push_str(&format!(
        "<w:pgSz w:w=\"{}\" w:h=\"{}\"{} />",
        twips(page.width_pt),
        twips(page.height_pt),
        if page.orientation == "landscape" { " w:orient=\"landscape\"" } else { "" }
    ));
    sect.push_str(&format!(
        "<w:pgMar w:top=\"{}\" w:right=\"{}\" w:bottom=\"{}\" w:left=\"{}\" w:header=\"{}\" w:footer=\"{}\" w:gutter=\"0\"/>",
        twips(page.margin_top_pt),
        twips(page.margin_right_pt),
        twips(page.margin_bottom_pt),
        twips(page.margin_left_pt),
        twips(page.header_distance_pt),
        twips(page.footer_distance_pt)
    ));
    if page.columns > 1 {
        sect.push_str(&format!("<w:cols w:num=\"{}\" w:space=\"{}\"/>", page.columns, twips(page.column_spacing_pt)));
    } else {
        sect.push_str("<w:cols w:space=\"708\"/>");
    }
    body.raw(&format!("<w:sectPr>{sect}</w:sectPr>"));

    let document_xml = format!("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<w:document {NS_DECL}><w:body>{}</w:body></w:document>", body.finish());

    let styles_xml = write_styles(document);
    let numbering_xml = write_numbering();
    let settings_xml = write_settings();

    // document.xml.rels: styles/numbering/settings first (rId1..3), then the rest.
    let mut entries = vec![
        ("rId1".to_string(), format!("http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles|styles.xml"), false),
        ("rId2".to_string(), format!("http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering|numbering.xml"), false),
        ("rId3".to_string(), format!("http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings|settings.xml"), false),
    ];
    entries.extend(rels.entries.iter().cloned());
    let mut rels_writer = Relationships::new(0);
    rels_writer.entries = entries;
    let document_rels = rels_writer.xml();

    let mut zip = ZipWriter::new();
    zip.add_text("[Content_Types].xml", &content_types(has_header, has_footer));
    zip.add_text("_rels/.rels", &root_relationships());
    zip.add_text("docProps/core.xml", &core_properties(document));
    zip.add_text("docProps/app.xml", &app_properties(document));
    zip.add_text("word/document.xml", &document_xml);
    zip.add_text("word/_rels/document.xml.rels", &document_rels);
    zip.add_text("word/styles.xml", &styles_xml);
    zip.add_text("word/numbering.xml", &numbering_xml);
    zip.add_text("word/settings.xml", &settings_xml);
    if let Some(xml) = header_xml {
        zip.add_text("word/header1.xml", &xml);
    }
    if let Some(xml) = footer_xml {
        zip.add_text("word/footer1.xml", &xml);
    }
    for (name, data) in &media.entries {
        zip.add(&format!("word/{name}"), data);
    }
    Ok(zip.finish())
}

pub fn write_docx_file(path: &Path, document: &TextDocument) -> OfficeResult<()> {
    let bytes = write_docx(document)?;
    crate::io::write_atomic(path, &bytes)
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

#[derive(Default)]
struct Numbering {
    /// numId -> abstractNumId
    num_to_abstract: HashMap<u32, u32>,
    /// (abstractNumId, level) -> (kind, start)
    levels: HashMap<(u32, u32), (String, u32)>,
}

#[derive(Clone)]
struct RelLink {
    target: String,
    external: bool,
}

struct PartContext {
    rels: HashMap<String, RelLink>,
    warnings: Vec<String>,
    /// True while the cached result of a PAGE/NUMPAGES field is being skipped.
    field_skip: bool,
}

fn read_relationships(reader: &ZipReader, part: &str) -> HashMap<String, RelLink> {
    let (dir, file) = match part.rsplit_once('/') {
        Some((dir, file)) => (format!("{dir}/"), file.to_string()),
        None => (String::new(), part.to_string()),
    };
    let rels_name = format!("{dir}_rels/{file}.rels");
    let mut map = HashMap::new();
    let Ok(text) = reader.read_text(&rels_name) else {
        return map;
    };
    let Ok(root) = parse_xml(&text) else {
        return map;
    };
    for node in root.children_named("Relationship") {
        let Some(id) = node.attr("Id") else { continue };
        let Some(target) = node.attr("Target") else { continue };
        let external = node.attr("TargetMode").map(|value| value.eq_ignore_ascii_case("external")).unwrap_or(false);
        map.insert(id.to_string(), RelLink { target: target.to_string(), external });
    }
    map
}

fn resolve_media_path(target: &str) -> String {
    if target.starts_with('/') {
        return target.trim_start_matches('/').to_string();
    }
    if target.contains("://") {
        return String::new();
    }
    format!("word/{}", target.trim_start_matches("./"))
}

fn read_numbering(reader: &ZipReader) -> Numbering {
    let mut numbering = Numbering::default();
    let Ok(text) = reader.read_text("word/numbering.xml") else {
        return numbering;
    };
    let Ok(root) = parse_xml(&text) else {
        return numbering;
    };
    for node in root.children_named("abstractNum") {
        let Some(abstract_id) = node.attr_any_ns("abstractNumId").and_then(|value| value.parse::<u32>().ok()) else { continue };
        for level in node.children_named("lvl") {
            let lvl = level.attr_any_ns("ilvl").and_then(|value| value.parse::<u32>().ok()).unwrap_or(0);
            let format = level
                .child("numFmt")
                .and_then(|node| node.attr_any_ns("val"))
                .unwrap_or("bullet")
                .to_string();
            let start = level
                .child("start")
                .and_then(|node| node.attr_any_ns("val"))
                .and_then(|value| value.parse::<u32>().ok())
                .unwrap_or(1);
            let kind = if format == "bullet" { "bullet" } else { "number" };
            numbering.levels.insert((abstract_id, lvl), (kind.to_string(), start));
        }
    }
    for node in root.children_named("num") {
        let Some(num_id) = node.attr_any_ns("numId").and_then(|value| value.parse::<u32>().ok()) else { continue };
        if let Some(abstract_id) = node.child("abstractNumId").and_then(|node| node.attr_any_ns("val")).and_then(|value| value.parse::<u32>().ok()) {
            numbering.num_to_abstract.insert(num_id, abstract_id);
        }
    }
    numbering
}

fn read_styles(reader: &ZipReader) -> Vec<ParaStyle> {
    let mut styles = default_styles();
    let Ok(text) = reader.read_text("word/styles.xml") else {
        return styles;
    };
    let Ok(root) = parse_xml(&text) else {
        return styles;
    };
    for node in root.children_named("style") {
        if node.attr_any_ns("type").map(|value| value != "paragraph").unwrap_or(false) {
            continue;
        }
        let Some(id) = node.attr_any_ns("styleId") else { continue };
        let existing = styles.iter().position(|style| style.id == id);
        let mut style = existing.map(|index| styles[index].clone()).unwrap_or_default();
        style.id = id.to_string();
        style.name = node.child("name").and_then(|node| node.attr_any_ns("val")).unwrap_or(id).to_string();
        style.based_on = node.child("basedOn").and_then(|node| node.attr_any_ns("val")).map(str::to_string);
        style.next = node.child("next").and_then(|node| node.attr_any_ns("val")).map(str::to_string);
        if let Some(properties) = node.child("pPr") {
            if let Some(value) = properties.child("jc").and_then(|node| node.attr_any_ns("val")) {
                style.align = Some(match value {
                    "center" => "center".into(),
                    "right" => "right".into(),
                    "both" => "justify".into(),
                    _ => "left".into(),
                });
            }
            if let Some(spacing) = properties.child("spacing") {
                if let Some(value) = spacing.attr_any_ns("line").and_then(parse_f64) {
                    if value > 1.0 {
                        style.line_spacing = Some(value / 240.0);
                    }
                }
                if let Some(value) = spacing.attr_any_ns("before").and_then(parse_f64) {
                    style.space_before_pt = Some(value / 20.0);
                }
                if let Some(value) = spacing.attr_any_ns("after").and_then(parse_f64) {
                    style.space_after_pt = Some(value / 20.0);
                }
            }
            if let Some(value) = properties.child("outlineLvl").and_then(|node| node.attr_any_ns("val")).and_then(|value| value.parse::<u32>().ok()) {
                style.outline_level = Some(value);
            }
            if properties.child("keepNext").is_some() {
                style.keep_with_next = Some(true);
            }
        }
        if let Some(properties) = node.child("rPr") {
            if let Some(font) = properties.child("rFonts").and_then(|node| node.attr_any_ns("ascii")) {
                style.font = Some(font.to_string());
            }
            if properties.child("b").is_some() {
                style.bold = Some(true);
            }
            if properties.child("i").is_some() {
                style.italic = Some(true);
            }
            if properties.child("u").is_some() {
                style.underline = Some(true);
            }
            if let Some(color) = properties.child("color").and_then(|node| node.attr_any_ns("val")) {
                if !color.eq_ignore_ascii_case("auto") {
                    style.color = normalize_hex(color);
                }
            }
            if let Some(size) = properties.child("sz").and_then(|node| node.attr_any_ns("val")).and_then(parse_f64) {
                style.size_pt = Some(size / 2.0);
            }
        }
        match existing {
            Some(index) => styles[index] = style,
            None => styles.push(style),
        }
    }
    styles
}

fn parse_f64(value: &str) -> Option<f64> {
    value.trim().parse::<f64>().ok()
}

fn parse_bool_flag(node: Option<&XmlNode>) -> bool {
    match node {
        Some(node) => !matches!(node.attr_any_ns("val"), Some("0") | Some("false") | Some("off")),
        None => false,
    }
}

fn read_run_properties(node: Option<&XmlNode>) -> Run {
    let mut run = Run::default();
    let Some(properties) = node else {
        return run;
    };
    if let Some(fonts) = properties.child("rFonts") {
        if let Some(font) = fonts.attr_any_ns("ascii") {
            run.font = Some(font.to_string());
        }
    }
    run.bold = parse_bool_flag(properties.child("b"));
    run.italic = parse_bool_flag(properties.child("i"));
    run.underline = properties.child("u").is_some();
    run.strike = parse_bool_flag(properties.child("strike"));
    if let Some(color) = properties.child("color").and_then(|node| node.attr_any_ns("val")) {
        if !color.eq_ignore_ascii_case("auto") {
            run.color = normalize_hex(color);
        }
    }
    if let Some(highlight) = properties.child("highlight").and_then(|node| node.attr_any_ns("val")) {
        let normalized = match highlight {
            "yellow" => "#FFFF00",
            "green" => "#00FF00",
            "cyan" => "#00FFFF",
            "magenta" => "#FF00FF",
            "blue" => "#0000FF",
            "red" => "#FF0000",
            "darkBlue" => "#000080",
            "darkGreen" => "#008000",
            "darkRed" => "#800000",
            "darkYellow" => "#808000",
            "gray" => "#808080",
            "lightGray" => "#C0C0C0",
            "black" => "#000000",
            "white" => "#FFFFFF",
            "darkGray" => "#A9A9A9",
            _ => "",
        };
        if !normalized.is_empty() {
            run.highlight = Some(normalized.into());
        }
    }
    if let Some(size) = properties.child("sz").and_then(|node| node.attr_any_ns("val")).and_then(parse_f64) {
        run.size_pt = Some(size / 2.0);
    }
    if let Some(align) = properties.child("vertAlign").and_then(|node| node.attr_any_ns("val")) {
        if align == "superscript" {
            run.superscript = true;
        } else if align == "subscript" {
            run.subscript = true;
        }
    }
    run
}

fn read_image_block(node: &XmlNode, rels: &HashMap<String, RelLink>, reader: &ZipReader, warnings: &mut Vec<String>) -> Option<Block> {
    let mut blips = Vec::new();
    node.find_all("a:blip", &mut blips);
    if blips.is_empty() {
        node.find_all("blip", &mut blips);
    }
    let blip = blips.first()?;
    let Some(embed) = blip.attr_any_ns("embed") else {
        warnings.push("An embedded object (chart or SmartArt) was not imported.".into());
        return None;
    };
    let Some(link) = rels.get(embed) else {
        warnings.push("An image could not be located in the document package.".into());
        return None;
    };
    let path = resolve_media_path(&link.target);
    let Ok(data) = reader.read(&path) else {
        warnings.push("An image could not be read from the document package.".into());
        return None;
    };
    let name = path.rsplit('/').next().unwrap_or("image").to_string();
    let image = ImageData::from_bytes(&name, &data);
    let mut width_pt = 320.0;
    let mut height_pt = 200.0;
    let mut extents = Vec::new();
    node.find_all("wp:extent", &mut extents);
    if let Some(extent) = extents.first() {
        if let Some(cx) = extent.attr("cx").and_then(parse_f64) {
            width_pt = cx / 12700.0;
        }
        if let Some(cy) = extent.attr("cy").and_then(parse_f64) {
            height_pt = cy / 12700.0;
        }
    }
    Some(Block::Image { image, width_pt, height_pt, align: "center".into(), caption: String::new() })
}

fn read_runs(node: &XmlNode, context: &mut PartContext, reader: &ZipReader, runs: &mut Vec<Run>, blocks: &mut Vec<Block>, first_break: &mut bool) {
    for child in &node.children {
        match child.local_name() {
            "r" => {
                let mut run = read_run_properties(child.child("rPr"));
                let mut has_text = false;
                for part in &child.children {
                    match part.local_name() {
                        "t" => {
                            if context.field_skip {
                                continue;
                            }
                            run.text.push_str(&part.deep_text());
                            has_text = true;
                        }
                        "tab" => {
                            run.text.push('\t');
                            has_text = true;
                        }
                        "br" => {
                            if part.attr_any_ns("type") == Some("page") {
                                if !run.text.is_empty() {
                                    runs.push(run.clone());
                                    run.text.clear();
                                }
                                flush_paragraph(runs, blocks, Some(ParaProps::default()));
                                blocks.push(Block::PageBreak);
                                *first_break = false;
                            } else {
                                run.text.push('\n');
                            }
                            has_text = true;
                        }
                        "drawing" | "pict" => {
                            if !run.text.is_empty() {
                                runs.push(run.clone());
                                run.text.clear();
                            }
                            if let Some(block) = read_image_block(part, &context.rels, reader, &mut context.warnings) {
                                flush_paragraph(runs, blocks, None);
                                blocks.push(block);
                            }
                        }
                        "instrText" => {
                            let instruction = part.deep_text().to_uppercase();
                            if instruction.contains("NUMPAGES") {
                                runs.push(Run { text: "{{pages}}".into(), ..run.clone() });
                                context.field_skip = true;
                            } else if instruction.contains("PAGE") {
                                runs.push(Run { text: "{{page}}".into(), ..run.clone() });
                                context.field_skip = true;
                            } else {
                                context.warnings.push("Fields (other than page numbers) are imported as plain text.".into());
                            }
                        }
                        "fldChar" => {
                            if part.attr_any_ns("fldCharType") == Some("end") {
                                context.field_skip = false;
                            }
                        }
                        _ => {}
                    }
                }
                if has_text || !run.text.is_empty() {
                    runs.push(run);
                }
            }
            "hyperlink" => {
                let link = child.attr_any_ns("id").and_then(|id| context.rels.get(id)).filter(|link| link.external).map(|link| link.target.clone());
                let mut inner_runs = Vec::new();
                let mut ignored = Vec::new();
                read_runs(child, context, reader, &mut inner_runs, &mut ignored, first_break);
                for mut run in inner_runs {
                    if run.link.is_none() {
                        run.link = link.clone();
                    }
                    runs.push(run);
                }
            }
            "smartTag" | "ins" | "sdt" | "sdtContent" => {
                read_runs(child, context, reader, runs, blocks, first_break);
            }
            "del" | "delText" => {}
            "commentRangeStart" | "commentRangeEnd" | "commentReference" | "footnoteReference" | "endnoteReference" => {
                context.warnings.push("Comments and notes are not imported.".into());
            }
            "fldSimple" => {
                let instruction = child.attr_any_ns("instr").unwrap_or_default().to_uppercase();
                if instruction.contains("NUMPAGES") {
                    runs.push(Run { text: "{{pages}}".into(), ..Default::default() });
                    continue;
                }
                if instruction.contains("PAGE") {
                    runs.push(Run { text: "{{page}}".into(), ..Default::default() });
                    continue;
                }
                context.warnings.push("Fields (other than page numbers) are imported as plain text.".into());
                let mut inner_runs = Vec::new();
                read_runs(child, context, reader, &mut inner_runs, blocks, first_break);
                runs.extend(inner_runs);
            }
            _ => {}
        }
    }
}

fn flush_paragraph(runs: &mut Vec<Run>, blocks: &mut Vec<Block>, props: Option<ParaProps>) {
    if runs.is_empty() {
        return;
    }
    blocks.push(Block::Paragraph { props: props.unwrap_or_default(), runs: std::mem::take(runs) });
}

fn read_paragraph(node: &XmlNode, context: &mut PartContext, reader: &ZipReader, numbering: &Numbering) -> Vec<Block> {
    let mut props = ParaProps::default();
    if let Some(properties) = node.child("pPr") {
        if let Some(style) = properties.child("pStyle").and_then(|node| node.attr_any_ns("val")) {
            props.style = style.to_string();
        }
        if let Some(align) = properties.child("jc").and_then(|node| node.attr_any_ns("val")) {
            props.align = match align {
                "center" => "center",
                "right" => "right",
                "both" => "justify",
                _ => "left",
            }
            .into();
        }
        if let Some(spacing) = properties.child("spacing") {
            if let Some(value) = spacing.attr_any_ns("before").and_then(parse_f64) {
                props.space_before_pt = value / 20.0;
            }
            if let Some(value) = spacing.attr_any_ns("after").and_then(parse_f64) {
                props.space_after_pt = value / 20.0;
            }
            if let Some(value) = spacing.attr_any_ns("line").and_then(parse_f64) {
                if value > 1.0 {
                    props.line_spacing = value / 240.0;
                }
            }
        }
        if let Some(indent) = properties.child("ind") {
            if let Some(value) = indent.attr_any_ns("left").and_then(parse_f64) {
                props.indent_left_pt = value / 20.0;
            }
            if let Some(value) = indent.attr_any_ns("right").and_then(parse_f64) {
                props.indent_right_pt = value / 20.0;
            }
            if let Some(value) = indent.attr_any_ns("firstLine").and_then(parse_f64) {
                props.first_line_pt = value / 20.0;
            }
            if let Some(value) = indent.attr_any_ns("hanging").and_then(parse_f64) {
                props.first_line_pt = -value / 20.0;
            }
        }
        props.page_break_before = properties.child("pageBreakBefore").is_some();
        if let Some(numbering_properties) = properties.child("numPr") {
            let num_id = numbering_properties
                .child("numId")
                .and_then(|node| node.attr_any_ns("val"))
                .and_then(|value| value.parse::<u32>().ok());
            let level = numbering_properties
                .child("ilvl")
                .and_then(|node| node.attr_any_ns("val"))
                .and_then(|value| value.parse::<u32>().ok())
                .unwrap_or(0);
            if let Some(num_id) = num_id {
                let abstract_id = numbering.num_to_abstract.get(&num_id).copied().unwrap_or(0);
                let (kind, start) = numbering
                    .levels
                    .get(&(abstract_id, level))
                    .cloned()
                    .unwrap_or_else(|| ("bullet".to_string(), 1));
                props.list = Some(ListInfo { kind, level, start, marker: String::new() });
            }
        }
    }
    let mut runs = Vec::new();
    let mut blocks = Vec::new();
    let mut first_break = true;
    read_runs(node, context, reader, &mut runs, &mut blocks, &mut first_break);
    flush_paragraph(&mut runs, &mut blocks, Some(props));
    if blocks.is_empty() {
        blocks.push(Block::Paragraph { props: ParaProps::default(), runs: vec![Run::default()] });
    }
    blocks
}

fn read_table(node: &XmlNode, context: &mut PartContext, reader: &ZipReader, numbering: &Numbering, warnings: &mut Vec<String>) -> Block {
    let mut widths = Vec::new();
    if let Some(grid) = node.child("tblGrid") {
        for column in grid.children_named("gridCol") {
            let width = column.attr_any_ns("w").and_then(parse_f64).unwrap_or(1200.0) / 20.0;
            widths.push(width);
        }
    }
    let mut rows = Vec::new();
    for row_node in node.children_named("tr") {
        let mut row = TableRow::default();
        if let Some(properties) = row_node.child("trPr") {
            row.header = properties.child("tblHeader").is_some();
            if let Some(height) = properties.child("trHeight").and_then(|node| node.attr_any_ns("val")).and_then(parse_f64) {
                if height > 0.0 {
                    row.height_pt = Some(height / 20.0);
                }
            }
        }
        for cell_node in row_node.children_named("tc") {
            let mut cell = TableCell::default();
            if let Some(properties) = cell_node.child("tcPr") {
                if let Some(span) = properties.child("gridSpan").and_then(|node| node.attr_any_ns("val")).and_then(|value| value.parse::<u32>().ok()) {
                    cell.colspan = span.max(1);
                }
                if properties.child("vMerge").is_some() {
                    cell.rowspan = 1;
                }
                if let Some(fill) = properties.child("shd").and_then(|node| node.attr_any_ns("fill")) {
                    if !fill.eq_ignore_ascii_case("auto") {
                        cell.background = normalize_hex(fill);
                    }
                }
                if let Some(valign) = properties.child("vAlign").and_then(|node| node.attr_any_ns("val")) {
                    cell.valign = valign.to_string();
                }
                if let Some(width) = properties.child("tcW").and_then(|node| node.attr_any_ns("w")).and_then(parse_f64) {
                    cell.width_pt = Some(width / 20.0);
                }
            }
            for child in &cell_node.children {
                match child.local_name() {
                    "p" => cell.blocks.extend(read_paragraph(child, context, reader, numbering)),
                    "tbl" => {
                        warnings.push("Nested tables are imported as plain content.".into());
                        cell.blocks.push(read_table(child, context, reader, numbering, warnings));
                    }
                    _ => {}
                }
            }
            if cell.blocks.is_empty() {
                cell.blocks.push(Block::paragraph(""));
            }
            row.cells.push(cell);
        }
        if !row.cells.is_empty() {
            rows.push(row);
        }
    }
    Block::Table {
        table: TableData { rows, column_widths_pt: widths, borders: true, border_color: "#94A3B8".into(), align: "left".into() },
    }
}

fn read_section(node: &XmlNode, document: &mut TextDocument) {
    let mut page = PageSetup::default();
    if let Some(size) = node.child("pgSz") {
        let width = size.attr_any_ns("w").and_then(parse_f64).unwrap_or(11906.0) / 20.0;
        let height = size.attr_any_ns("h").and_then(parse_f64).unwrap_or(16838.0) / 20.0;
        page.width_pt = width;
        page.height_pt = height;
        page.orientation = if width > height { "landscape".into() } else { "portrait".into() };
        page.size = match ((width.round() as i64), (height.round() as i64)) {
            (595, 842) | (842, 595) => "a4",
            (420, 595) | (595, 420) => "a5",
            (612, 792) | (792, 612) => "letter",
            (612, 1008) | (1008, 612) => "legal",
            _ => "custom",
        }
        .into();
    }
    if let Some(margins) = node.child("pgMar") {
        page.margin_top_pt = margins.attr_any_ns("top").and_then(parse_f64).unwrap_or(1440.0) / 20.0;
        page.margin_right_pt = margins.attr_any_ns("right").and_then(parse_f64).unwrap_or(1440.0) / 20.0;
        page.margin_bottom_pt = margins.attr_any_ns("bottom").and_then(parse_f64).unwrap_or(1440.0) / 20.0;
        page.margin_left_pt = margins.attr_any_ns("left").and_then(parse_f64).unwrap_or(1440.0) / 20.0;
        page.header_distance_pt = margins.attr_any_ns("header").and_then(parse_f64).unwrap_or(720.0) / 20.0;
        page.footer_distance_pt = margins.attr_any_ns("footer").and_then(parse_f64).unwrap_or(720.0) / 20.0;
    }
    if let Some(columns) = node.child("cols") {
        page.columns = columns.attr_any_ns("num").and_then(|value| value.parse::<u32>().ok()).unwrap_or(1).max(1);
        page.column_spacing_pt = columns.attr_any_ns("space").and_then(parse_f64).unwrap_or(708.0) / 20.0;
    }
    page.different_first_page = node.child("titlePg").is_some();
    document.page = page;
}

fn read_part_blocks(reader: &ZipReader, part: &str, document: &mut TextDocument, numbering: &Numbering, warnings: &mut Vec<String>) -> Vec<Block> {
    let Ok(text) = reader.read_text(part) else {
        return Vec::new();
    };
    let Ok(root) = parse_xml(&text) else {
        return Vec::new();
    };
    let mut context = PartContext { rels: read_relationships(reader, part), warnings: Vec::new(), field_skip: false };
    let mut blocks = Vec::new();
    let container = root.child("body").unwrap_or(&root);
    for child in &container.children {
        match child.local_name() {
            "p" => blocks.extend(read_paragraph(child, &mut context, reader, numbering)),
            "tbl" => blocks.push(read_table(child, &mut context, reader, numbering, warnings)),
            "sectPr" => read_section(child, document),
            "sdt" => {
                let mut inner = Vec::new();
                child.find_all("sdtContent", &mut inner);
                for content in inner {
                    for node in &content.children {
                        if node.local_name() == "p" {
                            blocks.extend(read_paragraph(node, &mut context, reader, numbering));
                        }
                    }
                }
            }
            "bookmarkStart" | "bookmarkEnd" | "proofErr" | "commentRangeStart" | "commentRangeEnd" => {}
            _ => {}
        }
    }
    warnings.extend(context.warnings);
    blocks
}

pub fn read_docx(bytes: &[u8]) -> OfficeResult<DocxRead> {
    let reader = ZipReader::open(bytes.to_vec())?;
    let mut warnings = Vec::new();
    let mut document = TextDocument::default();
    document.blocks.clear();

    let document_part = if reader.contains("word/document.xml") {
        "word/document.xml".to_string()
    } else {
        let root = reader
            .read_text("_rels/.rels")
            .ok()
            .and_then(|text| parse_xml(&text).ok())
            .ok_or_else(|| OfficeError::corrupt("The package does not contain a main document part."))?;
        let mut found = None;
        for node in root.children_named("Relationship") {
            let kind = node.attr("Type").unwrap_or_default();
            if kind.ends_with("/officeDocument") {
                if let Some(target) = node.attr("Target") {
                    found = Some(target.trim_start_matches('/').to_string());
                }
            }
        }
        found.ok_or_else(|| OfficeError::corrupt("The package does not declare a main document."))?
    };

    document.styles = read_styles(&reader);
    let numbering = read_numbering(&reader);
    document.blocks = read_part_blocks(&reader, &document_part, &mut document, &numbering, &mut warnings);

    // Header / footer parts referenced by the section.
    if let Some(text) = reader.read_text(&document_part).ok() {
        if let Ok(root) = parse_xml(&text) {
            let rels = read_relationships(&reader, &document_part);
            let mut sections = Vec::new();
            root.find_all("sectPr", &mut sections);
            for section in sections {
                for key in ["headerReference", "footerReference"] {
                    for reference in section.children_named(key) {
                        let Some(id) = reference.attr_any_ns("id") else { continue };
                        let Some(link) = rels.get(id) else { continue };
                        let part_dir = document_part.rsplit_once('/').map(|(dir, _)| dir).unwrap_or("word");
                        let rel_target = link.target.trim_start_matches('/');
                        let path = if rel_target.starts_with("word/") {
                            rel_target.to_string()
                        } else {
                            format!("{part_dir}/{rel_target}")
                        };
                        let mut part_document = TextDocument::default();
                        let blocks = read_part_blocks(&reader, &path, &mut part_document, &numbering, &mut warnings);
                        if key.starts_with("header") {
                            document.header = blocks;
                        } else {
                            document.footer = blocks;
                        }
                    }
                }
            }
        }
    }

    if reader.contains("word/comments.xml") {
        warnings.push("Comments were not imported.".into());
    }
    if reader.contains("word/vbaProject.bin") {
        warnings.push("Macros were not loaded. Documents always open with macros disabled.".into());
    }
    if reader.contains("word/footnotes.xml") || reader.contains("word/endnotes.xml") {
        warnings.push("Footnotes and endnotes were not imported.".into());
    }
    warnings.sort();
    warnings.dedup();

    if document.blocks.is_empty() {
        document.blocks.push(Block::paragraph(""));
    }
    document.metadata.title = document.title.clone();
    if let Ok(text) = reader.read_text("docProps/core.xml") {
        if let Ok(root) = parse_xml(&text) {
            if let Some(value) = root.child("dc:title").map(XmlNode::deep_text) {
                if !value.is_empty() {
                    document.title = value;
                }
            }
            if let Some(value) = root.child("dc:creator").map(XmlNode::deep_text) {
                document.metadata.author = value;
            }
            if let Some(value) = root.child("dc:subject").map(XmlNode::deep_text) {
                document.metadata.subject = value;
            }
            if let Some(value) = root.attr_any_ns("keywords").or_else(|| root.child("cp:keywords").map(|node| node.text.as_str())) {
                document.metadata.keywords = value.to_string();
            }
            if let Some(value) = root.child("dcterms:created").map(XmlNode::deep_text) {
                document.metadata.created = value;
            }
        }
    }
    if document.metadata.title.is_empty() {
        document.metadata.title = document.title.clone();
    }
    Ok(DocxRead { document, warnings })
}

pub fn read_docx_file(path: &Path) -> OfficeResult<DocxRead> {
    let bytes = crate::io::read_bytes(path)?;
    let mut result = read_docx(&bytes)?;
    if result.document.title.is_empty() || result.document.title == "Untitled document" {
        result.document.title = crate::io::file_stem(path);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_png() -> Vec<u8> {
        let mut buffer = image::RgbaImage::new(4, 4);
        for pixel in buffer.pixels_mut() {
            *pixel = image::Rgba([200, 30, 60, 255]);
        }
        let mut out = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(buffer).write_to(&mut out, image::ImageFormat::Png).unwrap();
        out.into_inner()
    }

    fn sample_document() -> TextDocument {
        let mut document = TextDocument::new_blank("Sample");
        document.blocks = vec![
            Block::heading("Introduction", 1),
            Block::Paragraph {
                props: ParaProps::default(),
                runs: vec![
                    Run { text: "Hello ".into(), ..Default::default() },
                    Run { text: "bold".into(), bold: true, ..Default::default() },
                    Run { text: " and ".into(), ..Default::default() },
                    Run { text: "italic".into(), italic: true, color: Some("#FF0000".into()), ..Default::default() },
                ],
            },
            Block::Paragraph {
                props: ParaProps { list: Some(ListInfo { kind: "bullet".into(), level: 0, start: 1, marker: "•".into() }), ..Default::default() },
                runs: vec![Run { text: "first".into(), ..Default::default() }],
            },
            Block::Paragraph {
                props: ParaProps { list: Some(ListInfo { kind: "number".into(), level: 0, start: 1, marker: "1.".into() }), ..Default::default() },
                runs: vec![Run { text: "second".into(), ..Default::default() }],
            },
            Block::Image {
                image: ImageData::from_bytes("pic.png", &sample_png()),
                width_pt: 120.0,
                height_pt: 90.0,
                align: "center".into(),
                caption: String::new(),
            },
        ];
        document.header = vec![Block::paragraph("Header text")];
        document.footer = vec![Block::paragraph("Footer text")];
        document
    }

    #[test]
    fn roundtrip_paragraphs_and_lists() {
        let document = sample_document();
        let bytes = write_docx(&document).unwrap();
        let read = read_docx(&bytes).unwrap();
        assert!(read.document.blocks.len() >= 5);
        let text = read.document.plain_text();
        assert!(text.contains("Introduction"));
        assert!(text.contains("bold"));
        let bold = read.document.blocks.iter().find_map(|block| match block {
            Block::Paragraph { runs, .. } => runs.iter().find(|run| run.text == "bold"),
            _ => None,
        });
        assert!(bold.map(|run| run.bold).unwrap_or(false));
        let lists: Vec<_> = read
            .document
            .blocks
            .iter()
            .filter_map(|block| match block {
                Block::Paragraph { props, .. } => props.list.as_ref(),
                _ => None,
            })
            .collect();
        assert!(lists.iter().any(|list| list.kind == "bullet"));
        assert!(lists.iter().any(|list| list.kind == "number"));
    }

    #[test]
    fn roundtrip_table() {
        let mut document = TextDocument::new_blank("Table");
        let mut table = TableData::simple(2, 3, 450.0);
        table.rows[0].cells[0].blocks = vec![Block::paragraph("Name")];
        table.rows[1].cells[2].blocks = vec![Block::paragraph("42")];
        document.blocks = vec![Block::Table { table }];
        let bytes = write_docx(&document).unwrap();
        let read = read_docx(&bytes).unwrap();
        let table = read
            .document
            .blocks
            .iter()
            .find_map(|block| match block {
                Block::Table { table } => Some(table),
                _ => None,
            })
            .expect("table missing");
        assert_eq!(table.rows.len(), 2);
        assert_eq!(table.rows[0].cells.len(), 3);
        assert!(table.rows[0].cells[0].blocks[0].plain_text().contains("Name"));
        assert!(table.rows[1].cells[2].blocks[0].plain_text().contains("42"));
    }

    #[test]
    fn roundtrip_image() {
        let document = sample_document();
        let bytes = write_docx(&document).unwrap();
        let read = read_docx(&bytes).unwrap();
        let image = read.document.blocks.iter().find_map(|block| match block {
            Block::Image { image, .. } => Some(image.clone()),
            _ => None,
        });
        assert!(image.is_some(), "image missing; warnings: {:?}", read.warnings);
        let image = image.unwrap();
        assert_eq!(image.mime, "image/png");
        assert!(!image.data_base64.is_empty());
    }

    #[test]
    fn roundtrip_page_setup() {
        let mut document = TextDocument::new_blank("Page");
        document.page = PageSetup::from_preset("letter", "landscape");
        document.page.columns = 2;
        let bytes = write_docx(&document).unwrap();
        let read = read_docx(&bytes).unwrap();
        assert_eq!(read.document.page.orientation, "landscape");
        assert_eq!(read.document.page.size, "letter");
        assert_eq!(read.document.page.columns, 2);
    }

    #[test]
    fn roundtrip_header_footer() {
        let document = sample_document();
        let bytes = write_docx(&document).unwrap();
        let read = read_docx(&bytes).unwrap();
        assert!(read.document.header.iter().map(Block::plain_text).any(|text| text.contains("Header")));
        assert!(read.document.footer.iter().map(Block::plain_text).any(|text| text.contains("Footer")));
    }

    #[test]
    fn roundtrip_hyperlink() {
        let mut document = TextDocument::new_blank("Links");
        document.blocks = vec![Block::Paragraph {
            props: ParaProps::default(),
            runs: vec![Run { text: "Open".into(), link: Some("https://example.com".into()), ..Default::default() }],
        }];
        let bytes = write_docx(&document).unwrap();
        let read = read_docx(&bytes).unwrap();
        let link = read.document.blocks.iter().find_map(|block| match block {
            Block::Paragraph { runs, .. } => runs.iter().find_map(|run| run.link.clone()),
            _ => None,
        });
        assert_eq!(link.as_deref(), Some("https://example.com"));
    }

    #[test]
    fn reads_minimal_hand_built_package() {
        let mut zip = ZipWriter::new();
        zip.add_text("[Content_Types].xml", r#"<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>"#);
        zip.add_text("_rels/.rels", r#"<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>"#);
        zip.add_text("word/document.xml", r#"<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Minimal</w:t></w:r></w:p><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Bold</w:t></w:r></w:p></w:body></w:document>"#);
        let read = read_docx(&zip.finish()).unwrap();
        assert_eq!(read.document.plain_text().trim(), "Minimal\nBold");
    }

    #[test]
    fn malformed_inputs_never_panic() {
        assert!(read_docx(&[]).is_err());
        assert!(read_docx(&[0u8; 64]).is_err());
        let mut zip = ZipWriter::new();
        zip.add_text("word/document.xml", "<w:document><broken>");
        // Truncated XML is tolerated (content is best effort), but must not panic.
        let _ = read_docx(&zip.finish());
    }

    #[test]
    fn package_structure() {
        let bytes = write_docx(&sample_document()).unwrap();
        assert!(bytes.len() > 2000);
        let reader = ZipReader::open(bytes).unwrap();
        assert!(reader.contains("[Content_Types].xml"));
        assert!(reader.contains("word/document.xml"));
        assert!(reader.contains("word/styles.xml"));
        assert!(reader.contains("word/numbering.xml"));
        assert!(reader.contains("word/footer1.xml"));
    }
}

