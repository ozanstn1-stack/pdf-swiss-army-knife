import { useState } from "react";
import { FileOutput, RotateCw, Trash2 } from "lucide-react";
import { Card, Field, Segmented, TextInput } from "../components/ui";
import { DropArea, ErrorBanner, FileChips, OptionCard, Results, RunBar, Screen, TwoColumn } from "../components/shell";
import { deletePages, extractPages, rotatePages } from "../lib/pdf";
import { resultFor, usePdfSession, suggestedName } from "../lib/session";
import { formatBytes, parsePageSelection } from "../lib/format";

type Tab = "extract" | "delete" | "rotate";

export function PageOpsScreen() {
  const session = usePdfSession({ accept: "pdf" });
  const [tab, setTab] = useState<Tab>("extract");
  const [selection, setSelection] = useState("1");
  const info = session.info;

  const run = () =>
    session.run(async () => {
      if (!session.primary) return;
      const total = info?.pageCount ?? 0;
      if (tab === "rotate") {
        const pages = selection.trim() ? (parsePageSelection(selection, total) ?? []) : [];
        const bytes = await rotatePages(session.primary.bytes, pages, 90);
        return resultFor(suggestedName(session.primary.name, "_rotated"), bytes, "rotated 90° clockwise");
      }
      const pages = parsePageSelection(selection, total);
      if (!pages) throw { code: "invalid_input", message: "Use a selection like 1,3,5-8." };
      if (tab === "extract") {
        const bytes = await extractPages(session.primary.bytes, pages);
        return resultFor(suggestedName(session.primary.name, "_extracted"), bytes, `${pages.length} pages · ${formatBytes(bytes.length)}`);
      }
      const bytes = await deletePages(session.primary.bytes, pages);
      return resultFor(suggestedName(session.primary.name, "_cleaned"), bytes, `${pages.length} pages removed`);
    }, tab === "extract" ? "Extracting pages" : tab === "delete" ? "Deleting pages" : "Rotating pages");

  const titles: Record<Tab, string> = {
    extract: "Extract pages",
    delete: "Delete pages",
    rotate: "Rotate pages",
  };

  return (
    <Screen
      title={titles[tab]}
      subtitle={
        tab === "extract"
          ? "Pull specific pages into a new document."
          : tab === "delete"
            ? "Remove pages and export a clean copy."
            : "Rotate pages 90° clockwise (use it repeatedly for 180/270°, or the Organize screen for exact per-page control)."
      }
      actions={
        <Segmented<Tab>
          value={tab}
          onChange={setTab}
          options={[
            { value: "extract", label: "Extract" },
            { value: "delete", label: "Delete" },
            { value: "rotate", label: "Rotate" },
          ]}
        />
      }
    >
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
                      {info.pageCount} pages · {formatBytes(info.fileSize)}
                    </p>
                  ) : null}
                </OptionCard>
                <OptionCard title="Page selection">
                  <Field
                    label="Pages"
                    hint={`Formats: 1,3,5-8 · "*" for all${tab === "rotate" ? " · empty = all pages" : ""}${info ? ` · ${info.pageCount} pages in this document` : ""}`}
                  >
                    <TextInput value={selection} onChange={(event) => setSelection(event.target.value)} placeholder="1,3,5-8" />
                  </Field>
                  {tab === "delete" ? (
                    <p className="text-xs" style={{ color: "var(--warn)" }}>
                      Deleting every page is not allowed; the original file is never modified.
                    </p>
                  ) : null}
                </OptionCard>
              </>
            )}
            <ErrorBanner error={session.error} />
          </>
        }
        side={
          <>
            <RunBar
              session={session}
              runLabel={titles[tab]}
              disabled={!session.primary || (tab !== "rotate" && !selection.trim())}
              onRun={() => void run()}
            />
            <Results results={session.results} onClear={() => session.setResults([])} />
            <Card className="p-4 text-xs muted flex items-start gap-2">
              {tab === "delete" ? <Trash2 size={13} style={{ marginTop: 2 }} /> : tab === "rotate" ? <RotateCw size={13} style={{ marginTop: 2 }} /> : <FileOutput size={13} style={{ marginTop: 2 }} />}
              <span>The result is a new download; your original file stays as it is.</span>
            </Card>
          </>
        }
      />
    </Screen>
  );
}
