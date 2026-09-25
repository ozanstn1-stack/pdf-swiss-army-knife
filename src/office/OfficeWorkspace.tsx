/**
 * Office workspace: a tab bar over the Writer/Calc/Impress editors with
 * shared autosave, crash recovery and version-history affordances.
 */
import { useCallback, useEffect, useState } from "react";
import { FilePlus2, FileSpreadsheet, FileText, Presentation, RotateCcw, X } from "lucide-react";
import { useRecovery, useOfficeTabs } from "../lib/office-store";
import type { OfficeKind } from "../lib/office-types";
import { useSettings, useToasts } from "../lib/store";
import { useT } from "../lib/i18n";
import { WriterEditor } from "./WriterEditor";
import { CalcEditor } from "./CalcEditor";
import { ImpressEditor } from "./ImpressEditor";

export function OfficeWorkspace() {
  const t = useT();
  const tabs = useOfficeTabs((state) => state.tabs);
  const activeId = useOfficeTabs((state) => state.activeId);
  const { create, activate, close } = useOfficeTabs();
  const settings = useSettings((state) => state.settings);
  const recovery = useRecovery();
  const [recovered, setRecovered] = useState<Array<{ documentId: string; kind: string; title: string }>>([]);

  useEffect(() => {
    void recovery.refresh().then((records) => {
      if (records.length > 0) setRecovered(records);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Autosave every configured interval; snapshots land in the recovery folder.
  useEffect(() => {
    const seconds = settings.autosaveSeconds ?? 30;
    if (!seconds || seconds <= 0) return;
    const timer = window.setInterval(() => {
      for (const tab of useOfficeTabs.getState().tabs) {
        if (tab.dirty) void useRecovery.getState().save(tab);
      }
    }, seconds * 1000);
    return () => window.clearInterval(timer);
  }, [settings.autosaveSeconds]);

  const restore = useCallback(
    async (documentId: string) => {
      const payload = await useRecovery.getState().restore(documentId);
      if (!payload) return;
      const title = recovered.find((entry) => entry.documentId === documentId)?.title ?? "Recovered document";
      const kind = payload.kind as OfficeKind;
      create(kind, title, payload.model as never);
      await useRecovery.getState().discard(documentId);
      setRecovered((current) => current.filter((entry) => entry.documentId !== documentId));
      useToasts.getState().push({ kind: "success", title: t("office.recovered"), detail: title });
    },
    [create, recovered, t],
  );

  const active = tabs.find((tab) => tab.id === activeId) ?? tabs[tabs.length - 1] ?? null;

  return (
    <div className="office-workspace">
      <div className="office-tabs">
        <div className="office-tab-list">
          {tabs.map((tab) => (
            <div key={tab.id} className={`office-tab${tab.id === active?.id ? " is-active" : ""}`} onClick={() => activate(tab.id)} title={tab.path ?? tab.title}>
              <span className={`office-tab-dot kind-${tab.kind}`} />
              <span className="office-tab-title">
                {tab.title}
                {tab.dirty ? " •" : ""}
              </span>
              <button
                type="button"
                className="icon-btn"
                onClick={(event) => {
                  event.stopPropagation();
                  close(tab.id);
                }}
                aria-label={t("common.close")}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
        <div className="office-tab-actions">
          <button type="button" className="tool-btn is-icon-only" title={t("office.newDocument")} onClick={() => create("writer")}>
            <FileText size={15} />
          </button>
          <button type="button" className="tool-btn is-icon-only" title={t("office.newSpreadsheet")} onClick={() => create("calc")}>
            <FileSpreadsheet size={15} />
          </button>
          <button type="button" className="tool-btn is-icon-only" title={t("office.newPresentation")} onClick={() => create("impress")}>
            <Presentation size={15} />
          </button>
        </div>
      </div>

      {recovered.length > 0 ? (
        <div className="recovery-banner">
          <RotateCcw size={15} />
          <span>{t("office.recoveryAvailable")}</span>
          <span className="spacer" />
          {recovered.slice(0, 3).map((entry) => (
            <button key={entry.documentId} type="button" className="btn btn-soft" onClick={() => void restore(entry.documentId)}>
              {entry.title}
            </button>
          ))}
          <button
            type="button"
            className="btn btn-soft"
            onClick={async () => {
              for (const entry of recovered) await useRecovery.getState().discard(entry.documentId);
              setRecovered([]);
            }}
          >
            {t("office.discardAll")}
          </button>
        </div>
      ) : null}

      <div className="office-editor-host">
        {active ? (
          active.kind === "writer" ? (
            <WriterEditor key={active.id} tab={active as never} />
          ) : active.kind === "calc" ? (
            <CalcEditor key={active.id} tab={active as never} />
          ) : (
            <ImpressEditor key={active.id} tab={active as never} />
          )
        ) : (
          <div className="empty-state">
            <FilePlus2 size={26} />
            <h3>{t("office.noTabs")}</h3>
            <p className="muted">{t("office.noTabsHint")}</p>
            <div className="row">
              <button type="button" className="btn btn-primary" onClick={() => create("writer")}>
                {t("office.newDocument")}
              </button>
              <button type="button" className="btn btn-soft" onClick={() => create("calc")}>
                {t("office.newSpreadsheet")}
              </button>
              <button type="button" className="btn btn-soft" onClick={() => create("impress")}>
                {t("office.newPresentation")}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
