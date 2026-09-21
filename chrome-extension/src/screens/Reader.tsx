import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, ChevronLeft, ChevronRight, Copy, Search, X, ZoomIn, ZoomOut } from "lucide-react";
import { Badge, Button, Card, IconButton, Spinner, useDebounced } from "../components/ui";
import { DropArea, ErrorBanner, Screen } from "../components/shell";
import { extractPageText, renderPage, searchDocument, type PdfSearchResult } from "../lib/render";
import { describeError, usePdfSession } from "../lib/session";
import { clamp, formatBytes } from "../lib/format";

async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = value;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

function ReaderCanvas({ bytes, page, width }: { bytes: Uint8Array; page: number; width: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [failed, setFailed] = useState(false);

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
            const canvas = canvasRef.current;
            if (!canvas) return;
            const scale = width / rendered.width;
            canvas.width = width;
            canvas.height = Math.round(rendered.height * scale);
            const context = canvas.getContext("2d");
            if (!context) return;
            context.fillStyle = "#ffffff";
            context.fillRect(0, 0, canvas.width, canvas.height);
            context.drawImage(rendered.canvas, 0, 0, canvas.width, canvas.height);
            setSize({ width: canvas.width, height: canvas.height });
          })
          .catch(() => setFailed(true));
      },
      { rootMargin: "700px" },
    );
    observer.observe(host);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [bytes, page, width]);

  return (
    <div ref={hostRef} className="card overflow-hidden shrink-0" style={{ width, minHeight: Math.round(width * 1.35), background: "white" }}>
      {failed ? <div className="flex items-center justify-center muted text-sm h-full">—</div> : null}
      <canvas ref={canvasRef} style={{ display: size ? "block" : "none", width: "100%", height: "auto" }} />
      {!size && !failed ? (
        <div className="flex items-center justify-center" style={{ height: Math.round(width * 1.35) }}>
          <Spinner size={20} />
        </div>
      ) : null}
    </div>
  );
}

export function ReaderScreen() {
  const session = usePdfSession({ accept: "pdf" });
  const scrollRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(880);
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [currentPage, setCurrentPage] = useState(1);
  const [query, setQuery] = useState("");
  const [searchResult, setSearchResult] = useState<PdfSearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [copied, setCopied] = useState(false);
  const [searchProgress, setSearchProgress] = useState<{ current: number; total: number } | null>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const cancelSearch = useRef(false);

  const debouncedZoom = useDebounced(zoom, 180);
  const info = session.info;
  const pageCount = info?.pageCount ?? 0;

  const renderWidth = useMemo(() => {
    const available = Math.max(320, containerWidth - 72);
    if (debouncedZoom === "fit") return Math.round(available);
    const base = ((info?.pageSizes[0]?.width ?? 595) * 96) / 72;
    return Math.round(clamp(base * debouncedZoom, 200, 2400));
  }, [containerWidth, debouncedZoom, info?.pageSizes]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => setContainerWidth(entries[0]?.contentRect.width ?? 880));
    observer.observe(element);
    setContainerWidth(element.clientWidth || 880);
    return () => observer.disconnect();
  }, [session.primary]);

  const handleScroll = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;
    const top = container.getBoundingClientRect().top + 12;
    let best = currentPage;
    let bestDistance = Number.POSITIVE_INFINITY;
    pageRefs.current.forEach((element, page) => {
      const distance = Math.abs(element.getBoundingClientRect().top - top);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = page;
      }
    });
    setCurrentPage((previous) => (previous === best ? previous : best));
  }, [currentPage]);

  const scrollToPage = useCallback((page: number) => {
    pageRefs.current.get(page)?.scrollIntoView({ behavior: "smooth", block: "start" });
    setCurrentPage(page);
  }, []);

  const runSearch = async () => {
    if (!session.primary || !query.trim()) return;
    cancelSearch.current = false;
    setSearching(true);
    setSearchResult(null);
    setSearchProgress({ current: 0, total: pageCount });
    try {
      const result = await searchDocument(
        session.primary.bytes,
        query,
        300,
        (page, total) => setSearchProgress({ current: page, total }),
        () => cancelSearch.current,
      );
      setSearchResult(result);
      if (result.matches.length) scrollToPage(result.matches[0].page);
    } catch (error) {
      const described = describeError(error);
      if (described.code !== "cancelled") session.setError(described);
    } finally {
      setSearching(false);
      setSearchProgress(null);
    }
  };

  const copyPage = async () => {
    if (!session.primary) return;
    const text = await extractPageText(session.primary.bytes, currentPage).catch(() => "");
    if (!text) {
      session.setError({ code: "no_text", message: "This page has no text layer (a scanned page needs OCR in the desktop app)." });
      return;
    }
    if (await copyText(text)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }
  };

  const matchesByPage = useMemo(() => {
    const map = new Map<number, number>();
    searchResult?.matches.forEach((match) => map.set(match.page, (map.get(match.page) ?? 0) + 1));
    return map;
  }, [searchResult]);

  if (!session.primary) {
    return (
      <Screen title="Reading mode" subtitle="Continuous scroll with zoom and full-text search.">
        <DropArea session={session} hint="or click to choose a PDF to read" />
      </Screen>
    );
  }

  return (
    <div className="h-full flex min-h-0">
      <div className="flex-1 min-w-0 flex flex-col min-h-0">
        <div className="flex items-center gap-2 px-4 py-2.5 border-b shrink-0 flex-wrap" style={{ borderColor: "var(--border)", background: "var(--bg-soft)" }}>
          <BookOpen size={16} style={{ color: "var(--accent)" }} />
          <span className="font-semibold text-[13.5px] truncate max-w-[200px]" title={session.primary.name}>
            {session.primary.name}
          </span>
          <Badge tone="accent">
            {currentPage} / {pageCount}
          </Badge>
          <div className="flex items-center gap-1 ml-2">
            <IconButton label="Zoom out" onClick={() => setZoom(typeof zoom === "number" ? clamp(zoom * 0.8, 0.25, 4) : 1)}>
              <ZoomOut size={15} />
            </IconButton>
            <button className="btn btn-sm" style={{ minWidth: 74 }} onClick={() => setZoom("fit")}>
              {typeof zoom === "number" ? `${Math.round(zoom * 100)}%` : "Fit width"}
            </button>
            <IconButton label="Zoom in" onClick={() => setZoom(typeof zoom === "number" ? clamp(zoom * 1.25, 0.25, 4) : 1.25)}>
              <ZoomIn size={15} />
            </IconButton>
          </div>
          <IconButton label="Previous page" onClick={() => scrollToPage(Math.max(1, currentPage - 1))} disabled={currentPage <= 1}>
            <ChevronLeft size={15} />
          </IconButton>
          <IconButton label="Next page" onClick={() => scrollToPage(Math.min(pageCount, currentPage + 1))} disabled={currentPage >= pageCount}>
            <ChevronRight size={15} />
          </IconButton>
          <div className="relative flex-1 min-w-[190px] max-w-[340px]">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 muted" />
            <input
              className="input input-sm pl-8 pr-8"
              placeholder="Find in document…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void runSearch();
                if (event.key === "Escape") {
                  cancelSearch.current = true;
                  setQuery("");
                  setSearchResult(null);
                }
              }}
            />
            {query ? (
              <button
                className="icon-btn absolute right-0 top-1/2 -translate-y-1/2"
                onClick={() => {
                  setQuery("");
                  setSearchResult(null);
                }}
                aria-label="Clear"
              >
                <X size={13} />
              </button>
            ) : null}
          </div>
          <Button size="sm" onClick={() => void runSearch()} disabled={!query.trim() || searching}>
            Search
          </Button>
          <IconButton label="Copy page text" onClick={() => void copyPage()}>
            <Copy size={15} />
          </IconButton>
        </div>

        {searching ? (
          <div className="px-4 py-1.5 text-xs muted shrink-0 flex items-center gap-2" style={{ background: "var(--surface-2)" }}>
            <Spinner size={12} /> Searching… {searchProgress ? `${searchProgress.current} / ${searchProgress.total}` : ""}
          </div>
        ) : searchResult ? (
          <div className="px-4 py-1.5 text-xs shrink-0" style={{ background: "var(--surface-2)" }}>
            {searchResult.totalMatches
              ? `${searchResult.totalMatches} matches on ${searchResult.pagesWithMatches} page(s)${searchResult.truncated ? " · showing the first results" : ""}`
              : searchResult.hasTextLayer
                ? "No matches found"
                : "This document has no text layer — run OCR in the desktop app to make it searchable"}
          </div>
        ) : null}

        <div ref={scrollRef} onScroll={handleScroll} className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden" style={{ background: "var(--bg)" }}>
          <div className="px-6 py-5 flex flex-col gap-5 items-center">
            {Array.from({ length: pageCount }, (_, index) => index + 1).map((page) => (
              <div
                key={`${page}-${renderWidth}`}
                className="flex flex-col gap-1.5 items-center"
                ref={(node) => {
                  if (node) pageRefs.current.set(page, node);
                  else pageRefs.current.delete(page);
                }}
              >
                <ReaderCanvas bytes={session.primary!.bytes} page={page} width={renderWidth} />
                <span className="text-[11px] muted">
                  {page}
                  {matchesByPage.get(page) ? ` · ${matchesByPage.get(page)} match${matchesByPage.get(page)! > 1 ? "es" : ""}` : ""}
                </span>
              </div>
            ))}
            <p className="text-xs muted py-3">Ctrl+F to search · Ctrl +/− to zoom · Ctrl+0 fit width</p>
          </div>
        </div>
      </div>

      <aside className="w-[290px] shrink-0 border-l overflow-y-auto hidden lg:flex flex-col gap-3 p-3" style={{ borderColor: "var(--border)", background: "var(--bg-soft)" }}>
        <p className="text-[12px] font-bold uppercase tracking-wider muted">Go to page</p>
        <div className="flex items-center gap-2">
          <input
            className="input input-sm"
            type="number"
            min={1}
            max={Math.max(1, pageCount)}
            value={currentPage}
            onChange={(event) => scrollToPage(clamp(Number(event.target.value) || 1, 1, Math.max(1, pageCount)))}
          />
          <span className="text-xs muted">/ {pageCount}</span>
        </div>
        <p className="text-[12px] font-bold uppercase tracking-wider muted mt-2">Search results</p>
        {searchResult?.matches.length ? (
          <div className="flex flex-col gap-1.5">
            {searchResult.matches.slice(0, 80).map((match, index) => (
              <button
                key={`${match.page}-${index}`}
                className="text-left card-soft px-2.5 py-2 text-[12.5px] hover:border-[var(--accent)]"
                onClick={() => scrollToPage(match.page)}
                title={match.snippet}
              >
                <span className="badge badge-accent mr-2">{match.page}</span>
                <span className="muted">{match.snippet}</span>
              </button>
            ))}
          </div>
        ) : (
          <p className="text-xs muted">Search the document text with the box above.</p>
        )}
        <div className="mt-auto pt-3 flex flex-col gap-2">
          {info ? (
            <Card className="p-3 text-[12.5px] flex flex-col gap-1">
              <span className="font-semibold truncate">{info.fileName}</span>
              <span className="muted">
                {info.pageCount} pages · {formatBytes(info.fileSize)} · PDF {info.version}
              </span>
              <span className="muted">{info.encrypted ? "restricted/encrypted" : "not encrypted"}</span>
            </Card>
          ) : null}
          {copied ? <p className="text-xs" style={{ color: "var(--ok)" }}>Page text copied to the clipboard</p> : null}
        </div>
      </aside>
      <ErrorBanner error={session.error} />
    </div>
  );
}
