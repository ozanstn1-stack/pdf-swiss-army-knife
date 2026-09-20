// Types mirrored from the Rust command layer (serde camelCase).

export interface AppError {
  code: string;
  message: string;
}

export interface EngineStatus {
  pdfium: boolean;
  qpdf: boolean;
  tesseract: boolean;
  tesseract_version: string | null;
  ocr_languages: string[];
}

export interface OcrLanguage {
  code: string;
  name: string;
}

export interface AppInfo {
  appVersion: string;
  coreVersion: string;
  platform: string;
  name: string;
}

export interface PageGeometry {
  page: number;
  width_pt: number;
  height_pt: number;
  display_width_pt: number;
  display_height_pt: number;
  rotation: number;
}

export interface PdfMetadata {
  title: string;
  author: string;
  subject: string;
  keywords: string;
  creator: string;
  producer: string;
  creation_date: string;
  mod_date: string;
}

export interface PdfInfo {
  path: string;
  fileName: string;
  fileSizeBytes: number;
  pageCount: number;
  pdfVersion: string;
  encrypted: boolean;
  hasTextLayer: boolean;
  metadata: PdfMetadata;
  pageGeometries: PageGeometry[];
  imageCount: number;
  title: string;
  author: string;
  producer: string;
}

export interface Thumbnail {
  dataUrl: string;
  width: number;
  height: number;
}

export type OverwriteMode = "error" | "replace" | "unique_name";

export interface OutputSpec {
  path: string;
  overwrite?: OverwriteMode;
}

export interface OpResult {
  path: string;
  pageCount?: number;
  originalBytes?: number;
  outputBytes?: number;
  reduction?: number;
  message?: string;
}

export interface ProgressPayload {
  jobId: string;
  stage: string;
  current: number;
  total: number;
  message?: string;
}

export interface RecentEntry {
  path: string;
  fileName: string;
  tool: string;
  timestamp: number;
}

export interface SplitPart {
  path: string;
  first_page: number;
  last_page: number;
}

export interface ImageOutput {
  path: string;
  page: number;
  width: number;
  height: number;
  bytes: number;
}

export interface CompressEstimate {
  original_bytes: number;
  estimated_bytes: number;
  page_count: number;
  reduction: number;
  method: string;
  sample_pages: number;
  accurate: boolean;
}

export interface CompressOptions {
  strategy: "lossless" | "raster";
  preset: "low" | "medium" | "high" | "custom";
  dpi: number;
  jpeg_quality: number;
  grayscale: boolean;
  remove_metadata: boolean;
}

export interface OcrPreprocess {
  auto_rotate: boolean;
  deskew: boolean;
  contrast: boolean;
  denoise: boolean;
  binarize: boolean;
  grayscale: boolean;
}

export interface OcrOptions {
  languages: string[];
  psm: number;
  dpi: number;
  output_mode: "searchable_pdf" | "text" | "markdown";
  pages: number[];
  preprocess: OcrPreprocess;
  skip_text_pages: boolean;
}

export type WatermarkPosition =
  | "top_left"
  | "top_center"
  | "top_right"
  | "center"
  | "bottom_left"
  | "bottom_center"
  | "bottom_right";

export interface WatermarkOptions {
  kind: "text" | "image";
  text: string;
  font_size_pt: number;
  bold: boolean;
  color: string;
  opacity: number;
  rotation_deg: number;
  position: WatermarkPosition;
  margin_pt: number;
  tile: boolean;
  image_path: string | null;
  image_scale: number;
  pages: number[];
}

export interface NumberingOptions {
  position: WatermarkPosition;
  format: "n" | "page_n" | "n_of_total" | "page_n_of_total";
  start_number: number;
  font_size_pt: number;
  color: string;
  margin_pt: number;
  pages: number[];
  count_from_start: boolean;
}

export interface ResizeOptions {
  page_size: string;
  custom_width_pt: number;
  custom_height_pt: number;
  orientation: "auto" | "portrait" | "landscape";
  mode: "fit" | "stretch";
  pages: number[];
}

export interface CropItem {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export type AnnotationKind = "text" | "image" | "rect" | "highlight" | "line";

export interface Annotation {
  kind: AnnotationKind;
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  font_size_pt: number;
  bold: boolean;
  color: string;
  opacity: number;
  image_path: string | null;
  line_width_pt: number;
  x2: number | null;
  y2: number | null;
}

export interface ImageToPdfOptions {
  page_size: string;
  custom_width_pt: number;
  custom_height_pt: number;
  orientation: "auto" | "portrait" | "landscape";
  fit: "fit" | "fill" | "actual";
  margin_pt: number;
  dpi: number;
  jpeg_quality: number;
}

export interface ImageItem {
  path: string;
  rotation_delta: number;
}

export interface PagePlanItem {
  source_page: number;
  rotation_delta: number;
}

export interface ProtectOptions {
  userPassword: string;
  ownerPassword: string;
  allowPrinting: boolean;
  allowCopying: boolean;
  allowEditing: boolean;
  allowCommenting: boolean;
}

export type SplitMode =
  | { mode: "ranges"; ranges: string[] }
  | { mode: "every_n"; n: number }
  | { mode: "individual" }
  | { mode: "at_pages"; pages: number[] };

export interface Settings {
  theme: "dark" | "light" | "system";
  language: "en" | "tr";
  defaultOutputDir: string;
  defaultCompression: "low" | "medium" | "high";
  defaultImageDpi: number;
  ocrLanguages: string[];
  autoCleanupTemp: boolean;
  showRecentFiles: boolean;
  defaultExportFormat: "jpg" | "png";
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "dark",
  language: "en",
  defaultOutputDir: "",
  defaultCompression: "medium",
  defaultImageDpi: 150,
  ocrLanguages: ["eng"],
  autoCleanupTemp: true,
  showRecentFiles: true,
  defaultExportFormat: "jpg",
};

export interface TextMatch {
  page: number;
  snippet: string;
  index_on_page: number;
}

export interface SearchResponse {
  matches: TextMatch[];
  pagesWithMatches: number;
  totalMatches: number;
  truncated: boolean;
}

export interface SelectedFile {
  path: string;
  name: string;
  sizeBytes: number;
  pages?: number;
}
