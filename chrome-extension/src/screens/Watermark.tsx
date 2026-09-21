import { useState } from "react";
import { Stamp } from "lucide-react";
import { Card, ColorInput, Field, Segmented, Slider, TextInput, Toggle } from "../components/ui";
import { DropArea, ErrorBanner, FileChips, OptionCard, Results, RunBar, Screen, TwoColumn } from "../components/shell";
import { addTextWatermark } from "../lib/pdf";
import { loadStampFonts, resultFor, usePdfSession, suggestedName } from "../lib/session";
import { parsePageSelection } from "../lib/format";
import type { WatermarkOptions } from "../lib/types";

const POSITIONS: WatermarkOptions["position"][] = [
  "top_left",
  "top_center",
  "top_right",
  "center",
  "bottom_left",
  "bottom_center",
  "bottom_right",
];

export function WatermarkScreen() {
  const session = usePdfSession({ accept: "pdf" });
  const [options, setOptions] = useState<Omit<WatermarkOptions, "fontBytes">>({
    text: "CONFIDENTIAL",
    fontFamily: "sans-bold",
    sizePt: 48,
    color: "#9aa0a6",
    opacity: 0.25,
    rotationDeg: 45,
    position: "center",
    marginPt: 24,
    tile: false,
    pages: [],
  });
  const [selection, setSelection] = useState("");

  const patch = (values: Partial<typeof options>) => setOptions((previous) => ({ ...previous, ...values }));

  const run = () =>
    session.run(async () => {
      if (!session.primary) return;
      const fonts = await loadStampFonts().catch(() => null);
      const pages = selection.trim() ? (parsePageSelection(selection, session.info?.pageCount ?? 0) ?? []) : [];
      const bytes = await addTextWatermark(session.primary.bytes, {
        ...options,
        pages,
        fontBytes: fonts ? (options.fontFamily === "sans-bold" ? fonts.sansBold : fonts.sans) : undefined,
      });
      return resultFor(suggestedName(session.primary.name, "_watermarked"), bytes, `${options.tile ? "tiled" : options.position} · ${Math.round(options.opacity * 100)}% opacity`);
    }, "Adding watermark");

  return (
    <Screen title="Watermark" subtitle="Stamp text onto your pages with control over position, rotation and opacity." actions={<Stamp size={18} className="muted" />}>
      <TwoColumn
        main={
          !session.primary ? (
            <DropArea session={session} />
          ) : (
            <>
              <OptionCard title="Document">
                <FileChips session={session} />
              </OptionCard>
              <OptionCard title="Watermark">
                <Field label="Text">
                  <TextInput value={options.text} onChange={(event) => patch({ text: event.target.value })} placeholder="DRAFT" />
                </Field>
                <Field label="Font">
                  <Segmented<WatermarkOptions["fontFamily"]>
                    value={options.fontFamily}
                    onChange={(value) => patch({ fontFamily: value })}
                    options={[
                      { value: "sans", label: "Regular (Unicode)" },
                      { value: "sans-bold", label: "Bold (Unicode)" },
                    ]}
                  />
                </Field>
                <Field label="Font size">
                  <Slider value={options.sizePt} min={12} max={160} onChange={(value) => patch({ sizePt: value })} />
                </Field>
                <Field label="Color">
                  <ColorInput value={options.color} onChange={(value) => patch({ color: value })} />
                </Field>
                <Field label="Opacity">
                  <Slider value={options.opacity * 100} min={5} max={100} onChange={(value) => patch({ opacity: value / 100 })} format={(value) => `${value}%`} />
                </Field>
                <Field label="Rotation">
                  <Slider value={options.rotationDeg} min={0} max={90} step={5} onChange={(value) => patch({ rotationDeg: value })} format={(value) => `${value}°`} />
                </Field>
                <Field label="Position">
                  <select className="select" value={options.position} onChange={(event) => patch({ position: event.target.value as WatermarkOptions["position"] })}>
                    {POSITIONS.map((position) => (
                      <option key={position} value={position}>
                        {position.split("_").map((part) => part[0].toUpperCase() + part.slice(1)).join(" ")}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Margin (pt)">
                  <Slider value={options.marginPt} min={0} max={120} onChange={(value) => patch({ marginPt: value })} />
                </Field>
                <Toggle checked={options.tile} onChange={(value) => patch({ tile: value })} label="Tile across the page" />
                <Field label="Pages" hint='Empty = all pages · "1,3,5-8" supported'>
                  <TextInput value={selection} onChange={(event) => setSelection(event.target.value)} placeholder="all" />
                </Field>
              </OptionCard>
            </>
          )
        }
        side={
          <>
            <RunBar session={session} runLabel="Add watermark" disabled={!session.primary || !options.text.trim()} onRun={() => void run()} />
            <Results results={session.results} onClear={() => session.setResults([])} />
            <Card className="p-4 text-xs muted">
              The bundled PT Sans font (SIL OFL) is used, so Turkish and other Latin characters work.
            </Card>
          </>
        }
      />
      <ErrorBanner error={session.error} />
    </Screen>
  );
}
