//! PDF Swiss Army Knife - Tauri application shell.
//!
//! The heavy lifting lives in the `pdfcore` crate; this layer only wires
//! commands, progress events, cancellation and engine discovery.

mod commands;
mod jobs;

use jobs::JobRegistry;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_os::init())
        .manage(JobRegistry::default())
        .setup(|app| {
            // Teach pdfcore where the bundled engines live. Both layouts are
            // covered: <install>/resources/engines (bundler default) and
            // <exe dir>/engines (portable layout).
            if let Ok(resource_dir) = app.path().resource_dir() {
                for candidate in [
                    resource_dir.join("resources").join("engines"),
                    resource_dir.join("engines"),
                ] {
                    if candidate.exists() {
                        pdfcore::engines::set_engine_base(candidate);
                        break;
                    }
                }
            }
            // Development/screenshot hook: keep the window above others so
            // automated captures are deterministic. No effect in normal use.
            if std::env::var("PDFSAK_ALWAYS_ON_TOP").is_ok() {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_always_on_top(true);
                }
            }
            // Fit the default window to the actual monitor so the layout is
            // never larger than the screen (laptops, high-DPI displays).
            if let Some(window) = app.get_webview_window("main") {
                let monitor = window
                    .current_monitor()
                    .ok()
                    .flatten()
                    .or_else(|| window.primary_monitor().ok().flatten());
                if let Some(monitor) = monitor {
                    // Work in physical pixels: WebView2 applies the Windows
                    // DPI scale to the CSS viewport, so sizing in logical units
                    // can still overflow the screen on scaled displays.
                    let screen = monitor.size();
                    let target_width = (screen.width as f64 * 0.92).min(1500.0).max(980.0);
                    let target_height = (screen.height as f64 * 0.88).min(950.0).max(660.0);
                    let _ = window.set_size(tauri::PhysicalSize::new(target_width, target_height));
                    let _ = window.center();
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Cancelling every running job when the window closes keeps the
            // process from lingering on long operations.
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if let Some(registry) = window.app_handle().try_state::<JobRegistry>() {
                    registry.cancel_all();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::engine_status,
            commands::ocr_languages,
            commands::cancel_job,
            commands::pdf_info,
            commands::page_thumbnail,
            commands::page_preview,
            commands::check_password,
            commands::merge_pdfs,
            commands::extract_pages,
            commands::delete_pages,
            commands::rotate_pages,
            commands::apply_page_plan,
            commands::split_pdf,
            commands::estimate_compression,
            commands::compress_pdf,
            commands::ocr_pdf,
            commands::protect_pdf,
            commands::unlock_pdf,
            commands::pdf_to_images,
            commands::images_to_pdf,
            commands::resize_pages,
            commands::crop_pages,
            commands::edit_metadata,
            commands::add_page_numbers,
            commands::watermark_pdf,
            commands::annotate_pdf,
            commands::load_settings,
            commands::save_settings,
            commands::load_recent,
            commands::add_recent,
            commands::clear_recent,
            commands::output_exists,
            commands::suggest_output,
            commands::file_sizes,
            commands::dev_launch_context,
            commands::log_frontend,
        ])
        .run(tauri::generate_context!())
        .expect("error while running PDF Swiss Army Knife");
}
