import { useState } from "react";
import { Hash } from "lucide-react";
import { Card, ColorInput, Field, Slider, TextInput, Toggle } from "../components/ui";
import { DropArea, ErrorBanner, FileChips, OptionCard, Results, RunBar, Screen, TwoColumn } from "../components/shell";
import { addPageNumbers } from "../lib/pdf";
import { resultFor, usePdfSession, suggestedName } from "../lib/session";
import { parsePageSelection } from "../lib/format";
import type { NumberingOptions } from "../lib/types";

const POSITIONS: NumberingOptions["position"][] = ["top_left", "top_center", "top_right", "bottom_left", "bottom_center", "bottom_right"];

export function NumberingScreen() {
  const session = usePdfSession({ accept: "pdf" });
  const [options, setOptions] = useState<NumberingOptions>({
    position: "bottom_center",
    format: "n",
    startNumber: 1,
    sizePt: 11,
    color: "#333333",
    marginPt: 28,
    countFromStart: true,
    pages: [],
  });
  const [selection, setSelection] = useState("");

  const patch = (values: Partial<NumberingOptions>) => setOptions((previous) => ({ ...previous, ...values }));

  const run = () =>
    session.run(async () => {
      if (!session.primary) return;
      const pages = selection.trim() ? (parsePageSelection(selection, session.info?.pageCount ?? 0) ?? []) : [];
      const bytes = await addPageNumbers(session.primary.bytes, { ...options, pages });
      return resultFor(suggestedName(session.primary.name, "_numbered"), bytes, `${options.format} · ${options.position}`);
    }, "Adding page numbers");

  return (
    <Screen title="Page numbers" subtitle="Stamp page numbers with your preferred format and position." actions={<Hash size={18} className="muted" />}>
      <TwoColumn
        main={
          !session.primary ? (
            <DropArea session={session} />
          ) : (
            <>
              <OptionCard title="Document">
                <FileChips session={session} />
              </OptionCard>
              <OptionCard title="Numbering">
                <Field label="Position">
                  <select className="select" value={options.position} onChange={(event) => patch({ position: event.target.value as NumberingOptions["position"] })}>
                    {POSITIONS.map((position) => (
                      <option key={position} value={position}>
                        {position.split("_").map((part) => part[0].toUpperCase() + part.slice(1)).join(" ")}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Format">
                  <select className="select" value={options.format} onChange={(event) => patch({ format: event.target.value as NumberingOptions["format"] })}>
                    <option value="n">1, 2, 3</option>
                    <option value="page_n">Page 1</option>
                    <option value="n_of_total">1 / 20</option>
                    <option value="page_n_of_total">Page 1 of 20</option>
                  </select>
                </Field>
                <Field label="Start number">
                  <TextInput
                    type="number"
                    value={options.startNumber}
                    onChange={(event) => patch({ startNumber: Math.max(1, Number(event.target.value) || 1) })}
                  />
                </Field>
                <Field label="Font size">
                  <Slider value={options.sizePt} min={7} max={28} onChange={(value) => patch({ sizePt: value })} />
                </Field>
                <Field label="Margin (pt)">
                  <Slider value={options.marginPt} min={6} max={90} onChange={(value) => patch({ marginPt: value })} />
                </Field>
                <Field label="Color">
                  <ColorInput value={options.color} onChange={(value) => patch({ color: value })} />
                </Field>
                <Toggle checked={options.countFromStart} onChange={(value) => patch({ countFromStart: value })} label="Continue numbering from the start value" />
                <Field label="Pages" hint="Empty = all pages">
                  <TextInput value={selection} onChange={(event) => setSelection(event.target.value)} placeholder="all" />
                </Field>
              </OptionCard>
            </>
          )
        }
        side={
          <>
            <RunBar session={session} runLabel="Add page numbers" disabled={!session.primary} onRun={() => void run()} />
            <Results results={session.results} onClear={() => session.setResults([])} />
            <Card className="p-4 text-xs muted">
              Numbers use the standard Helvetica font, so the labels themselves are ASCII (digits and "Page").
            </Card>
          </>
        }
      />
      <ErrorBanner error={session.error} />
    </Screen>
  );
}
