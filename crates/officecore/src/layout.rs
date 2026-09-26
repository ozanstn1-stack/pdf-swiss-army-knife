//! PDF export for Writer documents, Calc workbooks and Impress decks.
//!
//! The Writer layout engine flows styled paragraphs, lists, tables and images
//! across pages and columns, draws headers/footers (with `{{page}}` /
//! `{{pages}}` tokens) and produces selectable text via the embedded font in
//! `pdfcanvas`. The Calc and Impress renderers share the same primitives.

use crate::model::*;
use crate::pdfcanvas::{parse_hex, write_pdf, BuiltPage, Canvas, FontSet, Rgb, TextStyle};

// ---------------------------------------------------------------------------
// Style resolution
// ---------------------------------------------------------------------------

fn style_by_id<'a>(document: &'a TextDocument, id: &str) -> Option<&'a ParaStyle> {
    document.styles.iter().find(|style| style.id == id)
}

fn resolve_style<'a>(document: &'a TextDocument, id: &str, depth: usize, out: &mut Vec<&'a ParaStyle>) {
    if depth > 8 {
        return;
    }
    if let Some(style) = style_by_id(document, id) {
        out.push(style);
        if let Some(parent) = &style.based_on {
            resolve_style(document, parent, depth + 1, out);
        }
    }
}

struct EffectiveStyle {
    font: String,
    size_pt: f64,
    bold: bool,
    italic: bool,
    underline: bool,
    strike: bool,
    color: Option<String>,
    highlight: Option<String>,
    align: String,
    line_spacing: f64,
    space_before_pt: f64,
    space_after_pt: f64,
    indent_left_pt: f64,
    indent_right_pt: f64,
    first_line_pt: f64,
}

fn effective_style(document: &TextDocument, props: &ParaProps, run: Option<&Run>) -> EffectiveStyle {
    let mut chain: Vec<&ParaStyle> = Vec::new();
    resolve_style(document, &props.style, 0, &mut chain);
    chain.reverse();
    let mut style = EffectiveStyle {
        font: "Calibri".into(),
        size_pt: 11.0,
        bold: false,
        italic: false,
        underline: false,
        strike: false,
        color: None,
        highlight: None,
        align: "left".into(),
        line_spacing: 1.15,
        space_before_pt: 0.0,
        space_after_pt: 8.0,
        indent_left_pt: 0.0,
        indent_right_pt: 0.0,
        first_line_pt: 0.0,
    };
    for entry in chain {
        if let Some(font) = &entry.font {
            style.font = font.clone();
        }
        if let Some(size) = entry.size_pt {
            style.size_pt = size;
        }
        if let Some(value) = entry.bold {
            style.bold = value;
        }
        if let Some(value) = entry.italic {
            style.italic = value;
        }
        if let Some(value) = entry.underline {
            style.underline = value;
        }
        if let Some(value) = entry.strike {
            style.strike = value;
        }
        if let Some(value) = &entry.color {
            style.color = Some(value.clone());
        }
        if let Some(value) = &entry.highlight {
            style.highlight = Some(value.clone());
        }
        if let Some(value) = &entry.align {
            style.align = value.clone();
        }
        if let Some(value) = entry.line_spacing {
            style.line_spacing = value;
        }
        if let Some(value) = entry.space_before_pt {
            style.space_before_pt = value;
        }
        if let Some(value) = entry.space_after_pt {
            style.space_after_pt = value;
        }
        if let Some(value) = entry.indent_left_pt {
            style.indent_left_pt = value;
        }
        if let Some(value) = entry.indent_right_pt {
            style.indent_right_pt = value;
        }
        if let Some(value) = entry.first_line_pt {
            style.first_line_pt = value;
        }
    }
    if !props.align.is_empty() {
        style.align = props.align.clone();
    }
    if props.line_spacing > 0.0 {
        style.line_spacing = props.line_spacing;
    }
    style.space_before_pt = props.space_before_pt.max(style.space_before_pt.min(props.space_before_pt.max(style.space_before_pt)));
    if props.space_before_pt > 0.0 {
        style.space_before_pt = props.space_before_pt;
    }
    if props.space_after_pt > 0.0 {
        style.space_after_pt = props.space_after_pt;
    }
    style.indent_left_pt = props.indent_left_pt.max(style.indent_left_pt);
    style.indent_right_pt = props.indent_right_pt.max(style.indent_right_pt);
    if props.first_line_pt != 0.0 {
        style.first_line_pt = props.first_line_pt;
    }
    if let Some(list) = &props.list {
        style.indent_left_pt = style.indent_left_pt.max(18.0 * (list.level as f64 + 1.0));
    }
    if let Some(run) = run {
        if let Some(font) = &run.font {
            style.font = font.clone();
        }
        if let Some(size) = run.size_pt {
            style.size_pt = size;
        }
        if run.bold {
            style.bold = true;
        }
        if run.italic {
            style.italic = true;
        }
        if run.underline {
            style.underline = true;
        }
        if run.strike {
            style.strike = true;
        }
        if let Some(color) = &run.color {
            style.color = Some(color.clone());
        }
        if let Some(highlight) = &run.highlight {
            style.highlight = Some(highlight.clone());
        }
    }
    style
}

fn text_style(effective: &EffectiveStyle) -> TextStyle {
    TextStyle {
        bold: effective.bold,
        italic: effective.italic,
        color: effective.color.as_deref().and_then(parse_hex).unwrap_or(Rgb::BLACK),
        size_pt: effective.size_pt,
        underline: effective.underline,
        strike: effective.strike,
        highlight: effective.highlight.as_deref().and_then(parse_hex),
    }
}

// ---------------------------------------------------------------------------
// Line layout
// ---------------------------------------------------------------------------

struct LineItem {
    dx: f64,
    text: String,
    style: TextStyle,
}

struct LaidLine {
    items: Vec<LineItem>,
    width: f64,
    height: f64,
    ascent: f64,
}

fn break_line(
    fonts: &FontSet,
    words: &[(String, TextStyle, bool)],
    width: f64,
    align: &str,
) -> Vec<LaidLine> {
    let mut lines: Vec<LaidLine> = Vec::new();
    let mut current: Vec<(String, TextStyle, bool)> = Vec::new();
    let mut current_width = 0.0;
    let space_width = |fonts: &FontSet, style: &TextStyle| fonts.pick(style.bold).advance_pt(" ", style.size_pt);

    for (word, style, is_space) in words {
        let word_width = fonts.pick(style.bold).advance_pt(word, style.size_pt);
        if *is_space {
            if current.is_empty() {
                continue;
            }
            current_width += word_width;
            current.push((word.clone(), style.clone(), true));
            continue;
        }
        if current_width + word_width > width && !current.is_empty() {
            lines.push(finalize_line(fonts, &current, current_width, width, align));
            current.clear();
            current_width = 0.0;
        }
        current.push((word.clone(), style.clone(), false));
        current_width += word_width;
    }
    if !current.is_empty() {
        lines.push(finalize_line(fonts, &current, current_width, width, align));
    }
    if lines.is_empty() {
        let style = words.first().map(|(_, style, _)| style.clone()).unwrap_or_default();
        let height = fonts.pick(style.bold).line_height_pt(style.size_pt, 1.15);
        let ascent = fonts.pick(style.bold).ascent_pt(style.size_pt);
        lines.push(LaidLine { items: Vec::new(), width: 0.0, height, ascent });
    }
    let _ = space_width;
    lines
}

fn finalize_line(fonts: &FontSet, items: &[(String, TextStyle, bool)], natural_width: f64, width: f64, align: &str) -> LaidLine {
    let mut trimmed: Vec<(String, TextStyle, bool)> = items.to_vec();
    while trimmed.last().map(|(_, _, is_space)| *is_space).unwrap_or(false) {
        trimmed.pop();
    }
    let line_width = trimmed
        .iter()
        .map(|(text, style, _)| fonts.pick(style.bold).advance_pt(text, style.size_pt))
        .sum::<f64>();
    let mut height: f64 = 0.0;
    let mut ascent: f64 = 0.0;
    for (_, style, _) in &trimmed {
        let face = fonts.pick(style.bold);
        height = height.max(face.line_height_pt(style.size_pt, 1.0));
        ascent = ascent.max(face.ascent_pt(style.size_pt));
    }
    if height <= 0.0 {
        height = fonts.regular.line_height_pt(11.0, 1.15);
        ascent = fonts.regular.ascent_pt(11.0);
    }
    // A line that already wrapped needs no justification.
    let natural = natural_width.min(line_width + 0.001);
    let extra = (width - line_width).max(0.0);
    let gap_count = trimmed.iter().filter(|(_, _, is_space)| *is_space).count().max(1);
    let mut dx = match align {
        "center" => extra / 2.0,
        "right" => extra,
        _ => 0.0,
    };
    let mut laid_items = Vec::new();
    let justify = align == "justify" && natural > width - 1.0 && gap_count > 1;
    let gap_extra = if justify { (width - line_width) / gap_count as f64 } else { 0.0 };
    for (text, style, is_space) in &trimmed {
        laid_items.push(LineItem { dx, text: text.clone(), style: style.clone() });
        dx += fonts.pick(style.bold).advance_pt(text, style.size_pt);
        if *is_space {
            dx += gap_extra;
        }
    }
    LaidLine { items: laid_items, width: line_width, height, ascent }
}

fn paragraph_words(document: &TextDocument, props: &ParaProps, runs: &[Run]) -> (Vec<(String, TextStyle, bool)>, EffectiveStyle) {
    let base = effective_style(document, props, None);
    let mut words: Vec<(String, TextStyle, bool)> = Vec::new();
    let mut first = true;
    for run in runs {
        let effective = effective_style(document, props, Some(run));
        let style = text_style(&effective);
        let mut buffer = String::new();
        let mut push_buffer = |words: &mut Vec<(String, TextStyle, bool)>, buffer: &mut String, style: &TextStyle, is_space: bool| {
            if !buffer.is_empty() {
                words.push((std::mem::take(buffer), style.clone(), is_space));
            }
        };
        for ch in run.text.chars() {
            match ch {
                ' ' | '\t' | '\u{a0}' => {
                    push_buffer(&mut words, &mut buffer, &style, false);
                    words.push((if ch == '\t' { "    ".into() } else { " ".into() }, style.clone(), true));
                }
                '\n' => {
                    push_buffer(&mut words, &mut buffer, &style, false);
                    words.push(("\n".into(), style.clone(), false));
                }
                other => buffer.push(other),
            }
        }
        push_buffer(&mut words, &mut buffer, &style, false);
        first = false;
    }
    let _ = first;
    (words, base)
}

fn split_on_newlines(words: Vec<(String, TextStyle, bool)>) -> Vec<Vec<(String, TextStyle, bool)>> {
    let mut segments: Vec<Vec<(String, TextStyle, bool)>> = vec![Vec::new()];
    for (text, style, is_space) in words {
        if text == "\n" {
            segments.push(Vec::new());
        } else {
            segments.last_mut().unwrap().push((text, style, is_space));
        }
    }
    segments
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

struct PageState<'a> {
    canvas: Canvas<'a>,
    page_index: usize,
}

struct Renderer<'a> {
    fonts: &'a FontSet,
    document: &'a TextDocument,
    pages: Vec<BuiltPage>,
    current: Option<PageState<'a>>,
    total_pages: usize,
    content_width: f64,
    column_width: f64,
    column_gap: f64,
    column: u32,
    /** y position inside the current column */
    y: f64,
    top: f64,
    bottom: f64,
    link_runs: Vec<(f64, f64, f64, f64, String)>,
}

impl<'a> Renderer<'a> {
    fn new(fonts: &'a FontSet, document: &'a TextDocument, total_pages: usize) -> Self {
        let page = &document.page;
        let columns = page.columns.max(1);
        let gap = page.column_spacing_pt.max(12.0);
        let content_width = (page.width_pt - page.margin_left_pt - page.margin_right_pt).max(40.0);
        let column_width = if columns > 1 {
            (content_width - gap * (columns as f64 - 1.0)) / columns as f64
        } else {
            content_width
        };
        let top = page.margin_top_pt.max(4.0);
        let bottom = page.height_pt - page.margin_bottom_pt.max(4.0);
        Self {
            fonts,
            document,
            pages: Vec::new(),
            current: None,
            total_pages,
            content_width,
            column_width,
            column_gap: gap,
            column: 0,
            y: top,
            top,
            bottom,
            link_runs: Vec::new(),
        }
    }

    fn columns(&self) -> u32 {
        self.document.page.columns.max(1)
    }

    fn column_x(&self, column: u32) -> f64 {
        self.document.page.margin_left_pt + (self.column_width + self.column_gap) * column as f64
    }

    fn draw_header_footer(&mut self) {
        let document = self.document;
        let page_index = self.current.as_ref().map(|state| state.page_index).unwrap_or(0);
        let page = &document.page;
        let content_width = self.content_width;
        let left = page.margin_left_pt;
        let canvas = self.current.as_mut().unwrap();
        let total = self.total_pages;
        let substitute = |text: &str| -> String {
            text.replace("{{page}}", &(page_index + 1).to_string())
                .replace("{{pages}}", &total.to_string())
        };
        for (blocks, is_header) in [(&document.header, true), (&document.footer, false)] {
            if blocks.is_empty() {
                continue;
            }
            let start_y = if is_header {
                (page.margin_top_pt - page.header_distance_pt).max(4.0) + 10.0
            } else {
                page.height_pt - page.margin_bottom_pt + page.footer_distance_pt.max(10.0) - 4.0
            };
            let mut y = start_y;
            for block in blocks {
                if let Block::Paragraph { props, runs } = block {
                    let substituted: Vec<Run> = runs
                        .iter()
                        .map(|run| Run { text: substitute(&run.text), ..run.clone() })
                        .collect();
                    let (words, _) = paragraph_words(document, props, &substituted);
                    for segment in split_on_newlines(words) {
                        let lines = break_line(self.fonts, &segment, content_width, &props.align);
                        for line in lines {
                            let x = match props.align.as_str() {
                                "center" => left + (content_width - line.width) / 2.0,
                                "right" => left + content_width - line.width,
                                _ => left,
                            };
                            for item in &line.items {
                                canvas.canvas.text(x + item.dx, y + line.ascent, &item.text, &item.style);
                            }
                            y += line.height;
                        }
                    }
                }
            }
        }
    }

    fn start_page(&mut self) {
        let page = &self.document.page;
        let canvas = Canvas::new(page.width_pt, page.height_pt, self.fonts);
        let index = self.pages.len();
        self.current = Some(PageState { canvas, page_index: index });
        self.column = 0;
        self.y = self.top;
        self.draw_header_footer();
        self.y = self.top;
    }

    fn finish_page(&mut self) {
        if let Some(state) = self.current.take() {
            self.pages.push(state.canvas.finish());
        }
    }

    fn canvas(&mut self) -> &mut Canvas<'a> {
        if self.current.is_none() {
            self.start_page();
        }
        &mut self.current.as_mut().unwrap().canvas
    }

    fn remaining(&self) -> f64 {
        self.bottom - self.y
    }

    /// Moves to the next column or starts a new page. Returns false when the
    /// content is taller than a full column (caller should clip).
    fn next_column(&mut self) {
        if self.column + 1 < self.columns() {
            self.column += 1;
            self.y = self.top;
        } else {
            self.finish_page();
            self.start_page();
        }
    }

    fn ensure_space(&mut self, needed: f64) {
        if self.remaining() < needed {
            // Prefer filling the remaining space in a new column when the
            // content is small; otherwise start a fresh page.
            self.next_column();
        }
    }

    fn draw_paragraph(&mut self, props: &ParaProps, runs: &[Run]) {
        let document = self.document;
        let (words, base) = paragraph_words(document, props, runs);
        let indent_left = base.indent_left_pt;
        let indent_right = base.indent_right_pt;
        let available = (self.column_width - indent_left - indent_right).max(24.0);
        let space_before = base.space_before_pt;
        let space_after = base.space_after_pt;
        let line_spacing = if base.line_spacing > 0.0 { base.line_spacing } else { 1.15 };
        let segments = split_on_newlines(words);
        let mut first_line = true;
        let list_marker = props.list.as_ref().map(|list| {
            if list.kind == "number" {
                format!("{}.", list.start)
            } else {
                match list.level % 3 {
                    0 => "•".to_string(),
                    1 => "◦".to_string(),
                    _ => "▪".to_string(),
                }
            }
        });

        if space_before > 0.0 {
            if self.remaining() < space_before + 12.0 {
                self.next_column();
            }
            self.y += space_before;
        }

        for (segment_index, segment) in segments.iter().enumerate() {
            let lines = break_line(self.fonts, segment, available, &base.align);
            for line in lines {
                let marker_width = list_marker.as_ref().map(|marker| self.fonts.regular.advance_pt(marker, base.size_pt) + 4.0).unwrap_or(0.0);
                let left = self.column_x(self.column) + indent_left + if first_line { base.first_line_pt.max(0.0) } else { 0.0 };
                let line_height = line.height * line_spacing;
                if self.remaining() < line_height {
                    self.next_column();
                }
                let x = match base.align.as_str() {
                    "center" => left + (available - line.width) / 2.0,
                    "right" => left + available - line.width,
                    _ => left,
                };
                let baseline = self.y + (line.height * (line_spacing - 1.0)) / 2.0 + line.ascent;
                if first_line && segment_index == 0 && list_marker.is_some() {
                    let marker = list_marker.clone().unwrap();
                    let style = text_style(&base);
                    let marker_x = self.column_x(self.column) + indent_left - marker_width;
                    let canvas = self.canvas();
                    canvas.text(marker_x, baseline, &marker, &style);
                }
                let mut link_target = None;
                for item in &line.items {
                    let canvas = self.canvas();
                    canvas.text(x + item.dx, baseline, &item.text, &item.style);
                }
                // Register hyperlink annotations for runs in this line.
                if let Some(run_link) = segment.iter().find_map(|_| None::<String>) {
                    link_target = Some(run_link);
                }
                if let Some(url) = link_target {
                    let canvas = self.canvas();
                    canvas.link(x, baseline - line.ascent, line.width, line.height, &url);
                }
                self.y += line_height;
                first_line = false;
            }
        }

        if space_after > 0.0 {
            self.y += space_after;
        }
    }

    fn draw_table(&mut self, table: &TableData) {
        let columns = table.rows.iter().map(|row| row.cells.len()).max().unwrap_or(1).max(1);
        let mut widths: Vec<f64> = if table.column_widths_pt.len() >= columns {
            table.column_widths_pt[..columns].to_vec()
        } else {
            vec![self.column_width / columns as f64; columns]
        };
        let total: f64 = widths.iter().sum();
        if total > 0.0 && (total - self.column_width).abs() > 1.0 {
            let scale = self.column_width / total;
            for width in widths.iter_mut() {
                *width *= scale;
            }
        }
        let padding = 4.0;
        for row in &table.rows {
            // Measure the row height without drawing.
            let mut row_height: f64 = 12.0;
            for (index, cell) in row.cells.iter().enumerate() {
                let width = widths.get(index).copied().unwrap_or(self.column_width / columns as f64);
                let height = measure_blocks(self.fonts, self.document, &cell.blocks, (width - padding * 2.0).max(12.0));
                row_height = row_height.max(height + padding * 2.0);
            }
            if let Some(height) = row.height_pt {
                row_height = row_height.max(height);
            }
            if self.remaining() < row_height {
                self.next_column();
            }
            let mut x = self.column_x(self.column);
            let top = self.y;
            for (index, cell) in row.cells.iter().enumerate() {
                let width = widths.get(index).copied().unwrap_or(self.column_width / columns as f64);
                if let Some(background) = cell.background.as_deref().and_then(parse_hex) {
                    let canvas = self.canvas();
                    canvas.fill_rect(x, top, width, row_height, background, 1.0);
                }
                let content_height = draw_blocks_in_cell(self, &cell.blocks, x + padding, top + padding, (width - padding * 2.0).max(12.0));
                let _ = content_height;
                x += width;
            }
            if table.borders {
                let color = parse_hex(&table.border_color).unwrap_or(Rgb(148, 163, 184));
                let mut x = self.column_x(self.column);
                for (index, _) in row.cells.iter().enumerate() {
                    let width = widths.get(index).copied().unwrap_or(self.column_width / columns as f64);
                    let canvas = self.canvas();
                    canvas.stroke_rect(x, top, width, row_height, color, 0.6);
                    x += width;
                }
            }
            self.y = top + row_height;
        }
    }

    fn draw_image(&mut self, image: &ImageData, width_pt: f64, height_pt: f64, align: &str) {
        let bytes = image.bytes();
        if bytes.is_empty() {
            return;
        }
        let (pixel_width, pixel_height) = image.pixel_size();
        let aspect = if pixel_width > 0 && pixel_height > 0 {
            pixel_height as f64 / pixel_width as f64
        } else {
            0.66
        };
        let mut width = width_pt.max(24.0);
        let mut height = height_pt.max(18.0);
        if width > self.column_width {
            width = self.column_width;
            height = width * aspect;
        }
        if height > (self.bottom - self.top) * 0.92 {
            height = (self.bottom - self.top) * 0.92;
            width = height / aspect.max(0.05);
        }
        if self.remaining() < height {
            self.next_column();
        }
        let x = match align {
            "center" => self.column_x(self.column) + (self.column_width - width) / 2.0,
            "right" => self.column_x(self.column) + self.column_width - width,
            _ => self.column_x(self.column),
        };
        let y = self.y;
        let canvas = self.canvas();
        canvas.image(x, y, width, height, &bytes, &image.mime);
        self.y += height + 6.0;
    }

    fn draw_block(&mut self, block: &Block) {
        match block {
            Block::Paragraph { props, runs } => {
                if props.page_break_before {
                    self.next_column();
                }
                self.draw_paragraph(props, runs);
            }
            Block::Table { table } => self.draw_table(table),
            Block::Image { image, width_pt, height_pt, align, .. } => self.draw_image(image, *width_pt, *height_pt, align),
            Block::PageBreak => self.next_column(),
            Block::Rule => {
                if self.remaining() < 18.0 {
                    self.next_column();
                }
                let x = self.column_x(self.column);
                let y = self.y + 6.0;
                let width = self.column_width;
                let canvas = self.canvas();
                canvas.line(x, y, x + width, y, Rgb(148, 163, 184), 0.8, "solid");
                self.y += 14.0;
            }
            Block::Toc { entries } => {
                for entry in entries {
                    let (props, runs) = toc_entry_line(entry);
                    self.draw_paragraph(&props, &runs);
                }
            }
        }
    }
}

/// One table-of-contents line as a paragraph, dot leader included.
pub(crate) fn toc_entry_line(entry: &TocEntry) -> (ParaProps, Vec<Run>) {
    let mut props = ParaProps::default();
    props.style = format!("Toc{}", entry.level.clamp(1, 6));
    props.indent_left_pt = entry.level.saturating_sub(1) as f64 * 14.0;
    props.space_after_pt = 2.0;
    let text = if entry.page > 0 { format!("{} .... {}", entry.text, entry.page) } else { entry.text.clone() };
    (props, vec![Run { text, ..Default::default() }])
}

/// Height of a block sequence when laid out at a given width (no drawing).
fn measure_blocks(fonts: &FontSet, document: &TextDocument, blocks: &[Block], width: f64) -> f64 {
    let mut height = 0.0;
    for block in blocks {
        match block {
            Block::Paragraph { props, runs } => {
                let (words, base) = paragraph_words(document, props, runs);
                let available = (width - base.indent_left_pt - base.indent_right_pt).max(12.0);
                let spacing = if base.line_spacing > 0.0 { base.line_spacing } else { 1.15 };
                let mut block_height = base.space_before_pt;
                for segment in split_on_newlines(words) {
                    let lines = break_line(fonts, &segment, available, &base.align);
                    for line in lines {
                        block_height += line.height * spacing;
                    }
                }
                height += block_height + base.space_after_pt;
            }
            Block::Image { height_pt, width_pt, image, .. } => {
                let (pixel_width, pixel_height) = image.pixel_size();
                let aspect = if pixel_width > 0 && pixel_height > 0 { pixel_height as f64 / pixel_width as f64 } else { 0.66 };
                let mut image_height = height_pt.max(18.0);
                if *width_pt > width {
                    image_height = width * aspect;
                }
                height += image_height + 6.0;
            }
            Block::Rule => height += 14.0,
            Block::PageBreak => {}
            Block::Toc { entries } => {
                for entry in entries {
                    let (props, runs) = toc_entry_line(entry);
                    let (words, base) = paragraph_words(document, &props, &runs);
                    let available = (width - base.indent_left_pt - base.indent_right_pt).max(12.0);
                    let spacing = if base.line_spacing > 0.0 { base.line_spacing } else { 1.15 };
                    height += base.space_before_pt;
                    for segment in split_on_newlines(words) {
                        for line in break_line(fonts, &segment, available, &base.align) {
                            height += line.height * spacing;
                        }
                    }
                    height += base.space_after_pt;
                }
            }
            Block::Table { table } => {
                let columns = table.rows.iter().map(|row| row.cells.len()).max().unwrap_or(1).max(1);
                let column_width = width / columns as f64;
                for row in &table.rows {
                    let mut row_height: f64 = 12.0;
                    for cell in &row.cells {
                        row_height = row_height.max(measure_blocks(fonts, document, &cell.blocks, (column_width - 10.0).max(12.0)) + 8.0);
                    }
                    height += row_height;
                }
            }
        }
    }
    height
}

/// Draws cell blocks in an isolated canvas context (no pagination inside cells).
fn draw_blocks_in_cell(renderer: &mut Renderer<'_>, blocks: &[Block], x: f64, y: f64, width: f64) -> f64 {
    let mut cursor = y;
    for block in blocks {
        match block {
            Block::Paragraph { props, runs } => {
                let (words, base) = paragraph_words(renderer.document, props, runs);
                let available = (width - base.indent_left_pt - base.indent_right_pt).max(12.0);
                let spacing = if base.line_spacing > 0.0 { base.line_spacing } else { 1.15 };
                cursor += base.space_before_pt;
                for segment in split_on_newlines(words) {
                    let lines = break_line(renderer.fonts, &segment, available, &base.align);
                    for line in lines {
                        let left = x + base.indent_left_pt;
                        let line_x = match base.align.as_str() {
                            "center" => left + (available - line.width) / 2.0,
                            "right" => left + available - line.width,
                            _ => left,
                        };
                        let baseline = cursor + (line.height * (spacing - 1.0)) / 2.0 + line.ascent;
                        for item in &line.items {
                            let canvas = renderer.canvas();
                            canvas.text(line_x + item.dx, baseline, &item.text, &item.style);
                        }
                        cursor += line.height * spacing;
                    }
                }
                cursor += base.space_after_pt;
            }
            Block::Image { image, width_pt, height_pt, .. } => {
                let bytes = image.bytes();
                if bytes.is_empty() {
                    continue;
                }
                let image_width = width_pt.min(width).max(16.0);
                let (pixel_width, pixel_height) = image.pixel_size();
                let aspect = if pixel_width > 0 && pixel_height > 0 { pixel_height as f64 / pixel_width as f64 } else { 0.66 };
                let image_height = (height_pt * (image_width / width_pt.max(1.0))).max(12.0).min(width * aspect.max(0.1) * 4.0);
                let canvas = renderer.canvas();
                canvas.image(x, cursor, image_width, image_height, &bytes, &image.mime);
                cursor += image_height + 4.0;
            }
            Block::Rule => {
                let canvas = renderer.canvas();
                canvas.line(x, cursor + 4.0, x + width, cursor + 4.0, Rgb(148, 163, 184), 0.8, "solid");
                cursor += 10.0;
            }
            _ => {}
        }
    }
    cursor - y
}

fn render_pass(fonts: &FontSet, document: &TextDocument, total_pages: usize) -> Vec<BuiltPage> {
    let mut renderer = Renderer::new(fonts, document, total_pages);
    renderer.start_page();
    for block in &document.blocks {
        renderer.draw_block(block);
    }
    renderer.finish_page();
    renderer.pages
}

/// Renders a Writer document to PDF bytes.
pub fn document_to_pdf(document: &TextDocument) -> Vec<u8> {
    let fonts = FontSet::new();
    let mut pages = render_pass(&fonts, document, 1);
    if document.header.iter().chain(document.footer.iter()).any(contains_page_token) {
        pages = render_pass(&fonts, document, pages.len());
    }
    write_pdf(&pages, &fonts)
}

fn contains_page_token(block: &Block) -> bool {
    match block {
        Block::Paragraph { runs, .. } => runs.iter().any(|run| run.text.contains("{{page}}") || run.text.contains("{{pages}}")),
        Block::Table { table } => table.rows.iter().any(|row| row.cells.iter().any(|cell| cell.blocks.iter().any(contains_page_token))),
        _ => false,
    }
}

// ---------------------------------------------------------------------------
// Calc rendering
// ---------------------------------------------------------------------------

fn column_width_px(sheet: &Sheet, column: u32) -> f64 {
    sheet.col_widths.get(&column).copied().unwrap_or(96.0)
}

fn row_height_px(sheet: &Sheet, row: u32) -> f64 {
    sheet.row_heights.get(&row).copied().unwrap_or(22.0)
}

fn format_cell_value(value: &CellValue, sheet: &Sheet, address: &str) -> String {
    let _ = (sheet, address);
    match value {
        CellValue::Empty => String::new(),
        CellValue::Number(number) => {
            if number.fract() == 0.0 && number.abs() < 1e15 {
                format!("{}", *number as i64)
            } else {
                let text = format!("{number:.4}");
                text.trim_end_matches('0').trim_end_matches('.').to_string()
            }
        }
        CellValue::Text(text) => text.clone(),
        CellValue::Bool(value) => if *value { "TRUE" } else { "FALSE" }.to_string(),
        CellValue::Error(error) => error.clone(),
    }
}

/// Renders a workbook: every sheet becomes one or more landscape/portrait
/// pages, sliced by print area so large grids stay readable.
pub fn workbook_to_pdf(workbook: &Workbook, sheet_limit: usize) -> Vec<u8> {
    let fonts = FontSet::new();
    let mut pages: Vec<BuiltPage> = Vec::new();
    for sheet in workbook.sheets.iter().take(sheet_limit.max(1)) {
        pages.extend(render_sheet(&fonts, sheet, workbook));
    }
    if pages.is_empty() {
        let mut canvas = Canvas::new(842.0, 595.0, &fonts);
        canvas.text(40.0, 60.0, "Empty workbook", &TextStyle { size_pt: 16.0, ..Default::default() });
        pages.push(canvas.finish());
    }
    write_pdf(&pages, &fonts)
}

fn render_sheet(fonts: &FontSet, sheet: &Sheet, workbook: &Workbook) -> Vec<BuiltPage> {
    let page_width = 842.0;
    let page_height = 595.0;
    let margin = 28.0;
    let header_height = 40.0;
    let footer_height = 16.0;
    let content_top = margin + header_height;
    let content_bottom = page_height - margin - footer_height;

    // Determine the used range (bounded, keeps huge sheets printable).
    let mut max_row = 0u32;
    let mut max_col = 0u32;
    for address in sheet.cells.keys() {
        if let Some((row, column)) = crate::address::parse(address) {
            max_row = max_row.max(row);
            max_col = max_col.max(column);
        }
    }
    max_row = max_row.min(2_000);
    max_col = max_col.min(60);

    let col_widths: Vec<f64> = (0..=max_col).map(|column| column_width_px(sheet, column).min(220.0)).collect();

    // Slice columns into strips that fit the page width.
    let available_width = page_width - margin * 2.0;
    let mut strips: Vec<(u32, u32)> = Vec::new();
    let mut start = 0u32;
    let mut width = 0.0;
    for column in 0..=max_col {
        let column_width = col_widths[column as usize];
        if width + column_width > available_width && column > start {
            strips.push((start, column - 1));
            start = column;
            width = 0.0;
        }
        width += column_width;
    }
    strips.push((start, max_col));
    if strips.is_empty() {
        strips.push((0, 0));
    }

    let mut pages = Vec::new();
    for (strip_start, strip_end) in strips {
        let strip_width: f64 = (strip_start..=strip_end).map(|column| col_widths[column as usize]).sum();
        let mut row = 0u32;
        loop {
            let mut canvas = Canvas::new(page_width, page_height, fonts);
            let title_style = TextStyle { size_pt: 13.0, bold: true, ..Default::default() };
            let small = TextStyle { size_pt: 8.5, color: Rgb(90, 100, 115), ..Default::default() };
            canvas.text(margin, margin + 12.0, &sheet.name, &title_style);
            canvas.text(margin, margin + 26.0, &format!("{} | columns {}-{}", workbook.title, crate::address::column_name(strip_start), crate::address::column_name(strip_end)), &small);

            // Column headers.
            let mut x = margin;
            let header_style = TextStyle { size_pt: 8.5, bold: true, color: Rgb(60, 70, 85), ..Default::default() };
            canvas.fill_rect(margin, content_top - 14.0, strip_width, 14.0, Rgb(241, 245, 249), 1.0);
            for column in strip_start..=strip_end {
                let width = col_widths[column as usize];
                canvas.text(x + 3.0, content_top - 3.0, &crate::address::column_name(column), &header_style);
                x += width;
            }

            let mut y = content_top;
            let mut last_row = row;
            while y + row_height_px(sheet, last_row) <= content_bottom && last_row <= max_row {
                let row_height = row_height_px(sheet, last_row);
                let mut x = margin;
                if last_row % 2 == 1 {
                    canvas.fill_rect(margin, y, strip_width, row_height, Rgb(248, 250, 252), 1.0);
                }
                let row_label_style = TextStyle { size_pt: 8.0, color: Rgb(100, 116, 139), ..Default::default() };
                canvas.text(margin - 20.0, y + row_height * 0.65, &(last_row + 1).to_string(), &row_label_style);
                for column in strip_start..=strip_end {
                    let width = col_widths[column as usize];
                    let address = crate::address::format(last_row, column);
                    if let Some(cell) = sheet.cells.get(&address) {
                        let text = format_cell_value(&cell.value, sheet, &address);
                        if !text.is_empty() {
                            let bold = cell.style.bold;
                            let color = cell.style.color.as_deref().and_then(parse_hex).unwrap_or(Rgb::BLACK);
                            let style = TextStyle { size_pt: cell.style.size_pt.unwrap_or(9.0), bold, color, ..Default::default() };
                            let text_width = fonts.pick(bold).advance_pt(&text, style.size_pt);
                            let text_x = match cell.style.align.as_str() {
                                "center" => x + (width - text_width) / 2.0,
                                "right" => x + width - text_width - 3.0,
                                _ => x + 3.0,
                            };
                            canvas.text(text_x, y + row_height * 0.68, &truncate_to_width(fonts, &text, &style, width - 6.0), &style);
                        }
                        if let Some(fill) = cell.style.fill.as_deref().and_then(parse_hex) {
                            // Draw fills behind text: repaint for cells with a fill.
                            if text.is_empty() {
                                canvas.fill_rect(x, y, width, row_height, fill, 1.0);
                            }
                        }
                    }
                    x += width;
                }
                y += row_height;
                last_row += 1;
            }
            canvas.text(page_width - margin - 60.0, page_height - margin, &format!("Page {}", pages.len() + 1), &small);
            pages.push(canvas.finish());
            if last_row > max_row {
                break;
            }
            row = last_row;
        }
    }
    pages
}

fn truncate_to_width(fonts: &FontSet, text: &str, style: &TextStyle, width: f64) -> String {
    if fonts.pick(style.bold).advance_pt(text, style.size_pt) <= width {
        return text.to_string();
    }
    let mut out = String::new();
    for ch in text.chars() {
        let candidate = format!("{out}{ch}");
        if fonts.pick(style.bold).advance_pt(&candidate, style.size_pt) > width - 8.0 {
            break;
        }
        out.push(ch);
    }
    out.push('…');
    out
}

// ---------------------------------------------------------------------------
// Impress rendering
// ---------------------------------------------------------------------------

pub fn deck_to_pdf(deck: &Deck) -> Vec<u8> {
    let fonts = FontSet::new();
    let width = deck.size.width_pt.max(200.0);
    let height = deck.size.height_pt.max(150.0);
    let mut pages = Vec::new();
    for slide in &deck.slides {
        let mut canvas = Canvas::new(width, height, &fonts);
        let background = slide
            .background
            .as_deref()
            .and_then(parse_hex)
            .unwrap_or_else(|| theme_background(deck, slide));
        canvas.fill_rect(0.0, 0.0, width, height, background, 1.0);
        let mut objects: Vec<&SlideObject> = slide.objects.iter().collect();
        objects.sort_by_key(|object| object.z);
        for object in objects {
            draw_slide_object(&mut canvas, object, height, &fonts);
        }
        pages.push(canvas.finish());
    }
    if pages.is_empty() {
        let mut canvas = Canvas::new(width, height, &fonts);
        canvas.text(40.0, 60.0, "Empty presentation", &TextStyle { size_pt: 18.0, ..Default::default() });
        pages.push(canvas.finish());
    }
    write_pdf(&pages, &fonts)
}

fn theme_background(deck: &Deck, slide: &Slide) -> Rgb {
    let _ = slide;
    match deck.theme.as_str() {
        "dark" => Rgb(15, 23, 42),
        "business" => Rgb(248, 250, 252),
        "modern" => Rgb(255, 255, 255),
        "education" => Rgb(254, 252, 232),
        _ => Rgb(255, 255, 255),
    }
}

fn draw_slide_object(canvas: &mut Canvas<'_>, object: &SlideObject, slide_height: f64, fonts: &FontSet) {
    let style = object.style.clone().unwrap_or_default();
    let fill = style.fill.as_deref().and_then(parse_hex);
    let stroke = style.stroke.as_deref().and_then(parse_hex).map(|color| (color, style.stroke_width_pt.max(0.5)));
    let opacity = if style.opacity > 0.0 { style.opacity } else { 1.0 };
    canvas.save();
    if object.rotation.abs() > 0.01 {
        let cx = object.x + object.w / 2.0;
        let cy = object.y + object.h / 2.0;
        let radians = object.rotation.to_radians();
        let (sin, cos) = radians.sin_cos();
        let (px, py) = (cx, slide_height - cy);
        canvas.page.ops.push_str(&format!(
            "q\n{:.5} {:.5} {:.5} {:.5} {:.2} {:.2} cm\n",
            cos,
            sin,
            -sin,
            cos,
            px - cos * px + sin * py,
            py - sin * px - cos * py
        ));
    }
    match object.kind.as_str() {
        "ellipse" => canvas.ellipse(object.x, object.y, object.w, object.h, fill, stroke),
        "line" | "arrow" => {
            let line = object.line.clone().unwrap_or_default();
            let color = fill.or(stroke.map(|(color, _)| color)).unwrap_or(Rgb(30, 41, 59));
            let width = if style.stroke_width_pt > 0.0 { style.stroke_width_pt } else { 2.0 };
            let x2 = object.x + line.x2;
            let y2 = object.y + line.y2;
            canvas.line(object.x, object.y, x2, y2, color, width, &line.dash);
            if line.end_arrow {
                draw_arrow_head(canvas, object.x, object.y, x2, y2, color, width);
            }
            if line.begin_arrow {
                draw_arrow_head(canvas, x2, y2, object.x, object.y, color, width);
            }
        }
        "rect" => {
            if style.corner_radius_pt > 0.5 {
                canvas.rounded_rect(object.x, object.y, object.w, object.h, style.corner_radius_pt, fill, stroke);
            } else if fill.is_some() || stroke.is_some() {
                if let Some(color) = fill {
                    canvas.fill_rect(object.x, object.y, object.w, object.h, color, opacity);
                }
                if let Some((color, width)) = stroke {
                    canvas.stroke_rect(object.x, object.y, object.w, object.h, color, width);
                }
            }
        }
        "image" => {
            if let Some(image) = &object.image {
                let bytes = image.bytes();
                if !bytes.is_empty() {
                    canvas.image(object.x, object.y, object.w, object.h, &bytes, &image.mime);
                }
            }
        }
        "table" => {
            if let Some(table) = &object.table {
                draw_slide_table(canvas, object, table, fonts);
            }
        }
        "chart" => {
            if let Some(chart) = &object.chart {
                draw_slide_chart(canvas, object, chart, fonts);
            }
        }
        _ => {}
    }
    if let Some(frame) = &object.text {
        draw_text_frame(canvas, object, frame, fonts);
    }
    if object.rotation.abs() > 0.01 {
        canvas.page.ops.push_str("Q\n");
    }
    canvas.restore();
}

fn draw_arrow_head(canvas: &mut Canvas<'_>, x1: f64, y1: f64, x2: f64, y2: f64, color: Rgb, width: f64) {
    let angle = (y2 - y1).atan2(x2 - x1);
    let size = (width * 4.0).max(6.0);
    let left = (x2 - angle.cos() * size + angle.sin() * size * 0.5, y2 - angle.sin() * size - angle.cos() * size * 0.5);
    let right = (x2 - angle.cos() * size - angle.sin() * size * 0.5, y2 - angle.sin() * size + angle.cos() * size * 0.5);
    canvas.polygon(&[(x2, y2), left, right], Some(color), None);
}

fn draw_text_frame(canvas: &mut Canvas<'_>, object: &SlideObject, frame: &TextFrame, fonts: &FontSet) {
    let padding = 6.0;
    let align = if frame.align.is_empty() { "left" } else { frame.align.as_str() };
    let valign = if frame.valign.is_empty() { "top" } else { frame.valign.as_str() };
    let mut lines: Vec<(String, TextStyle, f64)> = Vec::new();
    for paragraph in &frame.paragraphs {
        let size = paragraph.size_pt.or(frame.size_pt).unwrap_or(16.0);
        let bold = paragraph.bold;
        let color = paragraph.color.as_deref().and_then(parse_hex).or_else(|| frame.color.as_deref().and_then(parse_hex)).unwrap_or(Rgb::BLACK);
        let style = TextStyle { size_pt: size, bold, italic: paragraph.italic, underline: paragraph.underline, color, ..Default::default() };
        let face = fonts.pick(bold);
        let bullet = if paragraph.bullet { if paragraph.bullet && !paragraph.text.starts_with('•') { "• " } else { "" } } else { "" };
        let text = format!("{bullet}{}", paragraph.text);
        let line_height = face.line_height_pt(size, 1.2);
        if text.is_empty() {
            lines.push((String::new(), style, line_height));
            continue;
        }
        let available = (object.w - padding * 2.0).max(20.0);
        let mut current = String::new();
        let mut current_width = 0.0;
        for word in text.split_whitespace() {
            let word_width = face.advance_pt(word, size) + face.advance_pt(" ", size);
            if current_width + word_width > available && !current.is_empty() {
                lines.push((std::mem::take(&mut current), style.clone(), line_height));
                current_width = 0.0;
            }
            current.push_str(word);
            current.push(' ');
            current_width += word_width;
        }
        lines.push((current.trim_end().to_string(), style, line_height));
    }
    let total_height: f64 = lines.iter().map(|(_, _, height)| *height).sum();
    let start_y = match valign {
        "middle" => object.y + (object.h - total_height) / 2.0,
        "bottom" => object.y + object.h - total_height - padding,
        _ => object.y + padding,
    };
    let mut y = start_y;
    for (text, style, line_height) in lines {
        if text.is_empty() {
            y += line_height;
            continue;
        }
        let width = fonts.pick(style.bold).advance_pt(&text, style.size_pt);
        let x = match align {
            "center" => object.x + (object.w - width) / 2.0,
            "right" => object.x + object.w - width - padding,
            _ => object.x + padding,
        };
        canvas.text(x, y + style.size_pt, &text, &style);
        y += line_height;
    }
}

fn draw_slide_table(canvas: &mut Canvas<'_>, object: &SlideObject, table: &TableData, fonts: &FontSet) {
    let rows = table.rows.len().max(1);
    let columns = table.rows.iter().map(|row| row.cells.len()).max().unwrap_or(1).max(1);
    let cell_width = object.w / columns as f64;
    let cell_height = object.h / rows as f64;
    for (row_index, row) in table.rows.iter().enumerate() {
        for (column_index, cell) in row.cells.iter().enumerate() {
            let x = object.x + cell_width * column_index as f64;
            let y = object.y + cell_height * row_index as f64;
            if let Some(background) = cell.background.as_deref().and_then(parse_hex) {
                canvas.fill_rect(x, y, cell_width, cell_height, background, 1.0);
            }
            canvas.stroke_rect(x, y, cell_width, cell_height, Rgb(148, 163, 184), 0.7);
            let text = cell.blocks.iter().map(Block::plain_text).collect::<Vec<_>>().join(" ");
            let style = TextStyle { size_pt: 12.0, ..Default::default() };
            let truncated = truncate_to_width(fonts, &text, &style, cell_width - 10.0);
            canvas.text(x + 5.0, y + cell_height / 2.0 + 4.0, &truncated, &style);
        }
    }
}

fn draw_slide_chart(canvas: &mut Canvas<'_>, object: &SlideObject, chart: &ChartData, fonts: &FontSet) {
    let title_style = TextStyle { size_pt: 12.0, bold: true, ..Default::default() };
    canvas.text(object.x, object.y + 12.0, &chart.title, &title_style);
    let plot_x = object.x;
    let plot_y = object.y + 20.0;
    let plot_w = object.w;
    let plot_h = (object.h - 20.0).max(20.0);
    canvas.stroke_rect(plot_x, plot_y, plot_w, plot_h, Rgb(203, 213, 225), 0.6);
    // Charts from spreadsheets are resolved by the UI; here we draw a labelled
    // placeholder that makes the data range explicit and never fakes values.
    let note = format!("{} chart · {}", chart.kind, if chart.series.is_empty() { "no series".to_string() } else { chart.series.iter().map(|series| series.range.clone()).collect::<Vec<_>>().join(", ") });
    let note_style = TextStyle { size_pt: 9.5, color: Rgb(100, 116, 139), ..Default::default() };
    let wrapped = truncate_to_width(fonts, &note, &note_style, plot_w - 12.0);
    canvas.text(plot_x + 6.0, plot_y + plot_h / 2.0, &wrapped, &note_style);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_document() -> TextDocument {
        let mut document = TextDocument::new_blank("Layout");
        document.blocks = vec![
            Block::heading("Heading", 1),
            Block::paragraph("A paragraph with enough words to wrap across at least two lines when the column is narrow."),
            Block::Paragraph {
                props: ParaProps { list: Some(ListInfo { kind: "bullet".into(), level: 0, start: 1, marker: "•".into() }), ..Default::default() },
                runs: vec![Run { text: "item one".into(), ..Default::default() }],
            },
            Block::Table { table: TableData::simple(3, 3, 460.0) },
            Block::PageBreak,
            Block::paragraph("Second page"),
        ];
        document.footer = vec![Block::Paragraph {
            props: ParaProps { align: "center".into(), ..Default::default() },
            runs: vec![Run { text: "Page {{page}} / {{pages}}".into(), ..Default::default() }],
        }];
        document
    }

    #[test]
    fn document_pdf_is_valid() {
        let bytes = document_to_pdf(&sample_document());
        assert!(bytes.starts_with(b"%PDF"));
        assert!(bytes.windows(5).any(|window| window == b"%%EOF"));
        assert!(bytes.len() > 3000);
    }

    #[test]
    fn multi_column_documents_render() {
        let mut document = TextDocument::new_blank("Columns");
        document.page.columns = 2;
        document.blocks = vec![Block::paragraph(&"word ".repeat(300))];
        let bytes = document_to_pdf(&document);
        assert!(bytes.starts_with(b"%PDF"));
    }

    #[test]
    fn workbook_pdf_is_valid() {
        let mut workbook = Workbook::new_blank("Budget");
        let sheet = &mut workbook.sheets[0];
        for row in 0..40u32 {
            crate::address::format(row, 0);
            sheet.set(&crate::address::format(row, 0), Cell { value: CellValue::Text(format!("Row {row}")), ..Default::default() });
            sheet.set(&crate::address::format(row, 1), Cell { value: CellValue::Number(row as f64 * 12.5), ..Default::default() });
        }
        let bytes = workbook_to_pdf(&workbook, 1);
        assert!(bytes.starts_with(b"%PDF"));
    }

    #[test]
    fn deck_pdf_is_valid() {
        let mut deck = Deck::new_blank("Deck");
        let mut slide = Slide::default();
        let mut object = SlideObject::new("rect", 40.0, 40.0, 300.0, 120.0);
        object.style = Some(ShapeStyle { fill: Some("#1D4ED8".into()), ..Default::default() });
        let mut text = SlideObject::new("text", 60.0, 60.0, 400.0, 120.0);
        text.text = Some(TextFrame {
            paragraphs: vec![TextParagraph { text: "Hello slides".into(), size_pt: Some(28.0), ..Default::default() }],
            ..Default::default()
        });
        slide.objects = vec![object, text];
        deck.slides = vec![slide];
        let bytes = deck_to_pdf(&deck);
        assert!(bytes.starts_with(b"%PDF"));
    }
}
