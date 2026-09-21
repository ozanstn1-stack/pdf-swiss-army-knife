// Copies runtime assets that are not part of the bundle into public/ so the
// Vite build (and the dev server) can serve them offline:
//   public/vendor/cmaps, public/vendor/standard_fonts  (pdf.js CJK support)
//   public/fonts/PT_Sans-*.ttf                         (Unicode stamps, OFL)
//
// Everything is derived from node_modules / the repository, so nothing large
// is committed to git.
import { cp, mkdir, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const pdfjs = join(root, "node_modules", "pdfjs-dist");
const fontSource = join(root, "..", "crates", "pdfcore", "assets", "fonts");

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function copyDir(from, to) {
  if (!(await exists(from))) {
    console.warn(`[prepare-assets] missing ${from} — skipping`);
    return;
  }
  await mkdir(to, { recursive: true });
  await cp(from, to, { recursive: true });
  console.log(`[prepare-assets] ${from} -> ${to}`);
}

await copyDir(join(pdfjs, "cmaps"), join(root, "public", "vendor", "cmaps"));
await copyDir(join(pdfjs, "standard_fonts"), join(root, "public", "vendor", "standard_fonts"));
await copyDir(fontSource, join(root, "public", "fonts"));
