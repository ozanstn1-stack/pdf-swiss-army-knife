/**
 * Shared save/open/export/version-history logic for the office editors.
 * Keeps the editors focused on editing while this hook deals with files.
 */
import { useCallback, useEffect, useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import type { OfficeKind } from "../lib/office-types";
import { openOfficePath, useOfficeTabs, type OfficeTab } from "../lib/office-store";
import { useSettings, useToasts, reportError } from "../lib/store";
import { useT } from "../lib/i18n";
import * as api from "../lib/office-api";

const FILTERS: Record<OfficeKind, { name: string; extensions: string[] }[]> = {
  writer: [
    { name: "Word document", extensions: ["docx"] },
    { name: "OpenDocument text", extensions: ["odt"] },
    { name: "Rich text", extensions: ["rtf"] },
    { name: "Plain text", extensions: ["txt"] },
    { name: "Markdown", extensions: ["md"] },
    { name: "Web page", extensions: ["html"] },
    { name: "PDF", extensions: ["pdf"] },
    { name: "Office Swiss Army Knife document", extensions: ["oswk"] },
  ],
  calc: [
    { name: "Excel workbook", extensions: ["xlsx"] },
    { name: "OpenDocument spreadsheet", extensions: ["ods"] },
    { name: "CSV", extensions: ["csv"] },
    { name: "PDF", extensions: ["pdf"] },
    { name: "Office Swiss Army Knife spreadsheet", extensions: ["oswk"] },
  ],
  impress: [
    { name: "PowerPoint presentation", extensions: ["pptx"] },
    { name: "OpenDocument presentation", extensions: ["odp"] },
    { name: "PDF", extensions: ["pdf"] },
    { name: "Office Swiss Army Knife presentation", extensions: ["oswk"] },
  ],
};

export function extensionOf(path: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(path);
  return match ? match[1].toLowerCase() : "";
}

const DEFAULT_EXTENSION: Record<OfficeKind, string> = { writer: "docx", calc: "xlsx", impress: "pptx" };

/** Suggests a file name for the save dialog when the tab has never been saved. */
function suggestedName(tab: OfficeTab, extension: string): string {
  const stem = (tab.title || "Untitled").replace(/[\\/:*?"<>|]/g, "-").trim() || "Untitled";
  return `${stem}.${extension}`;
}

export function useOfficeSession(tab: OfficeTab) {
  const t = useT();
  const markSaved = useOfficeTabs((state) => state.markSaved);
  const [busy, setBusy] = useState(false);

  const notify = (title: string, detail?: string) => {
    useToasts.getState().push({ kind: "success", title, detail });
  };

  const save = useCallback(
    async (targetPath?: string): Promise<string | null> => {
      // Ctrl+S keeps the current path; the caller that wants a new file must ask,
      // which is why `saveAs` no longer routes through `save(undefined)`.
      let path = targetPath ?? tab.path ?? undefined;
      if (!path) {
        path = (await saveDialog({
          title: `Save ${tab.title}`,
          defaultPath: suggestedName(tab, DEFAULT_EXTENSION[tab.kind]),
          filters: FILTERS[tab.kind],
        })) ?? undefined;
        if (!path) return null;
      }
      setBusy(true);
      try {
        const extension = extensionOf(path);
        // The native unit format carries everything the suite understands, so it
        // is the one target where a save is a full snapshot. Every other format
        // can drop features, which the engine reports through `warnings`.
        const lossless = extension === "oswk";
        const result = lossless
          ? await api.saveUnit(tab.kind, tab.title, tab.model, path)
          : await api.saveDocument(tab.kind, tab.model, path);
        markSaved(tab.id, result.path);
        if (result.warnings.length > 0) {
          useToasts.getState().push({ kind: "info", title: t("office.savedWithNotes"), detail: result.warnings.join(" ") });
        } else {
          notify(t("office.saved"), result.path);
        }
        void api.historyPush(tab.id, tab.kind, tab.title, tab.model).catch(() => undefined);
        if (!lossless && result.warnings.length > 0) {
          // A lossy export may have dropped something the user cares about, so
          // the recovery snapshot stays on disk until the next clean save.
          useToasts.getState().push({ kind: "info", title: t("office.recoveryKept"), detail: t("office.recoveryKeptHint") });
          return result.path;
        }
        void api.recoveryDiscard(tab.id).catch(() => undefined);
        return result.path;
      } catch (error) {
        reportError(error, t);
        return null;
      } finally {
        setBusy(false);
      }
    },
    [markSaved, t, tab],
  );

  /** Always asks for a destination, even when the tab already has a path. */
  const saveAs = useCallback(async (): Promise<string | null> => {
    const chosen = (await saveDialog({
      title: `Save ${tab.title} as`,
      defaultPath: tab.path ?? suggestedName(tab, extensionOf(tab.path ?? "") || DEFAULT_EXTENSION[tab.kind]),
      filters: FILTERS[tab.kind],
    })) as string | null;
    if (!chosen) return null;
    return save(chosen);
  }, [save, tab]);

  const exportPdf = useCallback(async (): Promise<string | null> => {
    const path = (await saveDialog({
      title: `Export ${tab.title} as PDF`,
      defaultPath: `${tab.title}.pdf`,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    })) as string | null;
    if (!path) return null;
    setBusy(true);
    try {
      const result = await api.exportPdf(tab.kind, tab.model, path);
      useToasts.getState().push({ kind: "success", title: t("office.pdfExported"), detail: result.path });
      return result.path;
    } catch (error) {
      reportError(error, t);
      return null;
    } finally {
      setBusy(false);
    }
  }, [t, tab]);

  const openRecentVersion = useCallback(
    async (version: number) => {
      try {
        const model = await api.historyLoad(tab.id, version);
        if (model) {
          useOfficeTabs.getState().edit(tab.id, () => model as never);
          useToasts.getState().push({ kind: "info", title: t("office.versionRestored"), detail: `v${version}` });
        }
      } catch (error) {
        reportError(error, t);
      }
    },
    [t, tab.id],
  );

  const choosePath = useCallback(async (): Promise<string | null> => {
    const path = (await saveDialog({
      title: `Save ${tab.title}`,
      defaultPath: `${tab.title}.${tab.kind === "writer" ? "docx" : tab.kind === "calc" ? "xlsx" : "pptx"}`,
      filters: FILTERS[tab.kind],
    })) as string | null;
    return path;
  }, [tab]);

  const openFile = useCallback(async (): Promise<string | null> => {
    const selection = await openDialog({
      multiple: false,
      filters: [
        {
          name: "Office documents",
          extensions: ["docx", "odt", "rtf", "txt", "md", "html", "xlsx", "ods", "csv", "pptx", "odp", "oswk"],
        },
      ],
    });
    return typeof selection === "string" ? selection : null;
  }, []);

  const autosaveInterval = useSettings((state) => state.settings).autosaveSeconds ?? 30;

  return { save, saveAs, exportPdf, busy, openRecentVersion, choosePath, openFile, autosaveInterval };
}

/**
 * Standard office keyboard shortcuts (Ctrl+S / Ctrl+Shift+S / Ctrl+O / Ctrl+P,
 * plus optional Ctrl+F / Ctrl+H). Uses capture phase so the editor wins over
 * the global PDF shortcuts.
 */
export function useEditorShortcuts(
  session: ReturnType<typeof useOfficeSession>,
  handlers?: { onFind?: () => void; onReplace?: () => void },
) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (key === "s") {
        event.preventDefault();
        event.stopImmediatePropagation();
        void (event.shiftKey ? session.saveAs() : session.save());
        return;
      }
      if (key === "o") {
        event.preventDefault();
        event.stopImmediatePropagation();
        void openIntoWorkspace();
        return;
      }
      if (key === "p") {
        event.preventDefault();
        event.stopImmediatePropagation();
        window.print();
        return;
      }
      if (key === "f" && handlers?.onFind) {
        event.preventDefault();
        event.stopImmediatePropagation();
        handlers.onFind();
        return;
      }
      if (key === "h" && handlers?.onReplace) {
        event.preventDefault();
        event.stopImmediatePropagation();
        handlers.onReplace();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [handlers?.onFind, handlers?.onReplace, session]);
}

/** Opens a file dialog and adds the chosen document as a workspace tab. */
export async function openIntoWorkspace(): Promise<string | null> {
  const selection = await openDialog({
    multiple: false,
    filters: [
      { name: "Documents", extensions: ["docx", "odt", "rtf", "txt", "md", "html", "xlsx", "ods", "csv", "pptx", "odp", "oswk"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (typeof selection !== "string") return null;
  const result = await openOfficePath(selection);
  if (!result.ok) {
    useToasts.getState().push({ kind: "error", title: "Unable to open this document.", detail: result.error });
    return null;
  }
  return selection;
}