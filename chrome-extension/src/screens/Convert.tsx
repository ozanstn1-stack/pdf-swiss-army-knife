import { useState } from "react";
import { FileImage, Images, RotateCw } from "lucide-react";
import { Card, Field, Segmented, Select, Slider, TextInput } from "../components/ui";
import { DropArea, FileChips, OptionCard, Results, RunBar, Screen, TwoColumn } from "../components/shell";
import { imagesToPdf } from "../lib/pdf";
import { renderPage } from "../lib/render";
import { resultFor, usePdfSession, suggestedName } from "../lib/session";
import { formatBytes, parsePageSelection } from "../lib/format";
import type { ImageToPdfOptions } from "../lib/types";

type Tab = "pdfToImages" | "imagesToPdf";

export function ConvertScreen({ initialTab = "pdfToImages" }: { initialTab?: Tab }) {
  const [tab, setTab] = useState<Tab>(initialTab);
  return (
    <Screen
      title="Convert"
      subtitle={tab === "pdfToImages" ? "Export pages as PNG or JPG at the resolution you need." : "Turn photos and scans into a single PDF."}
      actions={
        <Segmented<Tab>
          value={tab}
          onChange={setTab}
          options={[
            { value: "pdfToImages", label: "PDF → Images" },
            { value: "imagesToPdf", label: "Images → PDF" },
          ]}
        />
      }
    >
      {tab === "pdfToImages" ? <PdfToImages /> : <ImagesToPdf />}
    </Screen>
  );
}

function PdfToImages() {
  const session = usePdfSession({ accept: "pdf" });
  const [format, setFormat] = useState<"png" | "jpeg">("jpeg");
  const [dpi, setDpi] = useState(150);
  const [quality, setQuality] = useState(88);
  const [selection, setSelection] = useState("");
  const info = session.info;

  const pagesToExport = (): number[] => {
    const total = info?.pageCount ?? 0;
    if (!selection.trim()) return Array.from({ length: total }, (_, index) => index + 1);
    return parsePageSelection(selection, total) ?? [];
  };

  const run = () =>
    session.run(async () => {
      if (!session.primary) return;
      const pages = pagesToExport();
      if (!pages.length) throw { code: "invalid_input", message: "Select at least one page." };
      const outputs: { fileName: string; bytes: Uint8Array; detail: string }[] = [];
      session.setProgress({ label: "Rendering pages", current: 0, total: pages.length });
      for (let index = 0; index < pages.length; index += 1) {
        const page = pages[index];
        const rendered = await renderPage(session.primary.bytes, page, dpi);
        const type = format === "jpeg" ? "image/jpeg" : "image/png";
        const bytes = await new Promise<Uint8Array>((resolve, reject) => {
          rendered.canvas.toBlob(
            async (blob) => {
              if (!blob) {
                reject(new Error("Encoding failed"));
                return;
              }
              resolve(new Uint8Array(await blob.arrayBuffer()));
            },
            type,
            format === "jpeg" ? quality / 100 : 1,
          );
        });
        outputs.push({
          fileName: `${suggestedName(session.primary.name, "").replace(/\.pdf$/, "")}_page_${String(page).padStart(3, "0")}.${format === "jpeg" ? "jpg" : "png"}`,
          bytes,
          detail: `${rendered.width}×${rendered.height} · ${formatBytes(bytes.length)}`,
        });
        session.setProgress({ label: "Rendering pages", current: index + 1, total: pages.length });
      }
      return outputs.map((output) => ({ ...output, mime: format === "jpeg" ? "image/jpeg" : "image/png" }));
    }, "Rendering pages");

  return (
    <TwoColumn
      main={
        !session.primary ? (
          <DropArea session={session} />
        ) : (
          <>
            <OptionCard title="Document">
              <FileChips session={session} />
              {info ? (
                <p className="text-xs muted">
                  {info.pageCount} pages · {formatBytes(info.fileSize)}
                </p>
              ) : null}
            </OptionCard>
            <OptionCard title="Export options">
              <Field label="Format">
                <Segmented<"png" | "jpeg">
                  value={format}
                  onChange={setFormat}
                  options={[
                    { value: "jpeg", label: "JPG" },
                    { value: "png", label: "PNG" },
                  ]}
                />
              </Field>
              <Field label="Resolution">
                <Select<string>
                  value={String(dpi)}
                  onChange={(value) => setDpi(Number(value))}
                  options={[
                    { value: "72", label: "72 DPI" },
                    { value: "150", label: "150 DPI" },
                    { value: "200", label: "200 DPI" },
                    { value: "300", label: "300 DPI" },
                  ]}
                />
              </Field>
              {format === "jpeg" ? (
                <Field label="JPEG quality">
                  <Slider value={quality} min={50} max={100} onChange={setQuality} format={(value) => `${value}%`} />
                </Field>
              ) : null}
              <Field label="Pages" hint="Empty = all pages">
                <TextInput value={selection} onChange={(event) => setSelection(event.target.value)} placeholder="all" />
              </Field>
            </OptionCard>
          </>
        )
      }
      side={
        <>
          <RunBar session={session} runLabel="Export images" disabled={!session.primary} onRun={() => void run()} />
          <Results results={session.results} onClear={() => session.setResults([])} />
          <Card className="p-4 text-xs muted flex items-start gap-2">
            <FileImage size={13} style={{ marginTop: 2 }} />
            <span>Pages are rendered with pdf.js in this tab; the exported images are downloaded individually.</span>
          </Card>
        </>
      }
    />
  );
}

function ImagesToPdf() {
  const session = usePdfSession({ accept: "image", multiple: true });
  const [rotations, setRotations] = useState<Record<string, number>>({});
  const [options, setOptions] = useState<ImageToPdfOptions>({
    pageSize: "a4",
    customWidthPt: 595.28,
    customHeightPt: 841.89,
    orientation: "auto",
    fit: "fit",
    marginPt: 0,
    assumedDpi: 96,
  });

  const patch = (values: Partial<ImageToPdfOptions>) => setOptions((previous) => ({ ...previous, ...values }));

  const run = () =>
    session.run(async () => {
      if (!session.files.length) return;
      const items = session.files.map((file) => ({
        name: file.name,
        bytes: file.bytes,
        type: file.type,
        rotation: rotations[`${file.name}-${file.size}`] ?? 0,
      }));
      const bytes = await imagesToPdf(items, options);
      return resultFor("images.pdf", bytes, `${items.length} image${items.length > 1 ? "s" : ""} · ${formatBytes(bytes.length)}`);
    }, "Building PDF");

  return (
    <TwoColumn
      main={
        !session.files.length ? (
          <DropArea session={session} hint="or click to choose · PNG, JPG, WEBP" />
        ) : (
          <>
            <OptionCard title="Image order">
              <p className="text-xs muted -mt-1">Use ↑/↓ to order, rotate if a photo is sideways.</p>
              <div className="flex flex-col gap-2">
                {session.files.map((file, index) => {
                  const key = `${file.name}-${file.size}`;
                  return (
                    <div key={`${key}-${index}`} className="card-soft flex items-center gap-3 px-3 py-2">
                      <span className="w-6 h-6 rounded-md flex items-center justify-center text-xs font-semibold" style={{ background: "var(--accent-weak)", color: "var(--accent)" }}>
                        {index + 1}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13.5px]">{file.name}</p>
                        <p className="text-xs muted">
                          {formatBytes(file.size)}
                          {rotations[key] ? ` · rotated ${rotations[key]}°` : ""}
                        </p>
                      </div>
                      <button
                        className="btn btn-sm"
                        onClick={() => setRotations((previous) => ({ ...previous, [key]: ((previous[key] ?? 0) + 90) % 360 }))}
                      >
                        <RotateCw size={13} />
                      </button>
                      <button className="btn btn-sm" onClick={() => session.moveFile(index, index - 1)} disabled={index === 0}>
                        ↑
                      </button>
                      <button className="btn btn-sm" onClick={() => session.moveFile(index, index + 1)} disabled={index === session.files.length - 1}>
                        ↓
                      </button>
                      <button className="btn btn-sm btn-ghost" onClick={() => session.removeFile(index)}>
                        ✕
                      </button>
                    </div>
                  );
                })}
              </div>
            </OptionCard>
            <OptionCard title="Page setup">
              <Field label="Page size">
                <Select<ImageToPdfOptions["pageSize"]>
                  value={options.pageSize}
                  onChange={(value) => patch({ pageSize: value })}
                  options={[
                    { value: "a4", label: "A4" },
                    { value: "letter", label: "Letter" },
                    { value: "legal", label: "Legal" },
                    { value: "a3", label: "A3" },
                    { value: "a5", label: "A5" },
                    { value: "original", label: "Image size" },
                    { value: "custom", label: "Custom" },
                  ]}
                />
              </Field>
              {options.pageSize === "custom" ? (
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Width (pt)">
                    <TextInput type="number" value={options.customWidthPt} onChange={(event) => patch({ customWidthPt: Number(event.target.value) })} />
                  </Field>
                  <Field label="Height (pt)">
                    <TextInput type="number" value={options.customHeightPt} onChange={(event) => patch({ customHeightPt: Number(event.target.value) })} />
                  </Field>
                </div>
              ) : null}
              <Field label="Orientation">
                <Segmented<ImageToPdfOptions["orientation"]>
                  value={options.orientation}
                  onChange={(value) => patch({ orientation: value })}
                  options={[
                    { value: "auto", label: "Auto" },
                    { value: "portrait", label: "Portrait" },
                    { value: "landscape", label: "Landscape" },
                  ]}
                />
              </Field>
              <Field label="Image fitting">
                <Select<ImageToPdfOptions["fit"]>
                  value={options.fit}
                  onChange={(value) => patch({ fit: value })}
                  options={[
                    { value: "fit", label: "Fit (keep proportions)" },
                    { value: "fill", label: "Fill page (crop edges)" },
                    { value: "actual", label: "Actual size" },
                  ]}
                />
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Margin (pt)">
                  <TextInput type="number" value={options.marginPt} onChange={(event) => patch({ marginPt: Number(event.target.value) })} />
                </Field>
                <Field label="Assumed image DPI">
                  <TextInput type="number" value={options.assumedDpi} onChange={(event) => patch({ assumedDpi: Number(event.target.value) })} />
                </Field>
              </div>
            </OptionCard>
          </>
        )
      }
      side={
        <>
          <RunBar session={session} runLabel="Create PDF" disabled={!session.files.length} onRun={() => void run()} />
          <Results results={session.results} onClear={() => session.setResults([])} />
          <Card className="p-4 text-xs muted flex items-start gap-2">
            <Images size={13} style={{ marginTop: 2 }} />
            <span>JPEG images are embedded as-is (no quality loss); PNG transparency is preserved.</span>
          </Card>
        </>
      }
    />
  );
}

