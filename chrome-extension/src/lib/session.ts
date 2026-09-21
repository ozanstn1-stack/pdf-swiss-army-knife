import { useCallback, useEffect, useMemo, useState } from "react";
import type { OperationResult, PdfInfo } from "./types";
import { readInfo } from "./pdf";
import { fileBaseName, isImageName, isPdfName } from "./format";
import { takePendingFiles } from "./pending";

export interface LocalFile {
  name: string;
  size: number;
  type: string;
  bytes: Uint8Array;
}

export function describeError(error: unknown): { code: string; message: string } {
  if (error && typeof error === "object" && "code" in error && "message" in error) {
    const typed = error as { code: string; message: string };
    return { code: typed.code, message: typed.message };
  }
  if (error instanceof Error) return { code: "internal", message: error.message };
  return { code: "internal", message: String(error) };
}

export async function readFileList(list: FileList | File[]): Promise<LocalFile[]> {
  const files = Array.from(list);
  const output: LocalFile[] = [];
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    output.push({ name: file.name, size: file.size, type: file.type, bytes });
  }
  return output;
}

/** Triggers a browser download for a produced file (no server involved). */
export function downloadResult(result: OperationResult): void {
  const blob = new Blob([result.bytes as BlobPart], { type: result.mime ?? "application/pdf" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = result.fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function downloadBlob(fileName: string, bytes: Uint8Array, type: string): void {
  const blob = new Blob([bytes as BlobPart], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

let fontCache: { sans: Uint8Array; sansBold: Uint8Array } | null = null;

/** Loads the bundled OFL font used for Unicode watermarks/stamps. */
export async function loadStampFonts(): Promise<{ sans: Uint8Array; sansBold: Uint8Array }> {
  if (fontCache) return fontCache;
  const base =
    typeof chrome !== "undefined" && chrome.runtime?.getURL ? chrome.runtime.getURL("") : new URL(".", location.href).href;
  const [regular, bold] = await Promise.all([
    fetch(`${base}fonts/PT_Sans-Web-Regular.ttf`).then((response) => response.arrayBuffer()),
    fetch(`${base}fonts/PT_Sans-Web-Bold.ttf`).then((response) => response.arrayBuffer()),
  ]);
  fontCache = { sans: new Uint8Array(regular), sansBold: new Uint8Array(bold) };
  return fontCache;
}

export interface ProgressState {
  label: string;
  current: number;
  total: number;
}

export interface PdfSession {
  files: LocalFile[];
  primary: LocalFile | null;
  info: PdfInfo | null;
  infoLoading: boolean;
  busy: boolean;
  progress: ProgressState | null;
  results: OperationResult[];
  error: { code: string; message: string } | null;
  addFiles: (list: FileList | File[]) => Promise<void>;
  removeFile: (index: number) => void;
  moveFile: (from: number, to: number) => void;
  clearFiles: () => void;
  setResults: (results: OperationResult[]) => void;
  setProgress: (progress: ProgressState | null) => void;
  setError: (error: { code: string; message: string } | null) => void;
  run: (task: () => Promise<OperationResult | OperationResult[] | void>, label?: string) => Promise<void>;
  accept: string;
  multiple: boolean;
}

/**
 * Shared file/result state for a tool: matches the desktop app's flow
 * (pick files -> options -> run -> download results) without any backend.
 */
export function usePdfSession(options: { accept?: "pdf" | "image" | "any"; multiple?: boolean } = {}): PdfSession {
  const accept = options.accept ?? "pdf";
  const multiple = options.multiple ?? false;
  const [files, setFiles] = useState<LocalFile[]>([]);
  const [info, setInfo] = useState<PdfInfo | null>(null);
  const [infoLoading, setInfoLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [results, setResults] = useState<OperationResult[]>([]);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);

  const accepted = useCallback(
    (file: LocalFile) => {
      if (accept === "pdf") return isPdfName(file.name);
      if (accept === "image") return isImageName(file.name);
      return isPdfName(file.name) || isImageName(file.name);
    },
    [accept],
  );

  const addFiles = useCallback(
    async (list: FileList | File[]) => {
      const incoming = (await readFileList(list)).filter(accepted);
      if (!incoming.length) {
        setError({ code: "unsupported", message: accept === "pdf" ? "Select a PDF file." : "Select an image file." });
        return;
      }
      setError(null);
      setResults([]);
      setFiles((previous) => (multiple ? [...previous, ...incoming] : incoming.slice(0, 1)));
    },
    [accepted, accept, multiple],
  );

  const primary = files.length ? files[0] : null;

  // Files handed over by the home screen (e.g. "Merge this PDF").
  useEffect(() => {
    const handedOver = takePendingFiles();
    if (handedOver?.length) void addFiles(handedOver);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load document info whenever the primary PDF changes.
  const primaryKey = primary ? `${primary.name}:${primary.size}` : "";
  useMemo(() => {
    if (!primary || !isPdfName(primary.name)) {
      setInfo(null);
      return;
    }
    setInfoLoading(true);
    void readInfo(primary.name, primary.bytes)
      .then((result) => setInfo(result))
      .catch((loadError) => setError(describeError(loadError)))
      .finally(() => setInfoLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primaryKey]);

  const removeFile = useCallback((index: number) => {
    setFiles((previous) => previous.filter((_, i) => i !== index));
    setResults([]);
  }, []);

  const moveFile = useCallback((from: number, to: number) => {
    setFiles((previous) => {
      if (from === to || from < 0 || to < 0 || from >= previous.length || to >= previous.length) return previous;
      const next = [...previous];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
  }, []);

  const clearFiles = useCallback(() => {
    setFiles([]);
    setInfo(null);
    setResults([]);
    setError(null);
  }, []);

  const run = useCallback(
    async (task: () => Promise<OperationResult | OperationResult[] | void>, label = "Processing") => {
      setBusy(true);
      setError(null);
      setProgress({ label, current: 0, total: 1 });
      try {
        const outcome = await task();
        if (outcome) {
          setResults(Array.isArray(outcome) ? outcome : [outcome]);
        }
      } catch (taskError) {
        setError(describeError(taskError));
      } finally {
        setProgress(null);
        setBusy(false);
      }
    },
    [],
  );

  return {
    files,
    primary,
    info,
    infoLoading,
    busy,
    progress,
    results,
    error,
    addFiles,
    removeFile,
    moveFile,
    clearFiles,
    setResults,
    setProgress,
    setError,
    run,
    accept,
    multiple,
  };
}

export function resultFor(fileName: string, bytes: Uint8Array, detail: string): OperationResult {
  return { fileName, bytes, detail };
}

export function suggestedName(name: string, suffix: string): string {
  const base = fileBaseName(name);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? `${base.slice(0, dot)}${suffix}.pdf` : `${base}${suffix}.pdf`;
}
