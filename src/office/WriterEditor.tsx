/**
 * Writer editor: a page-aware rich text editor on the shared document model.
 *
 * Editing model: each paragraph is a contentEditable surface edited natively
 * (so caret behaviour, IME and clipboard work), then synchronised back into
 * the model runs on input. Structural changes (lists, tables, images, page
 * setup, styles) mutate the model directly, which keeps DOCX/ODT export exact.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Bold,
  Eraser,
  FileDown,
  FolderOpen,
  FileText,
  Highlighter,
  Image as ImageIcon,
  Indent,
  Italic,
  Link2,
  List,
  ListOrdered,
  Minus,
  Outdent,
  Printer,
  Redo2,
  Save,
  Search,
  SeparatorHorizontal,
  Strikethrough,
  Table as TableIcon,
  Underline,
  Undo2,
  MessageSquare,
  Columns2,
  Trash2,
  X,
} from "lucide-react";
import type { OfficeTab, TextDocument } from "../lib/office-store";
import { useOfficeTabs } from "../lib/office-store";
import { useToasts, reportError } from "../lib/store";
import { useT } from "../lib/i18n";
import { uid, wordCount, type Block, type DocComment, type ImageData, type ParaProps, type Run, type TableData } from "../lib/office-types";
import { defaultPageSetup, defaultParaProps, emptyMetadata, newParaBlock, newTextDocument } from "../lib/office-types";
import { Dialog, Ribbon, RibbonGroup, ToolButton, ToolColor, ToolNumber, ToolSelect, useTablePicker } from "./office-ui";
import { openIntoWorkspace, useEditorShortcuts, useOfficeSession } from "./useOfficeSession";
import {
  insertText,
  joinRuns,
  nextListLevel,
  nextParagraphProps,
  replaceRange,
  runsText,
  splitAtLineBreak,
  splitRuns,
  wordRangeAt,
} from "./writer/runs";
import { caretOffset, caretOnFirstLine, caretOnLastLine, repaintParagraph, selectedRange, setCaretOffset } from "./writer/caret";
import { domToRuns, runsToHtml, wrapCellRuns } from "./writer/writerDom";
import { emptyRun as emptyWriterRun } from "./writer/runs";

export { runsToHtml, domToRuns };

type WriterTab = OfficeTab & { model: TextDocument };

/** Structural edits the paragraph component asks the document to perform. */
type StructureAction =
  | { kind: "replace"; index: number; block: Block }
  | { kind: "split"; index: number; offset: number; to: number }
  | { kind: "mergeBackward"; index: number }
  | { kind: "mergeForward"; index: number }
  | { kind: "indent" | "outdent"; index: number }
  | { kind: "moveCaret"; index: number; delta: number; atLine: "start" | "end" };

interface SelectionInfo {
  paragraph: ParaProps;
  run: Run;
}

const HIGHLIGHT_COLORS = ["#FEF08A", "#BBF7D0", "#BFDBFE", "#FBCFE8", "#FED7AA", "#E9D5FF", "#FECACA", "#A7F3D0"];

export function WriterEditor({ tab }: { tab: WriterTab }) {
  const t = useT();
  const { edit } = useOfficeTabs();
  const session = useOfficeSession(tab);
  const [ribbon, setRibbon] = useState("home");
  const [zoom, setZoom] = useState(1);
  const [selection, setSelection] = useState<SelectionInfo | null>(null);
  const [editingHeader, setEditingHeader] = useState<"header" | "footer" | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findText, setFindText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [insertTable, setInsertTable] = useState(false);
  const [selectedImage, setSelectedImage] = useState<number | null>(null);
  const [pages, setPages] = useState(1);
  const bodyRef = useRef<HTMLDivElement>(null);
  // Caret the model wants placed after a structural edit. It is consumed by
  // the layout effect below, in the same commit that renders the new blocks.
  const pendingFocus = useRef<{ index: number; offset: number; scope: string } | null>(null);
  const picker = useTablePicker();

  const document = tab.model;
  const stats = useMemo(() => wordCount(document), [document]);

  useEditorShortcuts(session, { onFind: () => setFindOpen(true), onReplace: () => setFindOpen(true) });

  // Places the caret for a structural edit as part of the same commit. A
  // `setTimeout` version raced fast typing: the next keystroke reached the DOM
  // before focus had moved and was lost.
  useLayoutEffect(() => {
    const request = pendingFocus.current;
    if (!request) return;
    pendingFocus.current = null;
    const target = window.document.querySelector<HTMLElement>(`[data-scope="${request.scope}"][data-block-index="${request.index}"]`);
    if (!target) return;
    target.focus();
    setCaretOffset(target, request.offset);
  });

  // Ctrl+Enter inserts a real page break at the caret.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        insertPageBreak();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [document]);

  const update = useCallback((mutate: (document: TextDocument) => TextDocument) => edit(tab.id, (model) => mutate(model as TextDocument)), [edit, tab.id]);

  // Page count follows the rendered height of the document body.
  useEffect(() => {
    if (!bodyRef.current) return;
    const height = bodyRef.current.scrollHeight;
    const pageHeight = document.page.heightPt * (96 / 72);
    setPages(Math.max(1, Math.ceil(height / Math.max(200, pageHeight))));
  }, [document, zoom]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ rows: number; cols: number }>).detail;
      insertTableBlock(detail.rows, detail.cols);
      setInsertTable(false);
    };
    window.addEventListener("oswk-insert-table", handler);
    return () => window.removeEventListener("oswk-insert-table", handler);
  });

  // -------------------------------------------------------------------------
  // Model helpers
  // -------------------------------------------------------------------------

  const currentBlocks = () => (editingHeader ? (editingHeader === "header" ? document.header : document.footer) : document.blocks);

  const withBlocks = (blocks: Block[]) =>
    update((doc) => (editingHeader === "header" ? { ...doc, header: blocks } : editingHeader === "footer" ? { ...doc, footer: blocks } : { ...doc, blocks }));

  const updateBlock = (index: number, block: Block) => {
    const blocks = [...currentBlocks()];
    blocks[index] = block;
    withBlocks(blocks);
  };

  const insertBlockAfter = (index: number, block: Block) => {
    const blocks = [...currentBlocks()];
    blocks.splice(index + 1, 0, block);
    withBlocks(blocks);
  };

  const removeBlock = (index: number) => {
    const blocks = currentBlocks().filter((_, position) => position !== index);
    withBlocks(blocks.length > 0 ? blocks : [newParaBlock()]);
  };
  void removeBlock;

  // -------------------------------------------------------------------------
  // Selection tracking (focusin gives the edited paragraph)
  // -------------------------------------------------------------------------

  const handleParagraphFocus = (block: Extract<Block, { type: "paragraph" }>) => {
    setSelection({ paragraph: block.props, run: block.runs[0] ?? emptyRun() });
  };

  const activeIndex = (): number | null => {
    const active = window.document.activeElement as HTMLElement | null;
    if (active?.dataset?.blockIndex) return Number(active.dataset.blockIndex);
    return null;
  };

  const activeParagraph = (): Extract<Block, { type: "paragraph" }> | null => {
    const index = activeIndex();
    if (index === null) return null;
    const block = currentBlocks()[index];
    return block?.type === "paragraph" ? block : null;
  };

  const applyParaChange = (patch: Partial<ParaProps>) => {
    const index = activeIndex();
    if (index === null) return;
    const block = currentBlocks()[index];
    if (block?.type !== "paragraph") return;
    updateBlock(index, { ...block, props: { ...block.props, ...patch } });
  };

  const applyRunChange = (patch: Partial<Run>) => {
    const index = activeIndex();
    if (index === null) return;
    const block = currentBlocks()[index];
    if (block?.type !== "paragraph") return;
    const runs = (block.runs.length > 0 ? block.runs : [emptyRun()]).map((run) => ({ ...run, ...patch }));
    updateBlock(index, { ...block, runs });
  };

  const exec = (command: string, value?: string) => {
    try {
      window.document.execCommand(command, false, value);
    } catch {
      // execCommand can throw on unsupported commands in some webviews.
    }
    // Sync after the browser applies the change.
    window.setTimeout(() => {
      const active = window.document.activeElement as HTMLElement | null;
      if (active && active.dataset.blockIndex) {
        syncParagraph(Number(active.dataset.blockIndex), active);
      }
    }, 0);
  };

  // -------------------------------------------------------------------------
  // DOM <-> model synchronisation
  // -------------------------------------------------------------------------

  const syncParagraph = (index: number, element: HTMLElement) => {
    const block = currentBlocks()[index];
    if (!block) return;
    if (block.type === "paragraph") {
      const runs = domToRuns(element);
      updateBlock(index, { ...block, runs: runs.length > 0 ? runs : [emptyRun()] });
    } else if (block.type === "table") {
      // Table cells are handled by syncCell.
    }
  };

  const syncCell = (tableIndex: number, rowIndex: number, cellIndex: number, element: HTMLElement) => {
    const block = currentBlocks()[tableIndex];
    if (!block || block.type !== "table") return;
    const table: TableData = {
      ...block.table,
      rows: block.table.rows.map((row, r) =>
        r !== rowIndex
          ? row
          : {
              ...row,
              cells: row.cells.map((cell, c) =>
                c !== cellIndex ? cell : { ...cell, blocks: [wrapCellRuns(domToRuns(element))] },
              ),
            },
      ),
    };
    updateBlock(tableIndex, { type: "table", table });
  };

  // -------------------------------------------------------------------------
  // Formatting commands
  // -------------------------------------------------------------------------

  const setParagraphStyle = (styleId: string) => {
    const active = window.document.activeElement as HTMLElement | null;
    const index = active?.dataset?.blockIndex ? Number(active.dataset.blockIndex) : null;
    if (index === null) {
      const blocks = [...currentBlocks()];
      const first = blocks[0];
      if (first && first.type === "paragraph") {
        blocks[0] = { ...first, props: { ...first.props, style: styleId } };
        withBlocks(blocks);
      }
      return;
    }
    const block = currentBlocks()[index];
    if (block?.type === "paragraph") {
      updateBlock(index, { ...block, props: { ...block.props, style: styleId } });
    }
  };

  const setAlign = (align: string) => applyParaChange({ align });
  const setLineSpacing = (value: number) => applyParaChange({ lineSpacing: value });
  const setSpace = (before: number, after: number) => applyParaChange({ spaceBeforePt: before, spaceAfterPt: after });
  const setIndent = (delta: number) => {
    const block = activeParagraph();
    const current = block?.props.indentLeftPt ?? 0;
    applyParaChange({ indentLeftPt: Math.max(0, current + delta) });
  };

  const toggleList = (kind: "bullet" | "number") => {
    const active = window.document.activeElement as HTMLElement | null;
    const index = active?.dataset?.blockIndex ? Number(active.dataset.blockIndex) : null;
    if (index === null) return;
    const block = currentBlocks()[index];
    if (block?.type !== "paragraph") return;
    const list = block.props.list;
    const next = list && list.kind === kind ? null : { kind, level: list?.level ?? 0, start: 1, marker: kind === "number" ? "1." : "•" };
    updateBlock(index, { ...block, props: { ...block.props, list: next } });
  };

  const changeListLevel = (delta: number) => {
    const active = window.document.activeElement as HTMLElement | null;
    const index = active?.dataset?.blockIndex ? Number(active.dataset.blockIndex) : null;
    if (index === null) return;
    const block = currentBlocks()[index];
    if (block?.type !== "paragraph" || !block.props.list) return;
    const level = Math.max(0, Math.min(5, block.props.list.level + delta));
    updateBlock(index, { ...block, props: { ...block.props, list: { ...block.props.list, level } } });
  };

  const toggleInline = (field: "bold" | "italic" | "underline" | "strike" | "superscript" | "subscript") => {
    const command = field === "bold" ? "bold" : field === "italic" ? "italic" : field === "underline" ? "underline" : field === "strike" ? "strikeThrough" : field === "superscript" ? "superscript" : "subscript";
    exec(command);
  };

  const applyRunColor = (color: string, highlight: boolean) => {
    const active = window.document.activeElement as HTMLElement | null;
    if (active && active.dataset.blockIndex) {
      const index = Number(active.dataset.blockIndex);
      const block = currentBlocks()[index];
      if (block?.type === "paragraph") {
        const runs = block.runs.map((run) => (highlight ? { ...run, highlight: color } : { ...run, color }));
        updateBlock(index, { ...block, runs: runs.length ? runs : [emptyRun()] });
        // Keep the visual state in sync with the model.
        applyVisualStyle(active, highlight ? "background-color" : "color", color);
        return;
      }
    }
    exec(highlight ? "hiliteColor" : "foreColor", color);
  };

  const clearFormatting = () => {
    const active = window.document.activeElement as HTMLElement | null;
    const index = active?.dataset?.blockIndex ? Number(active.dataset.blockIndex) : null;
    if (index !== null) {
      const block = currentBlocks()[index];
      if (block?.type === "paragraph") {
        updateBlock(index, { ...block, runs: block.runs.map((run) => ({ ...emptyRun(run.text) })) });
        return;
      }
    }
    exec("removeFormat");
  };

  // -------------------------------------------------------------------------
  // Structural inserts
  // -------------------------------------------------------------------------

  const insertImageBlock = async () => {
    try {
      const selectionPaths = await openDialog({
        multiple: false,
        filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "bmp", "webp", "svg"] }],
      });
      if (typeof selectionPaths !== "string") return;
      const bytes = await readFile(selectionPaths);
      const name = selectionPaths.split(/[\\/]/).pop() ?? "image.png";
      const mime = mimeFromName(name);
      let base64 = "";
      const chunk = 0x8000;
      for (let index = 0; index < bytes.length; index += chunk) {
        base64 += String.fromCharCode(...bytes.subarray(index, index + chunk));
      }
      const image: ImageData = { name, mime, dataBase64: btoa(base64), alt: "" };
      const active = window.document.activeElement as HTMLElement | null;
      const index = active?.dataset?.blockIndex ? Number(active.dataset.blockIndex) + 1 : currentBlocks().length;
      insertBlockAfter(index - 1, { type: "image", image, widthPt: 320, heightPt: 220, align: "center", caption: "" });
    } catch (error) {
      reportError(error, t);
    }
  };

  const insertTableBlock = (rows: number, cols: number) => {
    const width = document.page.widthPt - document.page.marginLeftPt - document.page.marginRightPt;
    const table: TableData = {
      rows: Array.from({ length: rows }, (_, rowIndex) => ({
        cells: Array.from({ length: cols }, () => ({ blocks: [newParaBlock()], colspan: 1, rowspan: 1, background: null, align: "left", valign: "top", widthPt: null })),
        heightPt: null,
        header: rowIndex === 0,
      })),
      columnWidthsPt: Array.from({ length: cols }, () => width / cols),
      borders: true,
      borderColor: "#94A3B8",
      align: "left",
    };
    const active = window.document.activeElement as HTMLElement | null;
    const index = active?.dataset?.blockIndex ? Number(active.dataset.blockIndex) : currentBlocks().length - 1;
    insertBlockAfter(index, { type: "table", table });
  };

  const insertLink = () => {
    const url = window.prompt(t("writer.linkPrompt"), "https://");
    if (!url) return;
    exec("createLink", url);
    const active = window.document.activeElement as HTMLElement | null;
    if (active?.dataset?.blockIndex) {
      const index = Number(active.dataset.blockIndex);
      const block = currentBlocks()[index];
      if (block?.type === "paragraph") {
        updateBlock(index, { ...block, runs: block.runs.map((run) => ({ ...run, link: url })) });
      }
    }
  };

  const insertPageBreak = () => {
    const active = window.document.activeElement as HTMLElement | null;
    const index = active?.dataset?.blockIndex ? Number(active.dataset.blockIndex) : currentBlocks().length - 1;
    insertBlockAfter(index, { type: "pageBreak" });
  };

  const insertRule = () => {
    const active = window.document.activeElement as HTMLElement | null;
    const index = active?.dataset?.blockIndex ? Number(active.dataset.blockIndex) : currentBlocks().length - 1;
    insertBlockAfter(index, { type: "rule" });
  };

  // -------------------------------------------------------------------------
  // Structural editing (Enter / Backspace / Tab / arrow keys at an edge)
  // -------------------------------------------------------------------------

  /**
   * Applies a structural edit to the block list.
   *
   * Every branch works on a copy of the model, repaints the affected
   * paragraphs in the DOM (a focused contentEditable is not re-rendered by
   * React) and restores the caret once the model change has committed.
   */
  const handleStructure = (action: StructureAction, scope: "body" | "header" | "footer" | "cell") => {
    if (scope === "cell") return; // cell editing keeps the simple single-paragraph model
    const blocks = [...currentBlocks()];
    const block = blocks[action.index];
    if (!block) return;
    const paragraph = block.type === "paragraph" ? block : null;

    const focusParagraph = (index: number, offset: number) => {
      pendingFocus.current = { index, offset, scope };
    };

    /**
     * Writes the model's runs into a paragraph element immediately.
     *
     * React leaves a focused contentEditable's children alone (that is what
     * keeps native typing and IME working), so after a structural edit the
     * element still shows the pre-edit text. Moving focus away fires `blur`,
     * whose handler reads the DOM and writes it back into the model - undoing
     * the edit. Repainting before the focus moves keeps blur honest.
     */
    const repaintAt = (index: number, runs: Run[]) => {
      const element = window.document.querySelector<HTMLElement>(`[data-scope="${scope}"][data-block-index="${index}"]`);
      if (element) repaintParagraph(element, runs);
    };

    switch (action.kind) {
      case "replace": {
        blocks[action.index] = action.block;
        withBlocks(blocks);
        return;
      }
      case "split": {
        if (!paragraph) return;
        const [left, right] = splitRuns(paragraph.runs, action.offset);
        const tail = replaceRange(right, 0, Math.max(0, action.to - action.offset), "");
        const headText = runsText(left);
        blocks[action.index] = { ...paragraph, runs: left };
        blocks.splice(action.index + 1, 0, { type: "paragraph", props: nextParagraphProps(paragraph.props, headText), runs: tail });
        withBlocks(blocks);
        repaintAt(action.index, left);
        focusParagraph(action.index + 1, 0);
        return;
      }
      case "mergeBackward": {
        if (action.index === 0) return;
        const previous = blocks[action.index - 1];
        if (previous.type !== "paragraph" || !paragraph) {
          // A table, image or rule has no text to merge into: outdent a list
          // item instead, which is what every word processor does.
          if (paragraph?.props.list) {
            blocks[action.index] = { ...paragraph, props: nextListLevel(paragraph.props, -1) };
            withBlocks(blocks);
          }
          return;
        }
        const caret = runsText(previous.runs).length;
        const merged = joinRuns(previous.runs, paragraph.runs);
        blocks[action.index - 1] = { ...previous, runs: merged };
        blocks.splice(action.index, 1);
        withBlocks(blocks);
        repaintAt(action.index - 1, merged);
        focusParagraph(action.index - 1, caret);
        return;
      }
      case "mergeForward": {
        const next = blocks[action.index + 1];
        if (!paragraph || !next) return;
        if (next.type !== "paragraph") {
          blocks.splice(action.index + 1, 1);
          withBlocks(blocks);
          return;
        }
        const caret = runsText(paragraph.runs).length;
        const merged = joinRuns(paragraph.runs, next.runs);
        blocks[action.index] = { ...paragraph, runs: merged };
        blocks.splice(action.index + 1, 1);
        withBlocks(blocks);
        repaintAt(action.index, merged);
        focusParagraph(action.index, caret);
        return;
      }
      case "indent":
      case "outdent": {
        if (!paragraph) return;
        const delta = action.kind === "indent" ? 1 : -1;
        const next = paragraph.props.list ? nextListLevel(paragraph.props, delta) : { ...paragraph.props, indentLeftPt: Math.max(0, paragraph.props.indentLeftPt + delta * 24) };
        blocks[action.index] = { ...paragraph, props: next };
        withBlocks(blocks);
        return;
      }
      case "moveCaret": {
        const target = blocks[action.index + action.delta];
        if (!target || target.type !== "paragraph") return;
        const at = action.delta < 0 ? (action.atLine === "start" ? 0 : runsText(target.runs).length) : action.atLine === "end" ? runsText(target.runs).length : 0;
        focusParagraph(action.index + action.delta, at);
        return;
      }
    }
  };

  // -------------------------------------------------------------------------
  // Find / replace
  // -------------------------------------------------------------------------

  const runFind = (forward: boolean) => {
    if (!findText) return;
    try {
      (window as unknown as { find: (text: string, matchCase: boolean, backwards: boolean, wrap: boolean, wholeWord: boolean) => boolean }).find(findText, matchCase, !forward, true, wholeWord);
    } catch {
      useToasts.getState().push({ kind: "info", title: t("writer.findUnsupported"), detail: t("writer.findUnsupportedHint") });
    }
  };

  const replaceAll = () => {
    if (!findText) return;
    let count = 0;
    const transform = (text: string) => {
      const flags = matchCase ? "g" : "gi";
      const escaped = findText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = wholeWord ? new RegExp(`\\b${escaped}\\b`, flags) : new RegExp(escaped, flags);
      return { text: text.replace(pattern, replaceText), hits: (text.match(pattern) ?? []).length };
    };
    const mapRuns = (runs: Run[]): Run[] =>
      runs.map((run) => {
        const { text, hits } = transform(run.text);
        count += hits;
        return { ...run, text };
      });
    const mapBlocks = (blocks: Block[]): Block[] =>
      blocks.map((block) => {
        if (block.type === "paragraph") return { ...block, runs: mapRuns(block.runs) };
        if (block.type === "table")
          return {
            ...block,
            table: {
              ...block.table,
              rows: block.table.rows.map((row) => ({ ...row, cells: row.cells.map((cell) => ({ ...cell, blocks: mapBlocks(cell.blocks) })) })),
            },
          };
        return block;
      });
    update((doc) => {
      const next = { ...doc, blocks: mapBlocks(doc.blocks), header: mapBlocks(doc.header), footer: mapBlocks(doc.footer) };
      return next;
    });
    useToasts.getState().push({ kind: "success", title: t("writer.replaceDone"), detail: `${count}` });
  };

  // -------------------------------------------------------------------------
  // Comments
  // -------------------------------------------------------------------------

  const addComment = () => {
    const text = window.prompt(t("writer.commentPrompt"));
    if (!text) return;
    const comment: DocComment = { id: uid(), author: "Me", text, created: new Date().toISOString(), resolved: false };
    const active = window.document.activeElement as HTMLElement | null;
    const index = active?.dataset?.blockIndex ? Number(active.dataset.blockIndex) : null;
    update((doc) => {
      const blocks = [...doc.blocks];
      if (index !== null) {
        const block = blocks[index];
        if (block?.type === "paragraph") {
          blocks[index] = { ...block, runs: block.runs.map((run) => ({ ...run, comment: comment.id })) };
        }
      }
      return { ...doc, blocks, comments: [...doc.comments, comment] };
    });
    setCommentsOpen(true);
  };

  // -------------------------------------------------------------------------
  // Page setup
  // -------------------------------------------------------------------------

  const setPageSize = (size: string) => update((doc) => ({ ...doc, page: { ...doc.page, ...sizeDimensions(size, doc.page.orientation), size } }));
  const setOrientation = (orientation: string) =>
    update((doc) => {
      const landscape = orientation === "landscape";
      const currentlyLandscape = doc.page.widthPt > doc.page.heightPt;
      const page = { ...doc.page, orientation };
      if (landscape !== currentlyLandscape) {
        page.widthPt = doc.page.heightPt;
        page.heightPt = doc.page.widthPt;
      }
      return { ...doc, page };
    });
  const setMargin = (key: "marginTopPt" | "marginRightPt" | "marginBottomPt" | "marginLeftPt", value: number) =>
    update((doc) => ({ ...doc, page: { ...doc.page, [key]: value } }));
  const applyMarginPreset = (preset: "normal" | "narrow" | "wide") => {
    const values = preset === "narrow" ? 36 : preset === "wide" ? 108 : 72;
    update((doc) => ({
      ...doc,
      page: { ...doc.page, marginTopPt: values, marginBottomPt: values, marginLeftPt: values === 36 ? 36 : values, marginRightPt: values === 36 ? 36 : values },
    }));
  };
  const setColumns = (columns: number) => update((doc) => ({ ...doc, page: { ...doc.page, columns } }));

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  const pageWidth = document.page.widthPt * (96 / 72) * zoom;
  const pageHeight = document.page.heightPt * (96 / 72) * zoom;
  const marginTop = document.page.marginTopPt * (96 / 72) * zoom;
  const marginX = document.page.marginLeftPt * (96 / 72) * zoom;
  const styleOptions = document.styles.map((style) => ({ value: style.id, label: style.name }));
  const activeStyle = selection?.paragraph.style ?? "Normal";
  const activeRun = selection?.run;

  /**
   * Word behaviour: clicking anywhere in the page (including the empty area
   * below the text) places the caret in the nearest paragraph.
   */
  const handlePageMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest('[contenteditable="true"]')) return;
    const container = event.currentTarget;
    const candidates = Array.from(container.querySelectorAll<HTMLElement>(".para"));
    if (candidates.length === 0) return;
    event.preventDefault();
    const scope = event.currentTarget.dataset.scope ?? "body";
    const pool = candidates.filter((element) => (element.dataset.scope ?? "body") === scope);
    const usable = pool.length > 0 ? pool : candidates;
    const editable = usable.reduce(
      (best, element) => {
        const rect = element.getBoundingClientRect();
        const distance = Math.abs(rect.top + rect.height / 2 - event.clientY);
        return distance < best.distance ? { element, distance } : best;
      },
      { element: usable[0], distance: Number.POSITIVE_INFINITY },
    ).element;
    editable.focus();
    const selection = window.getSelection();
    if (selection) {
      const range = window.document.createRange();
      range.selectNodeContents(editable);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }
  };
  const handlePrint = () => {
    window.print();
  };

  const handleExportPdf = () => {
    void session.exportPdf();
  };

  const renderBlocks = (blocks: Block[], scope: "body" | "header" | "footer" | "cell", tablePath?: [number, number, number]) => (
    <>
      {blocks.map((block, index) => (
        <BlockView
          key={`${scope}-${index}-${block.type}`}
          block={block}
          index={index}
          scope={scope}
          zoom={zoom}
          selectedImage={selectedImage}
          onSelectImage={setSelectedImage}
          onFocusParagraph={handleParagraphFocus}
          onSync={(element) => {
            if (scope === "cell" && tablePath) syncCell(tablePath[0], tablePath[1], tablePath[2], element);
            else if (scope === "body" || scope === "header" || scope === "footer") syncParagraph(index, element);
          }}
          onUpdate={(next) => updateBlock(index, next)}
          onSyncCell={(path, element) => syncCell(path[0], path[1], path[2], element)}
          onStructure={(action) => handleStructure(action, scope)}
        />
      ))}
    </>
  );

  return (
    <div className="editor writer-editor">
      <Ribbon
        tabs={[
          { id: "home", label: t("writer.tabHome") },
          { id: "insert", label: t("writer.tabInsert") },
          { id: "layout", label: t("writer.tabLayout") },
          { id: "review", label: t("writer.tabReview") },
          { id: "view", label: t("writer.tabView") },
        ]}
        active={ribbon}
        onSelect={setRibbon}
      >
        {ribbon === "home" ? (
          <>
            <RibbonGroup label={t("writer.clipboard")}>
              <ToolButton icon={<Undo2 size={16} />} label={t("common.undo")} onClick={() => exec("undo")} disabled={session.busy} />
              <ToolButton icon={<Redo2 size={16} />} label={t("common.redo")} onClick={() => exec("redo")} disabled={session.busy} />
            </RibbonGroup>
            <RibbonGroup label={t("writer.font")}>
              <ToolSelect value={activeStyle} onChange={setParagraphStyle} options={styleOptions} title={t("writer.style")} width={132} />
              <ToolSelect
                value={String(activeRun?.sizePt ?? document.styles.find((style) => style.id === activeStyle)?.sizePt ?? 11)}
                onChange={(value) => applyRunChange({ sizePt: Number(value) })}
                options={[8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48].map((size) => ({ value: String(size), label: `${size}` }))}
                title={t("writer.fontSize")}
                width={64}
              />
              <ToolButton icon={<Bold size={16} />} onClick={() => toggleInline("bold")} active={activeRun?.bold} title={t("writer.bold")} />
              <ToolButton icon={<Italic size={16} />} onClick={() => toggleInline("italic")} active={activeRun?.italic} title={t("writer.italic")} />
              <ToolButton icon={<Underline size={16} />} onClick={() => toggleInline("underline")} active={activeRun?.underline} title={t("writer.underline")} />
              <ToolButton icon={<Strikethrough size={16} />} onClick={() => toggleInline("strike")} active={activeRun?.strike} title={t("writer.strike")} />
              <ToolColor value={activeRun?.color ?? "#1f2328"} onChange={(color) => applyRunColor(color, false)} title={t("writer.textColor")} />
              <ToolButton icon={<Highlighter size={16} />} onClick={() => applyRunColor(activeRun?.highlight ?? HIGHLIGHT_COLORS[0], true)} active={Boolean(activeRun?.highlight)} title={t("writer.highlight")} />
              <ToolButton icon={<Eraser size={16} />} onClick={clearFormatting} title={t("writer.clearFormatting")} />
            </RibbonGroup>
            <RibbonGroup label={t("writer.paragraph")}>
              <ToolButton icon={<AlignLeft size={16} />} onClick={() => setAlign("left")} active={selection?.paragraph.align === "left"} title={t("writer.alignLeft")} />
              <ToolButton icon={<AlignCenter size={16} />} onClick={() => setAlign("center")} active={selection?.paragraph.align === "center"} title={t("writer.alignCenter")} />
              <ToolButton icon={<AlignRight size={16} />} onClick={() => setAlign("right")} active={selection?.paragraph.align === "right"} title={t("writer.alignRight")} />
              <ToolButton icon={<AlignJustify size={16} />} onClick={() => setAlign("justify")} active={selection?.paragraph.align === "justify"} title={t("writer.alignJustify")} />
              <ToolButton icon={<List size={16} />} onClick={() => toggleList("bullet")} active={selection?.paragraph.list?.kind === "bullet"} title={t("writer.bullets")} />
              <ToolButton icon={<ListOrdered size={16} />} onClick={() => toggleList("number")} active={selection?.paragraph.list?.kind === "number"} title={t("writer.numbering")} />
              <ToolButton icon={<Indent size={16} />} onClick={() => (selection?.paragraph.list ? changeListLevel(1) : setIndent(24))} title={t("writer.increaseIndent")} />
              <ToolButton icon={<Outdent size={16} />} onClick={() => (selection?.paragraph.list ? changeListLevel(-1) : setIndent(-24))} title={t("writer.decreaseIndent")} />
              <ToolSelect
                value={String(selection?.paragraph.lineSpacing ?? 1.15)}
                onChange={(value) => setLineSpacing(Number(value))}
                options={[1, 1.15, 1.5, 2].map((value) => ({ value: String(value), label: `${value}` }))}
                title={t("writer.lineSpacing")}
                width={70}
              />
            </RibbonGroup>
            <RibbonGroup label={t("writer.find")}>
              <ToolButton icon={<Search size={16} />} label={t("common.find")} onClick={() => setFindOpen(true)} />
            </RibbonGroup>
          </>
        ) : null}

        {ribbon === "insert" ? (
          <>
            <RibbonGroup label={t("writer.insert")}>
              <ToolButton icon={<ImageIcon size={16} />} label={t("writer.image")} onClick={insertImageBlock} />
              <ToolButton icon={<TableIcon size={16} />} label={t("writer.table")} onClick={() => setInsertTable(true)} />
              <ToolButton icon={<Link2 size={16} />} label={t("writer.link")} onClick={insertLink} />
            </RibbonGroup>
            <RibbonGroup label={t("writer.pages")}>
              <ToolButton icon={<SeparatorHorizontal size={16} />} label={t("writer.pageBreak")} onClick={insertPageBreak} />
              <ToolButton icon={<Minus size={16} />} label={t("writer.horizontalRule")} onClick={insertRule} />
            </RibbonGroup>
            <RibbonGroup label={t("writer.headerFooter")}>
              <ToolButton icon={<FileText size={16} />} label={t("writer.header")} onClick={() => setEditingHeader(editingHeader === "header" ? null : "header")} active={editingHeader === "header"} />
              <ToolButton icon={<FileText size={16} />} label={t("writer.footer")} onClick={() => setEditingHeader(editingHeader === "footer" ? null : "footer")} active={editingHeader === "footer"} />
              <ToolButton
                label={t("writer.pageNumbers")}
                onClick={() => update((doc) => ({ ...doc, footer: [{ type: "paragraph", props: { ...defaultParaProps(), align: "center", spaceAfterPt: 0 }, runs: [{ ...emptyRun("Page {{page}} / {{pages}}") }] }] }))}
              />
            </RibbonGroup>
            <RibbonGroup label={t("writer.comments")}>
              <ToolButton icon={<MessageSquare size={16} />} label={t("writer.addComment")} onClick={addComment} />
            </RibbonGroup>
          </>
        ) : null}

        {ribbon === "layout" ? (
          <>
            <RibbonGroup label={t("writer.pageSetup")}>
              <ToolSelect
                value={document.page.size}
                onChange={setPageSize}
                options={[
                  { value: "a4", label: "A4" },
                  { value: "a5", label: "A5" },
                  { value: "letter", label: "Letter" },
                  { value: "legal", label: "Legal" },
                  { value: "a3", label: "A3" },
                ]}
                title={t("writer.pageSize")}
                width={90}
              />
              <ToolSelect
                value={document.page.orientation}
                onChange={setOrientation}
                options={[
                  { value: "portrait", label: t("writer.portrait") },
                  { value: "landscape", label: t("writer.landscape") },
                ]}
                title={t("writer.orientation")}
                width={110}
              />
              <ToolSelect
                value=""
                onChange={(value) => { if (value) applyMarginPreset(value as "normal" | "narrow" | "wide"); }}
                options={[
                  { value: "", label: t("writer.margins") },
                  { value: "normal", label: t("writer.marginNormal") },
                  { value: "narrow", label: t("writer.marginNarrow") },
                  { value: "wide", label: t("writer.marginWide") },
                ]}
                title={t("writer.margins")}
                width={110}
              />
              <ToolButton icon={<Columns2 size={16} />} onClick={() => setColumns(document.page.columns > 1 ? 1 : 2)} active={document.page.columns > 1} title={t("writer.columns")} />
            </RibbonGroup>
            <RibbonGroup label={t("writer.spacing")}>
              <ToolNumber value={selection?.paragraph.spaceBeforePt ?? 0} onChange={(value) => setSpace(value, selection?.paragraph.spaceAfterPt ?? 0)} min={0} max={144} title={t("writer.spaceBefore")} />
              <ToolNumber value={selection?.paragraph.spaceAfterPt ?? 0} onChange={(value) => setSpace(selection?.paragraph.spaceBeforePt ?? 0, value)} min={0} max={144} title={t("writer.spaceAfter")} />
            </RibbonGroup>
            <RibbonGroup label={t("writer.margins")}>
              <ToolNumber value={document.page.marginTopPt} onChange={(value) => setMargin("marginTopPt", value)} min={0} max={288} title={t("writer.marginTop")} />
              <ToolNumber value={document.page.marginBottomPt} onChange={(value) => setMargin("marginBottomPt", value)} min={0} max={288} title={t("writer.marginBottom")} />
              <ToolNumber value={document.page.marginLeftPt} onChange={(value) => setMargin("marginLeftPt", value)} min={0} max={288} title={t("writer.marginLeft")} />
              <ToolNumber value={document.page.marginRightPt} onChange={(value) => setMargin("marginRightPt", value)} min={0} max={288} title={t("writer.marginRight")} />
            </RibbonGroup>
          </>
        ) : null}

        {ribbon === "review" ? (
          <>
            <RibbonGroup label={t("writer.comments")}>
              <ToolButton icon={<MessageSquare size={16} />} label={t("writer.addComment")} onClick={addComment} />
              <ToolButton icon={<MessageSquare size={16} />} label={t("writer.comments")} onClick={() => setCommentsOpen(!commentsOpen)} active={commentsOpen} />
            </RibbonGroup>
            <RibbonGroup label={t("writer.find")}>
              <ToolButton icon={<Search size={16} />} label={t("writer.findReplace")} onClick={() => setFindOpen(true)} />
            </RibbonGroup>
          </>
        ) : null}

        {ribbon === "view" ? (
          <>
            <RibbonGroup label={t("writer.zoom")}>
              <ToolButton label="75%" onClick={() => setZoom(0.75)} active={zoom === 0.75} />
              <ToolButton label="100%" onClick={() => setZoom(1)} active={zoom === 1} />
              <ToolButton label="125%" onClick={() => setZoom(1.25)} active={zoom === 1.25} />
              <ToolButton label="150%" onClick={() => setZoom(1.5)} active={zoom === 1.5} />
            </RibbonGroup>
            <RibbonGroup label={t("writer.print")}>
              <ToolButton icon={<Printer size={16} />} label={t("common.print")} onClick={handlePrint} />
              <ToolButton icon={<FileDown size={16} />} label={t("writer.exportPdf")} onClick={handleExportPdf} />
            </RibbonGroup>
          </>
        ) : null}

        <div className="ribbon-spacer" />
        <RibbonGroup>
          <ToolButton icon={<FolderOpen size={16} />} label={t("common.open")} onClick={() => void openIntoWorkspace()} />
          <ToolButton icon={<Save size={16} />} label={t("common.save")} onClick={() => void session.save()} disabled={session.busy} />
          <ToolButton label={t("common.saveAs")} onClick={() => void session.saveAs()} disabled={session.busy} />
          <ToolButton icon={<FileDown size={16} />} label={t("writer.exportPdf")} onClick={handleExportPdf} />
        </RibbonGroup>
      </Ribbon>

      <div className="editor-toolbar">
        <span className="muted">{editingHeader ? t(`writer.${editingHeader}`) : tab.title}</span>
        {editingHeader ? (
          <button type="button" className="btn btn-soft" onClick={() => setEditingHeader(null)}>
            {t("writer.doneEditing")}
          </button>
        ) : null}
        <span className="spacer" />
        <span className="muted">
          {tab.path ?? t("writer.unsaved")} {tab.dirty ? "•" : ""}
        </span>
      </div>

      <div className="editor-scroll">
        <div className="writer-page" ref={bodyRef} data-scope={editingHeader ?? "body"} onMouseDown={handlePageMouseDown} style={{ width: pageWidth, minHeight: pageHeight, padding: `${marginTop}px ${marginX}px` }}>
          {editingHeader ? (
            <div className="writer-header-zone">{renderBlocks(editingHeader === "header" ? document.header : document.footer, editingHeader)}</div>
          ) : (
            <>
              {document.header.length > 0 ? <div className="writer-header-zone muted">{renderBlocks(document.header, "header")}</div> : null}
              <div className="writer-body">{renderBlocks(document.blocks, "body")}</div>
              {document.footer.length > 0 ? <div className="writer-footer-zone muted">{renderBlocks(document.footer, "footer")}</div> : null}
            </>
          )}
        </div>
      </div>

      <div className="editor-status">
        <span>
          {stats.words} {t("writer.words")}
        </span>
        <span>
          {stats.characters} {t("writer.characters")}
        </span>
        <span>
          {pages} {t("writer.pages")}
        </span>
        <span className="spacer" />
        <span>{Math.round(zoom * 100)}%</span>
      </div>

      {findOpen ? (
        <Dialog title={t("writer.findReplace")} onClose={() => setFindOpen(false)}>
          <div className="stack">
            <label className="field">
              <span>{t("writer.findWhat")}</span>
              <input value={findText} onChange={(event) => setFindText(event.target.value)} autoFocus />
            </label>
            <label className="field">
              <span>{t("writer.replaceWith")}</span>
              <input value={replaceText} onChange={(event) => setReplaceText(event.target.value)} />
            </label>
            <div className="row">
              <label className="check">
                <input type="checkbox" checked={matchCase} onChange={(event) => setMatchCase(event.target.checked)} /> {t("writer.matchCase")}
              </label>
              <label className="check">
                <input type="checkbox" checked={wholeWord} onChange={(event) => setWholeWord(event.target.checked)} /> {t("writer.wholeWord")}
              </label>
            </div>
            <div className="row">
              <button type="button" className="btn btn-soft" onClick={() => runFind(true)}>
                {t("writer.findNext")}
              </button>
              <button type="button" className="btn btn-soft" onClick={() => runFind(false)}>
                {t("writer.findPrevious")}
              </button>
              <button type="button" className="btn btn-primary" onClick={replaceAll}>
                {t("writer.replaceAll")}
              </button>
            </div>
          </div>
        </Dialog>
      ) : null}

      {insertTable ? (
        <Dialog title={t("writer.insertTable")} onClose={() => setInsertTable(false)}>
          {picker.grid}
        </Dialog>
      ) : null}

      {selectedImage !== null ? (
        <Dialog title={t("writer.imageOptions")} onClose={() => setSelectedImage(null)}>
          <ImageOptions
            block={document.blocks[selectedImage]}
            onChange={(width, height, align, caption) =>
              update((doc) => {
                const blocks = [...doc.blocks];
                const block = blocks[selectedImage];
                if (block?.type === "image") blocks[selectedImage] = { ...block, widthPt: width, heightPt: height, align, caption };
                return { ...doc, blocks };
              })
            }
          />
        </Dialog>
      ) : null}

      {commentsOpen ? (
        <div className="comments-sidebar">
          <div className="comments-head">
            <strong>{t("writer.comments")}</strong>
            <button type="button" className="icon-btn" onClick={() => setCommentsOpen(false)} aria-label={t("common.close")}>
              <X size={14} />
            </button>
          </div>
          {document.comments.length === 0 ? <p className="muted">{t("writer.noComments")}</p> : null}
          {document.comments.map((comment) => (
            <div key={comment.id} className={`comment-card${comment.resolved ? " is-resolved" : ""}`}>
              <div className="row">
                <strong>{comment.author}</strong>
                <span className="spacer" />
                <button
                  type="button"
                  className="icon-btn"
                  title={t("writer.resolveComment")}
                  onClick={() => update((doc) => ({ ...doc, comments: doc.comments.map((entry) => (entry.id === comment.id ? { ...entry, resolved: !entry.resolved } : entry)) }))}
                >
                  ✓
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  title={t("common.delete")}
                  onClick={() =>
                    update((doc) => ({
                      ...doc,
                      comments: doc.comments.filter((entry) => entry.id !== comment.id),
                      blocks: doc.blocks.map((block) =>
                        block.type === "paragraph" ? { ...block, runs: block.runs.map((run) => (run.comment === comment.id ? { ...run, comment: null } : run)) } : block,
                      ),
                    }))
                  }
                >
                  <Trash2 size={13} />
                </button>
              </div>
              <p>{comment.text}</p>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Block rendering
// ---------------------------------------------------------------------------

function BlockView({
  block,
  index,
  scope,
  zoom,
  onSelectImage,
  onFocusParagraph,
  onSync,
  onUpdate,
  onSyncCell,
  onStructure,
}: {
  block: Block;
  index: number;
  scope: string;
  zoom: number;
  selectedImage: number | null;
  onSelectImage: (index: number | null) => void;
  onFocusParagraph: (block: Extract<Block, { type: "paragraph" }>) => void;
  onSync: (element: HTMLElement) => void;
  onUpdate: (block: Block) => void;
  onSyncCell: (path: [number, number, number], element: HTMLElement) => void;
  onStructure: (action: StructureAction) => void;
}) {
  if (block.type === "paragraph") {
    return (
      <ParagraphView
        block={block}
        index={index}
        scope={scope}
        zoom={zoom}
        onFocus={() => onFocusParagraph(block)}
        onSync={onSync}
        onUpdate={onUpdate}
        onStructure={onStructure}
      />
    );
  }
  if (block.type === "table") {
    return <TableView block={block} index={index} zoom={zoom} onUpdate={onUpdate} onSyncCell={onSyncCell} />;
  }
  if (block.type === "image") {
    return (
      <figure className="writer-image" style={{ textAlign: block.align as "left" | "center" | "right" }}>
        <img
          src={`data:${block.image.mime};base64,${block.image.dataBase64}`}
          alt={block.image.alt}
          style={{ width: block.widthPt * (96 / 72) * zoom }}
          onClick={() => onSelectImage(index)}
        />
        <figcaption onDoubleClick={() => onSelectImage(index)}>{block.caption || block.image.name}</figcaption>
      </figure>
    );
  }
  if (block.type === "pageBreak") {
    return (
      <div className="writer-page-break" contentEditable={false}>
        <span>— page break —</span>
      </div>
    );
  }
  return <hr className="writer-rule" />;
}

/**
 * One editable paragraph.
 *
 * Normal typing is left to the browser. The keys that change the *structure* of
 * the document are intercepted here and reported upwards, because the model -
 * not the DOM - is the source of truth that DOCX/ODT export and PDF layout read.
 */
function ParagraphView({
  block,
  index,
  scope,
  zoom,
  onFocus,
  onSync,
  onStructure,
}: {
  block: Extract<Block, { type: "paragraph" }>;
  index: number;
  scope: string;
  zoom: number;
  onFocus: () => void;
  onSync: (element: HTMLElement) => void;
  onUpdate: (block: Block) => void;
  onStructure: (action: StructureAction) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(false);
  const props = block.props;
  // Caret to restore after a structural change, consumed by the effect below.
  const pendingCaret = useRef<number | null>(null);

  // Layout effect: the parent places the caret in its own layout effect right
  // after this one, so the content has to be in the DOM first. Child layout
  // effects run before the parent's, which makes that ordering guaranteed.
  useLayoutEffect(() => {
    if (!ref.current) return;
    const html = runsToHtml(block.runs);
    if (!focused) {
      if (ref.current.innerHTML !== html) ref.current.innerHTML = html;
      return;
    }
    // While focused the browser owns the DOM, but a structural change (Enter,
    // Backspace merge) rewrote the runs underneath us. When the text on screen
    // and the model disagree, the DOM is stale: repaint it and restore the
    // caret, otherwise the next blur writes the stale text back over the edit.
    const modelText = runsText(block.runs);
    const domText = runsText(domToRuns(ref.current));
    if (modelText === domText && pendingCaret.current === null) return;
    const at = pendingCaret.current ?? caretOffset(ref.current);
    pendingCaret.current = null;
    if (ref.current.innerHTML !== html) ref.current.innerHTML = html;
    setCaretOffset(ref.current, Math.min(at, modelText.length));
  }, [block.runs, focused]);

  const heading = props.style.startsWith("Heading");
  const Tag = (heading ? (`h${Math.min(6, Number(props.style.replace("Heading", "")) || 1)}`) : "div") as "div";
  const listMarker = props.list ? (props.list.kind === "number" ? `${props.list.start}.` : ["•", "◦", "▪"][props.list.level % 3]) : null;

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") return; // page break, handled globally
    const mod = event.ctrlKey || event.metaKey;
    const offset = caretOffset(element);
    const range = selectedRange(element);
    const plain = domToRuns(element);
    const from = range ? range[0] : offset;
    const to = range ? range[1] : offset;

    switch (event.key) {
      case "Enter": {
        if (event.shiftKey) {
          // Shift+Enter is a hard line break inside the same paragraph.
          event.preventDefault();
          const [left, right] = splitAtLineBreak(plain, to);
          const tail = replaceRange(right, 0, 0, "\n");
          onStructure({ kind: "replace", index, block: { ...block, runs: insertText(joinRuns(left, tail), from, "") } });
          // The repaint below puts the caret after the new line break.
          pendingCaret.current = from + 1;
          return;
        }
        event.preventDefault();
        onStructure({ kind: "split", index, offset: from, to });
        return;
      }
      case "Backspace": {
        if (from !== 0 || to !== 0) {
          if (mod) {
            event.preventDefault();
            const [start] = wordRangeAt(plain, from, "backward");
            onStructure({ kind: "replace", index, block: { ...block, runs: replaceRange(plain, start, from, "") } });
            pendingCaret.current = start;
            return;
          }
          if (range) {
            event.preventDefault();
            onStructure({ kind: "replace", index, block: { ...block, runs: replaceRange(plain, from, to, "") } });
            pendingCaret.current = from;
            return;
          }
          return; // normal character delete, the browser handles it
        }
        event.preventDefault();
        onStructure({ kind: "mergeBackward", index });
        return;
      }
      case "Delete": {
        const text = runsText(plain);
        if (to < text.length) {
          if (mod) {
            event.preventDefault();
            const [, end] = wordRangeAt(plain, to, "forward");
            onStructure({ kind: "replace", index, block: { ...block, runs: replaceRange(plain, from, end, "") } });
            return;
          }
          if (range) {
            event.preventDefault();
            onStructure({ kind: "replace", index, block: { ...block, runs: replaceRange(plain, from, to, "") } });
            pendingCaret.current = from;
            return;
          }
          return;
        }
        event.preventDefault();
        onStructure({ kind: "mergeForward", index });
        return;
      }
      case "Tab": {
        event.preventDefault();
        onStructure({ kind: event.shiftKey ? "outdent" : "indent", index });
        return;
      }
      case "ArrowUp":
        if (caretOnFirstLine(element)) {
          event.preventDefault();
          onStructure({ kind: "moveCaret", index, delta: -1, atLine: "start" });
        }
        return;
      case "ArrowDown":
        if (caretOnLastLine(element)) {
          event.preventDefault();
          onStructure({ kind: "moveCaret", index, delta: 1, atLine: "end" });
        }
        return;
      case "Home":
        if (!mod) {
          event.preventDefault();
          setCaretOffset(element, 0);
        }
        return;
      case "End": {
        if (!mod) {
          event.preventDefault();
          setCaretOffset(element, runsText(plain).length);
        }
        return;
      }
      default:
        return;
    }
  };

  return (
    <div className="para-row" style={{ marginLeft: props.list ? props.list.level * 24 : 0 }}>
      {listMarker ? <span className="list-marker" contentEditable={false}>{listMarker}</span> : null}
      <Tag
        ref={ref as never}
        className={`para para-${props.style.toLowerCase()}${props.pageBreakBefore ? " page-break-before" : ""}`}
        data-block-index={index}
        data-scope={scope}
        contentEditable
        suppressContentEditableWarning
        spellCheck
        onKeyDown={handleKeyDown}
        onFocus={() => {
          setFocused(true);
          onFocus();
        }}
        onBlur={(event) => {
          setFocused(false);
          onSync(event.currentTarget);
        }}
        onInput={(event) => {
          // Keep the model in sync while typing (cheap: paragraph runs only).
          onSync(event.currentTarget);
        }}
        style={{
          textAlign: props.align as "left" | "center" | "right" | "justify",
          lineHeight: props.lineSpacing,
          marginBottom: props.spaceAfterPt,
          marginTop: props.spaceBeforePt,
          textIndent: props.firstLinePt,
          fontSize: `${(effectiveFontSize(block) ?? 11) * zoom}pt`,
        }}
      />
    </div>
  );
}

function TableView({
  block,
  index,
  zoom,
  onUpdate,
  onSyncCell,
}: {
  block: Extract<Block, { type: "table" }>;
  index: number;
  zoom: number;
  onUpdate: (block: Block) => void;
  onSyncCell: (path: [number, number, number], element: HTMLElement) => void;
}) {
  const table = block.table;
  const [menuCell, setMenuCell] = useState<{ row: number; cell: number } | null>(null);
  const updateTable = (mutate: (table: TableData) => TableData) => onUpdate({ type: "table", table: mutate(table) });

  return (
    <div className="writer-table-wrap">
      <table className={`writer-table${table.borders ? "" : " no-borders"}`} style={{ width: `${(table.columnWidthsPt.reduce((sum, value) => sum + value, 0) || 400) * (96 / 72) * zoom}px` }}>
        <colgroup>
          {table.columnWidthsPt.map((width, columnIndex) => (
            <col key={columnIndex} style={{ width: `${width * (96 / 72) * zoom}px` }} />
          ))}
        </colgroup>
        <tbody>
          {table.rows.map((row, rowIndex) => (
            <tr key={rowIndex} className={row.header ? "is-header" : ""}>
              {row.cells.map((cell, cellIndex) => (
                <td
                  key={cellIndex}
                  colSpan={cell.colspan}
                  rowSpan={cell.rowspan}
                  style={{ background: cell.background ?? undefined, textAlign: (cell.align || "left") as "left" | "center" | "right", verticalAlign: (cell.valign || "top") as "top" | "middle" | "bottom" }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setMenuCell({ row: rowIndex, cell: cellIndex });
                  }}
                >
                  {(cell.blocks.length > 0 ? cell.blocks : [newParaBlock()]).map((inner, innerIndex) =>
                    inner.type === "paragraph" ? (
                      <CellParagraph
                        key={innerIndex}
                        block={inner}
                        tablePath={[index, rowIndex, cellIndex]}
                        onSyncCell={onSyncCell}
                      />
                    ) : null,
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {menuCell ? (
        <Dialog title={`Row ${menuCell.row + 1} · Cell ${menuCell.cell + 1}`} onClose={() => setMenuCell(null)}>
          <div className="row">
            <button type="button" className="btn btn-soft" onClick={() => { updateTable((current) => ({ ...current, rows: [...current.rows.slice(0, menuCell.row + 1), { ...current.rows[menuCell.row], header: false }, ...current.rows.slice(menuCell.row + 1)] })); setMenuCell(null); }}>
              Add row below
            </button>
            <button type="button" className="btn btn-soft" onClick={() => { updateTable((current) => (current.rows.length > 1 ? { ...current, rows: current.rows.filter((_, position) => position !== menuCell.row) } : current)); setMenuCell(null); }}>
              Delete row
            </button>
            <button type="button" className="btn btn-soft" onClick={() => { updateTable((current) => ({ ...current, rows: current.rows.map((row) => ({ ...row, cells: [...row.cells.slice(0, menuCell.cell + 1), { ...row.cells[menuCell.cell] }, ...row.cells.slice(menuCell.cell + 1)] })) })); setMenuCell(null); }}>
              Add column
            </button>
            <button type="button" className="btn btn-soft" onClick={() => { updateTable((current) => ({ ...current, rows: current.rows.map((row) => (row.cells.length > 1 ? { ...row, cells: row.cells.filter((_, position) => position !== menuCell.cell) } : row)) })); setMenuCell(null); }}>
              Delete column
            </button>
            <button type="button" className="btn btn-soft" onClick={() => { updateTable((current) => ({ ...current, rows: current.rows.map((row, r) => (r !== menuCell.row ? row : { ...row, cells: row.cells.map((cell, c) => (c !== menuCell.cell ? cell : { ...cell, background: cell.background ? null : "#EEF2FF" })) })) })); setMenuCell(null); }}>
              Toggle cell shade
            </button>
            <button type="button" className="btn btn-soft" onClick={() => { updateTable((current) => ({ ...current, borders: !current.borders })); setMenuCell(null); }}>
              Toggle borders
            </button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}

function CellParagraph({ block, tablePath, onSyncCell }: { block: Extract<Block, { type: "paragraph" }>; tablePath: [number, number, number]; onSyncCell: (path: [number, number, number], element: HTMLElement) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused && ref.current) ref.current.innerHTML = runsToHtml(block.runs);
  }, [block.runs, focused]);
  return (
    <div
      ref={ref}
      className="para cell-para"
      contentEditable
      suppressContentEditableWarning
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        setFocused(false);
        onSyncCell(tablePath, event.currentTarget);
      }}
      onInput={(event) => onSyncCell(tablePath, event.currentTarget)}
      style={{ textAlign: (block.props.align || "left") as "left" | "center" | "right" }}
    />
  );
}

function ImageOptions({
  block,
  onChange,
}: {
  block: Block;
  onChange: (width: number, height: number, align: string, caption: string) => void;
}) {
  if (block.type !== "image") return null;
  const aspect = block.widthPt / Math.max(1, block.heightPt);
  return (
    <div className="stack">
      <label className="field">
        <span>Width (pt)</span>
        <input
          type="number"
          value={Math.round(block.widthPt)}
          onChange={(event) => {
            const width = Number(event.target.value);
            onChange(width, Math.round(width / aspect), block.align, block.caption);
          }}
        />
      </label>
      <label className="field">
        <span>Caption</span>
        <input value={block.caption} onChange={(event) => onChange(block.widthPt, block.heightPt, block.align, event.target.value)} />
      </label>
      <label className="field">
        <span>Alignment</span>
        <select value={block.align} onChange={(event) => onChange(block.widthPt, block.heightPt, event.target.value, block.caption)}>
          <option value="left">Left</option>
          <option value="center">Center</option>
          <option value="right">Right</option>
        </select>
      </label>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

const emptyRun = emptyWriterRun;

function effectiveFontSize(block: Extract<Block, { type: "paragraph" }>): number | null {
  return block.runs.find((run) => run.sizePt)?.sizePt ?? null;
}

function applyVisualStyle(element: HTMLElement, property: string, value: string) {
  element.style.setProperty(property, value);
}


function mimeFromName(name: string): string {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  switch (extension) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "bmp":
      return "image/bmp";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    default:
      return "image/png";
  }
}

function sizeDimensions(size: string, orientation: string): { widthPt: number; heightPt: number } {
  const setup = defaultPageSetup(size, orientation);
  return { widthPt: setup.widthPt, heightPt: setup.heightPt };
}

export function blankWriterDocument(title: string): TextDocument {
  return newTextDocument(title);
}

export { emptyMetadata };
