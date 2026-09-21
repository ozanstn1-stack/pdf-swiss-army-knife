import { useRef, useState, type ReactNode } from "react";
import { CheckCircle2, Download, FileText, FolderOpen, X } from "lucide-react";
import { Badge, Button, Card, IconButton, Spinner } from "./ui";
import { downloadResult, type LocalFile, type PdfSession } from "../lib/session";
import { formatBytes } from "../lib/format";

export function Screen({
  title,
  subtitle,
  actions,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto px-7 py-6 flex flex-col gap-5" style={{ maxWidth: 1080 }}>
        <header className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-[21px] font-bold tracking-tight leading-tight">{title}</h1>
            {subtitle ? <p className="muted text-[13.5px] mt-1">{subtitle}</p> : null}
          </div>
          {actions ? <div className="flex items-center gap-2 shrink-0">{actions}</div> : null}
        </header>
        {children}
      </div>
    </div>
  );
}

export function TwoColumn({ main, side }: { main: ReactNode; side: ReactNode }) {
  return (
    <div className="two-col">
      <div className="col-main flex flex-col gap-4 min-w-0">{main}</div>
      <div className="col-side flex flex-col gap-4 min-w-0">{side}</div>
    </div>
  );
}

export function OptionCard({ title, children }: { title?: ReactNode; children: ReactNode }) {
  return (
    <div className="card p-4 flex flex-col gap-3.5">
      {title ? <h3 className="text-[13px] font-bold uppercase tracking-wider muted">{title}</h3> : null}
      {children}
    </div>
  );
}

export function DropArea({ session, hint }: { session: PdfSession; hint?: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const accept =
    session.accept === "pdf"
      ? "application/pdf"
      : session.accept === "image"
        ? "image/png,image/jpeg,image/webp"
        : "application/pdf,image/png,image/jpeg,image/webp";

  return (
    <div
      className="dropzone flex flex-col items-center justify-center text-center gap-3"
      data-over={over}
      style={{ padding: "42px 24px" }}
      onClick={() => inputRef.current?.click()}
      onDragOver={(event) => {
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setOver(false);
        if (event.dataTransfer?.files?.length) void session.addFiles(event.dataTransfer.files);
      }}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") inputRef.current?.click();
      }}
    >
      <input
        ref={inputRef}
        type="file"
        multiple={session.multiple}
        accept={accept}
        className="hidden"
        onChange={(event) => {
          if (event.target.files?.length) void session.addFiles(event.target.files);
          event.target.value = "";
        }}
      />
      <div className="rounded-2xl flex items-center justify-center" style={{ width: 54, height: 54, background: "var(--accent-weak)", color: "var(--accent)" }}>
        <FolderOpen size={24} />
      </div>
      <div>
        <p className="font-semibold text-[15px]">Drop files here</p>
        <p className="text-sm muted mt-1">{hint ?? "or click to choose · PDF, JPG, PNG — nothing leaves your browser"}</p>
      </div>
      <Button variant="primary" onClick={() => inputRef.current?.click()}>
        Select files
      </Button>
    </div>
  );
}

export function FileChips({
  session,
  reorder = false,
}: {
  session: PdfSession;
  reorder?: boolean;
}) {
  if (!session.files.length) return null;
  return (
    <div className="flex flex-col gap-2">
      {session.files.map((file: LocalFile, index: number) => (
        <div key={`${file.name}-${index}`} className="card-soft flex items-center gap-3 px-3 py-2.5">
          <span className="w-6 h-6 rounded-md flex items-center justify-center text-xs font-semibold shrink-0" style={{ background: "var(--accent-weak)", color: "var(--accent)" }}>
            {index + 1}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13.5px] font-medium" title={file.name}>
              {file.name}
            </p>
            <p className="text-xs muted">{formatBytes(file.size)}</p>
          </div>
          {reorder ? (
            <div className="flex gap-1">
              <Button size="sm" variant="ghost" disabled={index === 0} onClick={() => session.moveFile(index, index - 1)}>
                ↑
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={index === session.files.length - 1}
                onClick={() => session.moveFile(index, index + 1)}
              >
                ↓
              </Button>
            </div>
          ) : null}
          <IconButton label="Remove" onClick={() => session.removeFile(index)}>
            <X size={15} />
          </IconButton>
        </div>
      ))}
    </div>
  );
}

export function RunBar({
  session,
  runLabel,
  disabled = false,
  onRun,
  children,
}: {
  session: PdfSession;
  runLabel: string;
  disabled?: boolean;
  onRun: () => void;
  children?: ReactNode;
}) {
  return (
    <Card className="p-4 flex flex-col gap-3">
      {children}
      {session.progress ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between text-xs muted">
            <span className="flex items-center gap-1.5">
              <Spinner size={13} />
              {session.progress.label}
            </span>
            <span className="tabular-nums">
              {session.progress.total > 1 ? `${session.progress.current} / ${session.progress.total}` : ""}
            </span>
          </div>
          <div className="progress-track">
            <div
              className="progress-fill"
              style={{
                width: `${session.progress.total > 1 ? Math.round((session.progress.current / session.progress.total) * 100) : 12}%`,
              }}
            />
          </div>
        </div>
      ) : null}
      <Button variant="primary" size="lg" onClick={onRun} disabled={disabled || session.busy} icon={session.busy ? <Spinner size={16} /> : undefined}>
        {session.busy ? "Working…" : runLabel}
      </Button>
      {children ? null : <p className="text-[11px] muted">Everything runs locally in this browser tab.</p>}
    </Card>
  );
}

export function Results({ results, onClear }: { results: { fileName: string; bytes: Uint8Array; detail: string }[]; onClear?: () => void }) {
  if (!results.length) return null;
  return (
    <Card className="p-4 flex flex-col gap-2 fade-in">
      <div className="flex items-center justify-between">
        <p className="font-semibold text-[13.5px] flex items-center gap-2">
          <CheckCircle2 size={16} style={{ color: "var(--ok)" }} /> {results.length === 1 ? "Result ready" : `${results.length} files ready`}
        </p>
        {onClear ? (
          <IconButton label="Clear" onClick={onClear}>
            <X size={15} />
          </IconButton>
        ) : null}
      </div>
      <div className="flex flex-col gap-2">
        {results.map((result, index) => (
          <div key={`${result.fileName}-${index}`} className="card-soft flex items-center gap-3 px-3 py-2">
            <FileText size={15} style={{ color: "var(--accent)" }} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-medium" title={result.fileName}>
                {result.fileName}
              </p>
              <p className="text-xs muted">
                {formatBytes(result.bytes.length)}
                {result.detail ? ` · ${result.detail}` : ""}
              </p>
            </div>
            <Button size="sm" icon={<Download size={14} />} onClick={() => downloadResult(result)}>
              Download
            </Button>
          </div>
        ))}
      </div>
      {results.length > 1 ? (
        <Button size="sm" variant="ghost" onClick={() => results.forEach((result, index) => setTimeout(() => downloadResult(result), index * 400))}>
          Download all
        </Button>
      ) : null}
    </Card>
  );
}

export function ErrorBanner({ error }: { error: { code: string; message: string } | null }) {
  if (!error) return null;
  const hint =
    error.code === "password_required"
      ? " Password-protected PDFs can be opened in the desktop app (Unlock tool)."
      : error.code === "cancelled"
        ? ""
        : "";
  return (
    <Card className="p-3.5 flex items-start gap-3" soft>
      <Badge tone="danger">!</Badge>
      <p className="text-[13px] flex-1">
        {error.message}
        {hint}
      </p>
    </Card>
  );
}
