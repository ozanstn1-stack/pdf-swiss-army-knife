import { useEffect, useState } from "react";
import { Bot, CheckCircle2, KeyRound, ShieldAlert, Trash2, Zap } from "lucide-react";
import { Badge, Button, Card, Checkbox, Field, Segmented, Slider, Spinner, TextInput } from "./ui";
import { clamp } from "../lib/format";
import { useT } from "../lib/i18n";
import { aiClearKey, aiGetSettings, aiModels, aiSaveSettings, aiTestConnection } from "../lib/api";
import type { AiModelOption, AiSettingsView, AiTestResult, ReasoningEffort } from "../lib/types";

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
  const [model, setModel] = useState("deepseek-flash");
  const [models, setModels] = useState<AiModelOption[]>([]);
  const [temperature, setTemperature] = useState(0.2);
  const [maxTokens, setMaxTokens] = useState(4096);
  const [thinking, setThinking] = useState(true);
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>("high");
  const [contextTokens, setContextTokens] = useState(200_000);
  const [maxOutputTokens, setMaxOutputTokens] = useState(384_000);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<AiTestResult | null>(null);

  useEffect(() => {
    void aiModels()
      .then(setModels)
      .catch(() => undefined);
    void aiGetSettings()
      .then((settings) => {
        setView(settings);
        setBaseUrl(settings.baseUrl);
        setModel(settings.model);
        setTemperature(settings.temperature);
        setMaxTokens(settings.maxTokens);
        setThinking(settings.thinking);
        setReasoningEffort((settings.reasoningEffort as ReasoningEffort) ?? "high");
        setContextTokens(settings.contextTokens ?? 200_000);
        setMaxOutputTokens(settings.maxOutputTokens ?? 384_000);
      })
      .catch(() => undefined);
  }, []);

  const normalizedModel = model.trim().toLowerCase();
  const isV4Model =
    normalizedModel.startsWith("deepseek-v4") ||
    normalizedModel === "deepseek-flash" ||
    normalizedModel.startsWith("deepseek-flash-") ||
    normalizedModel === "deepseek-reasoner";

  const save = async () => {
    setSaving(true);
    try {
      const updated = await aiSaveSettings({
        apiKey: apiKey.trim() ? apiKey.trim() : undefined,
        baseUrl,
        model,
        temperature,
        maxTokens,
        thinking,
        reasoningEffort,
        contextTokens,
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
        <Field label={t("settings.aiModel")} hint={t("settings.aiModelHint")}>
          <div className="flex flex-col gap-2">
            <select
              className="select"
              value={models.some((option) => option.id === model) ? model : "__custom"}
              onChange={(event) => {
                if (event.target.value !== "__custom") setModel(event.target.value);
              }}
            >
              {models.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.id} — {option.label}
                </option>
              ))}
              <option value="__custom">{t("settings.aiModelCustom")}</option>
            </select>
            {!models.some((option) => option.id === model) ? (
              <TextInput
                value={model}
                onChange={(event) => setModel(event.target.value)}
                spellCheck={false}
                placeholder="deepseek-v4-flash"
              />
            ) : null}
          </div>
        </Field>
      </div>

      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
        <Field label={t("settings.aiTemperature")}>
          <Slider value={temperature} min={0} max={1.5} step={0.05} onChange={setTemperature} format={(value) => value.toFixed(2)} />
        </Field>
        <Field label={t("settings.aiMaxTokens")} hint={t("settings.aiMaxTokensHint")}>
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <TextInput
                type="number"
                value={maxTokens}
                min={256}
                max={maxOutputTokens}
                step={256}
                onChange={(event) => setMaxTokens(clamp(Number(event.target.value) || 256, 256, maxOutputTokens))}
              />
              <span className="text-xs muted shrink-0">/ {maxOutputTokens.toLocaleString()}</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {[4_096, 16_384, 32_768, 65_536, 131_072, 384_000].map((preset) => (
                <Button
                  key={preset}
                  size="sm"
                  variant={maxTokens === preset ? "primary" : "default"}
                  onClick={() => setMaxTokens(preset)}
                >
                  {preset >= 1000 ? `${Math.round(preset / 1024)}K` : preset}
                </Button>
              ))}
            </div>
          </div>
        </Field>
      </div>

      <Field label={t("settings.aiContextTokens")} hint={t("settings.aiContextTokensHint")}>
        <div className="flex items-center gap-2">
          <TextInput
            type="number"
            value={contextTokens}
            min={8_000}
            max={1_000_000}
            step={10_000}
            onChange={(event) => setContextTokens(clamp(Number(event.target.value) || 200_000, 8_000, 1_000_000))}
          />
          <span className="text-xs muted shrink-0">/ 1,000,000</span>
        </div>
        <div className="flex flex-wrap gap-1.5 mt-2">
          {[65_536, 131_072, 200_000, 500_000, 1_000_000].map((preset) => (
            <Button
              key={preset}
              size="sm"
              variant={contextTokens === preset ? "primary" : "default"}
              onClick={() => setContextTokens(preset)}
            >
              {preset === 1_000_000 ? "1M" : `${Math.round(preset / 1024)}K`}
            </Button>
          ))}
        </div>
      </Field>

      <div className="flex flex-col gap-2">
        <Checkbox
          checked={thinking}
          onChange={setThinking}
          label={t("settings.aiThinking")}
        />
        <p className="text-xs muted -mt-1">{t("settings.aiThinkingHint")}</p>
        {thinking ? (
          <Field label={t("settings.aiReasoningEffort")} hint={t("settings.aiReasoningEffortHint")}>
            <Segmented<ReasoningEffort>
              value={reasoningEffort}
              onChange={setReasoningEffort}
              options={[
                { value: "low", label: t("settings.aiEffortLow") },
                { value: "high", label: t("settings.aiEffortHigh") },
                { value: "max", label: t("settings.aiEffortMax") },
              ]}
            />
          </Field>
        ) : null}
        {!isV4Model ? <p className="text-xs" style={{ color: "var(--warn)" }}>{t("settings.aiThinkingModelWarning")}</p> : null}
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
