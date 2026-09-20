//! Development helper: prints document facts for a PDF (page count, text
//! layer, metadata, page sizes) so produced files can be verified from the
//! command line.
//!
//! Usage: cargo run -p pdfcore --example inspect -- <file.pdf> [password]

use pdfcore::info::pdf_info;
use std::path::Path;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let input = args.get(1).expect("usage: inspect <file.pdf> [password]");
    let password = args.get(2).map(|value| value.as_str());
    match pdf_info(Path::new(input), password) {
        Ok(info) => {
            println!("file:        {}", info.file_name);
            println!("pages:       {}", info.page_count);
            println!("size:        {} bytes", info.file_size_bytes);
            println!("version:     {}", info.pdf_version);
            println!("encrypted:   {}", info.encrypted);
            println!("text layer:  {}", info.has_text_layer);
            println!("images:      {}", info.image_count);
            println!("title:       {}", if info.title.is_empty() { "-" } else { &info.title });
            println!("author:      {}", if info.author.is_empty() { "-" } else { &info.author });
            if !info.page_geometries.is_empty() {
                let first = &info.page_geometries[0];
                println!(
                    "page 1 size: {:.1} x {:.1} pt (rotation {}°)",
                    first.display_width_pt, first.display_height_pt, first.rotation
                );
            }
            if let Ok(text) = pdfcore::render::extract_page_text(Path::new(input), password, 1) {
                let sample: String = text.trim().chars().take(120).collect();
                println!("page 1 text: {}", if sample.is_empty() { "-" } else { &sample });
            }
        }
        Err(err) => {
            eprintln!("failed: {err:?}");
            std::process::exit(1);
        }
    }
}
