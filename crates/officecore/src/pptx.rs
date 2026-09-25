//! PresentationML (PPTX) import and export.
//!
//! The writer emits a complete, valid package (master, layout, theme, slides,
//! notes, media) so PowerPoint, LibreOffice and OnlyOffice open it natively.
//! The reader extracts text boxes, pictures, shapes, tables, notes and slide
//! size, skipping animations/SmartArt with a warning.

use crate::error::{OfficeError, OfficeResult};
use crate::model::*;
use crate::xml::{escape_attr, escape_text, parse_xml, XmlNode};
use crate::zip::{ZipReader, ZipWriter};
use std::collections::HashMap;
use std::path::Path;

const NS: &str = concat!(
    "xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" ",
    "xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" ",
    "xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\""
);

fn emu(points: f64) -> i64 {
    (points * 12700.0).round() as i64
}

fn pt_from_emu(value: f64) -> f64 {
    value / 12700.0
}

#[derive(Debug, Clone)]
pub struct DeckRead {
    pub deck: Deck,
    pub warnings: Vec<String>,
}

// ---------------------------------------------------------------------------
// Theme catalogue
// ---------------------------------------------------------------------------

struct Theme {
    name: &'static str,
    dk1: &'static str,
    lt1: &'static str,
    dk2: &'static str,
    lt2: &'static str,
    accents: [&'static str; 6],
    heading_font: &'static str,
    body_font: &'static str,
}

fn theme_for(name: &str) -> Theme {
    match name {
        "business" => Theme {
            name: "Business",
            dk1: "1F2937",
            lt1: "FFFFFF",
            dk2: "111827",
            lt2: "F3F4F6",
            accents: ["1D4ED8", "0E7490", "B45309", "15803D", "7C3AED", "BE123C"],
            heading_font: "Segoe UI",
            body_font: "Segoe UI",
        },
        "dark" => Theme {
            name: "Dark",
            dk1: "F8FAFC",
            lt1: "0F172A",
            dk2: "E2E8F0",
            lt2: "1E293B",
            accents: ["60A5FA", "34D399", "FBBF24", "F472B6", "A78BFA", "22D3EE"],
            heading_font: "Segoe UI",
            body_font: "Segoe UI",
        },
        "modern" => Theme {
            name: "Modern",
            dk1: "0B1220",
            lt1: "FFFFFF",
            dk2: "334155",
            lt2: "E2E8F0",
            accents: ["2563EB", "14B8A6", "F97316", "8B5CF6", "EC4899", "10B981"],
            heading_font: "Segoe UI",
            body_font: "Segoe UI",
        },
        "education" => Theme {
            name: "Education",
            dk1: "1E293B",
            lt1: "FFFDF5",
            dk2: "334155",
            lt2: "FEF3C7",
            accents: ["B45309", "0369A1", "15803D", "7C2D12", "6D28D9", "0F766E"],
            heading_font: "Georgia",
            body_font: "Georgia",
        },
        "simple" => Theme {
            name: "Simple",
            dk1: "111111",
            lt1: "FFFFFF",
            dk2: "444444",
            lt2: "F2F2F2",
            accents: ["444444", "666666", "888888", "B0B0B0", "D0D0D0", "9A9A9A"],
            heading_font: "Arial",
            body_font: "Arial",
        },
        _ => Theme {
            name: "Minimal",
            dk1: "111827",
            lt1: "FFFFFF",
            dk2: "374151",
            lt2: "F9FAFB",
            accents: ["2563EB", "059669", "D97706", "DC2626", "7C3AED", "0891B2"],
            heading_font: "Segoe UI",
            body_font: "Segoe UI",
        },
    }
}

fn theme_xml(theme: &Theme) -> String {
    let accents = theme.accents;
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="{name}"><a:themeElements>
<a:clrScheme name="{name}"><a:dk1><a:srgbClr val="{dk1}"/></a:dk1><a:lt1><a:srgbClr val="{lt1}"/></a:lt1><a:dk2><a:srgbClr val="{dk2}"/></a:dk2><a:lt2><a:srgbClr val="{lt2}"/></a:lt2>
<a:accent1><a:srgbClr val="{a1}"/></a:accent1><a:accent2><a:srgbClr val="{a2}"/></a:accent2><a:accent3><a:srgbClr val="{a3}"/></a:accent3><a:accent4><a:srgbClr val="{a4}"/></a:accent4><a:accent5><a:srgbClr val="{a5}"/></a:accent5><a:accent6><a:srgbClr val="{a6}"/></a:accent6>
<a:hlink><a:srgbClr val="{a1}"/></a:hlink><a:folHlink><a:srgbClr val="{a5}"/></a:folHlink></a:clrScheme>
<a:fontScheme name="{name}"><a:majorFont><a:latin typeface="{heading}"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="{body}"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>
<a:fmtScheme name="{name}"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:lumMod val="110000"/><a:satMod val="105000"/><a:tint val="67000"/></a:schemeClr></a:gs><a:gs pos="50000"><a:schemeClr val="phClr"><a:lumMod val="105000"/><a:satMod val="103000"/><a:tint val="73000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:lumMod val="105000"/><a:satMod val="109000"/><a:tint val="81000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:satMod val="103000"/><a:lumMod val="102000"/><a:tint val="94000"/></a:schemeClr></a:gs><a:gs pos="50000"><a:schemeClr val="phClr"><a:satMod val="110000"/><a:lumMod val="100000"/><a:shade val="100000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:lumMod val="99000"/><a:satMod val="120000"/><a:shade val="78000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill></a:fillStyleLst>
<a:lnStyleLst><a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln><a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln><a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln></a:lnStyleLst>
<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>
<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:tint val="95000"/><a:satMod val="170000"/></a:schemeClr></a:solidFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="93000"/><a:satMod val="150000"/><a:shade val="98000"/><a:lumMod val="102000"/></a:schemeClr></a:gs><a:gs pos="50000"><a:schemeClr val="phClr"><a:tint val="98000"/><a:satMod val="130000"/><a:shade val="90000"/><a:lumMod val="103000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:shade val="63000"/><a:satMod val="120000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>"#,
        name = theme.name,
        dk1 = theme.dk1,
        lt1 = theme.lt1,
        dk2 = theme.dk2,
        lt2 = theme.lt2,
        a1 = accents[0],
        a2 = accents[1],
        a3 = accents[2],
        a4 = accents[3],
        a5 = accents[4],
        a6 = accents[5],
        heading = theme.heading_font,
        body = theme.body_font
    )
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

struct RelSet {
    next: usize,
    entries: Vec<(String, String, String)>,
}

impl RelSet {
    fn new() -> Self {
        Self { next: 1, entries: Vec::new() }
    }

    fn add(&mut self, kind: &str, target: &str) -> String {
        let id = format!("rId{}", self.next);
        self.next += 1;
        self.entries.push((id.clone(), kind.to_string(), target.to_string()));
        id
    }

    fn xml(&self) -> String {
        let mut out = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">");
        for (id, kind, target) in &self.entries {
            out.push_str(&format!("<Relationship Id=\"{id}\" Type=\"{kind}\" Target=\"{}\"/>", escape_attr(target)));
        }
        out.push_str("</Relationships>");
        out
    }
}

const REL_SLIDE: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide";
const REL_LAYOUT: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout";
const REL_IMAGE: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";
const REL_NOTES: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide";
const REL_MASTER: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster";
const REL_THEME: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme";

fn presentation_xml(deck: &Deck, slide_ids: &[String]) -> String {
    let mut out = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<p:presentation {NS} saveSubsetFonts=\"1\"><p:sldMasterIdLst><p:sldMasterId id=\"2147483648\" r:id=\"rId1\"/></p:sldMasterIdLst><p:sldIdLst>"
    );
    let mut next_id = 256u32;
    for rid in slide_ids {
        out.push_str(&format!("<p:sldId id=\"{next_id}\" r:id=\"{rid}\"/>"));
        next_id += 1;
    }
    out.push_str("</p:sldIdLst>");
    out.push_str(&format!(
        "<p:sldSz cx=\"{}\" cy=\"{}\"/><p:notesSz cx=\"6858000\" cy=\"9144000\"/></p:presentation>",
        emu(deck.size.width_pt.max(200.0)),
        emu(deck.size.height_pt.max(150.0))
    ));
    out
}

fn master_xml(theme: &Theme, background: &str) -> String {
    let _ = theme;
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<p:sldMaster {NS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val=\"{background}\"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMap bg1=\"lt1\" tx1=\"dk1\" bg2=\"lt2\" tx2=\"dk2\" accent1=\"accent1\" accent2=\"accent2\" accent3=\"accent3\" accent4=\"accent4\" accent5=\"accent5\" accent6=\"accent6\" hlink=\"hlink\" folHlink=\"folHlink\"/><p:sldLayoutIdLst><p:sldLayoutId id=\"2147483649\" r:id=\"rId1\"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>"
    )
}

fn layout_xml(background: &str) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<p:sldLayout {NS} type=\"blank\" preserve=\"1\"><p:cSld name=\"Blank\"><p:bg><p:bgPr><a:solidFill><a:srgbClr val=\"{background}\"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>"
    )
}

struct SlideWriter {
    rels: RelSet,
    media: Vec<(String, Vec<u8>)>,
    next_shape: usize,
}

impl SlideWriter {
    fn new() -> Self {
        Self { rels: RelSet::new(), media: Vec::new(), next_shape: 1 }
    }

    fn shape_id(&mut self) -> usize {
        self.next_shape += 1;
        self.next_shape
    }

    fn transform(x: f64, y: f64, w: f64, h: f64, rotation: f64) -> String {
        let rotation_attr = if rotation.abs() > 0.01 { format!(" rot=\"{}\"", (rotation * 60000.0).round() as i64) } else { String::new() };
        format!(
            "<a:xfrm{rotation_attr}><a:off x=\"{}\" y=\"{}\"/><a:ext cx=\"{}\" cy=\"{}\"/></a:xfrm>",
            emu(x.max(-100000.0)),
            emu(y.max(-100000.0)),
            emu(w.max(4.0)),
            emu(h.max(4.0))
        )
    }

    fn fill(stroke: &Option<(String, f64)>, fill: &Option<String>) -> String {
        let mut out = String::new();
        match fill {
            Some(color) => out.push_str(&format!("<a:solidFill><a:srgbClr val=\"{}\"/></a:solidFill>", escape_attr(color.trim_start_matches('#')))),
            None => out.push_str("<a:noFill/>"),
        }
        match stroke {
            Some((color, width)) => out.push_str(&format!(
                "<a:ln w=\"{}\"><a:solidFill><a:srgbClr val=\"{}\"/></a:solidFill><a:prstDash val=\"solid\"/></a:ln>",
                (width * 12700.0).round() as i64,
                escape_attr(color.trim_start_matches('#'))
            )),
            None => {}
        }
        out
    }

    fn text_body(text: &TextFrame, theme: &Theme) -> String {
        let default_size = text.size_pt.unwrap_or(18.0);
        let mut out = String::from("<p:txBody><a:bodyPr wrap=\"square\" rtlCol=\"0\"><a:normAutofit/></a:bodyPr><a:lstStyle/>");
        if text.paragraphs.is_empty() {
            out.push_str("<a:p/>");
        }
        for paragraph in &text.paragraphs {
            let size = paragraph.size_pt.unwrap_or(default_size);
            let bullet = if paragraph.bullet { "<a:buChar char=\"Ã¢â‚¬Â¢\"/>" } else { "<a:buNone/>" };
            out.push_str(&format!("<a:p><a:pPr lvl=\"{}\" algn=\"{}\">{bullet}</a:pPr>", paragraph.level.min(8), alignment(if paragraph.align.is_empty() { &text.align } else { &paragraph.align })));
            if paragraph.runs.is_empty() {
                let mut attributes = format!(" lang=\"tr-TR\" sz=\"{}\"", (size * 100.0).round() as i64);
                if paragraph.bold {
                    attributes.push_str(" b=\"1\"");
                }
                if paragraph.italic {
                    attributes.push_str(" i=\"1\"");
                }
                if paragraph.underline {
                    attributes.push_str(" u=\"sng\"");
                }
                if let Some(color) = paragraph.color.as_deref().or(text.color.as_deref()) {
                    attributes.push_str(&format!("><a:solidFill><a:srgbClr val=\"{}\"/></a:solidFill>", escape_attr(color.trim_start_matches('#'))));
                } else {
                    attributes.push('>');
                }
                out.push_str(&format!(
                    "<a:r><a:rPr{attributes}<a:latin typeface=\"{}\"/><a:cs typeface=\"{}\"/></a:rPr><a:t>{}</a:t></a:r>",
                    escape_attr(text.font.as_deref().unwrap_or(theme.body_font)),
                    escape_attr(theme.body_font),
                    escape_text(&paragraph.text)
                ));
            } else {
                for run in &paragraph.runs {
                    let mut attributes = format!(" lang=\"tr-TR\" sz=\"{}\"", (run.size_pt.unwrap_or(size) * 100.0).round() as i64);
                    if run.bold || paragraph.bold {
                        attributes.push_str(" b=\"1\"");
                    }
                    if run.italic || paragraph.italic {
                        attributes.push_str(" i=\"1\"");
                    }
                    if run.underline || paragraph.underline {
                        attributes.push_str(" u=\"sng\"");
                    }
                    if let Some(color) = run.color.as_deref().or(paragraph.color.as_deref()).or(text.color.as_deref()) {
                        attributes.push_str(&format!("><a:solidFill><a:srgbClr val=\"{}\"/></a:solidFill>", escape_attr(color.trim_start_matches('#'))));
                    } else {
                        attributes.push('>');
                    }
                    out.push_str(&format!("<a:r><a:rPr{attributes}<a:latin typeface=\"{}\"/><a:cs typeface=\"{}\"/></a:rPr><a:t>{}</a:t></a:r>", escape_attr(run.font.as_deref().or(text.font.as_deref()).unwrap_or(theme.body_font)), escape_attr(theme.body_font), escape_text(&run.text)));
                }
            }
            out.push_str("</a:p>");
        }
        out.push_str("</p:txBody>");
        out
    }

}

fn alignment(value: &str) -> &'static str {
    match value {
        "center" => "ctr",
        "right" => "r",
        _ => "l",
    }
}

fn object_xml(object: &SlideObject, theme: &Theme, writer: &mut SlideWriter) -> String {
    let style = object.style.clone().unwrap_or_default();
    let fill = style.fill.as_deref().map(str::to_string);
    let stroke = style.stroke.as_deref().map(|color| (color.to_string(), style.stroke_width_pt.max(0.5)));
    let name = if object.name.is_empty() { format!("{} {}", object.kind, object.id) } else { object.name.clone() };
    let id = writer.shape_id();
    match object.kind.as_str() {
        "image" => {
            let Some(image) = &object.image else { return String::new() };
            if image.is_empty() {
                return String::new();
            }
            let mut resolved = None;
            for (name, _) in &writer.media {
                if name == &image.name {
                    resolved = Some(name.clone());
                }
            }
            let part_name = resolved.unwrap_or_else(|| {
                let name = format!("image{}.{}", writer.media.len() + 1, image.extension());
                writer.media.push((name.clone(), image.bytes()));
                name
            });
            let rid = writer.rels.add(REL_IMAGE, &format!("../media/{part_name}"));
            format!(
                "<p:pic><p:nvPicPr><p:cNvPr id=\"{id}\" name=\"{}\"/><p:cNvPicPr><a:picLocks noChangeAspect=\"1\"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed=\"{rid}\"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>{}</p:spPr></p:pic>",
                escape_attr(&name),
                SlideWriter::transform(object.x, object.y, object.w, object.h, object.rotation)
            )
        }
        "line" | "arrow" => {
            let line = object.line.clone().unwrap_or_default();
            let color = fill
                .clone()
                .or_else(|| stroke.as_ref().map(|(color, _)| color.clone()))
                .unwrap_or_else(|| theme.accents[0].to_string());
            let width = if style.stroke_width_pt > 0.0 { style.stroke_width_pt } else { 2.0 };
            let mut ends = String::new();
            if line.begin_arrow {
                ends.push_str("<a:headEnd type=\"triangle\"/>");
            }
            if line.end_arrow {
                ends.push_str("<a:tailEnd type=\"triangle\"/>");
            }
            let (dx, dy) = (line.x2, line.y2);
            let off_x = if dx >= 0.0 { object.x } else { object.x + dx };
            let off_y = if dy >= 0.0 { object.y } else { object.y + dy };
            let flips = format!(
                "{}{}",
                if dx < 0.0 { " flipH=\"1\"" } else { "" },
                if dy < 0.0 { " flipV=\"1\"" } else { "" }
            );
            format!(
                "<p:cxnSp><p:nvCxnSpPr><p:cNvPr id=\"{id}\" name=\"{}\"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr><a:xfrm{flips}><a:off x=\"{}\" y=\"{}\"/><a:ext cx=\"{}\" cy=\"{}\"/></a:xfrm><a:prstGeom prst=\"line\"><a:avLst/></a:prstGeom><a:ln w=\"{}\"><a:solidFill><a:srgbClr val=\"{}\"/></a:solidFill><a:prstDash val=\"{}\"/>{ends}</a:ln></p:spPr></p:cxnSp>",
                escape_attr(&name),
                emu(off_x),
                emu(off_y),
                emu(dx.abs().max(1.0)),
                emu(dy.abs().max(1.0)),
                (width * 12700.0).round() as i64,
                escape_attr(color.trim_start_matches('#')),
                if line.dash.is_empty() || line.dash == "solid" { "solid" } else { &line.dash }
            )
        }
        "table" => {
            let Some(table) = &object.table else { return String::new() };
            let rows = table.rows.len().max(1);
            let columns = table.rows.iter().map(|row| row.cells.len()).max().unwrap_or(1).max(1);
            let cell_width = emu(object.w / columns as f64);
            let cell_height = emu(object.h / rows as f64);
            let mut grid = String::new();
            for _ in 0..columns {
                grid.push_str(&format!("<a:gridCol w=\"{cell_width}\"/>"));
            }
            let mut table_rows = String::new();
            for row in &table.rows {
                table_rows.push_str(&format!("<a:tr h=\"{cell_height}\">"));
                for cell in &row.cells {
                    let text = cell.blocks.iter().map(Block::plain_text).collect::<Vec<_>>().join(" ");
                    let fill_xml = cell
                        .background
                        .as_deref()
                        .map(|color| format!("<a:solidFill><a:srgbClr val=\"{}\"/></a:solidFill>", escape_attr(color.trim_start_matches('#'))))
                        .unwrap_or_else(|| "<a:solidFill><a:srgbClr val=\"FFFFFF\"/></a:solidFill>".into());
                    table_rows.push_str(&format!(
                        "<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang=\"tr-TR\" sz=\"1200\"/><a:t>{}</a:t></a:r></a:p></a:txBody><a:tcPr>{fill_xml}<a:lnL w=\"6350\"><a:solidFill><a:srgbClr val=\"94A3B8\"/></a:solidFill></a:lnL><a:lnR w=\"6350\"><a:solidFill><a:srgbClr val=\"94A3B8\"/></a:solidFill></a:lnR><a:lnT w=\"6350\"><a:solidFill><a:srgbClr val=\"94A3B8\"/></a:solidFill></a:lnT><a:lnB w=\"6350\"><a:solidFill><a:srgbClr val=\"94A3B8\"/></a:solidFill></a:lnB></a:tcPr></a:tc>",
                        escape_text(&text)
                    ));
                }
                table_rows.push_str("</a:tr>");
            }
            format!(
                "<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id=\"{id}\" name=\"{}\"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm>{}</p:xfrm><a:graphic><a:graphicData uri=\"http://schemas.openxmlformats.org/drawingml/2006/table\"><a:tbl><a:tblPr firstRow=\"1\" bandRow=\"1\"/><a:tblGrid>{grid}</a:tblGrid>{table_rows}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>",
                escape_attr(&name),
                SlideWriter::transform(object.x, object.y, object.w, object.h, object.rotation)
            )
        }
        _ => {
            let preset = match object.kind.as_str() {
                "ellipse" => "ellipse",
                "roundRect" => "roundRect",
                _ => "rect",
            };
            let mut body = String::new();
            body.push_str("<p:nvSpPr>");
            body.push_str(&format!("<p:cNvPr id=\"{id}\" name=\"{}\"/>", escape_attr(&name)));
            body.push_str("<p:cNvSpPr/><p:nvPr/></p:nvSpPr>");
            body.push_str(&format!("<p:spPr>{}<a:prstGeom prst=\"{preset}\"><a:avLst/></a:prstGeom>{}</p:spPr>", SlideWriter::transform(object.x, object.y, object.w, object.h, object.rotation), SlideWriter::fill(&stroke, &fill)));
            if let Some(text) = &object.text {
                body.push_str(&SlideWriter::text_body(text, theme));
            } else {
                body.push_str("<p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody>");
            }
            format!("<p:sp>{body}</p:sp>")
        }
    }
}

fn slide_xml(slide: &Slide, theme: &Theme, writer: &mut SlideWriter) -> String {
    let background = slide.background.as_deref().unwrap_or(theme.lt1);
    let mut shapes = String::new();
    let mut objects: Vec<&SlideObject> = slide.objects.iter().collect();
    objects.sort_by_key(|object| object.z);
    for object in objects {
        shapes.push_str(&object_xml(object, theme, writer));
    }
    let mut background_xml = String::new();
    if slide.background.is_some() {
        background_xml = format!(
            "<p:bg><p:bgPr><a:solidFill><a:srgbClr val=\"{}\"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>",
            escape_attr(background.trim_start_matches('#'))
        );
    }
    let transition = match slide.transition.as_deref() {
        Some("fade") => "<p:transition spd=\"med\"><p:fade/></p:transition>".to_string(),
        Some("push") => "<p:transition spd=\"med\"><p:push dir=\"l\"/></p:transition>".to_string(),
        Some("wipe") => "<p:transition spd=\"med\"><p:wipe dir=\"l\"/></p:transition>".to_string(),
        Some("slide") => "<p:transition spd=\"med\"><p:slide dir=\"l\"/></p:transition>".to_string(),
        _ => String::new(),
    };
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<p:sld {NS}><p:cSld>{background_xml}<p:spTree><p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>{shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>{transition}</p:sld>"
    )
}

fn notes_xml(slide: &Slide) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<p:notes {NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id=\"2\" name=\"Notes Placeholder\"/><p:cNvSpPr/><p:nvPr><p:ph type=\"body\" idx=\"1\"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang=\"tr-TR\"/><a:t>{}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>",
        escape_text(&slide.notes)
    )
}

#[derive(Debug, Clone)]
pub struct DeckWrite {
    pub bytes: Vec<u8>,
    pub warnings: Vec<String>,
}

pub fn write_pptx_package(deck: &Deck) -> OfficeResult<DeckWrite> {
    let theme = theme_for(&deck.theme);
    let mut warnings = Vec::new();
    if deck.slides.iter().any(|slide| slide.objects.iter().any(|object| object.kind == "chart")) {
        warnings.push("Charts are kept in the native .oswk file and are not embedded into PPTX yet.".into());
    }
    let background = match deck.theme.as_str() {
        "dark" => theme.lt1,
        _ => "FFFFFF",
    };

    let mut parts: Vec<(String, String, Option<String>, Vec<(String, Vec<u8>)>)> = Vec::new();
    for (index, slide) in deck.slides.iter().enumerate() {
        let mut writer = SlideWriter::new();
        writer.rels.add(REL_LAYOUT, "../slideLayouts/slideLayout1.xml");
        let xml = slide_xml(slide, &theme, &mut writer);
        let mut rels = writer.rels;
        let mut notes_part = None;
        if !slide.notes.trim().is_empty() {
            rels.add(REL_NOTES, &format!("../notesSlides/notesSlide{}.xml", index + 1));
            notes_part = Some(notes_xml(slide));
        }
        parts.push((xml, rels.xml(), notes_part, writer.media));
    }

    let mut slide_rids = Vec::new();
    let presentation_rels = {
        let mut rels = RelSet::new();
        rels.add(REL_MASTER, "slideMasters/slideMaster1.xml");
        for index in 0..parts.len() {
            slide_rids.push(rels.add(REL_SLIDE, &format!("slides/slide{}.xml", index + 1)));
        }
        rels.add("http://schemas.openxmlformats.org/officeDocument/2006/relationships/presProps", "presProps.xml");
        rels.add("http://schemas.openxmlformats.org/officeDocument/2006/relationships/viewProps", "viewProps.xml");
        rels.add("http://schemas.openxmlformats.org/officeDocument/2006/relationships/tableStyles", "tableStyles.xml");
        rels.add(REL_THEME, "theme/theme1.xml");
        rels.xml()
    };

    let mut zip = ZipWriter::new();
    let mut content_types = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/>",
    );
    for (extension, mime) in [("png", "image/png"), ("jpg", "image/jpeg"), ("jpeg", "image/jpeg"), ("gif", "image/gif"), ("bmp", "image/bmp"), ("webp", "image/webp")] {
        content_types.push_str(&format!("<Default Extension=\"{extension}\" ContentType=\"{mime}\"/>"));
    }
    content_types.push_str("<Override PartName=\"/ppt/presentation.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml\"/>");
    content_types.push_str("<Override PartName=\"/ppt/slideMasters/slideMaster1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml\"/>");
    content_types.push_str("<Override PartName=\"/ppt/slideLayouts/slideLayout1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml\"/>");
    content_types.push_str("<Override PartName=\"/ppt/theme/theme1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.theme+xml\"/>");
    content_types.push_str("<Override PartName=\"/ppt/presProps.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.presProps+xml\"/>");
    content_types.push_str("<Override PartName=\"/ppt/viewProps.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml\"/>");
    content_types.push_str("<Override PartName=\"/ppt/tableStyles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml\"/>");
    for index in 0..parts.len() {
        content_types.push_str(&format!("<Override PartName=\"/ppt/slides/slide{}.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.slide+xml\"/>", index + 1));
        if parts[index].2.is_some() {
            content_types.push_str(&format!("<Override PartName=\"/ppt/notesSlides/notesSlide{}.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml\"/>", index + 1));
        }
    }
    content_types.push_str("<Override PartName=\"/docProps/core.xml\" ContentType=\"application/vnd.openxmlformats-package.core-properties+xml\"/><Override PartName=\"/docProps/app.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.extended-properties+xml\"/></Types>");

    let mut root_rels = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">");
    root_rels.push_str("<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"ppt/presentation.xml\"/>");
    root_rels.push_str("<Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties\" Target=\"docProps/core.xml\"/>");
    root_rels.push_str("<Relationship Id=\"rId3\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties\" Target=\"docProps/app.xml\"/>");
    root_rels.push_str("</Relationships>");

    let master_rels = {
        let mut rels = RelSet::new();
        rels.add(REL_LAYOUT, "../slideLayouts/slideLayout1.xml");
        rels.add(REL_THEME, "../theme/theme1.xml");
        rels.xml()
    };
    let layout_rels = {
        let mut rels = RelSet::new();
        rels.add(REL_MASTER, "../slideMasters/slideMaster1.xml");
        rels.xml()
    };

    zip.add_text("[Content_Types].xml", &content_types);
    zip.add_text("_rels/.rels", &root_rels);
    zip.add_text("docProps/core.xml", &core_properties(deck));
    zip.add_text("docProps/app.xml", "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Properties xmlns=\"http://schemas.openxmlformats.org/officeDocument/2006/extended-properties\"><Application>Office Swiss Army Knife</Application></Properties>");
    zip.add_text("ppt/presentation.xml", &presentation_xml(deck, &slide_rids));
    zip.add_text("ppt/_rels/presentation.xml.rels", &presentation_rels);
    zip.add_text("ppt/presProps.xml", "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<p:presentationPr xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\"/>");
    zip.add_text("ppt/viewProps.xml", "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<p:viewPr xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\"/>");
    zip.add_text("ppt/tableStyles.xml", "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<a:tblStyleLst xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" def=\"mediumStyle2Accent1\"/>");
    zip.add_text("ppt/theme/theme1.xml", &theme_xml(&theme));
    zip.add_text("ppt/slideMasters/slideMaster1.xml", &master_xml(&theme, background));
    zip.add_text("ppt/slideMasters/_rels/slideMaster1.xml.rels", &master_rels);
    zip.add_text("ppt/slideLayouts/slideLayout1.xml", &layout_xml(background));
    zip.add_text("ppt/slideLayouts/_rels/slideLayout1.xml.rels", &layout_rels);
    for (index, (xml, rels, notes, media)) in parts.iter().enumerate() {
        zip.add_text(&format!("ppt/slides/slide{}.xml", index + 1), xml);
        zip.add_text(&format!("ppt/slides/_rels/slide{}.xml.rels", index + 1), rels);
        if let Some(notes) = notes {
            zip.add_text(&format!("ppt/notesSlides/notesSlide{}.xml", index + 1), notes);
            zip.add_text(&format!("ppt/notesSlides/_rels/notesSlide{}.xml.rels", index + 1), &format!(
                "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide\" Target=\"../slides/slide{}.xml\"/></Relationships>",
                index + 1
            ));
        }
        for (name, data) in media {
            zip.add(&format!("ppt/media/{name}"), data);
        }
    }
    Ok(DeckWrite { bytes: zip.finish(), warnings })
}

fn core_properties(deck: &Deck) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<cp:coreProperties xmlns:cp=\"http://schemas.openxmlformats.org/package/2006/metadata/core-properties\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\"><dc:title>{}</dc:title><dc:creator>{}</dc:creator></cp:coreProperties>",
        escape_text(&deck.title),
        escape_text(&deck.metadata.author)
    )
}

pub fn write_pptx(deck: &Deck) -> OfficeResult<Vec<u8>> {
    Ok(write_pptx_package(deck)?.bytes)
}

pub fn write_pptx_file(path: &Path, deck: &Deck) -> OfficeResult<()> {
    crate::io::write_atomic(path, &write_pptx(deck)?)
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

fn part_rels(reader: &ZipReader, part: &str) -> HashMap<String, String> {
    let (dir, file) = match part.rsplit_once('/') {
        Some((dir, file)) => (format!("{dir}/"), file.to_string()),
        None => (String::new(), part.to_string()),
    };
    let mut map = HashMap::new();
    let Ok(text) = reader.read_text(&format!("{dir}_rels/{file}.rels")) else {
        return map;
    };
    let Ok(root) = parse_xml(&text) else { return map };
    for node in root.children_named("Relationship") {
        if let (Some(id), Some(target)) = (node.attr("Id"), node.attr("Target")) {
            map.insert(id.to_string(), target.to_string());
        }
    }
    map
}

fn resolve_part(current: &str, target: &str) -> String {
    if target.starts_with('/') {
        return target.trim_start_matches('/').to_string();
    }
    let base = current.rsplit_once('/').map(|(dir, _)| dir).unwrap_or("");
    let mut segments: Vec<&str> = if base.is_empty() { Vec::new() } else { base.split('/').collect() };
    for segment in target.split('/') {
        match segment {
            "." | "" => {}
            ".." => {
                segments.pop();
            }
            other => segments.push(other),
        }
    }
    segments.join("/")
}

fn read_shape(node: &XmlNode, reader: &ZipReader, rels: &HashMap<String, String>, z: i32, warnings: &mut Vec<String>) -> Option<SlideObject> {
    match node.local_name() {
        "sp" => {
            let shape_props = node.find_descendant("spPr")?;
            let transform = shape_props.find_descendant("xfrm");
            let (x, y, w, h, rotation) = read_transform(transform);
            let preset = shape_props
                .find_descendant("prstGeom")
                .and_then(|geometry| geometry.attr("prst"))
                .unwrap_or("rect")
                .to_string();
            let mut object = SlideObject::new(match preset.as_str() {
                "ellipse" => "ellipse",
                "roundRect" => "roundRect",
                "line" => "line",
                _ => "rect",
            }, x, y, w, h);
            object.z = z;
            object.rotation = rotation;
            let fill = shape_props
                .find_descendant("solidFill")
                .and_then(|fill| fill.find_descendant("srgbClr"))
                .and_then(|color| color.attr("val"))
                .map(|value| format!("#{value}"));
            let stroke = shape_props
                .find_descendant("ln")
                .and_then(|line| line.find_descendant("srgbClr"))
                .and_then(|color| color.attr("val"))
                .map(|value| format!("#{value}"));
            if fill.is_some() || stroke.is_some() {
                object.style = Some(ShapeStyle { fill, stroke, stroke_width_pt: 1.5, opacity: 1.0, corner_radius_pt: 0.0, shadow: false });
            }
            let text_body = node.find_descendant("txBody");
            if let Some(text_body) = text_body {
                let paragraphs = read_paragraphs(text_body);
                if paragraphs.iter().any(|paragraph| !paragraph.text.trim().is_empty()) {
                    object.text = Some(TextFrame { paragraphs, ..Default::default() });
                }
            }
            Some(object)
        }
        "pic" => {
            let shape_props = node.find_descendant("spPr")?;
            let transform = shape_props.find_descendant("xfrm");
            let (x, y, w, h, rotation) = read_transform(transform);
            let embed = node.find_descendant("blip").and_then(|blip| blip.attr_any_ns("embed"))?;
            let target = rels.get(embed)?;
            let part = resolve_part("ppt/slides/slide1.xml", target);
            let data = reader.read(&part).ok()?;
            if data.is_empty() {
                return None;
            }
            let name = part.rsplit('/').next().unwrap_or("image.png").to_string();
            let mut object = SlideObject::new("image", x, y, w, h);
            object.z = z;
            object.rotation = rotation;
            object.image = Some(ImageData::from_bytes(&name, &data));
            Some(object)
        }
        "cxnSp" => {
            let shape_props = node.find_descendant("spPr")?;
            let transform = shape_props.find_descendant("xfrm");
            let (x, y, w, h, _) = read_transform(transform);
            let mut object = SlideObject::new("line", x, y, w, h);
            object.z = z;
            object.line = Some(LineSpec { x2: w, y2: h, end_arrow: node.find_descendant("tailEnd").is_some(), begin_arrow: node.find_descendant("headEnd").is_some(), dash: String::new() });
            let color = node
                .find_descendant("ln")
                .and_then(|line| line.find_descendant("srgbClr"))
                .and_then(|color| color.attr("val"))
                .map(|value| format!("#{value}"));
            object.style = Some(ShapeStyle { fill: color.clone(), stroke: color, stroke_width_pt: 2.0, opacity: 1.0, corner_radius_pt: 0.0, shadow: false });
            Some(object)
        }
        "graphicFrame" => {
            let transform = node.find_descendant("xfrm");
            let (x, y, w, h, rotation) = read_transform(transform);
            let table = node.find_descendant("tbl")?;
            let mut rows = Vec::new();
            for row_node in table.children_named("tr") {
                let mut cells = Vec::new();
                for cell in row_node.children_named("tc") {
                    let mut inner = Vec::new();
                    inner.push(Block::paragraph(&cell.deep_text().trim().to_string()));
                    cells.push(TableCell { blocks: inner, ..Default::default() });
                }
                rows.push(TableRow { cells, ..Default::default() });
            }
            let mut object = SlideObject::new("table", x, y, w, h);
            object.z = z;
            object.rotation = rotation;
            object.table = Some(TableData { rows, ..Default::default() });
            Some(object)
        }
        "grpSp" => {
            warnings.push("Grouped shapes were flattened during import.".into());
            None
        }
        _ => None,
    }
}

fn read_transform(transform: Option<&XmlNode>) -> (f64, f64, f64, f64, f64) {
    let Some(transform) = transform else { return (0.0, 0.0, 300.0, 120.0, 0.0) };
    let offset = transform.child("off");
    let extent = transform.child("ext");
    let x = offset.and_then(|node| node.attr("x")).and_then(|value| value.parse::<f64>().ok()).map(pt_from_emu).unwrap_or(0.0);
    let y = offset.and_then(|node| node.attr("y")).and_then(|value| value.parse::<f64>().ok()).map(pt_from_emu).unwrap_or(0.0);
    let w = extent.and_then(|node| node.attr("cx")).and_then(|value| value.parse::<f64>().ok()).map(pt_from_emu).unwrap_or(120.0);
    let h = extent.and_then(|node| node.attr("cy")).and_then(|value| value.parse::<f64>().ok()).map(pt_from_emu).unwrap_or(60.0);
    let rotation = transform.attr("rot").and_then(|value| value.parse::<f64>().ok()).map(|value| value / 60000.0).unwrap_or(0.0);
    (x, y, w, h, rotation)
}

fn read_paragraphs(text_body: &XmlNode) -> Vec<TextParagraph> {
    let mut paragraphs = Vec::new();
    for paragraph in text_body.children_named("p") {
        let properties = paragraph.child("pPr");
        let level = properties.and_then(|node| node.attr("lvl")).and_then(|value| value.parse::<u32>().ok()).unwrap_or(0);
        let align = properties.and_then(|node| node.attr("algn")).map(|value| match value {
            "ctr" => "center".to_string(),
            "r" => "right".to_string(),
            "just" => "justify".to_string(),
            _ => "left".to_string(),
        }).unwrap_or_default();
        let bullet = properties.map(|node| node.find_descendant("buChar").is_some() || node.find_descendant("buAutoNum").is_some()).unwrap_or(false);
        let mut text = String::new();
        let mut runs = Vec::new();
        let mut bold = false;
        let mut italic = false;
        let mut size: Option<f64> = None;
        let mut color: Option<String> = None;
        for child in &paragraph.children {
            if child.local_name() != "r" && child.local_name() != "fld" {
                continue;
            }
            let run_properties = child.child("rPr");
            let run_bold = run_properties.and_then(|node| node.attr("b")).map(|value| value == "1").unwrap_or(false);
            let run_italic = run_properties.and_then(|node| node.attr("i")).map(|value| value == "1").unwrap_or(false);
            let run_size = run_properties.and_then(|node| node.attr("sz")).and_then(|value| value.parse::<f64>().ok()).map(|value| value / 100.0);
            let run_color = run_properties
                .and_then(|node| node.find_descendant("srgbClr"))
                .and_then(|color| color.attr("val"))
                .map(|value| format!("#{value}"));
            bold |= run_bold;
            italic |= run_italic;
            if size.is_none() {
                size = run_size;
            }
            if color.is_none() {
                color = run_color.clone();
            }
            let run_text = child.find_descendant("t").map(XmlNode::deep_text).unwrap_or_default();
            if run_text.is_empty() {
                continue;
            }
            text.push_str(&run_text);
            runs.push(Run { text: run_text, bold: run_bold, italic: run_italic, color: run_color, size_pt: run_size, ..Default::default() });
        }
        paragraphs.push(TextParagraph { text, level, bold, italic, underline: false, size_pt: size, color, align, bullet, runs });
    }
    paragraphs
}

trait FindDescendant {
    fn find_descendant(&self, name: &str) -> Option<&XmlNode>;
}

impl FindDescendant for XmlNode {
    fn find_descendant<'a>(&'a self, name: &str) -> Option<&'a XmlNode> {
        let mut found: Vec<&XmlNode> = Vec::new();
        self.find_all(name, &mut found);
        found.into_iter().next()
    }
}

pub fn read_pptx(bytes: &[u8]) -> OfficeResult<DeckRead> {
    let reader = ZipReader::open(bytes.to_vec())?;
    if !reader.contains("ppt/presentation.xml") {
        return Err(OfficeError::corrupt("The package does not contain a presentation."));
    }
    let mut warnings = Vec::new();
    let presentation = reader.read_text("ppt/presentation.xml")?;
    let root = parse_xml(&presentation)?;
    let rels = part_rels(&reader, "ppt/presentation.xml");
    let mut deck = Deck::new_blank("Imported presentation");
    if let Some(size) = root.child("sldSz") {
        if let Some(cx) = size.attr("cx").and_then(|value| value.parse::<f64>().ok()) {
            deck.size.width_pt = pt_from_emu(cx);
        }
        if let Some(cy) = size.attr("cy").and_then(|value| value.parse::<f64>().ok()) {
            deck.size.height_pt = pt_from_emu(cy);
        }
    }
    deck.slides.clear();
    let mut slide_parts: Vec<String> = Vec::new();
    let mut slide_ids = Vec::new();
    root.find_all("sldId", &mut slide_ids);
    for node in slide_ids {
        if let Some(rid) = node.attr("r:id").or_else(|| node.attr_any_ns("id")) {
            if let Some(target) = rels.get(rid) {
                slide_parts.push(resolve_part("ppt/presentation.xml", target));
            }
        }
    }
    for part in &slide_parts {
        let Ok(text) = reader.read_text(part) else { continue };
        let Ok(slide_root) = parse_xml(&text) else { continue };
        let mut slide = Slide::default();
        slide.objects.clear();
        if let Some(background) = slide_root.find_descendant("bgPr") {
            if let Some(color) = background.find_descendant("srgbClr").and_then(|color| color.attr("val")) {
                slide.background = Some(format!("#{color}"));
            }
        }
        if let Some(transition) = slide_root.find_descendant("transition") {
            if transition.find_descendant("fade").is_some() {
                slide.transition = Some("fade".into());
            } else if transition.find_descendant("push").is_some() {
                slide.transition = Some("push".into());
            } else if transition.find_descendant("wipe").is_some() {
                slide.transition = Some("wipe".into());
            } else if transition.find_descendant("slide").is_some() {
                slide.transition = Some("slide".into());
            }
        }
        let slide_rels = part_rels(&reader, part);
        let mut z = 1i32;
        let shapes: Vec<&XmlNode> = slide_root
            .find_descendant("spTree")
            .map(|tree| tree.children.iter().filter(|child| child.local_name() != "nvGrpSpPr" && child.local_name() != "grpSpPr").collect())
            .unwrap_or_default();
        for shape in shapes {
            if let Some(object) = read_shape(shape, &reader, &slide_rels, z, &mut warnings) {
                slide.objects.push(object);
                z += 1;
            } else if shape.local_name() == "graphicFrame" {
                warnings.push("Some embedded objects (charts or diagrams) were not imported.".into());
            }
        }
        // Notes.
        for (rid, target) in &slide_rels {
            if target.contains("notesSlide") {
                let notes_part = resolve_part(part, target);
                if let Ok(notes_text) = reader.read_text(&notes_part) {
                    if let Ok(notes_root) = parse_xml(&notes_text) {
                        let mut body = Vec::new();
                        notes_root.find_all("bodyPr", &mut body);
                        slide.notes = notes_root
                            .children_named("cSld")
                            .flat_map(|cld| cld.children_named("spTree"))
                            .flat_map(|tree| tree.children.iter())
                            .filter_map(|shape| shape.find_descendant("txBody"))
                            .map(|body| read_paragraphs(body).iter().map(|paragraph| paragraph.text.clone()).collect::<Vec<_>>().join("\n"))
                            .collect::<Vec<_>>()
                            .join("\n")
                            .trim()
                            .to_string();
                    }
                }
                let _ = rid;
            }
        }
        deck.slides.push(slide);
    }
    if deck.slides.is_empty() {
        deck.slides.push(Slide::default());
    }
    if reader.names().any(|name| name.contains("vbaProject")) {
        warnings.push("Macros were not loaded. Presentations always open with macros disabled.".into());
    }
    warnings.push("Animations and complex effects are not imported.".into());
    warnings.sort();
    warnings.dedup();
    Ok(DeckRead { deck, warnings })
}

pub fn read_pptx_file(path: &Path) -> OfficeResult<DeckRead> {
    let bytes = crate::io::read_bytes(path)?;
    let mut result = read_pptx(&bytes)?;
    if result.deck.title.starts_with("Imported") || result.deck.title.is_empty() {
        result.deck.title = crate::io::file_stem(path);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_deck() -> Deck {
        let mut deck = Deck::new_blank("Sample deck");
        deck.theme = "business".into();
        let mut slide = Slide::default();
        let mut title = SlideObject::new("text", 60.0, 60.0, 600.0, 100.0);
        title.text = Some(TextFrame {
            paragraphs: vec![TextParagraph { text: "BaÃ…Å¸lÃ„Â±k slaytÃ„Â±".into(), size_pt: Some(32.0), bold: true, ..Default::default() }],
            ..Default::default()
        });
        let mut rect = SlideObject::new("rect", 60.0, 200.0, 320.0, 160.0);
        rect.style = Some(ShapeStyle { fill: Some("#1D4ED8".into()), ..Default::default() });
        rect.text = Some(TextFrame { paragraphs: vec![TextParagraph { text: "Kutu".into(), color: Some("#FFFFFF".into()), ..Default::default() }], ..Default::default() });
        slide.objects = vec![title, rect];
        slide.notes = "Notlar burada".into();
        slide.transition = Some("fade".into());
        let mut second = Slide::default();
        let mut table = SlideObject::new("table", 60.0, 120.0, 500.0, 200.0);
        table.table = Some(TableData::simple(2, 3, 500.0));
        second.objects = vec![table];
        deck.slides = vec![slide, second];
        deck
    }

    #[test]
    fn pptx_package_structure() {
        let result = write_pptx_package(&sample_deck()).unwrap();
        let reader = ZipReader::open(result.bytes.clone()).unwrap();
        for part in [
            "[Content_Types].xml",
            "ppt/presentation.xml",
            "ppt/slideMasters/slideMaster1.xml",
            "ppt/slideLayouts/slideLayout1.xml",
            "ppt/theme/theme1.xml",
            "ppt/slides/slide1.xml",
            "ppt/slides/slide2.xml",
            "ppt/slides/_rels/slide1.xml.rels",
            "ppt/notesSlides/notesSlide1.xml",
        ] {
            assert!(reader.contains(part), "missing {part}");
        }
        let presentation = reader.read_text("ppt/presentation.xml").unwrap();
        assert!(presentation.contains("sldIdLst"));
        assert!(presentation.contains("sldSz"));
    }

    #[test]
    fn pptx_roundtrip() {
        let bytes = write_pptx(&sample_deck()).unwrap();
        let read = read_pptx(&bytes).unwrap();
        assert_eq!(read.deck.slides.len(), 2);
        let texts: Vec<String> = read.deck.slides[0]
            .objects
            .iter()
            .filter_map(|object| object.text.as_ref().map(TextFrame::plain))
            .collect();
        assert!(texts.iter().any(|text| text.contains("BaÃ…Å¸lÃ„Â±k slaytÃ„Â±")), "texts: {texts:?}");
        assert!(read.deck.slides[0].notes.contains("Notlar"));
        assert_eq!(read.deck.size.width_pt.round() as i64, 960);
    }

    #[test]
    fn pptx_roundtrip_image() {
        let mut buffer = image::RgbaImage::new(4, 4);
        for pixel in buffer.pixels_mut() {
            *pixel = image::Rgba([10, 200, 90, 255]);
        }
        let mut png = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(buffer).write_to(&mut png, image::ImageFormat::Png).unwrap();
        let mut deck = Deck::new_blank("Images");
        let mut slide = Slide::default();
        let mut object = SlideObject::new("image", 40.0, 40.0, 200.0, 150.0);
        object.image = Some(ImageData::from_bytes("pic.png", &png.into_inner()));
        slide.objects = vec![object];
        deck.slides = vec![slide];
        let bytes = write_pptx(&deck).unwrap();
        let read = read_pptx(&bytes).unwrap();
        let image = read.deck.slides[0].objects.iter().find_map(|object| object.image.clone());
        assert!(image.map(|image| !image.data_base64.is_empty()).unwrap_or(false));
    }

    #[test]
    fn malformed_inputs_are_errors() {
        assert!(read_pptx(b"").is_err());
        assert!(read_pptx(&[3u8; 40]).is_err());
    }
}
