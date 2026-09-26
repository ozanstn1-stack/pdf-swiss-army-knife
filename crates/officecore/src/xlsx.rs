//! XLSX export (written directly as OOXML) and spreadsheet import.
//!
//! Export covers values, formulas, styling, number formats, column widths, row
//! heights, merges, freeze panes, gridline settings, defined names, autofilters,
//! tab colours, hyperlinks, cell comments, data validation, conditional
//! formatting, sheet protection and print layout. Import uses the well-tested
//! `calamine` parser so XLSX, XLS and ODS files from Excel and LibreOffice open
//! reliably; formatting is imported with limited support and that limitation is
//! reported to the user.

use crate::error::{OfficeError, OfficeResult};
use crate::io::{normalize_hex, write_atomic};
use crate::model::*;
use crate::xml::{escape_attr, escape_text, XmlWriter};
use crate::zip::ZipWriter;
use calamine::Reader as CalamineReader;
use std::collections::BTreeMap;
use std::io::Cursor;
use std::path::Path;

#[derive(Debug, Clone)]
pub struct SheetWrite {
    pub bytes: Vec<u8>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct SheetRead {
    pub workbook: Workbook,
    pub warnings: Vec<String>,
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

#[derive(Default)]
struct StyleTable {
    fonts: Vec<String>,
    fills: Vec<String>,
    borders: Vec<String>,
    num_formats: Vec<(u32, String)>,
    xfs: Vec<String>,
    font_keys: BTreeMap<String, usize>,
    fill_keys: BTreeMap<String, usize>,
    border_keys: BTreeMap<String, usize>,
    xf_keys: BTreeMap<String, usize>,
}

impl StyleTable {
    fn new() -> Self {
        let mut table = Self::default();
        // Index 0: defaults required by the spec.
        table.fonts.push("<font><sz val=\"11\"/><name val=\"Calibri\"/></font>".into());
        table.fills.push("<fill><patternFill patternType=\"none\"/></fill>".into());
        table.fills.push("<fill><patternFill patternType=\"gray125\"/></fill>".into());
        table.borders.push("<border><left/><right/><top/><bottom/><diagonal/></border>".into());
        table.xfs.push("<xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\"/>".into());
        table
    }

    fn builtin_number_format(format: &str) -> Option<u32> {
        match format.trim() {
            "0" => Some(1),
            "0.00" => Some(2),
            "#,##0" => Some(3),
            "#,##0.00" => Some(4),
            "0%" => Some(9),
            "0.00%" => Some(10),
            "0.00E+00" => Some(11),
            "# ?/?" => Some(12),
            "@" => Some(49),
            _ => None,
        }
    }

    fn font_id(&mut self, style: &CellStyle) -> usize {
        let size = style.size_pt.unwrap_or(11.0);
        let color = style.color.as_deref().and_then(normalize_hex);
        let mut xml = String::from("<font>");
        if style.bold {
            xml.push_str("<b/>");
        }
        if style.italic {
            xml.push_str("<i/>");
        }
        if style.underline {
            xml.push_str("<u/>");
        }
        if style.strike {
            xml.push_str("<strike/>");
        }
        xml.push_str(&format!("<sz val=\"{size}\"/>"));
        if let Some(color) = &color {
            xml.push_str(&format!("<color rgb=\"FF{}\"/>", color.trim_start_matches('#')));
        }
        xml.push_str(&format!("<name val=\"{}\"/></font>", escape_attr(style.font.as_deref().unwrap_or("Calibri"))));
        if let Some(index) = self.font_keys.get(&xml) {
            return *index;
        }
        self.fonts.push(xml.clone());
        let index = self.fonts.len() - 1;
        self.font_keys.insert(xml, index);
        index
    }

    fn fill_id(&mut self, style: &CellStyle) -> usize {
        let Some(fill) = style.fill.as_deref().and_then(normalize_hex) else { return 0 };
        let xml = format!(
            "<fill><patternFill patternType=\"solid\"><fgColor rgb=\"FF{}\"/><bgColor indexed=\"64\"/></patternFill></fill>",
            fill.trim_start_matches('#')
        );
        if let Some(index) = self.fill_keys.get(&xml) {
            return *index;
        }
        self.fills.push(xml.clone());
        let index = self.fills.len() - 1;
        self.fill_keys.insert(xml, index);
        index
    }

    fn border_id(&mut self, style: &CellStyle) -> usize {
        let render = |name: &str, border: &Option<BorderStyle>| -> String {
            match border {
                Some(border) if border.style != "none" => {
                    let color = normalize_hex(&border.color).unwrap_or_else(|| "#000000".into());
                    let kind = match border.style.as_str() {
                        "thick" => "thick",
                        "dashed" => "dashed",
                        "dotted" => "dotted",
                        "double" => "double",
                        _ => "thin",
                    };
                    format!("<{name} style=\"{kind}\"><color rgb=\"FF{}\"/></{name}>", color.trim_start_matches('#'))
                }
                _ => format!("<{name}/>"),
            }
        };
        let borders = &style.borders;
        if borders.top.is_none() && borders.right.is_none() && borders.bottom.is_none() && borders.left.is_none() {
            return 0;
        }
        let xml = format!(
            "<border>{}{}{}{}<diagonal/></border>",
            render("left", &borders.left),
            render("right", &borders.right),
            render("top", &borders.top),
            render("bottom", &borders.bottom)
        );
        if let Some(index) = self.border_keys.get(&xml) {
            return *index;
        }
        self.borders.push(xml.clone());
        let index = self.borders.len() - 1;
        self.border_keys.insert(xml, index);
        index
    }

    fn number_format_id(&mut self, format: &str) -> u32 {
        let format = format.trim();
        if format.is_empty() || format.eq_ignore_ascii_case("general") {
            return 0;
        }
        if let Some(builtin) = Self::builtin_number_format(format) {
            return builtin;
        }
        if let Some((id, _)) = self.num_formats.iter().find(|(_, existing)| existing == format) {
            return *id;
        }
        let id = 164 + self.num_formats.len() as u32;
        self.num_formats.push((id, format.to_string()));
        id
    }

    fn xf_id(&mut self, style: &CellStyle) -> usize {
        let font = self.font_id(style);
        let fill = self.fill_id(style);
        let border = self.border_id(style);
        let number_format = self.number_format_id(&style.number_format);
        let mut alignment = String::new();
        if !style.align.is_empty() && style.align != "general" {
            alignment.push_str(&format!(" horizontal=\"{}\"", style.align));
        }
        if !style.valign.is_empty() && style.valign != "bottom" {
            alignment.push_str(&format!(" vertical=\"{}\"", style.valign));
        }
        if style.wrap {
            alignment.push_str(" wrapText=\"1\"");
        }
        if style.rotation != 0 {
            alignment.push_str(&format!(" textRotation=\"{}\"", style.rotation));
        }
        let mut xml = format!("<xf numFmtId=\"{number_format}\" fontId=\"{font}\" fillId=\"{fill}\" borderId=\"{border}\" xfId=\"0\" applyFont=\"1\" applyFill=\"1\" applyBorder=\"1\" applyNumberFormat=\"1\"");
        if alignment.is_empty() {
            xml.push_str("/>");
        } else {
            xml.push_str(&format!(" applyAlignment=\"1\"><alignment{alignment}/></xf>"));
        }
        if let Some(index) = self.xf_keys.get(&xml) {
            return *index;
        }
        self.xfs.push(xml.clone());
        let index = self.xfs.len() - 1;
        self.xf_keys.insert(xml, index);
        index
    }

    fn xml(&self) -> String {
        let mut writer = XmlWriter::new();
        writer.declaration();
        writer.open(
            "styleSheet",
            &[("xmlns", "http://schemas.openxmlformats.org/spreadsheetml/2006/main")],
        );
        if !self.num_formats.is_empty() {
            writer.raw(&format!("<numFmts count=\"{}\">", self.num_formats.len()));
            for (id, format) in &self.num_formats {
                writer.raw(&format!("<numFmt numFmtId=\"{id}\" formatCode=\"{}\"/>", escape_attr(format)));
            }
            writer.raw("</numFmts>");
        }
        writer.raw(&format!("<fonts count=\"{}\">", self.fonts.len()));
        for font in &self.fonts {
            writer.raw(font);
        }
        writer.raw("</fonts>");
        writer.raw(&format!("<fills count=\"{}\">", self.fills.len()));
        for fill in &self.fills {
            writer.raw(fill);
        }
        writer.raw("</fills>");
        writer.raw(&format!("<borders count=\"{}\">", self.borders.len()));
        for border in &self.borders {
            writer.raw(border);
        }
        writer.raw("</borders>");
        writer.raw("<cellStyleXfs count=\"1\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\"/></cellStyleXfs>");
        writer.raw(&format!("<cellXfs count=\"{}\">", self.xfs.len()));
        for xf in &self.xfs {
            writer.raw(xf);
        }
        writer.raw("</cellXfs>");
        writer.raw("<cellStyles count=\"1\"><cellStyle name=\"Normal\" xfId=\"0\" builtinId=\"0\"/></cellStyles>");
        // One differential format backs every conditional-formatting rule, so
        // the highlight colour a rule shows in the editor is the colour a
        // spreadsheet shows after the round trip.
        writer.raw(&format!(
            "<dxfs count=\"1\"><dxf><font><color rgb=\"{}\"/></font><fill><patternFill><bgColor rgb=\"{}\"/></patternFill></fill></dxf></dxfs>",
            argb_of(CONDITIONAL_FILL),
            argb_of(CONDITIONAL_FILL)
        ));
        writer.raw("</styleSheet>");
        writer.finish()
    }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

fn column_width_units(pixels: f64) -> f64 {
    // Approximate Excel's character-based width.
    ((pixels - 5.0) / 7.0).max(2.0)
}

/// One worksheet plus the companion parts that hang off it.
///
/// XLSX keeps a worksheet's relationships in a sibling `.rels` file, so the
/// hyperlink targets, the comment part and its VML shapes cannot live in the
/// worksheet XML itself.
struct SheetPart {
    xml: String,
    rels: Vec<(String, String, String)>,
    comments: Vec<(String, String)>,
}

fn sheet_xml(sheet: &Sheet, styles: &mut StyleTable, shared: &mut Vec<String>, shared_index: &mut BTreeMap<String, usize>) -> SheetPart {
    let mut writer = XmlWriter::new();
    writer.declaration();
    writer.raw(
        "<worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\">",
    );
    // CT_Worksheet is a strict sequence: sheetPr, dimension, sheetViews,
    // sheetFormatPr, cols, sheetData, sheetProtection, autoFilter, mergeCells,
    // conditionalFormatting, dataValidations, hyperlinks, printOptions,
    // pageMargins, pageSetup, headerFooter, legacyDrawing. Emitting them out of
    // order produces a file Excel refuses to open, so the order is not cosmetic.
    if let Some(color) = sheet.tab_color.as_ref().filter(|value| !value.is_empty()) {
        writer.raw(&format!("<sheetPr><tabColor rgb=\"{}\"/></sheetPr>", argb_of(color)));
    }

    let mut max_row = 0u32;
    let mut max_col = 0u32;
    for address in sheet.cells.keys() {
        if let Some((row, column)) = crate::address::parse(address) {
            max_row = max_row.max(row);
            max_col = max_col.max(column);
        }
    }
    writer.raw(&format!(
        "<dimension ref=\"A1:{}\"/>",
        crate::address::format(max_row, max_col)
    ));

    writer.raw("<sheetViews><sheetView workbookViewId=\"0\"");
    if !sheet.show_gridlines {
        writer.raw(" showGridLines=\"0\"");
    }
    writer.raw(">");
    if sheet.freeze_rows > 0 || sheet.freeze_cols > 0 {
        let x_split = sheet.freeze_cols;
        let y_split = sheet.freeze_rows;
        let top_left = crate::address::format(y_split, x_split);
        writer.raw(&format!(
            "<pane xSplit=\"{x_split}\" ySplit=\"{y_split}\" topLeftCell=\"{top_left}\" activePane=\"bottomRight\" state=\"frozen\"/>"
        ));
    }
    writer.raw("</sheetView></sheetViews>");
    writer.raw("<sheetFormatPr defaultRowHeight=\"15\"/>");

    if !sheet.col_widths.is_empty() {
        writer.raw("<cols>");
        let mut widths: Vec<(&u32, &f64)> = sheet.col_widths.iter().collect();
        widths.sort_by_key(|(column, _)| **column);
        for (column, width) in widths {
            writer.raw(&format!(
                "<col min=\"{}\" max=\"{}\" width=\"{:.2}\" customWidth=\"1\"/>",
                column + 1,
                column + 1,
                column_width_units(*width)
            ));
        }
        writer.raw("</cols>");
    }

    writer.raw("<sheetData>");
    let mut rows: BTreeMap<u32, Vec<(u32, &Cell)>> = BTreeMap::new();
    let mut hyperlinks: Vec<(String, String)> = Vec::new();
    let mut comments: Vec<(String, String)> = Vec::new();
    for (address, cell) in &sheet.cells {
        if cell.is_empty() {
            continue;
        }
        if let (Some(target), Some((row, column))) = (cell.link.as_ref(), crate::address::parse(address)) {
            hyperlinks.push((crate::address::format(row, column), target.clone()));
        }
        if let (Some(text), Some((row, column))) = (cell.comment.as_ref(), crate::address::parse(address)) {
            if !text.trim().is_empty() {
                comments.push((crate::address::format(row, column), text.clone()));
            }
        }
        if let Some((row, column)) = crate::address::parse(address) {
            rows.entry(row).or_default().push((column, cell));
        }
    }
    for (row, mut cells) in rows {
        cells.sort_by_key(|(column, _)| *column);
        match sheet.row_heights.get(&row) {
            Some(height) => {
                writer.raw(&format!("<row r=\"{}\" ht=\"{:.2}\" customHeight=\"1\">", row + 1, height * 0.75));
            }
            None => {
                writer.raw(&format!("<row r=\"{}\">", row + 1));
            }
        }
        for (column, cell) in cells {
            let address = crate::address::format(row, column);
            let style_id = styles.xf_id(&cell.style);
            let style_attr = if style_id > 0 { format!(" s=\"{style_id}\"") } else { String::new() };
            let formula = cell.formula.as_deref().map(|formula| formula.trim_start_matches('=').to_string());
            let mut value_xml = String::new();
            let mut type_attr = String::new();
            match &cell.value {
                CellValue::Number(number) => value_xml = format!("<v>{number}</v>"),
                CellValue::Bool(value) => {
                    type_attr = " t=\"b\"".into();
                    value_xml = format!("<v>{}</v>", if *value { 1 } else { 0 });
                }
                CellValue::Error(error) => {
                    type_attr = " t=\"e\"".into();
                    value_xml = format!("<v>{}</v>", escape_text(error));
                }
                CellValue::Text(text) if !text.is_empty() => {
                    if formula.is_some() {
                        type_attr = " t=\"str\"".into();
                        value_xml = format!("<v>{}</v>", escape_text(text));
                    } else {
                        let index = match shared_index.get(text) {
                            Some(index) => *index,
                            None => {
                                let index = shared.len();
                                shared.push(text.clone());
                                shared_index.insert(text.clone(), index);
                                index
                            }
                        };
                        type_attr = " t=\"s\"".into();
                        value_xml = format!("<v>{index}</v>");
                    }
                }
                _ => {}
            }
            let formula_xml = formula.map(|formula| format!("<f>{}</f>", escape_text(&formula))).unwrap_or_default();
            if formula_xml.is_empty() && value_xml.is_empty() && cell.style == CellStyle::default() && cell.link.is_none() && cell.comment.is_none() {
                continue;
            }
            writer.raw(&format!("<c r=\"{address}\"{style_attr}{type_attr}>{formula_xml}{value_xml}</c>"));
        }
        writer.raw("</row>");
    }
    writer.raw("</sheetData>");

    // CT_Worksheet order from here on: sheetProtection, autoFilter,
    // mergeCells, conditionalFormatting, dataValidations, hyperlinks,
    // printOptions, pageMargins, pageSetup, headerFooter, legacyDrawing.
    if !sheet.sheet_protection.is_empty() {
        writer.raw(&format!("<sheetProtection password=\"{}\"/>", escape_attr(&sheet.sheet_protection)));
    }

    // AutoFilter: the active filter range, which is what the toolbar toggles.
    if let Some(filter) = &sheet.filter {
        if !filter.range.is_empty() {
            writer.raw(&format!("<autoFilter ref=\"{}\"/>", escape_attr(&filter.range)));
        }
    }

    if !sheet.merges.is_empty() {
        writer.raw(&format!("<mergeCells count=\"{}\">", sheet.merges.len()));
        for merge in &sheet.merges {
            writer.raw(&format!("<mergeCell ref=\"{}:{}\"/>", escape_attr(&merge.start), escape_attr(&merge.end)));
        }
        writer.raw("</mergeCells>");
    }

    // Conditional formatting; each rule points at the shared dxf in styles.xml.
    for (index, rule) in sheet.conditional.iter().enumerate() {
        if let Some(xml) = conditional_formatting_xml(rule, index) {
            writer.raw(&xml);
        }
    }

    // Data validation: list and numeric range, with the optional error message.
    if !sheet.validations.is_empty() {
        let mut count = 0;
        let mut body = String::new();
        for validation in &sheet.validations {
            let (kind, formula1, formula2) = match validation.kind.as_str() {
                "list" => ("list", validation.values.join(","), String::new()),
                "number" => (
                    "decimal",
                    validation.min.map(|value| value.to_string()).unwrap_or_default(),
                    validation.max.map(|value| value.to_string()).unwrap_or_default(),
                ),
                _ => continue,
            };
            let quoted = if kind == "list" { format!("\"{formula1}\"") } else { formula1 };
            let second = if formula2.is_empty() {
                String::new()
            } else {
                format!("<formula2>{}</formula2>", escape_text(&formula2))
            };
            let prompt = if validation.message.is_empty() {
                String::new()
            } else {
                format!(" promptTitle=\"Invalid value\" error=\"{}\"", escape_attr(&validation.message))
            };
            let blank = if validation.allow_blank { 1 } else { 0 };
            body.push_str(&format!(
                "<dataValidation type=\"{kind}\" allowBlank=\"{blank}\" showInputMessage=\"1\" showErrorMessage=\"1\"{prompt} sqref=\"{}\"><formula1>{}</formula1>{second}</dataValidation>",
                escape_attr(&validation.range),
                escape_text(&quoted)
            ));
            count += 1;
        }
        if count > 0 {
            writer.raw(&format!("<dataValidations count=\"{count}\">{body}</dataValidations>"));
        }
    }

    // Hyperlinks: one external relationship per target.
    let mut rels: Vec<(String, String, String)> = Vec::new();
    if !hyperlinks.is_empty() {
        writer.raw(&format!("<hyperlinks count=\"{}\">", hyperlinks.len()));
        for (address, target) in &hyperlinks {
            let rid = format!("rId{}", rels.len() + 1);
            writer.raw(&format!("<hyperlink ref=\"{}\" r:id=\"{rid}\"/>", escape_attr(address)));
            rels.push((
                rid,
                "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink".into(),
                target.clone(),
            ));
        }
        writer.raw("</hyperlinks>");
    }

    writer.raw(&print_settings_xml(sheet));

    if !comments.is_empty() {
        rels.push((
            "rIdComments".into(),
            "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments".into(),
            "../comments1.xml".into(),
        ));
        rels.push((
            "rIdVml".into(),
            "http://schemas.openxmlformats.org/officeDocument/2006/relationships/vmlDrawing".into(),
            "../drawings/vmlDrawing1.vml".into(),
        ));
        writer.raw("<legacyDrawing r:id=\"rIdVml\"/>");
    }

    writer.raw("</worksheet>");
    SheetPart {
        xml: writer.finish(),
        rels,
        comments,
    }
}

/// Builds a `<conditionalFormatting>` block plus the dxf index it points at.
///
/// Returns `None` for rule kinds that have no XLSX equivalent, which the caller
/// reports through the import/export warnings rather than emitting a broken
/// package.
fn conditional_formatting_xml(rule: &CondRule, index: usize) -> Option<String> {
    let dxf = CONDITIONAL_DXF_ID;
    // (rule type, operator, formula body). The formula carries the rule
    // threshold; a rule kind with no XLSX equivalent returns None.
    let (kind, operator, formula): (&str, &str, Option<String>) = match rule.kind.as_str() {
        "greater" => ("cellIs", "greaterThan", Some(format!("&gt;{}", escape_text(first_value(rule, "0"))))),
        "less" => ("cellIs", "lessThan", Some(format!("&lt;{}", escape_text(first_value(rule, "0"))))),
        "equal" => ("cellIs", "equal", Some(escape_text(first_value(rule, "0")))),
        "between" => (
            "cellIs",
            "between",
            Some(format!("{}~{}", escape_text(first_value(rule, "0")), escape_text(second_value(rule, "0")))),
        ),
        "text" => (
            "containsText",
            "containsText",
            Some(format!(
                "NOT(ISERROR(SEARCH(&quot;{}&quot;,{})))",
                escape_text(first_value(rule, "")),
                anchor_of(&rule.range)
            )),
        ),
        "duplicates" => (
            "duplicateValues",
            "duplicateValues",
            Some(format!("COUNTIF({},{})>1", anchor_of(&rule.range), anchor_of(&rule.range))),
        ),
        "top" => (
            "top10",
            "greaterThanOrEqual",
            Some(format!(
                "{}&gt;=LARGE({},{})",
                anchor_of(&rule.range),
                anchor_of(&rule.range),
                rule.top_n.unwrap_or(10)
            )),
        ),
        "bottom" => (
            "top10",
            "lessThanOrEqual",
            Some(format!(
                "{}&lt;=SMALL({},{})",
                anchor_of(&rule.range),
                anchor_of(&rule.range),
                rule.top_n.unwrap_or(10)
            )),
        ),
        // A data bar needs a different cfRule shape; it stays in .oswk and the
        // export reports it instead of emitting something Excel would reject.
        _ => return None,
    };
    let stop = if rule.stop_if_true { " stopIfTrue=\"1\"" } else { "" };
    let rank = if rule.kind == "bottom" { " bottom=\"1\"" } else { "" };
    let formulas = formula
        .map(|body| format!("<formula>{body}</formula>"))
        .unwrap_or_default();
    Some(format!(
        "<conditionalFormatting sqref=\"{}\"><cfRule type=\"{kind}\" dxfId=\"{dxf}\" priority=\"{}\"{stop} operator=\"{operator}\"{rank}>{formulas}</cfRule></conditionalFormatting>",
        escape_attr(&rule.range),
        index + 1
    ))
}

fn first_value<'a>(rule: &'a CondRule, fallback: &'a str) -> &'a str {
    rule.values.first().map(String::as_str).unwrap_or(fallback)
}

fn second_value<'a>(rule: &'a CondRule, fallback: &'a str) -> &'a str {
    rule.values.get(1).map(String::as_str).unwrap_or(fallback)
}

/// The top-left cell of a range, used as the relative anchor in rule formulas.
fn anchor_of(range: &str) -> String {
    range.split(':').next().unwrap_or(range).to_string()
}

/// One shared dxf for the whole workbook; every rule reuses it so the styles
/// part stays small and consistent with what the editor preview shows.
const CONDITIONAL_DXF_ID: usize = 0;

/// Highlight colour used by the single shared differential format.
const CONDITIONAL_FILL: &str = "#FFF3C4";

/// Paper size, orientation and print options for a sheet.
fn print_settings_xml(sheet: &Sheet) -> String {
    let mut out = String::from("<pageMargins left=\"0.7\" right=\"0.7\" top=\"0.75\" bottom=\"0.75\" header=\"0.3\" footer=\"0.3\"/>");
    let landscape = sheet.print.landscape;
    out.push_str(&format!(
        "<pageSetup paperSize=\"{}\" orientation=\"{}\" scale=\"{}\" fitToWidth=\"{}\" fitToHeight=\"{}\"/>",
        sheet.print.paper_size,
        if landscape { "landscape" } else { "portrait" },
        sheet.print.scale.clamp(10, 400),
        sheet.print.fit_to_width,
        sheet.print.fit_to_height
    ));
    out.push_str(&format!(
        "<printOptions horizontalCentered=\"{}\" gridLines=\"{}\" headings=\"{}\"/>",
        u8::from(sheet.print.center_horizontally),
        u8::from(sheet.print.print_gridlines),
        u8::from(sheet.print.print_headings)
    ));
    out.push_str(&format!(
        "<headerFooter differentFirst=\"{}\" differentOddEven=\"{}\"><oddHeader>&amp;C{}</oddHeader></headerFooter>",
        u8::from(sheet.print.different_first_page),
        u8::from(sheet.print.different_odd_even),
        escape_text(&sheet.print.header)
    ));
    out
}

pub fn write_xlsx_package(workbook: &Workbook) -> OfficeResult<SheetWrite> {
    let mut warnings = Vec::new();
    if workbook.sheets.iter().any(|sheet| !sheet.charts.is_empty()) {
        warnings.push("Charts are kept in the native .oswk file; XLSX export does not embed them yet.".into());
    }
    let mut styles = StyleTable::new();
    let mut shared: Vec<String> = Vec::new();
    let mut shared_index: BTreeMap<String, usize> = BTreeMap::new();

    let mut sheet_parts: Vec<SheetPart> = Vec::new();
    let mut sheet_names: Vec<String> = Vec::new();
    for (index, sheet) in workbook.sheets.iter().enumerate() {
        let mut name = sheet.name.clone();
        if name.is_empty() {
            name = format!("Sheet{}", index + 1);
        }
        name.truncate(31);
        sheet_names.push(name);
        sheet_parts.push(sheet_xml(sheet, &mut styles, &mut shared, &mut shared_index));
    }

    let mut zip = ZipWriter::new();
    let mut content_types = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">",
    );
    content_types.push_str("<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>");
    content_types.push_str("<Default Extension=\"xml\" ContentType=\"application/xml\"/>");
    content_types.push_str("<Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/>");
    for index in 0..sheet_parts.len() {
        content_types.push_str(&format!(
            "<Override PartName=\"/xl/worksheets/sheet{}.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/>",
            index + 1
        ));
    }
    content_types.push_str("<Override PartName=\"/xl/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml\"/>");
    content_types.push_str("<Override PartName=\"/xl/sharedStrings.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml\"/>");
    content_types.push_str("<Override PartName=\"/docProps/core.xml\" ContentType=\"application/vnd.openxmlformats-package.core-properties+xml\"/>");
    content_types.push_str("<Override PartName=\"/docProps/app.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.extended-properties+xml\"/>");
    content_types.push_str("</Types>");

    let mut root_rels = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">",
    );
    root_rels.push_str("<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"xl/workbook.xml\"/>");
    root_rels.push_str("<Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties\" Target=\"docProps/core.xml\"/>");
    root_rels.push_str("<Relationship Id=\"rId3\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties\" Target=\"docProps/app.xml\"/>");
    root_rels.push_str("</Relationships>");

    let mut workbook_xml = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><sheets>",
    );
    for (index, name) in sheet_names.iter().enumerate() {
        workbook_xml.push_str(&format!(
            "<sheet name=\"{}\" sheetId=\"{}\" r:id=\"rId{}\"/>",
            escape_attr(name),
            index + 1,
            index + 1
        ));
    }
    workbook_xml.push_str("</sheets>");
    // Defined names: workbook-level ones first, then each sheet's own. Excel
    // scopes a name with `localSheetId`, which is the sheet's position.
    let mut defined = String::new();
    let mut defined_count = 0usize;
    for entry in &workbook.names {
        if !entry.is_workbook_scope() {
            continue;
        }
        if let Some(xml) = defined_name_xml(entry, None) {
            defined.push_str(&xml);
            defined_count += 1;
        }
    }
    for (index, sheet_name) in sheet_names.iter().enumerate() {
        for entry in &workbook.names {
            if entry.is_workbook_scope() || entry.sheet.as_deref() != Some(sheet_name.as_str()) {
                continue;
            }
            if let Some(xml) = defined_name_xml(entry, Some(index)) {
                defined.push_str(&xml);
                defined_count += 1;
            }
        }
    }
    // A sheet's AutoFilter range is itself a defined name in the OOXML spec.
    for (index, sheet) in workbook.sheets.iter().enumerate() {
        if let Some(filter) = &sheet.filter {
            if !filter.range.is_empty() {
                defined.push_str(&format!(
                    "<definedName name=\"_xlnm._FilterDatabase\" localSheetId=\"{}\" hidden=\"1\">{}!{}</definedName>",
                    index,
                    escape_text(&sheet_names[index]),
                    escape_text(&filter.range.replace(':', ":"))
                ));
                defined_count += 1;
            }
        }
    }
    if defined_count > 0 {
        workbook_xml.push_str(&format!("<definedNames>{defined}</definedNames>"));
    }
    workbook_xml.push_str("</workbook>");

    let mut workbook_rels = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">",
    );
    for (index, _) in sheet_parts.iter().enumerate() {
        workbook_rels.push_str(&format!(
            "<Relationship Id=\"rId{}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet{}.xml\"/>",
            index + 1,
            index + 1
        ));
    }    let styles_rid = sheet_parts.len() + 1;
    let shared_rid = sheet_parts.len() + 2;
    workbook_rels.push_str(&format!(
        "<Relationship Id=\"rId{styles_rid}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles\" Target=\"styles.xml\"/>"
    ));
    workbook_rels.push_str(&format!(
        "<Relationship Id=\"rId{shared_rid}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings\" Target=\"sharedStrings.xml\"/>"
    ));
    workbook_rels.push_str("</Relationships>");

    let mut shared_xml = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<sst xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"",
    );
    shared_xml.push_str(&format!(" count=\"{}\" uniqueCount=\"{}\">", shared.len(), shared.len()));
    for text in &shared {
        shared_xml.push_str(&format!("<si><t xml:space=\"preserve\">{}</t></si>", escape_text(text)));
    }
    shared_xml.push_str("</sst>");

    let core = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<cp:coreProperties xmlns:cp=\"http://schemas.openxmlformats.org/package/2006/metadata/core-properties\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\"><dc:title>{}</dc:title><dc:creator>{}</dc:creator></cp:coreProperties>",
        escape_text(&workbook.title),
        escape_text(&workbook.metadata.author)
    );
    let app = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Properties xmlns=\"http://schemas.openxmlformats.org/officeDocument/2006/extended-properties\"><Application>Office Swiss Army Knife</Application></Properties>";

    let with_comments = sheet_parts.iter().any(|part| !part.comments.is_empty());
    if with_comments {
        content_types.push_str("<Override PartName=\"/xl/comments1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml\"/>");
        content_types.push_str("<Default Extension=\"vml\" ContentType=\"application/vnd.openxmlformats-officedocument.vmlDrawing\"/>");
    }

    zip.add_text("[Content_Types].xml", &content_types);
    zip.add_text("_rels/.rels", &root_rels);
    zip.add_text("docProps/core.xml", &core);
    zip.add_text("docProps/app.xml", app);
    zip.add_text("xl/workbook.xml", &workbook_xml);
    zip.add_text("xl/_rels/workbook.xml.rels", &workbook_rels);
    zip.add_text("xl/styles.xml", &styles.xml());
    zip.add_text("xl/sharedStrings.xml", &shared_xml);
    for (index, part) in sheet_parts.iter().enumerate() {
        zip.add_text(&format!("xl/worksheets/sheet{}.xml", index + 1), &part.xml);
        if !part.rels.is_empty() {
            let mut rels = String::from(
                "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">",
            );
            for (id, kind, target) in &part.rels {
                let extra = if kind.ends_with("/hyperlink") { " TargetMode=\"External\"" } else { "" };
                rels.push_str(&format!(
                    "<Relationship Id=\"{id}\" Type=\"{kind}\" Target=\"{}\"{extra}/>",
                    escape_attr(target)
                ));
            }
            rels.push_str("</Relationships>");
            zip.add_text(&format!("xl/worksheets/_rels/sheet{}.xml.rels", index + 1), &rels);
        }
    }
    if with_comments {
        // One comments part covering every sheet's notes, which is what Excel
        // produces for a workbook this size and keeps the package simple.
        let mut authors = String::from("Office Swiss Army Knife");
        let mut comments_xml = String::from(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<comments xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><authors>",
        );
        comments_xml.push_str(&format!("<author>{}</author>", escape_text(&authors)));
        authors.clear();
        comments_xml.push_str("</authors><commentList>");
        for part in &sheet_parts {
            for (address, text) in &part.comments {
                comments_xml.push_str(&format!(
                    "<comment ref=\"{address}\" authorId=\"0\"><text><r><rPr><sz val=\"9\"/></rPr><t xml:space=\"preserve\">{text}</t></r></text></comment>",
                    text = escape_text(text)
                ));
            }
        }
        comments_xml.push_str("</commentList></comments>");
        zip.add_text("xl/comments1.xml", &comments_xml);
        zip.add_text("xl/drawings/vmlDrawing1.vml", &comments_vml(&sheet_parts));
    }
    Ok(SheetWrite { bytes: zip.finish(), warnings })
}

/// Emits one `<definedName>` element, or `None` when the entry is unusable.
///
/// A name has to start with a letter or underscore and may not look like a
/// cell reference, otherwise Excel refuses to open the file - so a bad entry is
/// dropped rather than written out.
fn defined_name_xml(entry: &NamedRange, local_sheet_id: Option<usize>) -> Option<String> {
    let name = entry.name.trim();
    if name.is_empty() || entry.definition.trim().is_empty() {
        return None;
    }
    if !name.chars().next()?.is_alphabetic() && !name.starts_with('_') {
        return None;
    }
    if name.chars().any(|character| !(character.is_alphanumeric() || character == '_' || character == '.')) {
        return None;
    }
    if crate::address::parse(name).is_some() {
        return None;
    }
    let scope = match local_sheet_id {
        Some(index) => format!(" localSheetId=\"{index}\""),
        None => String::new(),
    };
    let mut definition = entry.definition.trim().to_string();
    if !definition.starts_with('=') {
        definition = format!("={definition}");
    }
    Some(format!(
        "<definedName name=\"{}\"{}>{}</definedName>",
        escape_attr(name),
        scope,
        escape_text(&definition)
    ))
}

/// The VML drawing Excel needs in order to show a comment marker on a cell.
///
/// OOXML stores comment *text* in `comments1.xml` but the little red triangle
/// and the hover box are legacy VML shapes, so a comments part without this
/// file opens with invisible notes.
fn comments_vml(parts: &[SheetPart]) -> String {
    let mut vml = String::from(
        "<xml xmlns:v=\"urn:schemas-microsoft-com:vml\" xmlns:o=\"urn:schemas-microsoft-com:office:office\" xmlns:x=\"urn:schemas-microsoft-com:office:excel\">",
    );
    vml.push_str("<o:shapelayout v:ext=\"edit\"><o:idmap v:ext=\"edit\" data=\"1\"/></o:shapelayout>");
    vml.push_str(
        "<v:shapetype id=\"_x0000_t202\" coordsize=\"21600,21600\" o:spt=\"202\" path=\"m,l,21600r21600,l21600,xe\"><v:stroke joinstyle=\"miter\"/><v:path gradientshapeok=\"t\" o:connecttype=\"rect\"/></v:shapetype>",
    );
    let mut shape_id = 1025u32;
    for part in parts {
        for (address, _) in &part.comments {
            // Column and row are zero based in the ClientData block.
            let (row, column) = crate::address::parse(address).unwrap_or((0, 0));
            vml.push_str(&format!(
                "<v:shape id=\"_x0000_s{shape_id}\" type=\"#_x0000_t202\" style=\"position:absolute;margin-left:59.25pt;margin-top:1.5pt;width:108pt;height:59.25pt;z-index:1;visibility:hidden\" fillcolor=\"#ffffe1\" o:insetmode=\"auto\"><v:fill color2=\"#ffffe1\"/><v:shadow on=\"t\" color=\"black\" obscured=\"t\"/><v:path o:connecttype=\"none\"/><v:textbox style=\"mso-direction-alt:auto\"><div style=\"text-align:left\"/></v:textbox><x:ClientData ObjectType=\"Note\"><x:MoveWithCells/><x:SizeWithCells/><x:AutoFill>False</x:AutoFill><x:Row>{row}</x:Row><x:Column>{column}</x:Column></x:ClientData></v:shape>"
            ));
            shape_id += 1;
        }
    }
    vml.push_str("</xml>");
    vml
}

/// `#RRGGBB` (or `RRGGBB`) to the `AARRGGBB` form XLSX attributes use.
fn argb_of(color: &str) -> String {
    let hex: String = color.chars().filter(|character| character.is_ascii_hexdigit()).collect();
    match hex.len() {
        6 => format!("FF{hex}"),
        8 => hex,
        _ => "FF000000".into(),
    }
}

pub fn write_xlsx(workbook: &Workbook) -> OfficeResult<Vec<u8>> {
    Ok(write_xlsx_package(workbook)?.bytes)
}

pub fn write_xlsx_file(path: &Path, workbook: &Workbook) -> OfficeResult<()> {
    let result = write_xlsx_package(workbook)?;
    write_atomic(path, &result.bytes)
}

// ---------------------------------------------------------------------------
// Import (XLSX / XLS / ODS via calamine)
// ---------------------------------------------------------------------------

fn contains_part(bytes: &[u8], needle: &str) -> bool {
    crate::zip::ZipReader::open(bytes.to_vec())
        .map(|reader| reader.names().any(|name| name.contains(needle)))
        .unwrap_or(false)
}

pub fn read_workbook_bytes(bytes: &[u8]) -> OfficeResult<SheetRead> {
    if bytes.len() < 8 {
        return Err(OfficeError::corrupt("The file is too small to be a spreadsheet."));
    }
    let mut warnings: Vec<String> = Vec::new();
    let mut workbook = Workbook::new_blank("Imported workbook");
    workbook.sheets.clear();

    let cursor = Cursor::new(bytes.to_vec());
    let mut sheets = calamine::open_workbook_auto_from_rs(cursor)
        .map_err(|error| OfficeError::corrupt(format!("Could not read the spreadsheet: {error}")))?;
    let names: Vec<String> = sheets.sheet_names().to_vec();
    if names.is_empty() {
        return Err(OfficeError::corrupt("The spreadsheet does not contain any sheet."));
    }
    let mut used_names: Vec<String> = Vec::new();
    for name in &names {
        let mut sheet = Sheet::new(name);
        let range = sheets
            .worksheet_range(name)
            .map_err(|error| OfficeError::corrupt(format!("Could not read sheet {name}: {error}")))?;
        let formulas = sheets.worksheet_formula(name).ok();
        let (start_row, start_col) = (range.start().map(|(row, _)| row).unwrap_or(0), range.start().map(|(_, column)| column).unwrap_or(0));
        let mut max_row = 0u32;
        let mut max_col = 0u32;
        for (row_index, row) in range.rows().enumerate() {
            for (column_index, value) in row.iter().enumerate() {
                let row_number = start_row + row_index as u32;
                let column_number = start_col + column_index as u32;
                if row_number > 100_000 || column_number > 1_000 {
                    continue;
                }
                let cell_value = match value {
                    calamine::Data::Empty => continue,
                    calamine::Data::Int(number) => CellValue::Number(*number as f64),
                    calamine::Data::Float(number) => CellValue::Number(*number),
                    calamine::Data::String(text) => CellValue::Text(text.clone()),
                    calamine::Data::Bool(flag) => CellValue::Bool(*flag),
                    #[allow(unreachable_patterns)]
                    calamine::Data::DateTime(serial) => CellValue::Number(serial.as_f64()),
                    calamine::Data::DateTimeIso(text) => CellValue::Text(text.clone()),
                    calamine::Data::DurationIso(text) => CellValue::Text(text.clone()),
                    calamine::Data::Error(error) => CellValue::Error(format!("{error:?}")),
                    _ => continue,
                };
                let formula = formulas
                    .as_ref()
                    .and_then(|range| range.get_value((row_number, column_number)))
                    .filter(|text| !text.is_empty())
                    .map(|text| {
                        let trimmed = text.trim().trim_start_matches('=');
                        format!("={trimmed}")
                    });
                if matches!(cell_value, CellValue::Empty) && formula.is_none() {
                    continue;
                }
                let address = crate::address::format(row_number, column_number);
                sheet.set(&address, Cell { value: cell_value, formula, ..Default::default() });
                max_row = max_row.max(row_number);
                max_col = max_col.max(column_number);
            }
        }
        sheet.row_count = (max_row + 51).max(200);
        sheet.col_count = (max_col + 6).max(26);
        if used_names.iter().any(|existing| existing == &sheet.name) {
            let unique = {
                let mut index = 2;
                loop {
                    let candidate = format!("{} ({index})", sheet.name);
                    if !used_names.contains(&candidate) {
                        break candidate;
                    }
                    index += 1;
                }
            };
            sheet.name = unique;
        }
        used_names.push(sheet.name.clone());
        workbook.sheets.push(sheet);
    }

    if workbook.sheets.is_empty() {
        workbook.sheets.push(Sheet::new("Sheet1"));
    }
    if contains_part(bytes, "xl/charts") || contains_part(bytes, "Object ") {
        warnings.push("Charts embedded in the spreadsheet are not imported.".into());
    }
    if contains_part(bytes, "xl/vbaProject.bin") {
        warnings.push("Macros were not loaded. Spreadsheets always open with macros disabled.".into());
    }
    warnings.push("Cell formatting, comments and charts from the original file are imported with limited support.".into());
    let title = String::new();
    if title.is_empty() {
        workbook.metadata.title = workbook.title.clone();
    }
    Ok(SheetRead { workbook, warnings })
}

pub fn read_workbook_file(path: &Path) -> OfficeResult<SheetRead> {
    let bytes = crate::io::read_bytes(path)?;
    let mut result = read_workbook_bytes(&bytes)?;
    if result.workbook.title == "Imported workbook" || result.workbook.title.is_empty() {
        result.workbook.title = crate::io::file_stem(path);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_workbook() -> Workbook {
        let mut workbook = Workbook::new_blank("Budget");
        let sheet = &mut workbook.sheets[0];
        sheet.name = "Budget".into();
        sheet.set("A1", Cell { value: CellValue::Text("Item".into()), style: CellStyle { bold: true, ..Default::default() }, ..Default::default() });
        sheet.set("B1", Cell { value: CellValue::Text("Qty".into()), ..Default::default() });
        sheet.set("C1", Cell { value: CellValue::Text("Price".into()), ..Default::default() });
        sheet.set("A2", Cell { value: CellValue::Text("Pen".into()), ..Default::default() });
        sheet.set("B2", Cell { value: CellValue::Number(10.0), ..Default::default() });
        sheet.set("C2", Cell { value: CellValue::Number(5.5), style: CellStyle { number_format: "0.00".into(), ..Default::default() }, ..Default::default() });
        sheet.set("D2", Cell { value: CellValue::Number(55.0), formula: Some("=B2*C2".into()), ..Default::default() });
        sheet.set("A3", Cell { value: CellValue::Bool(true), ..Default::default() });
        sheet.merges.push(MergeRange { start: "A4".into(), end: "C4".into() });
        sheet.col_widths.insert(0, 140.0);
        sheet.row_heights.insert(0, 28.0);
        sheet.freeze_rows = 1;
        workbook.sheets.push(Sheet::new("Second"));
        workbook
    }

    #[test]
    fn xlsx_package_structure() {
        let result = write_xlsx_package(&sample_workbook()).unwrap();
        let reader = crate::zip::ZipReader::open(result.bytes.clone()).unwrap();
        assert!(reader.contains("[Content_Types].xml"));
        assert!(reader.contains("xl/workbook.xml"));
        assert!(reader.contains("xl/worksheets/sheet1.xml"));
        assert!(reader.contains("xl/worksheets/sheet2.xml"));
        assert!(reader.contains("xl/styles.xml"));
        assert!(reader.contains("xl/sharedStrings.xml"));
        let sheet = reader.read_text("xl/worksheets/sheet1.xml").unwrap();
        assert!(sheet.contains("<f>B2*C2</f>"));
        assert!(sheet.contains("mergeCell"));
        assert!(sheet.contains("pane"));
    }

    #[test]
    fn xlsx_roundtrip_values() {
        let bytes = write_xlsx(&sample_workbook()).unwrap();
        let read = read_workbook_bytes(&bytes).unwrap();
        assert_eq!(read.workbook.sheets.len(), 2);
        let sheet = &read.workbook.sheets[0];
        assert_eq!(sheet.get("A1").map(|cell| cell.value.clone()), Some(CellValue::Text("Item".into())));
        assert_eq!(sheet.get("B2").map(|cell| cell.value.clone()), Some(CellValue::Number(10.0)));
        let formula = sheet.get("D2").and_then(|cell| cell.formula.clone());
        assert_eq!(formula.as_deref(), Some("=B2*C2"));
    }

    #[test]
    fn rejects_garbage() {
        assert!(read_workbook_bytes(b"").is_err());
        assert!(read_workbook_bytes(&[0u8; 32]).is_err());
    }

    #[test]
    fn reads_own_file_with_styles() {
        let mut workbook = Workbook::new_blank("Styles");
        let sheet = &mut workbook.sheets[0];
        sheet.set("A1", Cell {
            value: CellValue::Text("styled".into()),
            style: CellStyle {
                bold: true,
                italic: true,
                fill: Some("#FFF2CC".into()),
                color: Some("#7F6000".into()),
                number_format: String::new(),
                borders: CellBorders { top: Some(BorderStyle { style: "thin".into(), color: "#000000".into() }), ..Default::default() },
                ..Default::default()
            },
            ..Default::default()
        });
        let bytes = write_xlsx(&workbook).unwrap();
        let reader = crate::zip::ZipReader::open(bytes.clone()).unwrap();
        let styles = reader.read_text("xl/styles.xml").unwrap();
        assert!(styles.contains("FFF2CC"));
        assert!(styles.contains("<b/>"));
    }
}
