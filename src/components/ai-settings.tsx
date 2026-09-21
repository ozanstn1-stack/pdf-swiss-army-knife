import { useEffect, useState } from "react";
import { Bot, CheckCircle2, KeyRound, ShieldAlert, Trash2, Zap } from "lucide-react";
import { Badge, Button, Card, Field, Slider, Spinner, TextInput } from "./ui";
import { useT } from "../lib/i18n";
import { aiClearKey, aiGetSettings, aiSaveSettings, aiTestConnection } from "../lib/api";
import type { AiSettingsView, AiTestResult } from "../lib/types";

/**
 * Settings panel for the optional DeepSeek integration.
 *
 * This is the only screen that receives an API key. The key is written by the
 * Rust layer (Windows DPAPI encrypted) and is never logged; the UI only ever
 * shows a masked value afterwards.
 */
export function AiSettings() {
  const t = useT();
  const [view, setView] = useState<AiSettingsView | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("https://api.deepseek.com");
  const [model, setModel] = useState("deepseek-chat");
  const [temperature, setTemperature] = useState(0.2);
  const [maxTokens, setMaxTokens] = useState(4096);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<AiTestResult | null>(null);

  useEffect(() => {
    void aiGetSettings()
      .then((settings) => {
        setView(settings);
        setBaseUrl(settings.baseUrl);
        setModel(settings.model);
        setTemperature(settings.temperature);
        setMaxTokens(settings.maxTokens);
      })
      .catch(() => undefined);
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      const updated = await aiSaveSettings({
        apiKey: apiKey.trim() ? apiKey.trim() : undefined,
        baseUrl,
        model,
        temperature,
        maxTokens,
      });
      setView(updated);
      setApiKey("");
      setTestResult(null);
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      await save();
      const result = await aiTestConnection();
      setTestResult(result);
    } finally {
      setTesting(false);
    }
  };

  const clear = async () => {
    const updated = await aiClearKey();
    setView(updated);
    setTestResult(null);
  };

  return (
    <Card className="p-5 flex flex-col gap-4">
      <h3 className="font-semibold flex items-center gap-2">
        <Bot size={16} style={{ color: "var(--accent)" }} /> {t("settings.aiTitle")}
        <Badge tone={view?.configured ? "ok" : "warn"}>{view?.configured ? t("common.ready") : t("ai.notConfigured")}</Badge>
      </h3>

      <div className="card-soft p-3 flex items-start gap-2 text-xs">
        <ShieldAlert size={14} style={{ color: "var(--warn)", marginTop: 2 }} />
        <span>{t("settings.aiWarning")}</span>
      </div>

      <Field label={t("settings.aiKey")} hint={t("settings.aiKeyHint")}>
        <div className="flex gap-2">
          <TextInput
            type="password"
            value={apiKey}
            placeholder={view?.maskedKey || "sk-…"}
            onChange={(event) => setApiKey(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <Button variant="ghost" icon={<KeyRound size={15} />} onClick={() => void clear()} disabled={!view?.configured}>
            {t("settings.aiClear")}
          </Button>
        </div>
      </Field>

      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
        <Field label={t("settings.aiBaseUrl")} hint={t("settings.aiBaseUrlHint")}>
          <TextInput value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} spellCheck={false} />
        </Field>
        <Field label={t("settings.aiModel")}>
          <TextInput value={model} onChange={(event) => setModel(event.target.value)} spellCheck={false} />
        </Field>
      </div>

      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
        <Field label={t("settings.aiTemperature")}>
          <Slider value={temperature} min={0} max={1.5} step={0.05} onChange={setTemperature} format={(value) => value.toFixed(2)} />
        </Field>
        <Field label={t("settings.aiMaxTokens")}>
          <Slider value={maxTokens} min={512} max={8192} step={256} onChange={setMaxTokens} />
        </Field>
      </div>

      <div className="flex items-center gap-2">
        <Button variant="primary" icon={saving ? <Spinner size={14} /> : <Bot size={15} />} onClick={() => void save()} disabled={saving}>
          {t("common.save")}
        </Button>
        <Button
          variant="ghost"
          icon={testing ? <Spinner size={14} /> : <Zap size={15} />}
          onClick={() => void test()}
          disabled={testing || (!view?.configured && !apiKey.trim())}
        >
          {t("settings.aiTestConnection")}
        </Button>
        {view?.configured ? (
          <Button variant="danger" icon={<Trash2 size={15} />} onClick={() => void clear()}>
            {t("settings.aiClearKey")}
          </Button>
        ) : null}
      </div>

      {testResult ? (
        <div className="flex items-center gap-2 text-[13px]">
          {testResult.ok ? (
            <CheckCircle2 size={15} style={{ color: "var(--ok)" }} />
          ) : (
            <Badge tone="danger">!</Badge>
          )}
          <span>
            {testResult.ok ? t("settings.aiTestOk", { model: testResult.model }) : testResult.message}
          </span>
        </div>
      ) : null}

      <p className="text-xs muted">
        {t("settings.aiStorage")}:{" "}
        {view?.keyStorage === "dpapi"
          ? t("ai.keySecure")
          : view?.keyStorage === "plain"
            ? t("ai.keyPlain")
            : t("ai.keyMissing")}
      </p>
    </Card>
  );
}
