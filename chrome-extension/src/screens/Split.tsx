import { useState } from "react";
import { Scissors } from "lucide-react";
import { Card, Field, Segmented, TextArea } from "../components/ui";
import { DropArea, ErrorBanner, FileChips, OptionCard, Results, RunBar, Screen, TwoColumn } from "../components/shell";
import { splitPdf } from "../lib/pdf";
import { resultFor, usePdfSession } from "../lib/session";
import { formatBytes } from "../lib/format";
import type { SplitMode } from "../lib/types";

type Mode = "ranges" | "every_n" | "individual" | "at_pages";

export function SplitScreen() {
  const session = usePdfSession({ accept: "pdf" });
  const [mode, setMode] = useState<Mode>("every_n");
  const [ranges, setRanges] = useState("1-5\n6-10");
  const [everyN, setEveryN] = useState(10);
  const [atPages, setAtPages] = useState("5, 10");
  const info = session.info;

  const buildMode = (): SplitMode => {
    if (mode === "ranges") {
      return { mode: "ranges", ranges: ranges.split(/[\n,;]/).map((value) => value.trim()).filter(Boolean) };
    }
    if (mode === "every_n") return { mode: "every_n", n: Math.max(1, everyN) };
    if (mode === "at_pages") {
      return {
        mode: "at_pages",
        pages: atPages
          .split(/[,;]/)
          .map((value) => Number(value.trim()))
          .filter((value) => Number.isFinite(value) && value > 1),
      };
    }
    return { mode: "individual" };
  };

  const run = () =>
    session.run(async () => {
      if (!session.primary) return;
      const parts = await splitPdf(session.primary.name, session.primary.bytes, buildMode());
      return parts.map((part) =>
        resultFor(part.fileName, part.bytes, `pages ${part.firstPage}-${part.lastPage} · ${formatBytes(part.bytes.length)}`),
      );
    }, "Splitting document");

  return (
    <Screen title="Split PDF" subtitle="Break a document into smaller files by ranges, size or individual pages." actions={<Scissors size={18} className="muted" />}>
      <TwoColumn
        main={
          <>
            {!session.primary ? (
              <DropArea session={session} />
            ) : (
              <>
                <OptionCard title="Document">
                  <FileChips session={session} />
                  {info ? (
                    <p className="text-xs muted">
                      {info.pageCount} pages · {formatBytes(info.fileSize)} · PDF {info.version}
                    </p>
                  ) : null}
                </OptionCard>
                <OptionCard title="Split mode">
                  <Segmented<Mode>
                    value={mode}
                    onChange={setMode}
                    options={[
                      { value: "every_n", label: "Every N pages" },
                      { value: "ranges", label: "By ranges" },
                      { value: "individual", label: "Individual pages" },
                      { value: "at_pages", label: "At pages" },
                    ]}
                  />
                  {mode === "ranges" ? (
                    <Field label="One range per line" hint="e.g. 1-5, 6-10, 11-20">
                      <TextArea rows={4} value={ranges} onChange={(event) => setRanges(event.target.value)} />
                    </Field>
                  ) : null}
                  {mode === "every_n" ? (
                    <Field label="Pages per file">
                      <input
                        className="input"
                        type="number"
                        min={1}
                        value={everyN}
                        onChange={(event) => setEveryN(Number(event.target.value) || 1)}
                      />
                    </Field>
                  ) : null}
                  {mode === "at_pages" ? (
                    <Field label="Start a new file at these pages" hint="e.g. 5, 10">
                      <input className="input" value={atPages} onChange={(event) => setAtPages(event.target.value)} />
                    </Field>
                  ) : null}
                  {mode === "individual" && info ? <p className="text-xs muted">Creates {info.pageCount} single-page PDFs.</p> : null}
                </OptionCard>
              </>
            )}
            <ErrorBanner error={session.error} />
          </>
        }
        side={
          <>
            <RunBar session={session} runLabel="Split PDF" disabled={!session.primary} onRun={() => void run()} />
            <Results results={session.results} onClear={() => session.setResults([])} />
            <Card className="p-4 text-xs muted">
              Files are numbered from the source page ranges, so you can tell which part is which.
            </Card>
          </>
        }
      />
    </Screen>
  );
}
