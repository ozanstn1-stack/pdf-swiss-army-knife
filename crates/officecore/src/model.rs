//! Shared document model for Writer, Calc and Impress.
//!
//! The model is the in-app source of truth. File formats (DOCX, ODT, XLSX,
//! PPTX, ...) are import/export targets; the native `.oswk` unit format is the
//! model serialized as JSON, so a round-trip never loses anything the suite
//! understands. Fields are optional/defaulted so older files keep opening when
//! the model grows.

use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const MM_TO_PT: f64 = 72.0 / 25.4;
pub const PT_TO_MM: f64 = 25.4 / 72.0;
/// CSS pixels at the conventional 96 dpi used by the editors.
pub const PT_TO_PX: f64 = 96.0 / 72.0;
pub const PX_TO_PT: f64 = 72.0 / 96.0;

pub fn pt_to_px(pt: f64) -> f64 {
    pt * PT_TO_PX
}

pub fn px_to_pt(px: f64) -> f64 {
    px * PX_TO_PT
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct DocMetadata {
    pub title: String,
    pub author: String,
    pub subject: String,
    pub keywords: String,
    pub creator: String,
    pub last_modified_by: String,
    pub created: String,
    pub modified: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ImageData {
    pub name: String,
    pub mime: String,
    pub data_base64: String,
    pub alt: String,
}

impl Default for ImageData {
    fn default() -> Self {
        Self { name: "image".into(), mime: "image/png".into(), data_base64: String::new(), alt: String::new() }
    }
}

impl ImageData {
    pub fn from_bytes(name: &str, bytes: &[u8]) -> Self {
        let mime = guess_mime(name, bytes);
        Self {
            name: name.to_string(),
            mime,
            data_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
            alt: String::new(),
        }
    }

    pub fn from_path(path: &std::path::Path) -> std::io::Result<Self> {
        let bytes = std::fs::read(path)?;
        let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "image".into());
        Ok(Self::from_bytes(&name, &bytes))
    }

    pub fn bytes(&self) -> Vec<u8> {
        base64::engine::general_purpose::STANDARD.decode(self.data_base64.as_bytes()).unwrap_or_default()
    }

    pub fn is_empty(&self) -> bool {
        self.data_base64.is_empty()
    }

    /// Intrinsic size in pixels (0,0 when the format is unknown to the decoder).
    pub fn pixel_size(&self) -> (u32, u32) {
        image::load_from_memory(&self.bytes())
            .map(|image| (image.width(), image.height()))
            .unwrap_or((0, 0))
    }

    pub fn extension(&self) -> &'static str {
        match self.mime.as_str() {
            "image/jpeg" | "image/jpg" => "jpg",
            "image/gif" => "gif",
            "image/bmp" => "bmp",
            "image/tiff" => "tiff",
            "image/webp" => "webp",
            "image/svg+xml" => "svg",
            _ => "png",
        }
    }
}

pub fn guess_mime(name: &str, bytes: &[u8]) -> String {
    let lower = name.to_ascii_lowercase();
    if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        return "image/jpeg".into();
    }
    if lower.ends_with(".gif") {
        return "image/gif".into();
    }
    if lower.ends_with(".bmp") {
        return "image/bmp".into();
    }
    if lower.ends_with(".webp") {
        return "image/webp".into();
    }
    if lower.ends_with(".svg") {
        return "image/svg+xml".into();
    }
    if lower.ends_with(".png") {
        return "image/png".into();
    }
    if bytes.starts_with(&[0xFF, 0xD8]) {
        return "image/jpeg".into();
    }
    if bytes.starts_with(b"\x89PNG") {
        return "image/png".into();
    }
    "image/png".into()
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct PageSetup {
    pub size: String,
    pub width_pt: f64,
    pub height_pt: f64,
    pub orientation: String,
    pub margin_top_pt: f64,
    pub margin_right_pt: f64,
    pub margin_bottom_pt: f64,
    pub margin_left_pt: f64,
    pub columns: u32,
    pub column_spacing_pt: f64,
    pub header_distance_pt: f64,
    pub footer_distance_pt: f64,
    pub different_first_page: bool,
}

impl Default for PageSetup {
    fn default() -> Self {
        Self {
            size: "a4".into(),
            width_pt: 595.28,
            height_pt: 841.89,
            orientation: "portrait".into(),
            margin_top_pt: 72.0,
            margin_right_pt: 72.0,
            margin_bottom_pt: 72.0,
            margin_left_pt: 72.0,
            columns: 1,
            column_spacing_pt: 24.0,
            header_distance_pt: 36.0,
            footer_distance_pt: 36.0,
            different_first_page: false,
        }
    }
}

impl PageSetup {
    pub fn from_preset(size: &str, orientation: &str) -> Self {
        let (width, height) = match size {
            "a5" => (419.53, 595.28),
            "letter" => (612.0, 792.0),
            "legal" => (612.0, 1008.0),
            "a3" => (841.89, 1190.55),
            _ => (595.28, 841.89),
        };
        let landscape = orientation == "landscape";
        Self {
            size: size.to_string(),
            width_pt: if landscape { height } else { width },
            height_pt: if landscape { width } else { height },
            orientation: orientation.to_string(),
            ..Default::default()
        }
    }

    pub fn apply_orientation(&mut self, orientation: &str) {
        let landscape = orientation == "landscape";
        let currently_landscape = self.width_pt > self.height_pt;
        if landscape != currently_landscape {
            std::mem::swap(&mut self.width_pt, &mut self.height_pt);
        }
        self.orientation = orientation.to_string();
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ParaStyle {
    pub id: String,
    pub name: String,
    pub based_on: Option<String>,
    pub next: Option<String>,
    pub font: Option<String>,
    pub size_pt: Option<f64>,
    pub bold: Option<bool>,
    pub italic: Option<bool>,
    pub underline: Option<bool>,
    pub strike: Option<bool>,
    pub color: Option<String>,
    pub highlight: Option<String>,
    pub align: Option<String>,
    pub line_spacing: Option<f64>,
    pub space_before_pt: Option<f64>,
    pub space_after_pt: Option<f64>,
    pub indent_left_pt: Option<f64>,
    pub indent_right_pt: Option<f64>,
    pub first_line_pt: Option<f64>,
    pub outline_level: Option<u32>,
    pub keep_with_next: Option<bool>,
    pub page_break_before: Option<bool>,
}

impl Default for ParaStyle {
    fn default() -> Self {
        Self {
            id: "Normal".into(),
            name: "Normal".into(),
            based_on: None,
            next: None,
            font: None,
            size_pt: None,
            bold: None,
            italic: None,
            underline: None,
            strike: None,
            color: None,
            highlight: None,
            align: None,
            line_spacing: None,
            space_before_pt: None,
            space_after_pt: None,
            indent_left_pt: None,
            indent_right_pt: None,
            first_line_pt: None,
            outline_level: None,
            keep_with_next: None,
            page_break_before: None,
        }
    }
}

/// The style catalogue every Writer document starts with (fully original design).
pub fn default_styles() -> Vec<ParaStyle> {
    let mut list = Vec::new();
    let mut normal = ParaStyle::default();
    normal.font = Some("Calibri".into());
    normal.size_pt = Some(11.0);
    normal.line_spacing = Some(1.15);
    normal.space_after_pt = Some(8.0);
    normal.color = Some("#1f2328".into());
    list.push(normal);

    let mut title = ParaStyle { id: "Title".into(), name: "Title".into(), based_on: Some("Normal".into()), next: Some("Subtitle".into()), ..Default::default() };
    title.font = Some("Calibri Light".into());
    title.size_pt = Some(28.0);
    title.bold = Some(true);
    title.color = Some("#0f172a".into());
    title.space_after_pt = Some(6.0);
    list.push(title);

    let mut subtitle = ParaStyle { id: "Subtitle".into(), name: "Subtitle".into(), based_on: Some("Normal".into()), next: Some("Normal".into()), ..Default::default() };
    subtitle.size_pt = Some(15.0);
    subtitle.italic = Some(true);
    subtitle.color = Some("#475569".into());
    subtitle.space_after_pt = Some(14.0);
    list.push(subtitle);

    for (index, size) in [(1u32, 20.0f64), (2, 16.0), (3, 13.0), (4, 11.5), (5, 11.0), (6, 10.5)] {
        let mut heading = ParaStyle {
            id: format!("Heading{index}"),
            name: format!("Heading {index}"),
            based_on: Some("Normal".into()),
            next: Some("Normal".into()),
            ..Default::default()
        };
        heading.font = Some("Calibri Light".into());
        heading.size_pt = Some(size);
        heading.bold = Some(true);
        heading.color = Some(if index == 1 { "#1d4ed8".into() } else { "#334155".to_string() });
        heading.space_before_pt = Some(if index == 1 { 16.0 } else { 12.0 });
        heading.space_after_pt = Some(4.0);
        heading.keep_with_next = Some(true);
        heading.outline_level = Some(index - 1);
        list.push(heading);
    }

    let mut quote = ParaStyle { id: "Quote".into(), name: "Quote".into(), based_on: Some("Normal".into()), ..Default::default() };
    quote.italic = Some(true);
    quote.color = Some("#334155".into());
    quote.indent_left_pt = Some(24.0);
    quote.indent_right_pt = Some(24.0);
    quote.space_before_pt = Some(8.0);
    quote.space_after_pt = Some(8.0);
    list.push(quote);

    let mut caption = ParaStyle { id: "Caption".into(), name: "Caption".into(), based_on: Some("Normal".into()), ..Default::default() };
    caption.size_pt = Some(9.5);
    caption.italic = Some(true);
    caption.align = Some("center".into());
    caption.color = Some("#64748b".into());
    list.push(caption);

    let mut code = ParaStyle { id: "Code".into(), name: "Code".into(), based_on: Some("Normal".into()), ..Default::default() };
    code.font = Some("Consolas".into());
    code.size_pt = Some(10.0);
    code.space_after_pt = Some(0.0);
    list.push(code);

    list
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ListInfo {
    pub kind: String,
    pub level: u32,
    pub start: u32,
    pub marker: String,
}

impl Default for ListInfo {
    fn default() -> Self {
        Self { kind: "bullet".into(), level: 0, start: 1, marker: "•".into() }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ParaProps {
    pub style: String,
    pub align: String,
    pub line_spacing: f64,
    pub space_before_pt: f64,
    pub space_after_pt: f64,
    pub indent_left_pt: f64,
    pub indent_right_pt: f64,
    pub first_line_pt: f64,
    pub list: Option<ListInfo>,
    pub page_break_before: bool,
    /// Pagination rules written to DOCX as `w:keepNext` / `w:keepLines`.
    #[serde(default)]
    pub keep_with_next: bool,
    #[serde(default)]
    pub keep_together: bool,
}

impl Default for ParaProps {
    fn default() -> Self {
        Self {
            style: "Normal".into(),
            align: "left".into(),
            line_spacing: 1.15,
            space_before_pt: 0.0,
            space_after_pt: 8.0,
            indent_left_pt: 0.0,
            indent_right_pt: 0.0,
            first_line_pt: 0.0,
            list: None,
            page_break_before: false,
            keep_with_next: false,
            keep_together: false,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Run {
    pub text: String,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub strike: bool,
    pub color: Option<String>,
    pub highlight: Option<String>,
    pub font: Option<String>,
    pub size_pt: Option<f64>,
    pub link: Option<String>,
    pub comment: Option<String>,
    pub superscript: bool,
    pub subscript: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct TableCell {
    pub blocks: Vec<Block>,
    pub colspan: u32,
    pub rowspan: u32,
    pub background: Option<String>,
    pub align: String,
    pub valign: String,
    pub width_pt: Option<f64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct TableRow {
    pub cells: Vec<TableCell>,
    pub height_pt: Option<f64>,
    pub header: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct TableData {
    pub rows: Vec<TableRow>,
    pub column_widths_pt: Vec<f64>,
    pub borders: bool,
    pub border_color: String,
    pub align: String,
}

impl TableData {
    pub fn simple(rows: u32, columns: u32, width_pt: f64) -> Self {
        let column_width = if columns > 0 { width_pt / columns as f64 } else { width_pt };
        let table_rows = (0..rows)
            .map(|row| TableRow {
                cells: (0..columns).map(|_| TableCell::default()).collect(),
                height_pt: None,
                header: row == 0,
            })
            .collect();
        Self {
            rows: table_rows,
            column_widths_pt: vec![column_width; columns as usize],
            borders: true,
            border_color: "#94a3b8".into(),
            align: "left".into(),
        }
    }
}

/// One line of a table of contents.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct TocEntry {
    pub text: String,
    pub level: u32,
    pub page: u32,
    pub anchor: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Block {
    Paragraph { props: ParaProps, runs: Vec<Run> },
    Table { table: TableData },
    Image { image: ImageData, width_pt: f64, height_pt: f64, align: String, caption: String },
    PageBreak,
    Rule,
    /// A table of contents whose entries were last updated in the editor; the
    /// layout and DOCX export render them as static text.
    Toc { #[serde(default)] entries: Vec<TocEntry> },
}

impl Default for Block {
    fn default() -> Self {
        Block::Paragraph { props: ParaProps::default(), runs: vec![Run::default()] }
    }
}

impl Block {
    pub fn paragraph(text: &str) -> Self {
        Block::Paragraph {
            props: ParaProps::default(),
            runs: vec![Run { text: text.to_string(), ..Default::default() }],
        }
    }

    pub fn heading(text: &str, level: u32) -> Self {
        let mut props = ParaProps::default();
        props.style = format!("Heading{level}");
        Block::Paragraph { props, runs: vec![Run { text: text.to_string(), ..Default::default() }] }
    }

    pub fn plain_text(&self) -> String {
        match self {
            Block::Paragraph { runs, .. } => runs.iter().map(|run| run.text.as_str()).collect::<Vec<_>>().join(""),
            Block::Table { table } => table
                .rows
                .iter()
                .map(|row| {
                    row.cells
                        .iter()
                        .map(|cell| cell.blocks.iter().map(Block::plain_text).collect::<Vec<_>>().join(" "))
                        .collect::<Vec<_>>()
                        .join("\t")
                })
                .collect::<Vec<_>>()
                .join("\n"),
            Block::Image { caption, .. } => caption.clone(),
            Block::PageBreak => "\n".into(),
            Block::Rule => "".into(),
            Block::Toc { entries } => entries.iter().map(|entry| entry.text.clone()).collect::<Vec<_>>().join("\n"),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Comment {
    pub id: String,
    pub author: String,
    pub text: String,
    pub created: String,
    pub resolved: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct TextDocument {
    pub id: String,
    pub title: String,
    pub page: PageSetup,
    pub styles: Vec<ParaStyle>,
    pub blocks: Vec<Block>,
    pub header: Vec<Block>,
    pub footer: Vec<Block>,
    pub comments: Vec<Comment>,
    pub metadata: DocMetadata,
}

impl Default for TextDocument {
    fn default() -> Self {
        Self {
            id: String::new(),
            title: "Untitled document".into(),
            page: PageSetup::default(),
            styles: default_styles(),
            blocks: vec![Block::paragraph("")],
            header: Vec::new(),
            footer: Vec::new(),
            comments: Vec::new(),
            metadata: DocMetadata::default(),
        }
    }
}

impl TextDocument {
    pub fn new_blank(title: &str) -> Self {
        let mut document = Self::default();
        document.id = uuid::Uuid::new_v4().to_string();
        document.title = title.to_string();
        document
    }

    pub fn plain_text(&self) -> String {
        self.blocks.iter().map(Block::plain_text).collect::<Vec<_>>().join("\n")
    }

    pub fn word_count(&self) -> usize {
        self.plain_text().split_whitespace().count()
    }
}

// ---------------------------------------------------------------------------
// Calc
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", content = "value", rename_all = "camelCase")]
pub enum CellValue {
    Empty,
    Number(f64),
    Text(String),
    Bool(bool),
    Error(String),
}

impl Default for CellValue {
    fn default() -> Self {
        CellValue::Empty
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct BorderStyle {
    pub style: String,
    pub color: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct CellBorders {
    pub top: Option<BorderStyle>,
    pub right: Option<BorderStyle>,
    pub bottom: Option<BorderStyle>,
    pub left: Option<BorderStyle>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct CellStyle {
    pub font: Option<String>,
    pub size_pt: Option<f64>,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub strike: bool,
    pub color: Option<String>,
    pub fill: Option<String>,
    pub align: String,
    pub valign: String,
    pub wrap: bool,
    pub rotation: i32,
    pub borders: CellBorders,
    pub number_format: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Cell {
    pub value: CellValue,
    pub formula: Option<String>,
    pub style: CellStyle,
    pub comment: Option<String>,
    /// Hyperlink target; the cell text is the label.
    pub link: Option<String>,
}

/// Paper, orientation and print options for one sheet.
///
/// Mirrors the `pageSetup`/`printOptions`/`headerFooter` parts of an XLSX so a
/// print-ready sheet survives a round trip through the native format.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct PrintSettings {
    /// Excel paper size code; 9 is A4, 1 is Letter.
    pub paper_size: u32,
    pub landscape: bool,
    /// Percentage scale, 10..400.
    pub scale: u32,
    pub fit_to_width: u32,
    pub fit_to_height: u32,
    pub center_horizontally: bool,
    pub print_gridlines: bool,
    pub print_headings: bool,
    /// Row number repeated at the top of every page, e.g. "1:1".
    pub print_titles_rows: Option<String>,
    pub different_first_page: bool,
    pub different_odd_even: bool,
    pub header: String,
    pub footer: String,
}

impl Default for PrintSettings {
    fn default() -> Self {
        Self {
            paper_size: 9,
            landscape: false,
            scale: 100,
            fit_to_width: 1,
            fit_to_height: 0,
            center_horizontally: false,
            print_gridlines: false,
            print_headings: false,
            print_titles_rows: None,
            different_first_page: false,
            different_odd_even: false,
            header: String::new(),
            footer: String::new(),
        }
    }
}

impl Cell {
    pub fn is_empty(&self) -> bool {
        matches!(self.value, CellValue::Empty)
            && self.formula.is_none()
            && self.style == CellStyle::default()
            && self.comment.is_none()
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct MergeRange {
    pub start: String,
    pub end: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ChartSeries {
    pub name: String,
    pub range: String,
    pub color: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ChartData {
    pub kind: String,
    pub title: String,
    pub categories: String,
    pub series: Vec<ChartSeries>,
    pub legend: bool,
    pub x_title: String,
    pub y_title: String,
    pub stacked: bool,
    pub show_labels: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ChartPlacement {
    pub id: String,
    pub chart: ChartData,
    pub anchor: String,
    pub width_px: f64,
    pub height_px: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct CondRule {
    pub id: String,
    pub range: String,
    pub kind: String,
    pub values: Vec<String>,
    pub fill: Option<String>,
    pub color: Option<String>,
    pub top_n: Option<u32>,
    pub stop_if_true: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Validation {
    pub id: String,
    pub range: String,
    pub kind: String,
    pub values: Vec<String>,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub message: String,
    pub allow_blank: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct FilterState {
    pub range: String,
    pub column: u32,
    pub values: Vec<String>,
}

/// One aggregated column of a pivot table.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct PivotValueField {
    pub field: String,
    pub aggregation: String,
}

/// A filter on one pivot source field; an empty list keeps everything.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct PivotFilter {
    pub field: String,
    pub values: Vec<String>,
}

/// A pivot table definition over a cell range whose first row is headers.
///
/// The definition is the source of truth in `.oswk`; XLSX export materialises
/// the computed grid as plain values at `anchor` and reports that the result
/// is not a live Excel pivot table.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct PivotTable {
    pub id: String,
    pub name: String,
    pub source_sheet: String,
    pub source: String,
    pub rows: Vec<String>,
    pub columns: Vec<String>,
    pub values: Vec<PivotValueField>,
    pub filters: Vec<PivotFilter>,
    pub anchor: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Sheet {
    pub id: String,
    pub name: String,
    pub row_count: u32,
    pub col_count: u32,
    pub cells: BTreeMap<String, Cell>,
    pub col_widths: BTreeMap<u32, f64>,
    pub row_heights: BTreeMap<u32, f64>,
    pub merges: Vec<MergeRange>,
    pub freeze_rows: u32,
    pub freeze_cols: u32,
    pub charts: Vec<ChartPlacement>,
    pub pivot_tables: Vec<PivotTable>,
    pub conditional: Vec<CondRule>,
    pub validations: Vec<Validation>,
    pub filter: Option<FilterState>,
    pub show_gridlines: bool,
    pub tab_color: Option<String>,
    /// Print layout; kept in the native format and written to XLSX.
    pub print: PrintSettings,
    /// Legacy sheet-protection hash; empty means the sheet is unprotected.
    pub sheet_protection: String,
}

impl Default for Sheet {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: "Sheet1".into(),
            row_count: 200,
            col_count: 26,
            cells: BTreeMap::new(),
            col_widths: BTreeMap::new(),
            row_heights: BTreeMap::new(),
            merges: Vec::new(),
            freeze_rows: 0,
            freeze_cols: 0,
            charts: Vec::new(),
            pivot_tables: Vec::new(),
            conditional: Vec::new(),
            validations: Vec::new(),
            filter: None,
            show_gridlines: true,
            tab_color: None,
            print: PrintSettings::default(),
            sheet_protection: String::new(),
        }
    }
}

impl Sheet {
    pub fn new(name: &str) -> Self {
        let mut sheet = Self::default();
        sheet.id = uuid::Uuid::new_v4().to_string();
        sheet.name = name.to_string();
        sheet
    }

    pub fn set(&mut self, address: &str, cell: Cell) {
        if cell.is_empty() {
            self.cells.remove(address);
        } else {
            self.cells.insert(address.to_string(), cell);
        }
    }

    pub fn get(&self, address: &str) -> Option<&Cell> {
        self.cells.get(address)
    }

    /// Number of cells that are not empty (statistics pane).
    pub fn used_cells(&self) -> usize {
        self.cells.len()
    }

    pub fn extend_for(&mut self, address: &str) {
        if let Some((row, col)) = crate::address::parse(address) {
            if row + 1 > self.row_count {
                self.row_count = row + 1 + 50;
            }
            if col + 1 > self.col_count {
                self.col_count = col + 1 + 5;
            }
        }
    }
}

/// A workbook- or sheet-scoped defined name.
///
/// `definition` holds the raw target - a range (`Data!A1:A99`), a cell, a
/// constant or a formula - so a name can point at anything a formula can
/// express. `sheet` is `None` for a workbook-level name, which is what makes
/// `VAT_RATE` visible from every sheet.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct NamedRange {
    pub name: String,
    pub definition: String,
    pub sheet: Option<String>,
    pub comment: String,
}

impl NamedRange {
    /// True when the name is visible from every sheet.
    pub fn is_workbook_scope(&self) -> bool {
        self.sheet.as_deref().map(str::trim).unwrap_or("").is_empty()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Workbook {
    pub id: String,
    pub title: String,
    pub sheets: Vec<Sheet>,
    pub active_sheet: usize,
    /// Defined names, workbook-level and per-sheet.
    pub names: Vec<NamedRange>,
    pub metadata: DocMetadata,
}

impl Default for Workbook {
    fn default() -> Self {
        Self {
            id: String::new(),
            title: "Untitled spreadsheet".into(),
            sheets: vec![Sheet::new("Sheet1")],
            active_sheet: 0,
            names: Vec::new(),
            metadata: DocMetadata::default(),
        }
    }
}

impl Workbook {
    pub fn new_blank(title: &str) -> Self {
        let mut workbook = Self::default();
        workbook.id = uuid::Uuid::new_v4().to_string();
        workbook.title = title.to_string();
        workbook
    }

    /// Names visible from `sheet`: workbook-level names plus that sheet's own.
    pub fn names_for(&self, sheet: &str) -> Vec<&NamedRange> {
        self.names
            .iter()
            .filter(|entry| entry.is_workbook_scope() || entry.sheet.as_deref() == Some(sheet))
            .collect()
    }

    pub fn unique_sheet_name(&self, base: &str) -> String {
        let mut index = 1;
        loop {
            let name = if index == 1 { base.to_string() } else { format!("{base}{index}") };
            if !self.sheets.iter().any(|sheet| sheet.name == name) {
                return name;
            }
            index += 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Impress
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct SlideSize {
    pub preset: String,
    pub width_pt: f64,
    pub height_pt: f64,
}

impl Default for SlideSize {
    fn default() -> Self {
        // 16:9 widescreen in points (13.333in x 7.5in).
        Self { preset: "16:9".into(), width_pt: 960.0, height_pt: 540.0 }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct TextParagraph {
    pub text: String,
    pub level: u32,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub size_pt: Option<f64>,
    pub color: Option<String>,
    pub align: String,
    pub bullet: bool,
    pub runs: Vec<Run>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct TextFrame {
    pub paragraphs: Vec<TextParagraph>,
    pub valign: String,
    pub font: Option<String>,
    pub size_pt: Option<f64>,
    pub color: Option<String>,
    pub align: String,
}

impl TextFrame {
    pub fn plain(&self) -> String {
        self.paragraphs.iter().map(|p| p.text.as_str()).collect::<Vec<_>>().join("\n")
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ShapeStyle {
    pub fill: Option<String>,
    pub stroke: Option<String>,
    pub stroke_width_pt: f64,
    pub opacity: f64,
    pub corner_radius_pt: f64,
    pub shadow: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct LineSpec {
    pub x2: f64,
    pub y2: f64,
    pub begin_arrow: bool,
    pub end_arrow: bool,
    pub dash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct SlideObject {
    pub id: String,
    pub kind: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub rotation: f64,
    pub z: i32,
    pub text: Option<TextFrame>,
    pub image: Option<ImageData>,
    pub style: Option<ShapeStyle>,
    pub line: Option<LineSpec>,
    pub table: Option<TableData>,
    pub chart: Option<ChartData>,
    pub group_id: Option<String>,
    pub name: String,
}

impl Default for SlideObject {
    fn default() -> Self {
        Self {
            id: String::new(),
            kind: "rect".into(),
            x: 0.0,
            y: 0.0,
            w: 200.0,
            h: 100.0,
            rotation: 0.0,
            z: 0,
            text: None,
            image: None,
            style: None,
            line: None,
            table: None,
            chart: None,
            group_id: None,
            name: String::new(),
        }
    }
}

impl SlideObject {
    pub fn new(kind: &str, x: f64, y: f64, w: f64, h: f64) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            kind: kind.to_string(),
            x,
            y,
            w,
            h,
            z: 1,
            ..Default::default()
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Slide {
    pub id: String,
    pub layout: String,
    pub background: Option<String>,
    pub transition: Option<String>,
    pub transition_ms: u32,
    pub objects: Vec<SlideObject>,
    pub notes: String,
}

impl Default for Slide {
    fn default() -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            layout: "titleContent".into(),
            background: None,
            transition: None,
            transition_ms: 500,
            objects: Vec::new(),
            notes: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Deck {
    pub id: String,
    pub title: String,
    pub size: SlideSize,
    pub theme: String,
    pub slides: Vec<Slide>,
    pub metadata: DocMetadata,
}

impl Default for Deck {
    fn default() -> Self {
        Self {
            id: String::new(),
            title: "Untitled presentation".into(),
            size: SlideSize::default(),
            theme: "minimal".into(),
            slides: vec![Slide::default()],
            metadata: DocMetadata::default(),
        }
    }
}

impl Deck {
    pub fn new_blank(title: &str) -> Self {
        let mut deck = Self::default();
        deck.id = uuid::Uuid::new_v4().to_string();
        deck.title = title.to_string();
        deck
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writer_model_roundtrips_json() {
        let mut document = TextDocument::new_blank("Test");
        document.blocks.push(Block::heading("Intro", 1));
        let mut table = TableData::simple(2, 3, 400.0);
        table.rows[1].cells[0].blocks.push(Block::paragraph("cell"));
        document.blocks.push(Block::Table { table });
        let json = serde_json::to_string(&document).unwrap();
        let back: TextDocument = serde_json::from_str(&json).unwrap();
        assert_eq!(back.blocks.len(), 3);
    }

    #[test]
    fn workbook_default_shape() {
        let workbook = Workbook::new_blank("Test");
        assert_eq!(workbook.sheets.len(), 1);
        assert_eq!(workbook.sheets[0].row_count, 200);
        assert_eq!(workbook.unique_sheet_name("Sheet"), "Sheet");
        let mut workbook = workbook;
        workbook.sheets.push(Sheet::new("Sheet"));
        assert_eq!(workbook.unique_sheet_name("Sheet"), "Sheet2");
    }

    #[test]
    fn image_roundtrip() {
        let image = ImageData::from_bytes("x.png", &[0x89, b'P', b'N', b'G']);
        assert_eq!(image.mime, "image/png");
        assert_eq!(image.bytes().len(), 4);
        assert_eq!(image.extension(), "png");
    }
}
