import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpenCheck,
  Bot,
  Check,
  Copy,
  Languages,
  ListChecks,
  MessageCircleQuestion,
  Save,
  Sparkles,
  Square,
  Tags,
  Wand2,
} from "lucide-react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  aiAsk,
  aiCleanupText,
  aiDocumentPreview,
  aiExamplePrompts,
  aiSaveOutput,
  aiSuggestMetadata,
  aiSummarize,
  aiTranslate,
  cancelJob,
  editMetadata,
  onAiChunk,
  onAiProgress,
} from "../lib/api";
import { Badge, Button, Card, Checkbox, Field, Segmented, Spinner, TextInput } from "../components/ui";
import { DropZone, InfoStrip, ResultCard } from "../components/files";
import { OptionCard, Screen, TwoColumn } from "../components/layout";
import { useT } from "../lib/i18n";
import { logFrontend } from "../lib/api";
import { useTool } from "../lib/useTool";
import { useDev, useSettings } from "../lib/store";
import { formatBytes, uid } from "../lib/format";
import type {
  AiExamplePrompts,
  AiMetadataSuggestion,
  AiPreview,
  AiSettingsView,
  OpResult,
  SummaryLength,
  SummaryStyle,
} from "../lib/types";

type AiTab = "summary" | "translate" | "ask" | "cleanup" | "metadata";

export function Ai({ initialFiles, dragging }: { initialFiles?: string[]; dragging: boolean }) {
  const t = useT();
  const session = useTool({ suffix: "_ai", accept: "pdf", initialPaths: initialFiles });
  const settingsLoaded = useSettings((s) => s.loaded);
  const [aiSettings, setAiSettings] = useState<AiSettingsView | null>(null);
  const devTab = useDev((s) => s.tab) as AiTab | null;
  const [tab, setTab] = useState<AiTab>("summary");
  const [examples, setExamples] = useState<AiExamplePrompts | null>(null);
  const [preview, setPreview] = useState<AiPreview | null>(null);
  const [consent, setConsent] = useState(false);
  const [output, setOutput] = useState("");
  const [running, setRunning] = useState(false);
  const [stage, setStage] = useState<{ stage: string; current: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [metadataSuggestion, setMetadataSuggestion] = useState<AiMetadataSuggestion | null>(null);
  const [metadataResult, setMetadataResult] = useState<OpResult | null>(null);
  const [summaryOptions, setSummaryOptions] = useState({
    language: "auto",
    length: "medium" as SummaryLength,
    style: "paragraph" as SummaryStyle,
    focus: "",
  });
  const [targetLanguage, setTargetLanguage] = useState("tr");
  const [bilingual, setBilingual] = useState(false);
  const [question, setQuestion] = useState("");
  const jobId = useRef(uid("ai"));
  const outputRef = useRef<HTMLDivElement>(null);

  // Development hook: start on a specific tab for screenshots.
  useEffect(() => {
    if (devTab && ["summary", "translate", "ask", "cleanup", "metadata"].includes(devTab)) setTab(devTab);
  }, [devTab]);

  // Load AI settings and example prompts once.
  useEffect(() => {
    void import("../lib/api").then(async ({ aiGetSettings }) => {
      setAiSettings(await aiGetSettings().catch(() => null));
    });
    void aiExamplePrompts().then(setExamples).catch(() => undefined);
  }, [settingsLoaded]);

  // Streamed answer chunks + progress.
  useEffect(() => {
    let unlistenChunk: (() => void) | undefined;
    let unlistenProgress: (() => void) | undefined;
    void onAiChunk((payload) => {
      if (payload.jobId !== jobId.current) return;
      setOutput((previous) => previous + payload.delta);
    }).then((fn) => {
      unlistenChunk = fn;
    });
    void onAiProgress((payload) => {
      if (payload.jobId !== jobId.current) return;
      setStage({ stage: payload.stage, current: payload.current, total: payload.total });
    }).then((fn) => {
      unlistenProgress = fn;
    });
    return () => {
      unlistenChunk?.();
      unlistenProgress?.();
    };
  }, []);

  // Auto-scroll the output while streaming.
  useEffect(() => {
    const element = outputRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [output]);

  const refreshPreview = useCallback(async () => {
    if (!session.primary) {
      setPreview(null);
      return;
    }
    try {
      const result = await aiDocumentPreview(session.primary.path, undefined, session.password || undefined);
      setPreview(result);
    } catch (previewError) {
      setPreview(null);
      fail(String((previewError as { message?: string })?.message ?? previewError));
    }
  }, [session.password, session.primary]);

  useEffect(() => {
    setOutput("");
    setError(null);
    setMetadataSuggestion(null);
    setMetadataResult(null);
    setConsent(false);
    void refreshPreview();
  }, [refreshPreview]);

  const configured = aiSettings?.configured ?? false;
  const canRun = configured && consent && Boolean(session.primary) && !running;

  const fail = (message: string) => {
    setError(message);
    void logFrontend("ai-error", message);
    console.warn("[ai]", message);
  };
  const resetJob = () => {
    jobId.current = uid("ai");
    setStage(null);
  };

  // Development automation (PDFSAK_DEV_RUN=1) runs the active tab once ready.
  session.registerAutoRun(() => {
    setConsent(true);
    if (tab === "ask") setQuestion("What is the total amount?");
    void (tab === "translate"
      ? runTranslate()
      : tab === "ask"
        ? runAsk("What is the total amount?")
        : tab === "cleanup"
          ? runCleanup()
          : tab === "metadata"
            ? runMetadata()
            : runSummary());
  });
  const runSummary = async () => {
    if (!session.primary) return;
    resetJob();
    setRunning(true);
    setOutput("");
    setError(null);
    try {
      const result = await aiSummarize({
        path: session.primary.path,
        options: {
          language: summaryOptions.language.trim() || "auto",
          length: summaryOptions.length,
          style: summaryOptions.style,
          focus: summaryOptions.focus,
        },
        password: session.password || undefined,
        jobId: jobId.current,
      });
      setOutput(result.text);
    } catch (runError) {
      fail(String((runError as { message?: string })?.message ?? runError));
    } finally {
      setRunning(false);
      setStage(null);
    }
  };

  const runTranslate = async () => {
    if (!session.primary) return;
    resetJob();
    setRunning(true);
    setOutput("");
    setError(null);
    try {
      const result = await aiTranslate({
        path: session.primary.path,
        options: { target_language: targetLanguage, bilingual },
        password: session.password || undefined,
        jobId: jobId.current,
      });
      setOutput(result.text);
    } catch (runError) {
      fail(String((runError as { message?: string })?.message ?? runError));
    } finally {
      setRunning(false);
      setStage(null);
    }
  };

  const runAsk = async (questionOverride?: string) => {
    const asked = (questionOverride ?? question).trim();
    if (!session.primary || !asked) return;
    resetJob();
    setRunning(true);
    setOutput("");
    setError(null);
    try {
      const result = await aiAsk({
        path: session.primary.path,
        question: asked,
        password: session.password || undefined,
        jobId: jobId.current,
      });
      setOutput(result.text);
    } catch (runError) {
      fail(String((runError as { message?: string })?.message ?? runError));
    } finally {
      setRunning(false);
      setStage(null);
    }
  };

  const runCleanup = async () => {
    if (!session.primary) return;
    resetJob();
    setRunning(true);
    setOutput("");
    setError(null);
    try {
      const result = await aiCleanupText({
        path: session.primary.path,
        password: session.password || undefined,
        jobId: jobId.current,
      });
      setOutput(result.text);
    } catch (runError) {
      fail(String((runError as { message?: string })?.message ?? runError));
    } finally {
      setRunning(false);
      setStage(null);
    }
  };

  const runMetadata = async () => {
    if (!session.primary) return;
    resetJob();
    setRunning(true);
    setMetadataSuggestion(null);
    setError(null);
    try {
      const suggestion = await aiSuggestMetadata(session.primary.path, session.password || undefined, jobId.current);
      setMetadataSuggestion(suggestion);
    } catch (runError) {
      fail(String((runError as { message?: string })?.message ?? runError));
    } finally {
      setRunning(false);
      setStage(null);
    }
  };

  const applyMetadata = async () => {
    if (!session.primary || !metadataSuggestion) return;
    const picked = await saveDialog({
      title: t("common.save"),
      defaultPath: session.outputPath,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (!picked) return;
    setRunning(true);
    try {
      const result = await editMetadata(
        session.primary.path,
        { path: String(picked), overwrite: "error" },
        {
          title: metadataSuggestion.title,
          author: metadataSuggestion.author,
          subject: metadataSuggestion.subject,
          keywords: metadataSuggestion.keywords.join(", "),
          creator: "PDF Swiss Army Knife (AI)",
          producer: "PDF Swiss Army Knife (AI)",
          creation_date: "",
          mod_date: "",
        },
        false,
        uid("ai-meta"),
        session.password || undefined,
      );
      setMetadataResult(result);
    } catch (applyError) {
      fail(String((applyError as { message?: string })?.message ?? applyError));
    } finally {
      setRunning(false);
    }
  };

  const stop = () => {
    void cancelJob(jobId.current).catch(() => undefined);
    setRunning(false);
  };

  const saveOutput = async () => {
    if (!output.trim()) return;
    const extension = tab === "summary" || tab === "ask" || tab === "metadata" ? "md" : "md";
    const base = session.primary ? session.primary.path.replace(/\.pdf$/i, "") : "ai-output";
    const picked = await saveDialog({
      title: t("common.save"),
      defaultPath: `${base}${tab === "translate" ? "_translated" : tab === "cleanup" ? "_clean" : "_ai"}.${extension}`,
      filters: [
        { name: "Markdown", extensions: ["md"] },
        { name: "Text", extensions: ["txt"] },
      ],
    });
    if (!picked) return;
    try {
      const saved = await aiSaveOutput(String(picked), output, "unique_name");
      setError(null);
      setSavedPath(saved);
    } catch (saveError) {
      fail(String((saveError as { message?: string })?.message ?? saveError));
    }
  };

  const [savedPath, setSavedPath] = useState<string | null>(null);

  const copyOutput = async () => {
    try {
      await navigator.clipboard.writeText(output);
    } catch {
      /* clipboard unavailable */
    }
  };

  const tabs: { id: AiTab; label: string; icon: React.ReactNode }[] = useMemo(
    () => [
      { id: "summary", label: t("ai.tabSummary"), icon: <Sparkles size={14} /> },
      { id: "translate", label: t("ai.tabTranslate"), icon: <Languages size={14} /> },
      { id: "ask", label: t("ai.tabAsk"), icon: <MessageCircleQuestion size={14} /> },
      { id: "cleanup", label: t("ai.tabCleanup"), icon: <Wand2 size={14} /> },
      { id: "metadata", label: t("ai.tabMetadata"), icon: <Tags size={14} /> },
    ],
    [t],
  );

  const activeRun = () => {
    switch (tab) {
      case "summary":
        return runSummary;
      case "translate":
        return runTranslate;
      case "ask":
        return runAsk;
      case "cleanup":
        return runCleanup;
      default:
        return runMetadata;
    }
  };

  return (
    <Screen
      title={t("ai.title")}
      subtitle={t("ai.subtitle")}
      actions={
        aiSettings ? (
          <Badge tone={configured ? "ok" : "warn"}>
            <Bot size={11} /> {configured ? aiSettings.model : t("ai.notConfigured")}
          </Badge>
        ) : null
      }
    >
      <TwoColumn
        main={
          <>
            {!configured ? (
              <Card className="p-4 flex flex-col gap-3">
                <p className="font-semibold text-[14px]">{t("ai.notConfigured")}</p>
                <p className="text-[13px] muted">{t("ai.notConfiguredBody")}</p>
                <div className="text-xs muted">
                  {t("ai.privacyTitle")}: {t("ai.privacyBody")}
                </div>
              </Card>
            ) : null}

            {!session.primary ? (
              <DropZone onPaths={(paths) => void session.addPaths(paths)} dragging={dragging} accept="pdf" />
            ) : (
              <>
                <OptionCard>
                  <div className="flex items-center justify-between gap-3">
                    <InfoStrip info={session.info} error={session.infoError} />
                    <Button size="sm" variant="ghost" onClick={() => void session.pickFiles()}>
                      {t("common.selectFile")}
                    </Button>
                  </div>
                </OptionCard>

                <Card className="p-4 flex flex-col gap-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    <BookOpenCheck size={16} style={{ color: "var(--accent)" }} />
                    <p className="font-semibold text-[13.5px]">{t("ai.privacyTitle")}</p>
                    <span className="ml-auto text-xs muted">
                      {preview
                        ? `${t("ai.preview", { pages: preview.pages, chars: preview.characters })} · ~${preview.estimatedWords} ${t("ai.words")}`
                        : t("common.loading")}
                    </span>
                  </div>
                  {consent ? (
                    <div className="flex items-center gap-2 text-xs">
                      <span className="flex items-center gap-1.5" style={{ color: "var(--ok)" }}>
                        <Check size={13} /> {t("ai.consentShort")}
                      </span>
                      <Button size="sm" variant="ghost" onClick={() => setConsent(false)}>
                        {t("ai.consentChange")}
                      </Button>
                    </div>
                  ) : (
                    <>
                      <p className="text-[13px] muted">{t("ai.privacyBody")}</p>
                      <Checkbox checked={consent} onChange={setConsent} label={t("ai.consent")} />
                    </>
                  )}
                </Card>

                <Card className="p-4">
                  <div className="flex flex-wrap items-center gap-2 mb-3">
                    {tabs.map((entry) => (
                      <Button
                        key={entry.id}
                        size="sm"
                        variant={tab === entry.id ? "primary" : "default"}
                        icon={entry.icon}
                        onClick={() => {
                          setTab(entry.id);
                          setOutput("");
                          setError(null);
                          setMetadataSuggestion(null);
                        }}
                      >
                        {entry.label}
                      </Button>
                    ))}
                  </div>

                  {tab === "summary" ? (
                    <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
                      <Field label={t("ai.language")} hint={t("ai.languageHint")}>
                        <TextInput
                          value={summaryOptions.language}
                          onChange={(event) => setSummaryOptions({ ...summaryOptions, language: event.target.value })}
                        />
                      </Field>
                      <Field label={t("ai.length")}>
                        <Segmented<SummaryLength>
                          value={summaryOptions.length}
                          onChange={(value) => setSummaryOptions({ ...summaryOptions, length: value })}
                          options={[
                            { value: "short", label: t("ai.lengthShort") },
                            { value: "medium", label: t("ai.lengthMedium") },
                            { value: "detailed", label: t("ai.lengthDetailed") },
                          ]}
                        />
                      </Field>
                      <Field label={t("ai.style")}>
                        <Segmented<SummaryStyle>
                          value={summaryOptions.style}
                          onChange={(value) => setSummaryOptions({ ...summaryOptions, style: value })}
                          options={[
                            { value: "paragraph", label: t("ai.styleParagraph") },
                            { value: "bullets", label: t("ai.styleBullets") },
                            { value: "executive", label: t("ai.styleExecutive") },
                          ]}
                        />
                      </Field>
                      <Field label={t("ai.focus")} hint={t("common.optional")}>
                        <TextInput
                          value={summaryOptions.focus}
                          onChange={(event) => setSummaryOptions({ ...summaryOptions, focus: event.target.value })}
                          placeholder={t("ai.focusPlaceholder")}
                        />
                      </Field>
                    </div>
                  ) : null}

                  {tab === "translate" ? (
                    <div className="flex flex-col gap-3">
                      <div className="flex flex-wrap gap-2">
                        {(examples?.translate_targets ?? ["tr", "en", "de", "fr", "es"]).map((code) => (
                          <button
                            key={code}
                            className="badge"
                            style={{
                              cursor: "pointer",
                              padding: "6px 12px",
                              background: targetLanguage === code ? "var(--accent)" : "var(--surface-3)",
                              color: targetLanguage === code ? "var(--accent-text)" : "var(--muted)",
                            }}
                            onClick={() => setTargetLanguage(code)}
                          >
                            {code.toUpperCase()}
                          </button>
                        ))}
                        <TextInput
                          className="input-sm"
                          style={{ width: 140 }}
                          value={targetLanguage}
                          onChange={(event) => setTargetLanguage(event.target.value)}
                          placeholder="tr / Turkish"
                        />
                      </div>
                      <Checkbox
                        checked={bilingual}
                        onChange={setBilingual}
                        label={t("ai.bilingual")}
                      />
                      <p className="text-xs muted">{t("ai.translateHint")}</p>
                    </div>
                  ) : null}

                  {tab === "ask" ? (
                    <div className="flex flex-col gap-3">
                      <Field label={t("ai.question")}>
                        <TextInput
                          value={question}
                          onChange={(event) => setQuestion(event.target.value)}
                          placeholder={t("ai.questionPlaceholder")}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" && canRun) void runAsk();
                          }}
                        />
                      </Field>
                      <div className="flex flex-wrap gap-2">
                        {(examples?.ask ?? []).map((example) => (
                          <Button key={example} size="sm" variant="ghost" onClick={() => setQuestion(example)}>
                            {example}
                          </Button>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {tab === "cleanup" ? (
                    <div className="flex flex-col gap-2">
                      <p className="text-[13px]">{t("ai.cleanupIntro")}</p>
                      <p className="text-xs muted">{t("ai.cleanupHint")}</p>
                    </div>
                  ) : null}

                  {tab === "metadata" ? (
                    <div className="flex flex-col gap-3">
                      <p className="text-[13px]">{t("ai.metadataIntro")}</p>
                      {metadataSuggestion ? (
                        <div className="card-soft p-3 flex flex-col gap-2 text-[13px]">
                          <div>
                            <strong>{t("metadata.fieldTitle")}:</strong> {metadataSuggestion.title || "—"}
                          </div>
                          <div>
                            <strong>{t("metadata.author")}:</strong> {metadataSuggestion.author || "—"}
                          </div>
                          <div>
                            <strong>{t("metadata.subject")}:</strong> {metadataSuggestion.subject || "—"}
                          </div>
                          <div className="flex items-center gap-2 flex-wrap">
                            <strong>{t("metadata.keywords")}:</strong>
                            {metadataSuggestion.keywords.map((keyword) => (
                              <Badge key={keyword}>{keyword}</Badge>
                            ))}
                          </div>
                          <Button size="sm" icon={<Save size={14} />} onClick={() => void applyMetadata()}>
                            {t("ai.metadataApply")}
                          </Button>
                        </div>
                      ) : (
                        <p className="text-xs muted">{t("ai.metadataHint")}</p>
                      )}
                    </div>
                  ) : null}
                </Card>

                {output ? (
                  <Card className="p-4 flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                      <p className="font-semibold text-[13.5px] flex items-center gap-2">
                        <ListChecks size={15} /> {t("ai.output")}
                        {running ? <Spinner size={13} /> : null}
                      </p>
                      <div className="flex gap-1.5">
                        <Button size="sm" variant="ghost" icon={<Copy size={14} />} onClick={() => void copyOutput()}>
                          {t("ai.copy")}
                        </Button>
                        <Button size="sm" icon={<Save size={14} />} onClick={() => void saveOutput()} disabled={running}>
                          {t("ai.save")}
                        </Button>
                      </div>
                    </div>
                    <div ref={outputRef} className="card-soft p-3 max-h-[420px] overflow-y-auto whitespace-pre-wrap text-[13.5px] leading-relaxed">
                      {output}
                    </div>
                    {savedPath ? (
                      <p className="text-xs" style={{ color: "var(--ok)" }}>
                        {t("ai.saved")}: {savedPath}
                      </p>
                    ) : null}
                  </Card>
                ) : null}

                {error ? (
                  <Card className="p-3.5 flex items-start gap-3" soft>
                    <Badge tone="danger">!</Badge>
                    <p className="text-[13px] flex-1">{error}</p>
                  </Card>
                ) : null}
              </>
            )}
          </>
        }
        side={
          <>
            <Card className="p-4 flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <Bot size={16} style={{ color: "var(--accent)" }} />
                <p className="font-semibold text-[13.5px]">{t("ai.runPanel")}</p>
              </div>
              {running ? (
                <>
                  <p className="text-xs muted">
                    {stage
                      ? t("ai.stage", { stage: stage.stage, current: stage.current, total: stage.total })
                      : t("common.processing")}
                  </p>
                  <div className="progress-track">
                    <div
                      className="progress-fill"
                      style={{
                        width: `${stage && stage.total > 0 ? Math.max(6, Math.round((stage.current / stage.total) * 100)) : 10}%`,
                      }}
                    />
                  </div>
                  <Button variant="danger" icon={<Square size={14} />} onClick={stop}>
                    {t("ai.stop")}
                  </Button>
                </>
              ) : (
                <Button
                  variant="primary"
                  size="lg"
                  icon={<Sparkles size={16} />}
                  disabled={!canRun}
                  onClick={() => void activeRun()()}
                >
                  {t("ai.run")}
                </Button>
              )}
              {!configured ? (
                <p className="text-xs" style={{ color: "var(--warn)" }}>
                  {t("ai.addKeyFirst")}
                </p>
              ) : !consent ? (
                <p className="text-xs muted">{t("ai.needConsent")}</p>
              ) : null}
              {tab === "ask" && !question.trim() ? <p className="text-xs muted">{t("ai.questionPlaceholder")}</p> : null}
            </Card>

            {aiSettings ? (
              <Card soft className="p-4 text-xs muted flex flex-col gap-1.5">
                <p>
                  {t("ai.model")}: <strong className="text-[var(--text)]">{aiSettings.model}</strong>
                </p>
                <p>Key: {aiSettings.maskedKey || "—"}</p>
                <p>
                  {aiSettings.keyStorage === "dpapi"
                    ? t("ai.keySecure")
                    : aiSettings.keyStorage === "plain"
                      ? t("ai.keyPlain")
                      : t("ai.keyMissing")}
                </p>
                {preview ? <p>{formatBytes(preview.characters)}</p> : null}
              </Card>
            ) : null}

            {metadataResult ? <ResultCard result={metadataResult} onReset={() => setMetadataResult(null)} /> : null}
          </>
        }
      />
    </Screen>
  );
}
