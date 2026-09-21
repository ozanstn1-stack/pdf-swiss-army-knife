import { useMemo } from "react";
import { Combine } from "lucide-react";
import { Card } from "../components/ui";
import { DropArea, ErrorBanner, FileChips, OptionCard, Results, RunBar, Screen, TwoColumn } from "../components/shell";
import { mergePdfs } from "../lib/pdf";
import { resultFor, usePdfSession } from "../lib/session";
import { formatBytes } from "../lib/format";

export function MergeScreen() {
  const session = usePdfSession({ multiple: true, accept: "pdf" });
  const combined = useMemo(() => session.files.reduce((sum, file) => sum + file.size, 0), [session.files]);

  const run = () =>
    session.run(async () => {
      session.setProgress({ label: "Merging documents", current: 0, total: session.files.length });
      const bytes = await mergePdfs(session.files.map((file) => ({ name: file.name, bytes: file.bytes })));
      const name = `merged_${session.files.length}_documents.pdf`;
      session.setProgress({ label: "Merging documents", current: session.files.length, total: session.files.length });
      return resultFor(name, bytes, `${session.files.length} documents · ${formatBytes(bytes.length)}`);
    }, "Merging documents");

  return (
    <Screen title="Merge PDFs" subtitle="Combine several documents into one, in exactly the order you choose." actions={<Combine size={18} className="muted" />}>
      <TwoColumn
        main={
          <>
            {!session.files.length ? (
              <DropArea session={session} hint="or click to choose · select two or more PDFs" />
            ) : (
              <OptionCard title={`${session.files.length} documents · ${formatBytes(combined)}`}>
                <p className="text-xs muted -mt-1">Use the arrows to set the order; the first document provides the metadata.</p>
                <FileChips session={session} reorder />
              </OptionCard>
            )}
            <ErrorBanner error={session.error} />
          </>
        }
        side={
          <>
            <RunBar session={session} runLabel="Merge PDFs" disabled={session.files.length < 2} onRun={() => void run()} />
            <Results results={session.results} onClear={() => session.setResults([])} />
            <Card className="p-4 text-xs muted flex flex-col gap-1.5">
              <p>Merging keeps the original files untouched — the result is a new download.</p>
              <p>Bookmarks/outlines of the sources are not merged (same as the desktop version).</p>
            </Card>
          </>
        }
      />
    </Screen>
  );
}
