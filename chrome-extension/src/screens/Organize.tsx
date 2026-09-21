import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Copy, Layers, RotateCcw, RotateCw, Trash2 } from "lucide-react";
import { Badge, Button, Card, IconButton } from "../components/ui";
import { DropArea, ErrorBanner, OptionCard, Results, RunBar, Screen, TwoColumn } from "../components/shell";
import { applyPagePlan } from "../lib/pdf";
import { renderPage } from "../lib/render";
import { resultFor, usePdfSession, suggestedName } from "../lib/session";

interface PageItem {
  id: string;
  source: number;
  rotation: number;
}

function PageThumb({ bytes, page, width, rotation }: { bytes: Uint8Array; page: number; width: number; rotation: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting) || cancelled) return;
        observer.disconnect();
        void renderPage(bytes, page, 96)
          .then((rendered) => {
            if (cancelled) return;
            const canvas = ref.current;
            if (!canvas) return;
            const scale = width / rendered.width;
            canvas.width = width;
            canvas.height = Math.round(rendered.height * scale);
            const context = canvas.getContext("2d");
            if (!context) return;
            context.fillStyle = "#ffffff";
            context.fillRect(0, 0, canvas.width, canvas.height);
            context.drawImage(rendered.canvas, 0, 0, canvas.width, canvas.height);
            setReady(true);
          })
          .catch(() => undefined);
      },
      { rootMargin: "400px" },
    );
    observer.observe(host);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [bytes, page, width]);

  return (
    <div ref={hostRef} className="flex items-center justify-center" style={{ width, minHeight: width * 1.3, background: "var(--surface-2)" }}>
      <canvas ref={ref} style={{ width, display: ready ? "block" : "none", transform: `rotate(${rotation}deg)` }} />
    </div>
  );
}

export function OrganizeScreen() {
  const session = usePdfSession({ accept: "pdf" });
  const [pages, setPages] = useState<PageItem[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [history, setHistory] = useState<PageItem[][]>([]);
  const seed = useRef(1);
  const info = session.info;

  useEffect(() => {
    const total = info?.pageCount ?? 0;
    setPages(Array.from({ length: total }, (_, index) => ({ id: `p${index + 1}-${seed.current++}`, source: index + 1, rotation: 0 })));
    setSelected(new Set());
    setHistory([]);
  }, [info?.pageCount, info?.fileName]);

  const commit = useCallback(
    (next: PageItem[]) => {
      setHistory((previous) => [...previous.slice(-49), pages]);
      setPages(next);
      setSelected(new Set());
    },
    [pages],
  );

  const rotateSelection = (delta: number) => {
    if (!selected.size) return;
    commit(
      pages.map((page, index) =>
        selected.has(index) ? { ...page, rotation: ((page.rotation + delta) % 360 + 360) % 360 } : page,
      ),
    );
  };

  const duplicateSelection = () => {
    if (!selected.size) return;
    const next: PageItem[] = [];
    pages.forEach((page, index) => {
      next.push(page);
      if (selected.has(index)) next.push({ ...page, id: `${page.id}-copy${seed.current++}` });
    });
    commit(next);
  };

  const deleteSelection = () => {
    if (!selected.size || selected.size >= pages.length) return;
    commit(pages.filter((_, index) => !selected.has(index)));
  };

  const movePage = (from: number, to: number) => {
    if (to < 0 || to >= pages.length) return;
    const next = [...pages];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    commit(next);
  };

  const run = () =>
    session.run(async () => {
      if (!session.primary) return;
      const bytes = await applyPagePlan(
        session.primary.bytes,
        pages.map((page) => ({ source: page.source, rotation: page.rotation })),
      );
      return resultFor(suggestedName(session.primary.name, "_organized"), bytes, `${pages.length} pages exported`);
    }, "Exporting pages");

  const changed = useMemo(
    () => pages.some((page, index) => page.source !== index + 1 || page.rotation !== 0) || pages.length !== (info?.pageCount ?? 0),
    [pages, info?.pageCount],
  );

  return (
    <Screen
      title="Organize pages"
      subtitle="Reorder, rotate, duplicate and delete pages, then export a new PDF."
      actions={
        session.primary ? (
          <div className="flex items-center gap-1.5">
            <IconButton label="Undo" onClick={() => setHistory((previous) => { const last = previous[previous.length - 1]; if (last) { setPages(last); setSelected(new Set()); } return previous.slice(0, -1); })} disabled={!history.length}>
              <RotateCcw size={15} />
            </IconButton>
            <IconButton label="Rotate left" onClick={() => rotateSelection(-90)} disabled={!selected.size}>
              <RotateCcw size={15} />
            </IconButton>
            <IconButton label="Rotate right" onClick={() => rotateSelection(90)} disabled={!selected.size}>
              <RotateCw size={15} />
            </IconButton>
            <IconButton label="Duplicate" onClick={duplicateSelection} disabled={!selected.size}>
              <Copy size={15} />
            </IconButton>
            <IconButton label="Delete" onClick={deleteSelection} disabled={!selected.size || selected.size >= pages.length}>
              <Trash2 size={15} />
            </IconButton>
          </div>
        ) : null
      }
    >
      <TwoColumn
        main={
          !session.primary ? (
            <DropArea session={session} />
          ) : (
            <>
              <Card className="p-4 flex flex-wrap items-center gap-3">
                <Badge tone={selected.size ? "accent" : "default"}>{selected.size} selected</Badge>
                <Button size="sm" variant="ghost" onClick={() => setSelected(new Set(pages.map((_, index) => index)))}>
                  Select all
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                  Clear
                </Button>
                {changed ? <span className="text-xs" style={{ color: "var(--warn)" }}>unsaved changes</span> : null}
                <div className="ml-auto flex gap-1.5">
                  <Button size="sm" onClick={() => rotateSelection(-90)} disabled={!selected.size}>
                    90° ↺
                  </Button>
                  <Button size="sm" onClick={() => rotateSelection(90)} disabled={!selected.size}>
                    90° ↻
                  </Button>
                  <Button size="sm" onClick={() => rotateSelection(180)} disabled={!selected.size}>
                    180°
                  </Button>
                </div>
              </Card>
              <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }}>
                {pages.map((page, index) => (
                  <div key={page.id} className="flex flex-col gap-1">
                    <div
                      className="thumb"
                      data-selected={selected.has(index)}
                      style={{ aspectRatio: "1 / 1.3" }}
                      onClick={(event) => {
                        const next = new Set(selected);
                        if (event.ctrlKey || event.metaKey) {
                          if (next.has(index)) next.delete(index);
                          else next.add(index);
                        } else if (event.shiftKey && selected.size) {
                          const anchor = Math.min(...selected);
                          for (let i = Math.min(anchor, index); i <= Math.max(anchor, index); i += 1) next.add(i);
                        } else {
                          next.clear();
                          next.add(index);
                        }
                        setSelected(next);
                      }}
                    >
                      <PageThumb bytes={session.primary!.bytes} page={page.source} width={150} rotation={page.rotation} />
                      <span className="absolute top-1.5 left-1.5 text-[11px] font-semibold px-1.5 py-0.5 rounded-md" style={{ background: "rgb(0 0 0 / 0.55)", color: "white" }}>
                        {index + 1}
                      </span>
                      {page.rotation ? (
                        <span className="absolute top-1.5 right-1.5 text-[10px] px-1.5 py-0.5 rounded-md" style={{ background: "rgb(0 0 0 / 0.45)", color: "white" }}>
                          {page.rotation}°
                        </span>
                      ) : null}
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] muted">source {page.source}</span>
                      <div className="flex">
                        <IconButton label="Move left" onClick={() => movePage(index, index - 1)} disabled={index === 0}>
                          ←
                        </IconButton>
                        <IconButton label="Move right" onClick={() => movePage(index, index + 1)} disabled={index === pages.length - 1}>
                          →
                        </IconButton>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )
        }
        side={
          session.primary ? (
            <>
              <RunBar session={session} runLabel="Export PDF" onRun={() => void run()} />
              <OptionCard title="Organize">
                <p className="text-xs muted">Click a page to select it, Ctrl+click to add/remove, Shift+click for a range.</p>
                <div className="flex gap-2">
                  <Button size="sm" icon={<Copy size={14} />} onClick={duplicateSelection} disabled={!selected.size}>
                    Duplicate
                  </Button>
                  <Button size="sm" variant="ghost" icon={<Layers size={14} />} onClick={() => setHistory([])} disabled={!history.length}>
                    Clear history
                  </Button>
                </div>
                <p className="text-xs muted">Rotations and order are applied when you export; the original file is untouched.</p>
              </OptionCard>
              <Results results={session.results} onClear={() => session.setResults([])} />
            </>
          ) : null
        }
      />
      <ErrorBanner error={session.error} />
    </Screen>
  );
}
