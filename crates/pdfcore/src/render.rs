//! Page rasterization and text extraction through pdfium (bundled DLL).
//! pdfium is not thread safe, so every call goes through the global instance
//! which serializes access internally (pdfium-render `thread_safe` bindings).

use crate::engines;
use crate::error::{PdfError, PdfResult};
use pdfium_render::prelude::*;
use std::path::Path;
use std::sync::OnceLock;

static PDFIUM: OnceLock<Result<Pdfium, String>> = OnceLock::new();

fn pdfium() -> PdfResult<&'static Pdfium> {
    let result = PDFIUM.get_or_init(|| {
        let bindings = match engines::pdfium_path() {
            Some(dll) => {
                let dir = dll.parent().unwrap_or_else(|| Path::new("."));
                let name = Pdfium::pdfium_platform_library_name_at_path(dir);
                Pdfium::bind_to_library(name)
            }
            None => Pdfium::bind_to_system_library(),
        };
        let bindings = bindings.map_err(|e| format!("pdfium could not be loaded: {e}"))?;
        Ok(Pdfium::new(bindings))
    });
    match result {
        Ok(pdfium) => Ok(pdfium),
        Err(msg) => Err(PdfError::EngineMissing(msg.clone())),
    }
}

pub fn is_available() -> bool {
    pdfium().is_ok()
}

pub fn ensure_available() -> PdfResult<()> {
    pdfium().map(|_| ())
}

#[derive(Debug, Clone, Copy)]
pub struct RenderOptions {
    pub dpi: f32,
    /// Upper bounds in pixels; the render is scaled down proportionally when
    /// exceeded (protects against giant pages).
    pub max_width: Option<u32>,
    pub max_height: Option<u32>,
}

impl Default for RenderOptions {
    fn default() -> Self {
        Self {
            dpi: 150.0,
            max_width: None,
            max_height: None,
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct PageGeometry {
    pub page: u32,
    pub width_pt: f64,
    pub height_pt: f64,
    /// Width/height as displayed, i.e. after the page's /Rotate value.
    pub display_width_pt: f64,
    pub display_height_pt: f64,
    pub rotation: i32,
}

/// RGB(A) pixel buffer returned by the renderer.
#[derive(Debug, Clone)]
pub struct RenderedPage {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

impl RenderedPage {
    pub fn to_dynamic_image(&self) -> PdfResult<image::DynamicImage> {
        let buffer = image::RgbaImage::from_raw(self.width, self.height, self.rgba.clone())
            .ok_or_else(|| PdfError::ConversionFailed("invalid render buffer".into()))?;
        Ok(image::DynamicImage::ImageRgba8(buffer))
    }
}

fn render_config(options: &RenderOptions, page_w: f32, page_h: f32) -> PdfRenderConfig {
    let mut target_w = (page_w * options.dpi / 72.0).round().max(1.0);
    let mut target_h = (page_h * options.dpi / 72.0).round().max(1.0);
    if let Some(max_w) = options.max_width {
        if target_w > max_w as f32 {
            let scale = max_w as f32 / target_w;
            target_w = max_w as f32;
            target_h = (target_h * scale).round().max(1.0);
        }
    }
    if let Some(max_h) = options.max_height {
        if target_h > max_h as f32 {
            let scale = max_h as f32 / target_h;
            target_h = max_h as f32;
            target_w = (target_w * scale).round().max(1.0);
        }
    }
    PdfRenderConfig::new()
        .set_target_width(target_w as i32)
        .set_target_height(target_h as i32)
        .render_form_data(true)
}

/// Reads page geometry (sizes in points, rotation) for every page.
pub fn page_geometries(path: &Path, password: Option<&str>) -> PdfResult<Vec<PageGeometry>> {
    let pdfium = pdfium()?;
    let doc = pdfium
        .load_pdf_from_file(path, password)
        .map_err(|e| PdfError::InvalidPdf(format!("{e}")))?;
    let mut out = Vec::with_capacity(doc.pages().len() as usize);
    for (index, page) in doc.pages().iter().enumerate() {
        let (w, h) = (page.width().value as f64, page.height().value as f64);
        // pdfium reports dimensions after applying /Rotate; recover the raw
        // MediaBox orientation for completeness.
        let rotation = match page.rotation() {
            Ok(PdfPageRenderRotation::None) => 0,
            Ok(PdfPageRenderRotation::Degrees90) => 90,
            Ok(PdfPageRenderRotation::Degrees180) => 180,
            Ok(PdfPageRenderRotation::Degrees270) => 270,
            _ => 0,
        };
        out.push(PageGeometry {
            page: index as u32 + 1,
            width_pt: w,
            height_pt: h,
            display_width_pt: w,
            display_height_pt: h,
            rotation,
        });
    }
    Ok(out)
}

/// Renders a single page (1-based index) as RGBA.
pub fn render_page(
    path: &Path,
    password: Option<&str>,
    page_number: u32,
    options: &RenderOptions,
) -> PdfResult<RenderedPage> {
    let pdfium = pdfium()?;
    let doc = pdfium
        .load_pdf_from_file(path, password)
        .map_err(|e| PdfError::InvalidPdf(format!("{e}")))?;
    let index = page_number
        .checked_sub(1)
        .ok_or(PdfError::RangeOutOfBounds)? as PdfPageIndex;
    if index as usize >= doc.pages().len() as usize {
        return Err(PdfError::RangeOutOfBounds);
    }
    let page = doc
        .pages()
        .get(index)
        .map_err(|e| PdfError::ProcessingFailed(format!("{e}")))?;
    let config = render_config(options, page.width().value, page.height().value);
    let bitmap = page
        .render_with_config(&config)
        .map_err(|e| PdfError::ConversionFailed(format!("render failed: {e}")))?;
    let width = bitmap.width() as u32;
    let height = bitmap.height() as u32;
    let image = bitmap
        .as_image()
        .map_err(|e| PdfError::ConversionFailed(format!("bitmap conversion failed: {e}")))?;
    Ok(RenderedPage {
        width,
        height,
        rgba: image.to_rgba8().into_raw(),
    })
}

/// Renders a page straight to PNG or JPEG bytes.
pub fn render_page_bytes(
    path: &Path,
    password: Option<&str>,
    page_number: u32,
    options: &RenderOptions,
    format: crate::images::ImageFormat,
    jpeg_quality: u8,
    grayscale: bool,
) -> PdfResult<Vec<u8>> {
    let rendered = render_page(path, password, page_number, options)?;
    crate::images::encode_image(&rendered, format, jpeg_quality, grayscale)
}

/// Extracts the text layer of a page via pdfium (empty when the page is a
/// scanned image without OCR).
pub fn extract_page_text(path: &Path, password: Option<&str>, page_number: u32) -> PdfResult<String> {
    let pdfium = pdfium()?;
    let doc = pdfium
        .load_pdf_from_file(path, password)
        .map_err(|e| PdfError::InvalidPdf(format!("{e}")))?;
    let index = page_number
        .checked_sub(1)
        .ok_or(PdfError::RangeOutOfBounds)? as PdfPageIndex;
    let page = doc
        .pages()
        .get(index)
        .map_err(|_| PdfError::RangeOutOfBounds)?;
    let text = page
        .text()
        .map_err(|e| PdfError::ProcessingFailed(format!("{e}")))?
        .all();
    Ok(text)
}

/// Heuristic: does the document already contain a usable text layer?
/// Samples up to `sample` pages spread through the document.
pub fn document_has_text(path: &Path, password: Option<&str>, sample: u32) -> PdfResult<bool> {
    let pdfium = pdfium()?;
    let doc = pdfium
        .load_pdf_from_file(path, password)
        .map_err(|e| PdfError::InvalidPdf(format!("{e}")))?;
    let total = doc.pages().len().max(0) as u32;
    if total == 0 {
        return Ok(false);
    }
    let take = sample.clamp(1, total);
    let step = (total / take).max(1);
    let mut checked = 0;
    let mut index = 0u32;
    while checked < take && index < total {
        if let Ok(page) = doc.pages().get(index as PdfPageIndex) {
            if let Ok(text) = page.text() {
                let content = text.all();
                if content.trim().chars().count() > 3 {
                    return Ok(true);
                }
            }
        }
        checked += 1;
        index += step;
    }
    Ok(false)
}