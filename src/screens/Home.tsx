import { useEffect, useMemo, useState } from "react";
import {
  Archive,
  BookOpen,
  Bot,
  Combine,
  FileImage,
  FileSearch,
  Images,
  KeyRound,
  Layers,
  Lock,
  Minimize2,
  Scissors,
  Sparkles,
  Stamp,
  Type,
  Wand2,
} from "lucide-react";
import { Button, Card, EmptyState } from "../components/ui";
import { DropZone } from "../components/files";
import { Screen } from "../components/layout";
import { useT } from "../lib/i18n";
import { useRecent, useSettings } from "../lib/store";
import { fileBaseName, formatDate, isPdf } from "../lib/format";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import type { Navigate, ScreenId } from "../lib/nav";
import { fileStem } from "../lib/format";

export interface ToolCardSpec {
  id: ScreenId;
  titleKey: string;
  descKey: string;
  icon: React.ReactNode;
  accent?: boolean;
}

export function Home({
  onNavigate,
  onDropFiles,
  dragging,
  onFileList,
}: {
  onNavigate: Navigate;
  onDropFiles: (paths: string[]) => void;
  dragging: boolean;
  onFileList: (paths: string[]) => void;
}) {
  const t = useT();
  const recent = useRecent((s) => s.entries);
  const refreshRecent = useRecent((s) => s.refresh);
  const settings = useSettings((s) => s.settings);
  const [suggestion, setSuggestion] = useState<string | null>(null);

  useEffect(() => {
    void refreshRecent();
  }, [refreshRecent]);

  const cards: ToolCardSpec[] = useMemo(
    () => [
      { id: "reader", titleKey: "nav.reader", descKey: "reader.subtitle", icon: <BookOpen size={20} />, accent: true },
      { id: "ai", titleKey: "nav.ai", descKey: "ai.subtitle", icon: <Bot size={20} />, accent: true },
      { id: "merge", titleKey: "nav.merge", descKey: "merge.subtitle", icon: <Combine size={20} />, accent: true },
      { id: "organize", titleKey: "nav.organize", descKey: "organize.subtitle", icon: <Layers size={20} /> },
      { id: "split", titleKey: "nav.split", descKey: "split.subtitle", icon: <Scissors size={20} /> },
      { id: "compress", titleKey: "nav.compress", descKey: "compress.subtitle", icon: <Minimize2 size={20} />, accent: true },
      { id: "ocr", titleKey: "nav.ocr", descKey: "ocr.subtitle", icon: <FileSearch size={20} />, accent: true },
      { id: "pdfToImages", titleKey: "nav.pdfToImages", descKey: "convert.pdfToImagesSubtitle", icon: <FileImage size={20} />, accent: true },
      { id: "imagesToPdf", titleKey: "nav.imagesToPdf", descKey: "convert.imagesToPdfSubtitle", icon: <Images size={20} />, accent: true },
      { id: "watermark", titleKey: "nav.watermark", descKey: "watermark.subtitle", icon: <Stamp size={20} />, accent: true },
      { id: "protect", titleKey: "nav.protect", descKey: "security.protectSubtitle", icon: <Lock size={20} />, accent: true },
      { id: "annotate", titleKey: "annotate.title", descKey: "annotate.subtitle", icon: <Type size={20} /> },
      { id: "pageTools", titleKey: "nav.pageTools", descKey: "pageTools.resizeSubtitle", icon: <Wand2 size={20} /> },
      { id: "batch", titleKey: "nav.batch", descKey: "batch.subtitle", icon: <Archive size={20} /> },
    ],
    [],
  );

  return (
    <Screen title={t("app.name")} subtitle={t("app.tagline")}>
      <DropZone
        onPaths={(paths) => {
          onDropFiles(paths);
          const first = paths[0];
          if (first) setSuggestion(first);
        }}
        title={t("home.dropTitle")}
        hint={t("home.dropHint")}
        dragging={dragging}
      />

      {suggestion ? (
        <Card className="p-4 fade-in">
          <div className="flex items-center gap-2 mb-3">
            <Sparkles size={16} style={{ color: "var(--accent)" }} />
            <p className="text-[13.5px]">
              <strong>{fileBaseName(suggestion)}</strong> — {t("home.quickActions")}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {[
              ["reader", BookOpen],
              ["merge", Combine],
              ["organize", Layers],
              ["split", Scissors],
              ["compress", Minimize2],
              ["ocr", FileSearch],
              ["watermark", Stamp],
              ["protect", Lock],
            ].map(([id, Icon]) => {
              const IconComponent = Icon as typeof Combine;
              return (
                <Button
                  key={id as string}
                  size="sm"
                  icon={<IconComponent size={14} />}
                  onClick={() => onNavigate(id as ScreenId, { files: [suggestion] })}
                >
                  {t(`nav.${id}`)}
                </Button>
              );
            })}
            <Button size="sm" variant="ghost" icon={<KeyRound size={14} />} onClick={() => onNavigate("info", { files: [suggestion] })}>
              {t("nav.info")}
            </Button>
          </div>
        </Card>
      ) : null}

      <section>
        <h2 className="text-[13px] font-bold uppercase tracking-wider muted mb-3">{t("home.quickActions")}</h2>
        <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))" }}>
          {cards.map((card) => (
            <button key={card.id} className="tool-card" onClick={() => onNavigate(card.id)}>
              <span className="tool-icon" style={card.accent ? { background: "var(--accent)", color: "var(--accent-text)" } : undefined}>
                {card.icon}
              </span>
              <span>
                <span className="block font-semibold text-[14.5px]">{t(card.titleKey)}</span>
                <span className="block text-xs muted mt-1 leading-relaxed">{t(card.descKey)}</span>
              </span>
            </button>
          ))}
        </div>
      </section>

      {settings.showRecentFiles ? (
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-[13px] font-bold uppercase tracking-wider muted">{t("home.recent")}</h2>
            <Button size="sm" variant="ghost" onClick={() => onNavigate("history")}>
              {t("home.viewAll")}
            </Button>
          </div>
          {recent.length === 0 ? (
            <Card>
              <EmptyState icon={<FileImage size={22} />} title={t("home.recentEmpty")} hint={t("home.recentEmptyHint")} />
            </Card>
          ) : (
            <Card className="p-2">
              <div className="flex flex-col">
                {recent.slice(0, 6).map((entry) => (
                  <div key={entry.path} className="flex items-center gap-3 px-2.5 py-2 rounded-lg hover:bg-[var(--surface-2)]">
                    <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: "var(--accent-weak)", color: "var(--accent)" }}>
                      <FileImage size={15} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13.5px] font-medium">{entry.fileName || fileStem(entry.path)}</p>
                      <p className="text-xs muted truncate">{entry.path}</p>
                    </div>
                    <span className="text-xs muted shrink-0">{formatDate(entry.timestamp)}</span>
                    <div className="flex gap-1 shrink-0">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          if (isPdf(entry.path)) {
                            onFileList([entry.path]);
                            onNavigate("organize");
                          } else {
                            void openPath(entry.path).catch(() => undefined);
                          }
                        }}
                      >
                        {t("common.open")}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void revealItemInDir(entry.path).catch(() => undefined)}>
                        📁
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </section>
      ) : null}

      <Card soft className="p-4 flex items-start gap-3">
        <Lock size={16} style={{ color: "var(--ok)", marginTop: 2 }} />
        <div>
          <p className="font-semibold text-[13px]">{t("nav.privacy")}</p>
          <p className="text-xs muted mt-1">{t("home.privacyNote")} {t("home.supportedFormats")}</p>
        </div>
      </Card>


    </Screen>
  );
}
