import { useEffect, useState } from "react";
import { Eraser, Save } from "lucide-react";
import { Button, Card, Field, TextInput } from "../components/ui";
import { DropArea, ErrorBanner, FileChips, OptionCard, Results, RunBar, Screen, TwoColumn } from "../components/shell";
import { clearMetadata, editMetadata } from "../lib/pdf";
import { resultFor, usePdfSession, suggestedName } from "../lib/session";

const EMPTY = { title: "", author: "", subject: "", keywords: "", creator: "", producer: "" };

export function MetadataScreen() {
  const session = usePdfSession({ accept: "pdf" });
  const [form, setForm] = useState({ ...EMPTY });

  useEffect(() => {
    if (!session.info) return;
    setForm({
      title: session.info.title,
      author: session.info.author,
      subject: session.info.subject,
      keywords: session.info.keywords,
      creator: session.info.creator,
      producer: session.info.producer,
    });
  }, [session.info]);

  const patch = (values: Partial<typeof form>) => setForm((previous) => ({ ...previous, ...values }));

  const save = () =>
    session.run(async () => {
      if (!session.primary) return;
      const bytes = await editMetadata(session.primary.bytes, form);
      return resultFor(suggestedName(session.primary.name, "_metadata"), bytes, "metadata updated");
    }, "Saving metadata");

  const remove = () =>
    session.run(async () => {
      if (!session.primary) return;
      const bytes = await clearMetadata(session.primary.bytes);
      return resultFor(suggestedName(session.primary.name, "_metadata"), bytes, "metadata cleared");
    }, "Clearing metadata");

  const fields: { key: keyof typeof form; label: string }[] = [
    { key: "title", label: "Title" },
    { key: "author", label: "Author" },
    { key: "subject", label: "Subject" },
    { key: "keywords", label: "Keywords" },
    { key: "creator", label: "Creator" },
    { key: "producer", label: "Producer" },
  ];

  return (
    <Screen title="Metadata editor" subtitle="Read and edit document properties such as title and author.">
      <TwoColumn
        main={
          <>
            {!session.primary ? (
              <DropArea session={session} />
            ) : (
              <>
                <OptionCard title="Document">
                  <FileChips session={session} />
                  <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))" }}>
                    {fields.map((field) => (
                      <Field key={field.key} label={field.label}>
                        <TextInput value={form[field.key]} onChange={(event) => patch({ [field.key]: event.target.value })} />
                      </Field>
                    ))}
                  </div>
                </OptionCard>
              </>
            )}
            <ErrorBanner error={session.error} />
          </>
        }
        side={
          <>
            <RunBar session={session} runLabel="Save metadata" disabled={!session.primary} onRun={() => void save()} />
            <Card className="p-4 flex flex-col gap-2">
              <Button variant="danger" icon={<Eraser size={15} />} onClick={() => void remove()} disabled={!session.primary}>
                Clear all metadata
              </Button>
              <Button variant="ghost" icon={<Save size={15} />} onClick={() => session.setResults([])} disabled={!session.results.length}>
                Reset result
              </Button>
              <p className="text-xs muted">Clearing writes empty fields; dates set by the original producer are kept.</p>
            </Card>
            <Results results={session.results} onClear={() => session.setResults([])} />
          </>
        }
      />
    </Screen>
  );
}
