/**
 * Shared save/open/export/version-history logic for the office editors.
 * Keeps the editors focused on editing while this hook deals with files.
 */
import { useCallback, useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import type { OfficeKind } from "../lib/office-types";
import { useOfficeTabs, type OfficeTab } from "../lib/office-store";
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

export function useOfficeSession(tab: OfficeTab) {
  const t = useT();
  const markSaved = useOfficeTabs((state) => state.markSaved);
  const [busy, setBusy] = useState(false);

  const notify = (title: string, detail?: string) => {
    useToasts.getState().push({ kind: "success", title, detail });
  };

  const save = useCallback(
    async (targetPath?: string): Promise<string | null> => {
      let path = targetPath ?? tab.path ?? undefined;
      if (!path) {
        path = (await saveDialog({
          title: `Save ${tab.title}`,
          defaultPath: `${tab.title}.${tab.kind === "writer" ? "docx" : tab.kind === "calc" ? "xlsx" : "pptx"}`,
          filters: FILTERS[tab.kind],
        })) ?? undefined;
        if (!path) return null;
      }
      setBusy(true);
      try {
        const extension = extensionOf(path);
        if (extension === "oswk") {
          const result = await api.saveUnit(tab.kind, tab.title, tab.model, path);
          markSaved(tab.id, result.path);
          notify(t("office.saved"), result.path);
          return result.path;
        }
        const result = await api.saveDocument(tab.kind, tab.model, path);
        markSaved(tab.id, result.path);
        if (result.warnings.length > 0) {
          useToasts.getState().push({ kind: "info", title: t("office.savedWithNotes"), detail: result.warnings.join(" ") });
        } else {
          notify(t("office.saved"), result.path);
        }
        void api.historyPush(tab.id, tab.kind, tab.title, tab.model).catch(() => undefined);
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

  const saveAs = useCallback(async () => save(undefined), [save]);

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
