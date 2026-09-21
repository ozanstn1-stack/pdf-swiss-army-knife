import type { PDFFont } from "pdf-lib";

export type Overwrite = "ask" | "rename";

export interface PdfInfo {
  fileName: string;
  fileSize: number;
  pageCount: number;
  version: string;
  encrypted: boolean;
  title: string;
  author: string;
  subject: string;
  keywords: string;
  creator: string;
  producer: string;
  creationDate: string;
  modificationDate: string;
  pageSizes: { width: number; height: number; count: number }[];
}

export interface Metadata {
  title: string;
  author: string;
  subject: string;
  keywords: string;
  creator: string;
  producer: string;
}

export interface PageBox {
  width: number;
  height: number;
  rotation: number;
}

export interface PagePlanItem {
  source: number; // 1-based page number in the source document
  rotation: number; // absolute rotation for this instance
}

export type SplitMode =
  | { mode: "ranges"; ranges: string[] }
  | { mode: "every_n"; n: number }
  | { mode: "individual" }
  | { mode: "at_pages"; pages: number[] };

export interface WatermarkOptions {
  text: string;
  fontFamily: "sans" | "sans-bold";
  fontBytes?: Uint8Array;
  sizePt: number;
  color: string;
  opacity: number;
  rotationDeg: number;
  position: "top_left" | "top_center" | "top_right" | "center" | "bottom_left" | "bottom_center" | "bottom_right";
  marginPt: number;
  tile: boolean;
  pages: number[]; // empty = all
}

export interface NumberingOptions {
  position: "top_left" | "top_center" | "top_right" | "bottom_left" | "bottom_center" | "bottom_right";
  format: "n" | "page_n" | "n_of_total" | "page_n_of_total";
  startNumber: number;
  sizePt: number;
  color: string;
  marginPt: number;
  countFromStart: boolean;
  pages: number[];
}

export interface ImageToPdfOptions {
  pageSize: "a3" | "a4" | "a5" | "letter" | "legal" | "original" | "custom";
  customWidthPt: number;
  customHeightPt: number;
  orientation: "auto" | "portrait" | "landscape";
  fit: "fit" | "fill" | "actual";
  marginPt: number;
  assumedDpi: number;
}

export interface CompressOptions {
  strategy: "lossless" | "raster";
  dpi: number;
  jpegQuality: number;
}

export interface SearchMatch {
  page: number;
  snippet: string;
}

export interface OperationResult {
  fileName: string;
  bytes: Uint8Array;
  detail: string;
  /** MIME type for downloads (defaults to application/pdf). */
  mime?: string;
}

export interface FontResource {
  sans: Uint8Array;
  sansBold: Uint8Array;
}

export type EmbeddedFont = PDFFont;
