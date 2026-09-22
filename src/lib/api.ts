import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AiAskRequest,
  AiCleanupRequest,
  AiExamplePrompts,
  AiMetadataSuggestion,
  AiLibraryEntry,
  AiModelOption,
  AiPreview,
  AiSettingsInput,
  AiSettingsView,
  AiSummarizeRequest,
  AiTestResult,
  AiTextResult,
  AiTranslateRequest,
  Annotation,
  AppInfo,
  CompressEstimate,
  CompressOptions,
  CropItem,
  EngineStatus,
  ImageItem,
  ImageToPdfOptions,
  NumberingOptions,
  OcrLanguage,
  OcrOptions,
  OperationEntry,
  OpResult,
  OutputSpec,
  PagePlanItem,
  PdfInfo,
  ProgressPayload,
  SearchResponse,
  ProtectOptions,
  RecentEntry,
  Settings,
  SplitMode,
  Thumbnail,
  WatermarkOptions,
} from "./types";

/** Normalizes any thrown value into a friendly {code, message} pair. */
export function toAppError(error: unknown): { code: string; message: string } {
  if (typeof error === "string") {
    return { code: "internal", message: error };
  }
  if (error && typeof error === "object" && "code" in error && "message" in error) {
    const e = error as { code: string; message: string };
    return { code: String(e.code), message: String(e.message) };
  }
  if (error instanceof Error) {
    return { code: "internal", message: error.message };
  }
  return { code: "internal", message: String(error) };
}

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

export const appInfo = () => invoke<AppInfo>("app_info");
export const engineStatus = () => invoke<EngineStatus>("engine_status");
export const ocrLanguages = () => invoke<OcrLanguage[]>("ocr_languages");
export const cancelJob = (jobId: string) => invoke<void>("cancel_job", { jobId });

export const onProgress = (handler: (payload: ProgressPayload) => void): Promise<UnlistenFn> =>
  listen<ProgressPayload>("job:progress", (event) => handler(event.payload));

// ---------------------------------------------------------------------------
// AI (DeepSeek) - the only network feature, opt-in with the user's own key
// ---------------------------------------------------------------------------

export const aiGetSettings = () => invoke<AiSettingsView>("ai_get_settings");
export const aiSaveSettings = (input: AiSettingsInput) => invoke<AiSettingsView>("ai_save_settings", { input });
export const aiClearKey = () => invoke<AiSettingsView>("ai_clear_key");
export const aiTestConnection = () => invoke<AiTestResult>("ai_test_connection");
export const aiDocumentPreview = (path: string, pages: number[] | undefined, password?: string) =>
  invoke<AiPreview>("ai_document_preview", { path, pages: pages ?? null, password: password || null });
export const aiSummarize = (request: AiSummarizeRequest) => invoke<AiTextResult>("ai_summarize", { request });
export const aiTranslate = (request: AiTranslateRequest) => invoke<AiTextResult>("ai_translate", { request });
export const aiAsk = (request: AiAskRequest) => invoke<AiTextResult>("ai_ask", { request });
export const aiCleanupText = (request: AiCleanupRequest) => invoke<AiTextResult>("ai_cleanup_text", { request });
export const aiSuggestMetadata = (path: string, password: string | undefined, jobId: string) =>
  invoke<AiMetadataSuggestion>("ai_suggest_metadata", { request: { path, password: password || null, jobId } });
export const aiSaveOutput = (path: string, text: string, overwrite?: string) =>
  invoke<string>("ai_save_output", { path, text, overwrite: overwrite ?? null });
export const aiExamplePrompts = () => invoke<AiExamplePrompts>("ai_example_prompts");
export const aiModels = () => invoke<AiModelOption[]>("ai_models");

// ---------------------------------------------------------------------------
// AI library (saved results) and the operation log
// ---------------------------------------------------------------------------

export interface SaveAiEntryRequest {
  kind: string;
  sourcePath: string;
  sourceName: string;
  model: string;
  pages: number;
  characters: number;
  options: string;
  text: string;
  elapsedMs: number;
  directory?: string;
}

export const aiLibrarySave = (request: SaveAiEntryRequest) => invoke<AiLibraryEntry>("ai_library_save", { request });
export const aiLibraryList = () => invoke<AiLibraryEntry[]>("ai_library_list");
export const aiLibraryText = (id: string) => invoke<string>("ai_library_text", { id });
export const aiLibraryDelete = (id: string, deleteFile = true) =>
  invoke<AiLibraryEntry[]>("ai_library_delete", { id, deleteFile });
export const aiLibraryClear = (deleteFiles = true) => invoke<void>("ai_library_clear", { deleteFiles });
export const aiLibraryExport = (id: string, target: string) => invoke<string>("ai_library_export", { id, target });
export const aiLibraryDefaultDir = () => invoke<string>("ai_library_default_dir");

export const logOperation = (entry: {
  operation: string;
  inputPath: string;
  outputPath?: string;
  pageCount?: number;
  inputBytes?: number;
  outputBytes?: number;
  ok?: boolean;
  detail?: string;
}) => invoke<void>("log_operation", { entry }).catch(() => undefined);
export const loadOperations = () => invoke<OperationEntry[]>("load_operations");
export const clearOperations = () => invoke<void>("clear_operations");

export const onAiChunk = (
  handler: (payload: { jobId: string; delta: string; kind: "content" | "reasoning" }) => void,
): Promise<UnlistenFn> =>
  listen<{ jobId: string; delta: string; kind: "content" | "reasoning" }>("ai:chunk", (event) => handler(event.payload));

export const onAiProgress = (
  handler: (payload: { jobId: string; stage: string; current: number; total: number }) => void,
): Promise<UnlistenFn> => listen("ai:progress", (event) => handler(event.payload as never));

// ---------------------------------------------------------------------------
// Inspection
// ---------------------------------------------------------------------------

export const pdfInfo = (path: string, password?: string) =>
  invoke<PdfInfo>("pdf_info", { path, password: password || null });

export const pageThumbnail = (path: string, page: number, maxWidth = 200, password?: string) =>
  invoke<Thumbnail>("page_thumbnail", { path, page, maxWidth, password: password || null });

export const pagePreview = (
  path: string,
  page: number,
  maxWidth = 1100,
  password?: string,
  format: "png" | "jpeg" = "png",
  quality = 86,
) => invoke<Thumbnail>("page_preview", { path, page, maxWidth, password: password || null, format, quality });

export const pageText = (path: string, page: number, password?: string) =>
  invoke<string>("page_text", { path, page, password: password || null });

export const searchDocument = (
  path: string,
  query: string,
  matchCase: boolean,
  maxResults: number,
  password: string | undefined,
  jobId: string,
) =>
  invoke<SearchResponse>("search_document", {
    path,
    query,
    matchCase,
    maxResults,
    password: password ?? null,
    jobId,
  });

export const checkPassword = (path: string, password: string) =>
  invoke<boolean>("check_password", { path, password });

export const outputExists = (path: string) => invoke<boolean>("output_exists", { path });

export const suggestOutput = (input: string, suffix: string) =>
  invoke<string>("suggest_output", { input, suffix });

export const fileSizes = (paths: string[]) => invoke<(number | null)[]>("file_sizes", { paths });

export const logFrontend = (level: string, message: string) =>
  invoke<void>("log_frontend", { level, message }).catch(() => undefined);

export const devLaunchContext = () =>
  invoke<{ startScreen: string | null; files: string[] | null; autoRun: boolean; tab: string | null }>("dev_launch_context");

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export const mergePdfs = (
  inputs: string[],
  output: OutputSpec,
  preserveMetadata: boolean,
  jobId: string,
) => invoke<OpResult>("merge_pdfs", { request: { inputs, output, preserveMetadata, jobId } });

interface PagesPayload {
  input: string;
  pages?: number[];
  selection?: string;
  degrees?: number;
  output: OutputSpec;
  password?: string;
  jobId: string;
}

export const extractPages = (payload: PagesPayload) =>
  invoke<OpResult>("extract_pages", { request: payload });

export const deletePages = (payload: PagesPayload) =>
  invoke<OpResult>("delete_pages", { request: payload });

export const rotatePages = (payload: PagesPayload) =>
  invoke<OpResult>("rotate_pages", { request: payload });

export const applyPagePlan = (
  input: string,
  plan: PagePlanItem[],
  output: OutputSpec,
  jobId: string,
  password?: string,
) => invoke<OpResult>("apply_page_plan", { request: { input, plan, output, password, jobId } });

export const splitPdf = (
  input: string,
  mode: SplitMode,
  outputDir: string,
  overwrite: OutputSpec["overwrite"],
  jobId: string,
  password?: string,
) =>
  invoke<{ parts: { path: string; first_page: number; last_page: number }[]; outputDir: string }>(
    "split_pdf",
    { request: { input, mode, outputDir, overwrite, password, jobId } },
  );

export const estimateCompression = (input: string, options: CompressOptions, password?: string) =>
  invoke<CompressEstimate>("estimate_compression", { input, options, password: password || null });

export const compressPdf = (
  input: string,
  output: OutputSpec,
  options: CompressOptions,
  jobId: string,
  password?: string,
) => invoke<OpResult>("compress_pdf", { request: { input, output, options, password, jobId } });

export const ocrPdf = (
  input: string,
  output: OutputSpec,
  options: OcrOptions,
  jobId: string,
  password?: string,
) => invoke<OpResult>("ocr_pdf", { request: { input, output, options, password, jobId } });

export const protectPdf = (
  input: string,
  output: OutputSpec,
  options: ProtectOptions,
  jobId: string,
  password?: string,
) =>
  invoke<OpResult>("protect_pdf", {
    request: { input, output, ...options, password, jobId },
  });

export const unlockPdf = (input: string, output: OutputSpec, password: string, jobId: string) =>
  invoke<OpResult>("unlock_pdf", { request: { input, output, password, jobId } });

export const pdfToImages = (
  request: {
    input: string;
    outputDir: string;
    format: "jpeg" | "png";
    dpi: number;
    jpegQuality: number;
    grayscale: boolean;
    namePrefix: string;
    pages: number[];
    overwrite?: OutputSpec["overwrite"];
    password?: string;
    jobId: string;
  },
) =>
  invoke<{ files: { path: string; page: number; width: number; height: number; bytes: number }[]; totalBytes: number; dpi: number; format: string }>(
    "pdf_to_images",
    { request },
  );

export const imagesToPdf = (
  items: ImageItem[],
  output: OutputSpec,
  options: ImageToPdfOptions,
  jobId: string,
) => invoke<OpResult>("images_to_pdf", { request: { items, output, options, jobId } });

export const resizePages = (
  input: string,
  output: OutputSpec,
  options: { page_size: string; custom_width_pt: number; custom_height_pt: number; orientation: string; mode: string; pages: number[] },
  jobId: string,
  password?: string,
) => invoke<OpResult>("resize_pages", { request: { input, output, options, password, jobId } });

export const cropPages = (
  input: string,
  output: OutputSpec,
  crops: CropItem[],
  jobId: string,
  password?: string,
) => invoke<OpResult>("crop_pages", { request: { input, output, crops, password, jobId } });

export const editMetadata = (
  input: string,
  output: OutputSpec,
  metadata: {
    title: string;
    author: string;
    subject: string;
    keywords: string;
    creator: string;
    producer: string;
    creation_date: string;
    mod_date: string;
  },
  remove: boolean,
  jobId: string,
  password?: string,
) =>
  invoke<OpResult>("edit_metadata", {
    request: { input, output, metadata, remove, password, jobId },
  });

export const addPageNumbers = (
  input: string,
  output: OutputSpec,
  options: NumberingOptions,
  jobId: string,
  password?: string,
) => invoke<OpResult>("add_page_numbers", { request: { input, output, options, password, jobId } });

export const watermarkPdf = (
  input: string,
  output: OutputSpec,
  options: WatermarkOptions,
  jobId: string,
  password?: string,
) => invoke<OpResult>("watermark_pdf", { request: { input, output, options, password, jobId } });

export const annotatePdf = (
  input: string,
  output: OutputSpec,
  annotations: Annotation[],
  jobId: string,
  password?: string,
) => invoke<OpResult>("annotate_pdf", { request: { input, output, annotations, password, jobId } });

// ---------------------------------------------------------------------------
// Settings / recent
// ---------------------------------------------------------------------------

export const loadSettings = () => invoke<Partial<Settings>>("load_settings");
export const saveSettings = (settings: Settings) => invoke<void>("save_settings", { settings });
export const loadRecent = () => invoke<RecentEntry[]>("load_recent");
export const addRecent = (entry: RecentEntry) => invoke<void>("add_recent", { entry });
export const clearRecent = () => invoke<void>("clear_recent");
