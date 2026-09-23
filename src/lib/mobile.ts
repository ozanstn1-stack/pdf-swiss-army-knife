import { invoke } from "@tauri-apps/api/core";
import { appCacheDir, join } from "@tauri-apps/api/path";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import * as AndroidFs from "tauri-plugin-android-fs-api";
import { fileBaseName, uid } from "./format";

// ---------------------------------------------------------------------------
// Android file bridge
//
// The desktop UI is built around real filesystem paths: every Tauri command
// reads and writes plain files. Android does not hand out paths for files the
// user picks (the Storage Access Framework returns content:// URIs), and it
// does not let ordinary files be opened by other apps either. This module
// closes that gap:
//
//   * picked documents are copied into the app cache and handed to the UI as
//     ordinary paths, so every tool keeps working unchanged;
//   * finished documents are published to the public Downloads folder (or to
//     a destination the user picked) and the resulting content:// URI is used
//     for "open" and "share".
//
// Everything here is a no-op on desktop.
// ---------------------------------------------------------------------------

let androidCache: boolean | null = null;

/** True when running inside the Android WebView. */
export function isAndroid(): boolean {
  if (androidCache !== null) return androidCache;
  androidCache = typeof navigator !== "undefined" && /android/i.test(navigator.userAgent);
  return androidCache;
}

const publishedUris = new Map<string, AndroidFs.FsUri>();

/** Content URI of a document the app published (after open/share/save). */
export function publishedUri(path: string): string | undefined {
  return publishedUris.get(path)?.uri;
}

function sanitizeName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]/g, "_").trim();
  return cleaned || "document.pdf";
}

function uniqueName(name: string, taken: Set<string>): string {
  if (!taken.has(name.toLowerCase())) {
    taken.add(name.toLowerCase());
    return name;
  }
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  let index = 2;
  let candidate = `${stem} (${index})${extension}`;
  while (taken.has(candidate.toLowerCase())) {
    index += 1;
    candidate = `${stem} (${index})${extension}`;
  }
  taken.add(candidate.toLowerCase());
  return candidate;
}

export function mimeForName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".bmp")) return "image/bmp";
  if (lower.endsWith(".tif") || lower.endsWith(".tiff")) return "image/tiff";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".txt")) return "text/plain";
  if (lower.endsWith(".md")) return "text/markdown";
  return "application/octet-stream";
}

function mimeFilters(accept: "pdf" | "image" | "any"): string[] {
  if (accept === "pdf") return ["application/pdf"];
  if (accept === "image") return ["image/*"];
  return ["application/pdf", "image/*"];
}

/** Picks documents through the system picker and imports them as local paths. */
export async function pickAndroidFiles(options: {
  multiple: boolean;
  accept: "pdf" | "image" | "any";
}): Promise<string[]> {
  const picked = await AndroidFs.showOpenFilePicker({
    multiple: options.multiple,
    mimeTypes: mimeFilters(options.accept),
    localOnly: true,
  });
  if (!picked.length) return [];

  const cache = await appCacheDir();
  const directory = await join(cache, "imports", uid("import"));
  await invoke("ensure_dir", { path: directory });

  const taken = new Set<string>();
  const paths: string[] = [];
  for (const uri of picked) {
    let name = "document.pdf";
    try {
      name = sanitizeName(await AndroidFs.getName(uri));
    } catch {
      name = "document.pdf";
    }
    const destination = await join(directory, uniqueName(name, taken));
    await AndroidFs.copyFile(uri, destination, { create: true });
    paths.push(destination);
  }
  return paths;
}

export interface AndroidTarget {
  uri: AndroidFs.FsUri;
  name: string;
}

/** Picks a destination file (SAF "save as") for a single output. */
export async function pickAndroidSaveTarget(
  defaultName: string,
  mimeType?: string,
): Promise<AndroidTarget | null> {
  const uri = await AndroidFs.showSaveFilePicker(defaultName, mimeType ?? mimeForName(defaultName));
  if (!uri) return null;
  const name = await AndroidFs.getName(uri).catch(() => defaultName);
  return { uri, name };
}

/** Picks a destination folder (SAF) for tools that produce several files. */
export async function pickAndroidFolder(): Promise<AndroidTarget | null> {
  const uri = await AndroidFs.showOpenDirPicker();
  if (!uri) return null;
  const name = await AndroidFs.getName(uri).catch(() => "folder");
  return { uri, name };
}

async function ensurePublicAccess(): Promise<void> {
  const level = await AndroidFs.getAndroidApiLevel().catch(() => 29);
  if (level >= 29) return;
  const granted = await AndroidFs.checkPublicFilesPermission().catch(() => false);
  if (!granted) {
    await AndroidFs.requestPublicFilesPermission().catch(() => false);
  }
}

async function createPublicDownload(name: string, mimeType: string): Promise<AndroidFs.FsUri> {
  const taken = new Set<string>();
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const candidate = uniqueName(name, taken);
    try {
      return await AndroidFs.createNewPublicFile(
        AndroidFs.PublicGeneralPurposeDir.Download,
        `PDF Swiss Army Knife/${candidate}`,
        mimeType,
        { isPending: true },
      );
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("could not create a destination file");
}

async function createInDir(dirUri: AndroidFs.FsUri, name: string, mimeType: string): Promise<AndroidFs.FsUri> {
  const taken = new Set<string>();
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const candidate = uniqueName(name, taken);
    try {
      return await AndroidFs.createNewFile(dirUri, candidate, mimeType);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("could not create a destination file");
}

export interface PublishTarget {
  /** A single file chosen with the save dialog. */
  file?: AndroidTarget | null;
  /** A folder chosen with the directory picker. */
  dir?: AndroidTarget | null;
}

/**
 * Copies finished documents to a user-visible location and remembers the
 * resulting content URIs so they can be opened or shared afterwards.
 * Without an explicit target the documents land in
 * `Downloads/PDF Swiss Army Knife`.
 */
export async function publishOutputs(paths: string[], target?: PublishTarget): Promise<void> {
  if (!isAndroid() || !paths.length) return;
  if (!target?.file && !target?.dir) {
    await ensurePublicAccess();
  }
  for (const path of paths) {
    const name = fileBaseName(path);
    const mimeType = mimeForName(name);
    try {
      let uri: AndroidFs.FsUri;
      if (target?.file) {
        uri = target.file.uri;
        await AndroidFs.copyFile(path, uri, { create: false });
      } else if (target?.dir) {
        uri = await createInDir(target.dir.uri, name, mimeType);
        await AndroidFs.copyFile(path, uri, { create: false });
      } else {
        uri = await createPublicDownload(name, mimeType);
        await AndroidFs.copyFile(path, uri, { create: false });
        await AndroidFs.setPublicFilePending(uri, false).catch(() => undefined);
        await AndroidFs.scanPublicFile(uri).catch(() => undefined);
      }
      publishedUris.set(path, uri);
    } catch (error) {
      console.error("publish failed", path, error);
    }
  }
}

/**
 * Android replacement for the desktop "save" dialog: asks for a destination
 * and writes text straight into it. Returns false when the user cancels.
 */
export async function saveTextOnAndroid(text: string, defaultName: string): Promise<boolean> {
  const target = await pickAndroidSaveTarget(defaultName, mimeForName(defaultName));
  if (!target) return false;
  await AndroidFs.writeTextFile(target.uri, text);
  publishedUris.set(defaultName, target.uri);
  return true;
}

/**
 * Android replacement for the desktop "save" dialog: asks for a destination
 * and copies an existing document into it. Returns the chosen name or null.
 */
export async function saveFileOnAndroid(sourcePath: string, defaultName?: string): Promise<string | null> {
  const name = defaultName ?? fileBaseName(sourcePath);
  const target = await pickAndroidSaveTarget(name);
  if (!target) return null;
  await AndroidFs.copyFile(sourcePath, target.uri, { create: false });
  publishedUris.set(sourcePath, target.uri);
  return target.name;
}

/** Opens a document with the system viewer (Android) or default app. */
export async function openAnyFile(path: string): Promise<void> {
  if (!isAndroid()) {
    await openPath(path);
    return;
  }
  let uri = publishedUris.get(path);
  if (!uri) {
    await publishOutputs([path]);
    uri = publishedUris.get(path);
  }
  if (uri) {
    await AndroidFs.showViewFileAppChooser(uri);
  }
}

/** Shares a document with another app (Android) or reveals it in the folder. */
export async function revealAnyFile(path: string): Promise<void> {
  if (!isAndroid()) {
    await revealItemInDir(path);
    return;
  }
  let uri = publishedUris.get(path);
  if (!uri) {
    await publishOutputs([path]);
    uri = publishedUris.get(path);
  }
  if (uri) {
    await AndroidFs.showShareFileAppChooser(uri);
  }
}
