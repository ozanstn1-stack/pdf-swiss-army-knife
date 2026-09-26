/**
 * Writer pagination engine.
 *
 * Pure layout: it takes the measured geometry of every block (line boxes for
 * paragraphs, row boxes for tables, heights for images) and decides which
 * fragment of each block lands on which page. Measurement itself lives in
 * `measure.ts`; keeping the split logic separate means the pagination rules -
 * keep-with-next, keep-together, widows/orphans, repeated table headers - are
 * unit-testable without a browser.
 */
export interface BlockMetrics {
  index: number;
  kind: "paragraph" | "table" | "image" | "rule" | "pageBreak" | "toc";
  /** Total height of the block in px. */
  heightPx: number;
  /** Cumulative line bottoms for paragraphs, in px from the block top. */
  lines: number[];
  /** Cumulative row bottoms for tables, in px from the table top. */
  rows: number[];
  /** Height of the repeated header row of a table, 0 when there is none. */
  headerHeightPx: number;
  keepWithNext: boolean;
  keepTogether: boolean;
  pageBreakBefore: boolean;
}

export interface Fragment {
  index: number;
  mode: "whole" | "lines" | "rows";
  /** Paragraph: first visible line. Table: first row. */
  from: number;
  /** Exclusive end. */
  to: number;
  heightPx: number;
  /** Vertical shift for paragraph continuations (px). */
  offsetPx: number;
  /** Table continuations repeat the header row. */
  repeatHeader: boolean;
}

export interface PageLayout {
  fragments: Fragment[];
  usedPx: number;
  /** True when the page only carries the spill-over of a split block. */
  continuation: boolean;
}

export interface PaginationOptions {
  /** Lines that must stay together at the bottom of a page. */
  orphans?: number;
  /** Lines that must stay together at the top of a page. */
  widows?: number;
}

interface WorkItem {
  metrics: BlockMetrics;
  fromLine: number;
  fromRow: number;
  /** True when this is a continuation on a fresh page. */
  continuation: boolean;
  /** True when a keep rule already deferred the block once. */
  deferred: boolean;
}

function fits(lines: number[], from: number, remaining: number): number {
  let count = 0;
  while (from + count < lines.length && lines[from + count] <= remaining) count += 1;
  return count;
}

/**
 * Lays blocks out into pages of `contentHeightPx`.
 *
 * Anything that cannot be split (images, short tables) moves to the next page;
 * paragraphs split at line boundaries and tables at row boundaries, honouring
 * the widow/orphan minimums and repeating a table's header row.
 */
export function paginate(blocks: BlockMetrics[], contentHeightPx: number, options: PaginationOptions = {}): PageLayout[] {
  const orphans = Math.max(1, options.orphans ?? 2);
  const widows = Math.max(1, options.widows ?? 2);
  const pages: PageLayout[] = [];
  let page: PageLayout = { fragments: [], usedPx: 0, continuation: false };
  const queue: WorkItem[] = blocks.map((metrics) => ({ metrics, fromLine: 0, fromRow: 0, continuation: false, deferred: false }));

  const pushPage = (continuation: boolean) => {
    if (page.fragments.length > 0) pages.push(page);
    page = { fragments: [], usedPx: 0, continuation };
  };

  while (queue.length > 0) {
    const item = queue.shift()!;
    const metrics = item.metrics;
    if (metrics.kind === "pageBreak") {
      pushPage(false);
      continue;
    }
    if (metrics.pageBreakBefore && !item.continuation && page.fragments.length > 0) {
      pushPage(true);
    }

    const remaining = contentHeightPx - page.usedPx;
    // A continuation fragment of a table pays for the repeated header.
    const overhead = item.fromRow > 0 ? metrics.headerHeightPx : 0;
    const heightLeft = metrics.heightPx - (item.fromRow > 0 ? metrics.rows[item.fromRow - 1] ?? 0 : 0) - (item.fromLine > 0 ? metrics.lines[item.fromLine - 1] ?? 0 : 0);

    // keepTogether and keepWithNext can only be honoured when the page is not
    // empty and the block fits a page of its own at all.
    const nextItem = queue[0];
    const keepTogetherBreak = metrics.keepTogether && !item.continuation && !item.deferred && page.fragments.length > 0 && heightLeft + overhead <= contentHeightPx;
    // keep-with-next: when the follower cannot share the rest of this page,
    // the pair moves together - but only once, otherwise an empty fresh page
    // would defer for ever.
    const keepWithNextBreak =
      metrics.keepWithNext &&
      !item.continuation &&
      !item.deferred &&
      (page.fragments.length > 0 || page.continuation) &&
      heightLeft + overhead <= contentHeightPx &&
      nextItem !== undefined &&
      nextItem.metrics.kind !== "pageBreak" &&
      heightLeft + overhead + nextItem.metrics.heightPx > remaining;
    if (keepTogetherBreak || keepWithNextBreak) {
      pushPage(true);
      queue.unshift({ ...item, deferred: true });
      continue;
    }

    if (heightLeft + overhead <= remaining) {
      const from = metrics.kind === "table" ? item.fromRow : item.fromLine;
      const to = metrics.kind === "paragraph" ? metrics.lines.length : metrics.kind === "table" ? metrics.rows.length : 0;
      const consumed = metrics.kind === "table" ? (item.fromRow > 0 ? metrics.rows[item.fromRow - 1] ?? 0 : 0) : item.fromLine > 0 ? metrics.lines[item.fromLine - 1] ?? 0 : 0;
      page.fragments.push({
        index: metrics.index,
        mode: metrics.kind === "paragraph" && item.fromLine > 0 ? "lines" : metrics.kind === "table" && item.fromRow > 0 ? "rows" : "whole",
        from,
        to,
        heightPx: heightLeft + overhead,
        offsetPx: consumed,
        repeatHeader: metrics.kind === "table" && item.fromRow > 0 && metrics.headerHeightPx > 0,
      });
      page.usedPx += heightLeft + overhead;
      continue;
    }

    if (metrics.kind === "paragraph" && metrics.lines.length > 1) {
      const total = metrics.lines.length;
      const consumed = item.fromLine > 0 ? metrics.lines[item.fromLine - 1] : 0;
      let count = fits(metrics.lines, item.fromLine, remaining + consumed);
      // Widows: never leave fewer than `widows` lines for the next page.
      count = Math.min(count, total - item.fromLine - (total - item.fromLine > widows ? widows : 0));
      // Orphans: never leave fewer than `orphans` lines behind on this page.
      if (count < Math.min(orphans, total - item.fromLine)) count = 0;
      if (count > 0) {
        const bottom = metrics.lines[item.fromLine + count - 1];
        const top = item.fromLine > 0 ? metrics.lines[item.fromLine - 1] : 0;
        page.fragments.push({
          index: metrics.index,
          mode: "lines",
          from: item.fromLine,
          to: item.fromLine + count,
          heightPx: bottom - top,
          offsetPx: top,
          repeatHeader: false,
        });
        page.usedPx += bottom - top;
        pushPage(true);
        queue.unshift({ metrics, fromLine: item.fromLine + count, fromRow: 0, continuation: true, deferred: false });
        continue;
      }
    }

    if (metrics.kind === "table" && metrics.rows.length > 0 && metrics.rows.length > item.fromRow) {
      const available = remaining - (item.fromRow > 0 ? metrics.headerHeightPx : 0);
      const offset = item.fromRow > 0 ? metrics.rows[item.fromRow - 1] : 0;
      let count = 0;
      while (item.fromRow + count < metrics.rows.length && metrics.rows[item.fromRow + count] - offset <= available) count += 1;
      if (count > 0) {
        const bottom = metrics.rows[item.fromRow + count - 1];
        page.fragments.push({
          index: metrics.index,
          mode: "rows",
          from: item.fromRow,
          to: item.fromRow + count,
          heightPx: bottom - offset + (item.fromRow > 0 ? metrics.headerHeightPx : 0),
          offsetPx: offset,
          repeatHeader: item.fromRow > 0 && metrics.headerHeightPx > 0,
        });
        page.usedPx += bottom - offset + (item.fromRow > 0 ? metrics.headerHeightPx : 0);
        pushPage(true);
        queue.unshift({ metrics, fromLine: 0, fromRow: item.fromRow + count, continuation: true, deferred: false });
        continue;
      }
    }

    // Nothing of the block fits on this page: move it whole to the next one.
    if (page.fragments.length > 0) {
      pushPage(true);
      queue.unshift(item);
      continue;
    }
    // The page is empty, so the block has to go somewhere. A paragraph taller
    // than a page splits at the raw fit (widow/orphan rules cannot be honoured
    // without losing content); a table places one row; anything else is clipped.
    if (metrics.kind === "paragraph" && metrics.lines.length > item.fromLine) {
      const consumed = item.fromLine > 0 ? metrics.lines[item.fromLine - 1] : 0;
      const raw = Math.max(1, fits(metrics.lines, item.fromLine, contentHeightPx + consumed));
      const bottom = metrics.lines[item.fromLine + raw - 1];
      page.fragments.push({
        index: metrics.index,
        mode: "lines",
        from: item.fromLine,
        to: item.fromLine + raw,
        heightPx: Math.min(bottom - consumed, contentHeightPx),
        offsetPx: consumed,
        repeatHeader: false,
      });
      page.usedPx = contentHeightPx;
      pushPage(true);
      if (item.fromLine + raw < metrics.lines.length) queue.unshift({ ...item, fromLine: item.fromLine + raw, continuation: true, deferred: false });
      continue;
    }
    if (metrics.kind === "table" && metrics.rows.length > item.fromRow) {
      const nextRow = item.fromRow + 1;
      const offset = item.fromRow > 0 ? metrics.rows[item.fromRow - 1] : 0;
      page.fragments.push({
        index: metrics.index,
        mode: "rows",
        from: item.fromRow,
        to: nextRow,
        heightPx: metrics.rows[nextRow - 1] - offset + overhead,
        offsetPx: offset,
        repeatHeader: item.fromRow > 0 && metrics.headerHeightPx > 0,
      });
      page.usedPx = contentHeightPx;
      pushPage(true);
      if (nextRow < metrics.rows.length) queue.unshift({ ...item, fromRow: nextRow, continuation: true, deferred: false });
      continue;
    }
    page.fragments.push({
      index: metrics.index,
      mode: "whole",
      from: 0,
      to: 0,
      heightPx: Math.min(metrics.heightPx, contentHeightPx),
      offsetPx: 0,
      repeatHeader: false,
    });
    page.usedPx = contentHeightPx;
    pushPage(true);
  }
  if (page.fragments.length > 0) pages.push(page);
  if (pages.length === 0) pages.push({ fragments: [], usedPx: 0, continuation: false });
  return pages;
}

/** The page index (1-based) that contains a block, for the navigation pane. */
export function pageOfBlock(pages: PageLayout[], index: number): number {
  for (let page = 0; page < pages.length; page += 1) {
    if (pages[page].fragments.some((fragment) => fragment.index === index)) return page + 1;
  }
  return 1;
}
