import { useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  FileSearch,
  HardDrive,
  KeyRound,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { Badge, Card, Kbd } from "../components/ui";
import { Screen } from "../components/layout";
import { useT } from "../lib/i18n";
import { useSettings } from "../lib/store";
import { appInfo } from "../lib/api";

function VersionLine() {
  const t = useT();
  const [version, setVersion] = useState("");
  useEffect(() => {
    void appInfo()
      .then((info) => setVersion(`v${info.appVersion} · core ${info.coreVersion} · ${info.platform}`))
      .catch(() => setVersion("v1.1.0"));
  }, []);
  return (
    <p className="text-xs muted">
      {t("settings.version")}: {version || "…"}
    </p>
  );
}

export function Settings() {
  const t = useT();
  const settings = useSettings((s) => s.settings);
  const engine = useSettings((s) => s.engine);
  const languages = useSettings((s) => s.languages);
  const update = useSettings((s) => s.update);

  const toggleLanguage = (code: string) => {
    const next = settings.ocrLanguages.includes(code)
      ? settings.ocrLanguages.filter((value) => value !== code)
      : [...settings.ocrLanguages, code];
    void update({ ocrLanguages: next.length ? next : ["eng"] });
  };

  const shortcuts: [string, string][] = [
    ["Ctrl + O", t("nav.home")],
    ["Ctrl + ,", t("nav.settings")],
    ["Ctrl + A", t("common.selectAll")],
    ["Delete", t("common.delete")],
    ["Ctrl + Z", t("common.undo")],
    ["Ctrl + Y", t("common.redo")],
    ["Esc", t("common.cancel")],
  ];

  return (
    <Screen title={t("settings.title")} subtitle={t("settings.subtitle")}>
      <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))" }}>
        <Card className="p-5 flex flex-col gap-4">
          <h3 className="font-semibold flex items-center gap-2">
            <Sparkles size={16} style={{ color: "var(--accent)" }} /> {t("settings.appearance")}
          </h3>
          <div>
            <label className="label">{t("settings.theme")}</label>
            <div className="seg">
              {(["dark", "light", "system"] as const).map((theme) => (
                <button key={theme} data-active={settings.theme === theme} onClick={() => void update({ theme })}>
                  {t(`settings.${theme}`)}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="label">{t("settings.language")}</label>
            <div className="seg">
              <button data-active={settings.language === "en"} onClick={() => void update({ language: "en" })}>
                English
              </button>
              <button data-active={settings.language === "tr"} onClick={() => void update({ language: "tr" })}>
                Türkçe
              </button>
            </div>
          </div>
        </Card>

        <Card className="p-5 flex flex-col gap-4">
          <h3 className="font-semibold flex items-center gap-2">
            <HardDrive size={16} style={{ color: "var(--accent)" }} /> {t("settings.defaults")}
          </h3>
          <div>
            <label className="label">{t("settings.defaultOutputDir")}</label>
            <input
              className="input"
              value={settings.defaultOutputDir}
              placeholder={t("settings.sameAsInput")}
              onChange={(event) => void update({ defaultOutputDir: event.target.value })}
            />
          </div>
          <div>
            <label className="label">{t("settings.defaultCompression")}</label>
            <div className="seg">
              {(["low", "medium", "high"] as const).map((preset) => (
                <button
                  key={preset}
                  data-active={settings.defaultCompression === preset}
                  onClick={() => void update({ defaultCompression: preset })}
                >
                  {t(`compress.${preset}`)}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="label">{t("settings.defaultImageDpi")}</label>
            <div className="seg">
              {[72, 150, 300].map((dpi) => (
                <button key={dpi} data-active={settings.defaultImageDpi === dpi} onClick={() => void update({ defaultImageDpi: dpi })}>
                  {dpi}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="label">{t("settings.defaultExportFormat")}</label>
            <div className="seg">
              {(["jpg", "png"] as const).map((format) => (
                <button
                  key={format}
                  data-active={settings.defaultExportFormat === format}
                  onClick={() => void update({ defaultExportFormat: format })}
                >
                  {format.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
        </Card>

        <Card className="p-5 flex flex-col gap-4">
          <h3 className="font-semibold flex items-center gap-2">
            <FileSearch size={16} style={{ color: "var(--accent)" }} /> {t("settings.ocrLanguage")}
          </h3>
          <div className="flex flex-wrap gap-2">
            {languages.map((language) => (
              <button
                key={language.code}
                type="button"
                className="badge"
                style={{
                  cursor: "pointer",
                  padding: "6px 12px",
                  background: settings.ocrLanguages.includes(language.code) ? "var(--accent)" : "var(--surface-3)",
                  color: settings.ocrLanguages.includes(language.code) ? "var(--accent-text)" : "var(--muted)",
                }}
                onClick={() => toggleLanguage(language.code)}
              >
                {language.name}
              </button>
            ))}
          </div>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={settings.showRecentFiles}
              onChange={(event) => void update({ showRecentFiles: event.target.checked })}
            />
            <span>{t("settings.showRecentFiles")}</span>
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={settings.autoCleanupTemp}
              onChange={(event) => void update({ autoCleanupTemp: event.target.checked })}
            />
            <span>{t("settings.autoCleanupTemp")}</span>
          </label>
        </Card>

        <Card className="p-5 flex flex-col gap-4">
          <h3 className="font-semibold flex items-center gap-2">
            <ShieldCheck size={16} style={{ color: "var(--ok)" }} /> {t("settings.engines")}
          </h3>
          <ul className="flex flex-col gap-2 text-[13px]">
            <li className="flex items-center justify-between">
              <span>{t("settings.enginePdfium")}</span>
              <Badge tone={engine?.pdfium ? "ok" : "danger"}>{engine?.pdfium ? t("info.yes") : t("info.no")}</Badge>
            </li>
            <li className="flex items-center justify-between">
              <span>{t("settings.engineQpdf")}</span>
              <Badge tone={engine?.qpdf ? "ok" : "danger"}>{engine?.qpdf ? t("info.yes") : t("info.no")}</Badge>
            </li>
            <li className="flex items-center justify-between">
              <span>{t("settings.engineTesseract")}</span>
              <Badge tone={engine?.tesseract ? "ok" : "danger"}>
                {engine?.tesseract ? engine.tesseract_version ?? t("info.yes") : t("info.no")}
              </Badge>
            </li>
          </ul>
          <p className="text-xs muted">{engine?.ocr_languages.length ?? 0} OCR languages installed</p>
        </Card>

        <Card className="p-5 flex flex-col gap-4">
          <h3 className="font-semibold flex items-center gap-2">
            <KeyRound size={16} style={{ color: "var(--accent)" }} /> {t("settings.shortcuts")}
          </h3>
          <ul className="flex flex-col gap-2 text-[13px]">
            {shortcuts.map(([keys, label]) => (
              <li key={keys} className="flex items-center justify-between">
                <span className="muted">{label}</span>
                <span className="flex gap-1">
                  {keys.split(" + ").map((key) => (
                    <Kbd key={`${keys}-${key}`}>{key}</Kbd>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </Card>

        <Card className="p-5 flex flex-col gap-3">
          <h3 className="font-semibold flex items-center gap-2">
            {engine?.tesseract ? (
              <CheckCircle2 size={16} style={{ color: "var(--ok)" }} />
            ) : (
              <AlertTriangle size={16} style={{ color: "var(--warn)" }} />
            )}
            {t("settings.privacyTitle")}
          </h3>
          <p className="text-[13px] muted leading-relaxed">{t("settings.privacyBody")}</p>
          <VersionLine />
        </Card>
      </div>
    </Screen>
  );
}
