export type ScreenId =
  | "home"
  | "reader"
  | "merge"
  | "organize"
  | "split"
  | "compress"
  | "ocr"
  | "pdfToImages"
  | "imagesToPdf"
  | "protect"
  | "unlock"
  | "watermark"
  | "annotate"
  | "metadata"
  | "pageTools"
  | "batch"
  | "history"
  | "settings"
  | "info";

export interface PageToolsTab {
  tab: "extract" | "delete" | "rotate" | "resize" | "crop" | "numbering";
}

export type Navigate = (screen: ScreenId, options?: { files?: string[]; pageToolsTab?: PageToolsTab["tab"] }) => void;
