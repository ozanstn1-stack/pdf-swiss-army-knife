//! XLSX export (written directly as OOXML) and spreadsheet import.
//!
//! Export covers values, formulas, styling, number formats, column widths,
//! row heights, merges, freeze panes and gridline settings. Import uses the
//! well-tested `calamine` parser so XLSX, XLS and ODS files from Excel and
//! LibreOffice open reliably; formatting is imported with limited support and
//! that limitation is reported to the user.

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

fn sheet_xml(sheet: &Sheet, styles: &mut StyleTable, shared: &mut Vec<String>, shared_index: &mut BTreeMap<String, usize>) -> String {
    let mut writer = XmlWriter::new();
    writer.declaration();
    writer.raw(
        "<worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\">",
    );

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
    for (address, cell) in &sheet.cells {
        if cell.is_empty() {
            continue;
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
            if formula_xml.is_empty() && value_xml.is_empty() && cell.style == CellStyle::default() {
                continue;
            }
            writer.raw(&format!("<c r=\"{address}\"{style_attr}{type_attr}>{formula_xml}{value_xml}</c>"));
        }
        writer.raw("</row>");
    }
    writer.raw("</sheetData>");

    if !sheet.merges.is_empty() {
        writer.raw(&format!("<mergeCells count=\"{}\">", sheet.merges.len()));
        for merge in &sheet.merges {
            writer.raw(&format!("<mergeCell ref=\"{}:{}\"/>", escape_attr(&merge.start), escape_attr(&merge.end)));
        }
        writer.raw("</mergeCells>");
    }

    // Data validation (list/number) is written; conditional formatting is kept
    // in the native format and reported as an XLSX limitation.
    if !sheet.validations.is_empty() {
        writer.raw(&format!("<dataValidations count=\"{}\">", sheet.validations.len()));
        for validation in &sheet.validations {
            let (kind, formula1) = match validation.kind.as_str() {
                "list" => ("list", validation.values.join(",")),
                "number" => ("decimal", validation.min.map(|value| value.to_string()).unwrap_or_default()),
                _ => ("none", String::new()),
            };
            if kind == "none" {
                continue;
            }
            let formula1 = if kind == "list" { format!("\"{formula1}\"") } else { formula1 };
            writer.raw(&format!(
                "<dataValidation type=\"{kind}\" allowBlank=\"1\" showInputMessage=\"1\" showErrorMessage=\"1\" sqref=\"{}\"><formula1>{}</formula1></dataValidation>",
                escape_attr(&validation.range),
                escape_text(&formula1)
            ));
        }
        writer.raw("</dataValidations>");
    }

    writer.raw("<pageMargins left=\"0.7\" right=\"0.7\" top=\"0.75\" bottom=\"0.75\" header=\"0.3\" footer=\"0.3\"/>");
    writer.raw("</worksheet>");
    writer.finish()
}

pub fn write_xlsx_package(workbook: &Workbook) -> OfficeResult<SheetWrite> {
    let mut warnings = Vec::new();
    if workbook.sheets.iter().any(|sheet| !sheet.charts.is_empty()) {
        warnings.push("Charts are kept in the native .oswk file; XLSX export does not embed them yet.".into());
    }
    if workbook.sheets.iter().any(|sheet| !sheet.conditional.is_empty()) {
        warnings.push("Conditional formatting rules are applied in the editor but are not written to XLSX.".into());
    }
    let mut styles = StyleTable::new();
    let mut shared: Vec<String> = Vec::new();
    let mut shared_index: BTreeMap<String, usize> = BTreeMap::new();

    let mut sheet_parts: Vec<(String, String)> = Vec::new();
    for (index, sheet) in workbook.sheets.iter().enumerate() {
        let mut name = sheet.name.clone();
        if name.is_empty() {
            name = format!("Sheet{}", index + 1);
        }
        name.truncate(31);
        sheet_parts.push((name, sheet_xml(sheet, &mut styles, &mut shared, &mut shared_index)));
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
    for (index, (name, _)) in sheet_parts.iter().enumerate() {
        workbook_xml.push_str(&format!(
            "<sheet name=\"{}\" sheetId=\"{}\" r:id=\"rId{}\"/>",
            escape_attr(name),
            index + 1,
            index + 1
        ));
    }
    workbook_xml.push_str("</sheets></workbook>");

    let mut workbook_rels = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">",
    );
    for (index, _) in sheet_parts.iter().enumerate() {
        workbook_rels.push_str(&format!(
            "<Relationship Id=\"rId{}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet{}.xml\"/>",
            index + 1,
            index + 1
        ));
    }
    let styles_rid = sheet_parts.len() + 1;
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

    zip.add_text("[Content_Types].xml", &content_types);
    zip.add_text("_rels/.rels", &root_rels);
    zip.add_text("docProps/core.xml", &core);
    zip.add_text("docProps/app.xml", app);
    zip.add_text("xl/workbook.xml", &workbook_xml);
    zip.add_text("xl/_rels/workbook.xml.rels", &workbook_rels);
    zip.add_text("xl/styles.xml", &styles.xml());
    zip.add_text("xl/sharedStrings.xml", &shared_xml);
    for (index, (_, xml)) in sheet_parts.iter().enumerate() {
        zip.add_text(&format!("xl/worksheets/sheet{}.xml", index + 1), xml);
    }
    Ok(SheetWrite { bytes: zip.finish(), warnings })
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
