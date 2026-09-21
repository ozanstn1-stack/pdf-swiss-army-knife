import { useState } from "react";
import { Gauge, Minimize2 } from "lucide-react";
import { Button, Card, Field, Segmented, Slider, Spinner } from "../components/ui";
import { DropArea, ErrorBanner, FileChips, OptionCard, Results, RunBar, Screen, TwoColumn } from "../components/shell";
import { compressLossless, compressWithRenderer } from "../lib/pdf";
import { renderPageToJpeg } from "../lib/render";
import { describeError, resultFor, usePdfSession, suggestedName } from "../lib/session";
import { formatBytes } from "../lib/format";

export function CompressScreen() {
  const session = usePdfSession({ accept: "pdf" });
  const [strategy, setStrategy] = useState<"lossless" | "raster">("raster");
  const [level, setLevel] = useState<"low" | "medium" | "high" | "custom">("medium");
  const [dpi, setDpi] = useState(150);
  const [quality, setQuality] = useState(62);
  const [estimate, setEstimate] = useState<{ original: number; estimated: number; method: string } | null>(null);
  const [analysing, setAnalysing] = useState(false);

  const effective = () => {
    switch (level) {
      case "low":
        return { dpi: 200, quality: 78 };
      case "high":
        return { dpi: 110, quality: 45 };
      case "custom":
        return { dpi, quality };
      default:
        return { dpi: 150, quality: 62 };
    }
  };

  const analyse = async () => {
    if (!session.primary) return;
    const primary = session.primary;
    const original = primary.bytes.length;
    if (strategy === "lossless") {
      setAnalysing(true);
      try {
        const bytes = await compressLossless(primary.bytes);
        setEstimate({ original, estimated: bytes.length, method: "lossless (measured)" });
      } catch (error) {
        session.setError(describeError(error));
      } finally {
        setAnalysing(false);
      }
      return;
    }
    const { dpi: targetDpi, quality: targetQuality } = effective();
    setAnalysing(true);
    try {
      const samplePages = Math.min(primary.bytes.length > 0 && session.info ? session.info.pageCount : 1, 2);
      let total = 0;
      for (let page = 1; page <= samplePages; page += 1) {
        const jpeg = await renderPageToJpeg(primary.bytes, page, targetDpi, targetQuality);
        total += jpeg.length;
      }
      const average = total / samplePages;
      const pages = session.info?.pageCount ?? samplePages;
      setEstimate({
        original,
        estimated: Math.round(average * pages + pages * 900 + 4096),
        method: `raster @ ${targetDpi} dpi · q${targetQuality} (measured on ${samplePages} page${samplePages > 1 ? "s" : ""})`,
      });
    } catch (error) {
      session.setError(describeError(error));
    } finally {
      setAnalysing(false);
    }
  };

  const run = () =>
    session.run(async () => {
      if (!session.primary) return;
      const primary = session.primary;
      if (strategy === "lossless") {
        session.setProgress({ label: "Optimizing structure", current: 0, total: 1 });
        const bytes = await compressLossless(primary.bytes);
        return resultFor(suggestedName(primary.name, "_compressed"), bytes, `${formatBytes(primary.bytes.length)} → ${formatBytes(bytes.length)}`);
      }
      const { dpi: targetDpi, quality: targetQuality } = effective();
      const pages = session.info?.pageCount ?? 1;
      session.setProgress({ label: "Re-rendering pages", current: 0, total: pages });
      const bytes = await compressWithRenderer(
        primary.bytes,
        { strategy, dpi: targetDpi, jpegQuality: targetQuality },
        async (source, pageNumber, renderDpi) => {
          const jpeg = await renderPageToJpeg(source, pageNumber, renderDpi, targetQuality);
          session.setProgress({ label: "Re-rendering pages", current: pageNumber, total: pages });
          return jpeg;
        },
      );
      const reduction = 1 - bytes.length / primary.bytes.length;
      return resultFor(
        suggestedName(primary.name, "_compressed"),
        bytes,
        `${formatBytes(primary.bytes.length)} → ${formatBytes(bytes.length)} (${reduction > 0 ? "−" : "+"}${Math.abs(Math.round(reduction * 100))}%)`,
      );
    }, "Compressing");

  return (
    <Screen title="Compress PDF" subtitle="Reduce file size while keeping the document usable." actions={<Minimize2 size={18} className="muted" />}>
      <TwoColumn
        main={
          !session.primary ? (
            <DropArea session={session} />
          ) : (
            <>
              <OptionCard title="Document">
                <FileChips session={session} />
                {session.info ? (
                  <p className="text-xs muted">
                    {session.info.pageCount} pages · {formatBytes(session.info.fileSize)}
                  </p>
                ) : null}
              </OptionCard>
              <OptionCard title="Compression method">
                <Segmented<"lossless" | "raster">
                  value={strategy}
                  onChange={(value) => {
                    setStrategy(value);
                    setEstimate(null);
                  }}
                  options={[
                    { value: "raster", label: "Strong (re-render)" },
                    { value: "lossless", label: "Lossless" },
                  ]}
                />
                <p className="text-xs muted -mt-1">
                  {strategy === "raster"
                    ? "Renders each page as a JPEG at the chosen resolution — best for scans. Text becomes part of the image."
                    : "Optimizes the file structure and object streams; text stays selectable. Modest savings."}
                </p>
                {strategy === "raster" ? (
                  <>
                    <Field label="Level">
                      <Segmented<"low" | "medium" | "high" | "custom">
                        value={level}
                        onChange={(value) => {
                          setLevel(value);
                          setEstimate(null);
                        }}
                        options={[
                          { value: "low", label: "Low" },
                          { value: "medium", label: "Medium" },
                          { value: "high", label: "High" },
                          { value: "custom", label: "Custom" },
                        ]}
                      />
                    </Field>
                    {level === "custom" ? (
                      <>
                        <Field label="Image resolution (DPI)">
                          <Slider value={dpi} min={72} max={300} step={2} onChange={(value) => setDpi(value)} format={(value) => `${value}`} />
                        </Field>
                        <Field label="JPEG quality">
                          <Slider value={quality} min={25} max={95} onChange={(value) => setQuality(value)} format={(value) => `${value}%`} />
                        </Field>
                      </>
                    ) : null}
                  </>
                ) : null}
                <Button size="sm" icon={analysing ? <Spinner size={14} /> : <Gauge size={14} />} onClick={() => void analyse()} disabled={analysing}>
                  Analyze
                </Button>
                {estimate ? (
                  <div className="card-soft p-3 text-[13px] flex flex-col gap-1">
                    <p>
                      Original: <strong>{formatBytes(estimate.original)}</strong> · Estimated: <strong>{formatBytes(estimate.estimated)}</strong> ·{" "}
                      <span style={{ color: estimate.estimated < estimate.original ? "var(--ok)" : "var(--danger)" }}>
                        {Math.round((1 - estimate.estimated / estimate.original) * 100)}%
                      </span>
                    </p>
                    <p className="text-xs muted">{estimate.method}</p>
                  </div>
                ) : null}
              </OptionCard>
            </>
          )
        }
        side={
          <>
            <RunBar session={session} runLabel="Compress PDF" disabled={!session.primary} onRun={() => void run()} />
            <Results results={session.results} onClear={() => session.setResults([])} />
            <Card className="p-4 text-xs muted">Everything happens in this tab — no upload, no server.</Card>
          </>
        }
      />
      <ErrorBanner error={session.error} />
    </Screen>
  );
}
