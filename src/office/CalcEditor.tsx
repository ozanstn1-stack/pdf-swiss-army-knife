/**
 * Calc editor: virtualised spreadsheet grid with a real formula engine,
 * formatting, multiple sheets, sorting, conditional formatting, validation
 * and SVG charts fed from cell ranges.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDownAZ,
  ArrowUpAZ,
  BarChart3,
  Bold,
  Copy,
  Eraser,
  Filter,
  Grid3x3,
  Italic,
  Merge,
  Minus,
  Plus,
  Redo2,
  Save,
  Sigma,
  Trash2,
  Underline,
  Undo2,
  Snowflake,
} from "lucide-react";
import type { OfficeTab, Workbook } from "../lib/office-store";
import { useOfficeTabs } from "../lib/office-store";
import { useT } from "../lib/i18n";
import { useToasts } from "../lib/store";
import { cellText, defaultCellStyle, emptyCell, newSheet, type Cell, type CellStyle, type CellValue, type ChartData, type Sheet } from "../lib/office-types";
import {
  ERR,
  FormulaError,
  addressesInRange,
  columnLabel,
  evaluateFormula,
  formatAddress,
  formatNumber as formatNumeric,
  isError,
  parseAddress,
  parseRange,
  type Scalar,
} from "./calc/formula";
import { Dialog, Ribbon, RibbonGroup, ToolButton, ToolColor, ToolSelect } from "./office-ui";
import { useOfficeSession } from "./useOfficeSession";

type CalcTab = OfficeTab & { model: Workbook };

const ROW_HEIGHT = 24;
const HEADER_WIDTH = 56;
const DEFAULT_COL_WIDTH = 96;

interface Selection {
  anchor: { row: number; col: number };
  focus: { row: number; col: number };
}

interface CellPosition {
  row: number;
  col: number;
}

export function CalcEditor({ tab }: { tab: CalcTab }) {
  const t = useT();
  const workbook = tab.model;
  const edit = useOfficeTabs((state) => state.edit);
  const session = useOfficeSession(tab);
  const [ribbon, setRibbon] = useState("home");
  const [sheetIndex, setSheetIndex] = useState(workbook.activeSheet ?? 0);
  const [selection, setSelection] = useState<Selection>({ anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } });
  const [editing, setEditing] = useState<{ row: number; col: number; value: string } | null>(null);
  const [formulaDraft, setFormulaDraft] = useState("");
  const [scroll, setScroll] = useState({ top: 0, left: 0, width: 900, height: 500 });
  const [chartDialog, setChartDialog] = useState(false);
  const [conditionalDialog, setConditionalDialog] = useState(false);
  const [validationDialog, setValidationDialog] = useState(false);
  const [filterOpen, setFilterOpen] = useState<{ col: number; values: Array<{ value: string; checked: boolean }> } | null>(null);
  const [undoStack, setUndoStack] = useState<Workbook[]>([]);
  const [redoStack, setRedoStack] = useState<Workbook[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const sheet = workbook.sheets[Math.min(sheetIndex, workbook.sheets.length - 1)] ?? workbook.sheets[0];
  const activeCell = sheet.cells[formatAddress(selection.focus.row, selection.focus.col)];
  const computed = useMemo(() => computeSheetValues(workbook, sheet), [workbook, sheet]);

  const update = useCallback(
    (mutate: (workbook: Workbook) => Workbook, recordUndo = true) => {
      if (recordUndo) {
        setUndoStack((stack) => [...stack.slice(-40), workbook]);
        setRedoStack([]);
      }
      edit(tab.id, (model) => mutate(model as Workbook));
    },
    [edit, tab.id, workbook],
  );

  const updateSheet = useCallback(
    (mutate: (sheet: Sheet) => Sheet, recordUndo = true) => {
      update(
        (current) => ({ ...current, sheets: current.sheets.map((candidate, index) => (index === sheetIndex ? mutate(candidate) : candidate)) }),
        recordUndo,
      );
    },
    [sheetIndex, update],
  );

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      setScroll((current) => ({ ...current, width: element.clientWidth, height: element.clientHeight }));
    });
    observer.observe(element);
    setScroll((current) => ({ ...current, width: element.clientWidth, height: element.clientHeight }));
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setFormulaDraft(activeCell?.formula ?? cellText(activeCell));
  }, [selection.focus.row, selection.focus.col, activeCell]);

  // -------------------------------------------------------------------------
  // Cell helpers
  // -------------------------------------------------------------------------

  const setCell = (row: number, col: number, cell: Cell, recordUndo = true) => {
    updateSheet((current) => {
      const address = formatAddress(row, col);
      const cells = { ...current.cells };
      if (cell.value.kind === "empty" && !cell.formula && !cell.comment && JSON.stringify(cell.style) === JSON.stringify(defaultCellStyle())) {
        delete cells[address];
      } else {
        cells[address] = cell;
      }
      return { ...current, cells, rowCount: Math.max(current.rowCount, row + 51), colCount: Math.max(current.colCount, col + 6) };
    }, recordUndo);
  };

  const setCells = (entries: Array<{ row: number; col: number; cell: Cell }>) => {
    updateSheet((current) => {
      const cells = { ...current.cells };
      for (const entry of entries) {
        const address = formatAddress(entry.row, entry.col);
        cells[address] = entry.cell;
      }
      return { ...current, cells };
    });
  };

  const commitEdit = (move: "down" | "right" | "none" = "down") => {
    if (!editing) return;
    const { row, col, value } = editing;
    const cell = sheet.cells[formatAddress(row, col)] ?? emptyCell();
    const next: Cell = value.startsWith("=")
      ? { ...cell, formula: value, value: formulaResult(value, workbook, sheet) }
      : { ...cell, formula: null, value: parseInputValue(value) };
    setCell(row, col, next);
    setEditing(null);
    if (move === "down") setSelection({ anchor: { row: row + 1, col }, focus: { row: row + 1, col } });
    if (move === "right") setSelection({ anchor: { row, col: col + 1 }, focus: { row, col: col + 1 } });
  };

  const applyStyle = (patch: Partial<CellStyle>) => {
    const addresses = addressesInRange(`${formatAddress(selection.anchor.row, selection.anchor.col)}:${formatAddress(selection.focus.row, selection.focus.col)}`);
    const entries = addresses.map((address) => {
      const position = parseAddress(address)!;
      const cell = sheet.cells[address] ?? emptyCell();
      return { row: position.row, col: position.col, cell: { ...cell, style: { ...cell.style, ...patch } } };
    });
    setCells(entries);
  };

  const applyBorder = (side: "top" | "right" | "bottom" | "left" | "all") => {
    const addresses = addressesInRange(`${formatAddress(selection.anchor.row, selection.anchor.col)}:${formatAddress(selection.focus.row, selection.focus.col)}`);
    const entries = addresses.map((address) => {
      const position = parseAddress(address)!;
      const cell = sheet.cells[address] ?? emptyCell();
      const borders = { ...cell.style.borders };
      const style = { style: "thin", color: "#334155" };
      if (side === "all") {
        borders.top = style;
        borders.right = side === "all" ? style : borders.right;
        borders.bottom = style;
        borders.left = style;
      } else {
        borders[side] = style;
      }
      return { row: position.row, col: position.col, cell: { ...cell, style: { ...cell.style, borders } } };
    });
    setCells(entries);
  };

  const clearSelection = () => {
    const addresses = addressesInRange(`${formatAddress(selection.anchor.row, selection.anchor.col)}:${formatAddress(selection.focus.row, selection.focus.col)}`);
    updateSheet((current) => {
      const cells = { ...current.cells };
      for (const address of addresses) delete cells[address];
      return { ...current, cells };
    });
  };

  const clipboardRef = useRef<{ rows: Scalar[][]; start: CellPosition } | null>(null);

  const copySelection = () => {
    const parts = parseRange(`${formatAddress(selection.anchor.row, selection.anchor.col)}:${formatAddress(selection.focus.row, selection.focus.col)}`);
    if (!parts) return;
    const rows: Scalar[][] = [];
    for (let row = parts.start.row; row <= parts.end.row; row += 1) {
      const line: Scalar[] = [];
      for (let col = parts.start.col; col <= parts.end.col; col += 1) {
        line.push(computed.get(formatAddress(row, col)) ?? "");
      }
      rows.push(line);
    }
    clipboardRef.current = { rows, start: { row: parts.start.row, col: parts.start.col } };
    const text = rows.map((line) => line.map((value) => String(value ?? "")).join("\t")).join("\n");
    void navigator.clipboard?.writeText(text).catch(() => undefined);
  };

  const pasteAtSelection = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        const rows = text.split(/\r?\n/).filter((line) => line.length > 0).map((line) => line.split("\t"));
        applyPasted(rows);
        return;
      }
    } catch {
      // Clipboard read may be blocked; fall back to the in-app clipboard.
    }
    if (clipboardRef.current) {
      applyPasted(clipboardRef.current.rows.map((line) => line.map((value) => String(value ?? ""))));
    }
  };

  const applyPasted = (rows: string[][]) => {
    const entries: Array<{ row: number; col: number; cell: Cell }> = [];
    rows.forEach((line, rowOffset) => {
      line.forEach((value, colOffset) => {
        const row = selection.focus.row + rowOffset;
        const col = selection.focus.col + colOffset;
        const cell = sheet.cells[formatAddress(row, col)] ?? emptyCell();
        entries.push({ row, col, cell: { ...cell, formula: value.startsWith("=") ? value : null, value: value.startsWith("=") ? formulaResult(value, workbook, sheet) : parseInputValue(value) } });
      });
    });
    setCells(entries);
  };

  // -------------------------------------------------------------------------
  // Keyboard handling
  // -------------------------------------------------------------------------

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const { row, col } = selection.focus;
    const move = (dRow: number, dCol: number, extend = false) => {
      event.preventDefault();
      const next = { row: Math.max(0, row + dRow), col: Math.max(0, col + dCol) };
      setSelection(extend ? { anchor: selection.anchor, focus: next } : { anchor: next, focus: next });
    };
    if (editing) return;
    switch (event.key) {
      case "ArrowUp":
        move(-1, 0, event.shiftKey);
        break;
      case "ArrowDown":
        move(1, 0, event.shiftKey);
        break;
      case "ArrowLeft":
        move(0, -1, event.shiftKey);
        break;
      case "ArrowRight":
        move(0, 1, event.shiftKey);
        break;
      case "Tab":
        event.preventDefault();
        move(0, event.shiftKey ? -1 : 1);
        break;
      case "Enter":
        event.preventDefault();
        setEditing({ row, col, value: activeCell?.formula ?? cellText(activeCell) });
        break;
      case "F2":
        event.preventDefault();
        setEditing({ row, col, value: activeCell?.formula ?? cellText(activeCell) });
        break;
      case "Delete":
      case "Backspace":
        clearSelection();
        break;
      case "Escape":
        setEditing(null);
        break;
      case "c":
        if (event.ctrlKey || event.metaKey) {
          event.preventDefault();
          copySelection();
        }
        break;
      case "v":
        if (event.ctrlKey || event.metaKey) {
          event.preventDefault();
          void pasteAtSelection();
        }
        break;
      case "z":
        if (event.ctrlKey || event.metaKey) {
          event.preventDefault();
          undo();
        }
        break;
      case "y":
        if (event.ctrlKey || event.metaKey) {
          event.preventDefault();
          redo();
        }
        break;
      default:
        if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key.length === 1) {
          setEditing({ row, col, value: event.key });
        }
    }
  };

  const undo = () => {
    setUndoStack((stack) => {
      const previous = stack[stack.length - 1];
      if (!previous) return stack;
      setRedoStack((redos) => [...redos, workbook]);
      edit(tab.id, () => previous);
      return stack.slice(0, -1);
    });
  };

  const redo = () => {
    setRedoStack((stack) => {
      const next = stack[stack.length - 1];
      if (!next) return stack;
      setUndoStack((undos) => [...undos, workbook]);
      edit(tab.id, () => next);
      return stack.slice(0, -1);
    });
  };

  // -------------------------------------------------------------------------
  // Sheets
  // -------------------------------------------------------------------------

  const addSheet = () => {
    update((current) => {
      const name = uniqueSheetName(current, "Sheet");
      const sheets = [...current.sheets, newSheet(name)];
      return { ...current, sheets, activeSheet: sheets.length - 1 };
    });
    setSheetIndex(workbook.sheets.length);
  };

  const removeSheet = (index: number) => {
    if (workbook.sheets.length <= 1) return;
    const sheets = workbook.sheets.filter((_, position) => position !== index);
    update((current) => ({ ...current, sheets, activeSheet: Math.max(0, Math.min(index, sheets.length - 1)) }));
    setSheetIndex(Math.max(0, Math.min(index, sheets.length - 1)));
  };

  const renameSheet = (index: number) => {
    const name = window.prompt(t("calc.sheetName"), workbook.sheets[index]?.name ?? "");
    if (!name) return;
    update((current) => ({ ...current, sheets: current.sheets.map((candidate, position) => (position === index ? { ...candidate, name } : candidate)) }));
  };

  // -------------------------------------------------------------------------
  // Sort / filter / conditional / validation
  // -------------------------------------------------------------------------

  const sortByColumn = (column: number, ascending: boolean) => {
    const parts = parseRange(sheet.filter?.range ?? usedRange(sheet));
    if (!parts) return;
    const header = sheet.cells[formatAddress(parts.start.row, column)] !== undefined && parts.start.row === 0;
    const startRow = header ? parts.start.row + 1 : parts.start.row;
    const rows: Array<{ values: Array<{ col: number; cell: Cell | undefined }>; key: Scalar }> = [];
    for (let row = startRow; row <= parts.end.row; row += 1) {
      const values = [];
      for (let col = parts.start.col; col <= parts.end.col; col += 1) {
        values.push({ col, cell: sheet.cells[formatAddress(row, col)] });
      }
      rows.push({ values, key: computed.get(formatAddress(row, column)) ?? "" });
    }
    rows.sort((a, b) => {
      const left = a.key;
      const right = b.key;
      const leftNumber = typeof left === "number" ? left : Number(left);
      const rightNumber = typeof right === "number" ? right : Number(right);
      if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return ascending ? leftNumber - rightNumber : rightNumber - leftNumber;
      const compare = String(left).localeCompare(String(right));
      return ascending ? compare : -compare;
    });
    updateSheet((current) => {
      const cells = { ...current.cells };
      for (const address of addressesInRange(`${formatAddress(startRow, parts.start.col)}:${formatAddress(parts.end.row, parts.end.col)}`)) delete cells[address];
      rows.forEach((row, rowOffset) => {
        row.values.forEach((value) => {
          if (value.cell) cells[formatAddress(startRow + rowOffset, value.col)] = value.cell;
        });
      });
      return { ...current, cells };
    });
  };

  const openFilter = (col: number) => {
    const parts = parseRange(usedRange(sheet));
    if (!parts) return;
    const values = new Map<string, boolean>();
    for (let row = parts.start.row + 1; row <= parts.end.row; row += 1) {
      const text = String(computed.get(formatAddress(row, col)) ?? "");
      if (!values.has(text)) values.set(text, true);
    }
    setFilterOpen({ col, values: [...values.entries()].map(([value, checked]) => ({ value, checked })) });
  };

  const applyFilter = () => {
    if (!filterOpen) return;
    const allowed = new Set(filterOpen.values.filter((entry) => entry.checked).map((entry) => entry.value));
    updateSheet((current) => {
      const parts = parseRange(usedRange(current));
      if (!parts) return current;
      for (let row = parts.start.row; row <= parts.end.row; row += 1) {
        const address = formatAddress(row, filterOpen.col);
        const value = String(computed.get(address) ?? "");
        const position = parseAddress(address);
        if (!position) continue;
        const hidden = !allowed.has(value);
        if (hidden) {
          current = { ...current, rowHeights: { ...current.rowHeights, [position.row]: 0 } };
        } else if (current.rowHeights[position.row] === 0) {
          const heights = { ...current.rowHeights };
          delete heights[position.row];
          current = { ...current, rowHeights: heights };
        }
      }
      return { ...current, filter: { range: usedRange(current), column: filterOpen.col, values: [...allowed] } };
    });
    setFilterOpen(null);
  };

  const addChart = (kind: string) => {
    const parts = parseRange(`${formatAddress(selection.anchor.row, selection.anchor.col)}:${formatAddress(selection.focus.row, selection.focus.col)}`);
    if (!parts || parts.start.row === parts.end.row) {
      useToasts.getState().push({ kind: "info", title: t("calc.chartNeedsData") });
      return;
    }
    const categories = `${formatAddress(parts.start.row + 1, parts.start.col)}:${formatAddress(parts.end.row, parts.start.col)}`;
    const series: ChartData["series"] = [];
    for (let col = parts.start.col + 1; col <= parts.end.col; col += 1) {
      series.push({
        name: String(computed.get(formatAddress(parts.start.row, col)) ?? `Series ${col}`),
        range: `${formatAddress(parts.start.row + 1, col)}:${formatAddress(parts.end.row, col)}`,
        color: null,
      });
    }
    const chart: ChartData = { kind, title: t("calc.chartTitle"), categories, series, legend: true, xTitle: "", yTitle: "", stacked: false, showLabels: false };
    const anchor = formatAddress(parts.end.row + 2, parts.start.col);
    updateSheet((current) => ({ ...current, charts: [...current.charts, { id: crypto.randomUUID(), chart, anchor, widthPx: 420, heightPx: 260 }] }));
    setChartDialog(false);
  };

  const addConditional = (rule: { kind: string; values: string[]; fill: string; topN?: number }) => {
    const range = usedRange(sheet);
    updateSheet((current) => ({
      ...current,
      conditional: [
        ...current.conditional,
        { id: crypto.randomUUID(), range, kind: rule.kind, values: rule.values, fill: rule.fill, color: null, topN: rule.topN ?? null, stopIfTrue: false },
      ],
    }));
    setConditionalDialog(false);
  };

  const addValidation = (validation: { kind: string; values: string[]; min: number | null; max: number | null; message: string }) => {
    const range = `${formatAddress(selection.anchor.row, selection.anchor.col)}:${formatAddress(selection.focus.row, selection.focus.col)}`;
    updateSheet((current) => ({
      ...current,
      validations: [...current.validations, { id: crypto.randomUUID(), range, kind: validation.kind, values: validation.values, min: validation.min, max: validation.max, message: validation.message, allowBlank: true }],
    }));
    setValidationDialog(false);
  };

  const toggleFreeze = () => {
    const row = selection.focus.row;
    const col = selection.focus.col;
    updateSheet((current) => (current.freezeRows === row && current.freezeCols === col ? { ...current, freezeRows: 0, freezeCols: 0 } : { ...current, freezeRows: row, freezeCols: col }));
  };

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  const totalWidth = useMemo(() => {
    let total = 0;
    for (let col = 0; col < sheet.colCount; col += 1) total += sheet.colWidths[String(col)] ?? DEFAULT_COL_WIDTH;
    return total;
  }, [sheet]);

  const visible = useMemo(() => {
    const rows: number[] = [];
    const startRow = Math.max(0, Math.floor(scroll.top / ROW_HEIGHT) - 2);
    const endRow = Math.min(sheet.rowCount - 1, startRow + Math.ceil(scroll.height / ROW_HEIGHT) + 4);
    for (let row = startRow; row <= endRow; row += 1) rows.push(row);
    const columns: Array<{ col: number; x: number }> = [];
    let x = 0;
    let startCol = 0;
    for (let col = 0; col < sheet.colCount; col += 1) {
      const width = sheet.colWidths[String(col)] ?? DEFAULT_COL_WIDTH;
      if (x + width < scroll.left) {
        x += width;
        startCol = col + 1;
        continue;
      }
      if (x > scroll.left + scroll.width + 200) break;
      columns.push({ col, x: x - scroll.left });
      x += width;
    }
    return { rows, columns, startCol };
  }, [scroll, sheet]);

  const selectionBounds = useMemo(() => {
    const parts = parseRange(`${formatAddress(selection.anchor.row, selection.anchor.col)}:${formatAddress(selection.focus.row, selection.focus.col)}`);
    return parts ?? { start: selection.anchor, end: selection.focus };
  }, [selection]);

  const columnX = (col: number) => {
    let x = 0;
    for (let index = 0; index < col; index += 1) x += sheet.colWidths[String(index)] ?? DEFAULT_COL_WIDTH;
    return x - scroll.left + HEADER_WIDTH;
  };

  const nameBox = `${formatAddress(selection.focus.row, selection.focus.col)}${selection.anchor.row !== selection.focus.row || selection.anchor.col !== selection.focus.col ? `:${formatAddress(selection.anchor.row, selection.anchor.col)}` : ""}`;

  return (
    <div className="editor calc-editor">
      <Ribbon
        tabs={[
          { id: "home", label: t("calc.tabHome") },
          { id: "insert", label: t("calc.tabInsert") },
          { id: "formulas", label: t("calc.tabFormulas") },
          { id: "data", label: t("calc.tabData") },
          { id: "view", label: t("calc.tabView") },
        ]}
        active={ribbon}
        onSelect={setRibbon}
      >
        {ribbon === "home" ? (
          <>
            <RibbonGroup label={t("writer.clipboard")}>
              <ToolButton icon={<Undo2 size={16} />} onClick={undo} disabled={undoStack.length === 0} title={t("common.undo")} />
              <ToolButton icon={<Redo2 size={16} />} onClick={redo} disabled={redoStack.length === 0} title={t("common.redo")} />
              <ToolButton icon={<Copy size={16} />} onClick={copySelection} title={t("common.copy")} />
              <ToolButton icon={<Eraser size={16} />} onClick={clearSelection} title={t("calc.clearCells")} />
            </RibbonGroup>
            <RibbonGroup label={t("writer.font")}>
              <ToolButton icon={<Bold size={16} />} onClick={() => applyStyle({ bold: !(activeCell?.style.bold ?? false) })} active={activeCell?.style.bold} title={t("writer.bold")} />
              <ToolButton icon={<Italic size={16} />} onClick={() => applyStyle({ italic: !(activeCell?.style.italic ?? false) })} active={activeCell?.style.italic} title={t("writer.italic")} />
              <ToolButton icon={<Underline size={16} />} onClick={() => applyStyle({ underline: !(activeCell?.style.underline ?? false) })} active={activeCell?.style.underline} title={t("writer.underline")} />
              <ToolColor value={activeCell?.style.color ?? "#1f2328"} onChange={(color) => applyStyle({ color })} title={t("writer.textColor")} />
              <ToolColor value={activeCell?.style.fill ?? "#ffffff"} onChange={(fill) => applyStyle({ fill })} title={t("calc.fillColor")} />
            </RibbonGroup>
            <RibbonGroup label={t("writer.paragraph")}>
              <ToolButton icon={<AlignLeft size={16} />} onClick={() => applyStyle({ align: "left" })} active={activeCell?.style.align === "left"} title={t("writer.alignLeft")} />
              <ToolButton icon={<AlignCenter size={16} />} onClick={() => applyStyle({ align: "center" })} active={activeCell?.style.align === "center"} title={t("writer.alignCenter")} />
              <ToolButton icon={<AlignRight size={16} />} onClick={() => applyStyle({ align: "right" })} active={activeCell?.style.align === "right"} title={t("writer.alignRight")} />
              <ToolButton icon={<Merge size={16} />} onClick={() => toggleMerge(sheet, selection, updateSheet)} title={t("calc.mergeCells")} />
              <ToolButton icon={<Grid3x3 size={16} />} onClick={() => applyBorder("all")} title={t("calc.borders")} />
            </RibbonGroup>
            <RibbonGroup label={t("calc.numberFormat")}>
              <ToolSelect
                value={activeCell?.style.numberFormat ?? "General"}
                onChange={(numberFormat) => applyStyle({ numberFormat })}
                options={[
                  { value: "General", label: t("calc.formatGeneral") },
                  { value: "0", label: "1234" },
                  { value: "0.00", label: "12.34" },
                  { value: "#,##0", label: "1,234" },
                  { value: "#,##0.00", label: "1,234.56" },
                  { value: "0%", label: "12%" },
                  { value: "$#,##0.00", label: "$1,234.56" },
                  { value: "dd.mm.yyyy", label: "31.12.2025" },
                  { value: "hh:mm", label: "13:45" },
                ]}
                width={120}
              />
            </RibbonGroup>
          </>
        ) : null}

        {ribbon === "insert" ? (
          <RibbonGroup label={t("calc.charts")}>
            <ToolButton icon={<BarChart3 size={16} />} label={t("calc.chart")} onClick={() => setChartDialog(true)} />
          </RibbonGroup>
        ) : null}

        {ribbon === "formulas" ? (
          <>
            <RibbonGroup label={t("calc.functions")}>
              <ToolButton icon={<Sigma size={16} />} label="SUM" onClick={() => insertFunction("SUM")} />
              <ToolButton label="AVERAGE" onClick={() => insertFunction("AVERAGE")} />
              <ToolButton label="IF" onClick={() => insertFunction("IF")} />
              <ToolButton label="COUNT" onClick={() => insertFunction("COUNT")} />
              <ToolButton label="ROUND" onClick={() => insertFunction("ROUND")} />
              <ToolButton label="VLOOKUP" onClick={() => insertFunction("VLOOKUP")} />
            </RibbonGroup>
            <RibbonGroup label={t("calc.conditional")}>
              <ToolButton icon={<Filter size={16} />} label={t("calc.conditionalFormatting")} onClick={() => setConditionalDialog(true)} />
              <ToolButton label={t("calc.dataValidation")} onClick={() => setValidationDialog(true)} />
            </RibbonGroup>
          </>
        ) : null}

        {ribbon === "data" ? (
          <>
            <RibbonGroup label={t("calc.sort")}>
              <ToolButton icon={<ArrowUpAZ size={16} />} label={t("calc.sortAsc")} onClick={() => sortByColumn(selection.focus.col, true)} />
              <ToolButton icon={<ArrowDownAZ size={16} />} label={t("calc.sortDesc")} onClick={() => sortByColumn(selection.focus.col, false)} />
              <ToolButton icon={<Filter size={16} />} label={t("calc.filter")} onClick={() => openFilter(selection.focus.col)} />
            </RibbonGroup>
            <RibbonGroup label={t("calc.structure")}>
              <ToolButton icon={<Plus size={16} />} label={t("calc.insertRow")} onClick={() => insertRow(sheet, selection.focus.row, updateSheet)} />
              <ToolButton icon={<Minus size={16} />} label={t("calc.deleteRow")} onClick={() => deleteRow(sheet, selection.focus.row, updateSheet)} />
              <ToolButton icon={<Plus size={16} />} label={t("calc.insertColumn")} onClick={() => insertColumn(sheet, selection.focus.col, updateSheet)} />
              <ToolButton icon={<Minus size={16} />} label={t("calc.deleteColumn")} onClick={() => deleteColumn(sheet, selection.focus.col, updateSheet)} />
            </RibbonGroup>
          </>
        ) : null}

        {ribbon === "view" ? (
          <>
            <RibbonGroup label={t("calc.view")}>
              <ToolButton icon={<Snowflake size={16} />} label={t("calc.freezePanes")} onClick={toggleFreeze} active={sheet.freezeRows > 0 || sheet.freezeCols > 0} />
              <ToolButton label={sheet.showGridlines ? t("calc.hideGridlines") : t("calc.showGridlines")} onClick={() => updateSheet((current) => ({ ...current, showGridlines: !current.showGridlines }))} />
            </RibbonGroup>
            <RibbonGroup label={t("calc.sheets")}>
              <ToolButton icon={<Plus size={16} />} label={t("calc.addSheet")} onClick={addSheet} />
            </RibbonGroup>
          </>
        ) : null}

        <div className="ribbon-spacer" />
        <RibbonGroup>
          <ToolButton icon={<Save size={16} />} label={t("common.save")} onClick={() => void session.save()} disabled={session.busy} />
        </RibbonGroup>
      </Ribbon>

      <div className="calc-formula-bar">
        <input className="name-box" value={nameBox} onChange={(event) => {
          const parts = parseRange(event.target.value.trim());
          if (parts) setSelection({ anchor: parts.start, focus: parts.end });
        }} />
        <span className="fx">fx</span>
        <input
          className="formula-input"
          value={editing ? editing.value : formulaDraft}
          placeholder={t("calc.formulaHint")}
          onChange={(event) => {
            setFormulaDraft(event.target.value);
            if (editing) setEditing({ ...editing, value: event.target.value });
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              if (!editing) setEditing({ row: selection.focus.row, col: selection.focus.col, value: formulaDraft });
              else commitEdit("down");
            }
            if (event.key === "Escape") {
              setEditing(null);
              setFormulaDraft(activeCell?.formula ?? cellText(activeCell));
            }
          }}
        />
      </div>

      <div className="calc-grid-wrap" ref={containerRef}>
        <div
          className="calc-grid"
          tabIndex={0}
          ref={gridRef}
          onKeyDown={handleKeyDown}
          onScroll={(event) => setScroll((current) => ({ ...current, top: (event.target as HTMLDivElement).scrollTop, left: (event.target as HTMLDivElement).scrollLeft }))}
          style={{ width: "100%", height: "100%" }}
        >
          <div className="calc-canvas" style={{ width: HEADER_WIDTH + totalWidth, height: ROW_HEIGHT * (sheet.rowCount + 1) }}>
            <div className="calc-col-headers" style={{ transform: `translate(${HEADER_WIDTH - scroll.left}px, 0)` }}>
              {visible.columns.map(({ col, x }) => (
                <div
                  key={col}
                  className={`calc-col-header${selection.focus.col === col ? " is-active" : ""}`}
                  style={{ left: x, width: sheet.colWidths[String(col)] ?? DEFAULT_COL_WIDTH }}
                  onMouseDown={() => setSelection({ anchor: { row: 0, col }, focus: { row: sheet.rowCount - 1, col } })}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    insertColumn(sheet, col, updateSheet);
                  }}
                >
                  {columnLabel(col)}
                  <span
                    className="col-resize"
                    onMouseDown={(event) => {
                      event.stopPropagation();
                      startColumnResize(event, col, sheet, updateSheet);
                    }}
                  />
                </div>
              ))}
            </div>
            <div className="calc-row-headers" style={{ transform: `translate(0, ${ROW_HEIGHT - scroll.top}px)` }}>
              {visible.rows.map((row) => (
                <div
                  key={row}
                  className={`calc-row-header${selection.focus.row === row ? " is-active" : ""}`}
                  style={{ top: row * ROW_HEIGHT, height: sheet.rowHeights[String(row)] ?? ROW_HEIGHT }}
                  onMouseDown={() => setSelection({ anchor: { row, col: 0 }, focus: { row, col: sheet.colCount - 1 } })}
                >
                  {row + 1}
                </div>
              ))}
            </div>
            <div className="calc-cells" style={{ transform: `translate(${HEADER_WIDTH - scroll.left}px, ${ROW_HEIGHT - scroll.top}px)`, width: totalWidth, height: ROW_HEIGHT * sheet.rowCount }}>
              {visible.rows.map((row) =>
                visible.columns.map(({ col, x }) => {
                  const address = formatAddress(row, col);
                  const value = computed.get(address) ?? "";
                  const cell = sheet.cells[address];
                  const width = sheet.colWidths[String(col)] ?? DEFAULT_COL_WIDTH;
                  const isEditing = editing?.row === row && editing?.col === col;
                  const inSelection = row >= selectionBounds.start.row && row <= selectionBounds.end.row && col >= selectionBounds.start.col && col <= selectionBounds.end.col;
                  const fill = conditionalFill(sheet, address, value, computed);
                  const style = cell?.style ?? defaultCellStyle();
                  const validation = sheet.validations.find((rule) => addressesInRange(rule.range, 100).includes(address));
                  const invalid = validation ? !isValid(validation, value) : false;
                  return (
                    <div
                      key={address}
                      className={`calc-cell${inSelection ? " is-selected" : ""}${invalid ? " is-invalid" : ""}`}
                      style={{
                        left: x,
                        top: row * ROW_HEIGHT,
                        width,
                        height: sheet.rowHeights[String(row)] ?? ROW_HEIGHT,
                        background: fill ?? style.fill ?? undefined,
                        fontWeight: style.bold ? 700 : undefined,
                        fontStyle: style.italic ? "italic" : undefined,
                        textDecoration: [style.underline ? "underline" : "", style.strike ? "line-through" : ""].filter(Boolean).join(" ") || undefined,
                        color: style.color ?? undefined,
                        textAlign: (style.align === "general" ? (typeof value === "number" ? "right" : "left") : style.align) as "left" | "right" | "center",
                        justifyContent: style.align === "center" ? "center" : style.align === "right" || (style.align === "general" && typeof value === "number") ? "flex-end" : "flex-start",
                      }}
                      onMouseDown={(event) => {
                        if (event.shiftKey) setSelection({ anchor: selection.anchor, focus: { row, col } });
                        else setSelection({ anchor: { row, col }, focus: { row, col } });
                      }}
                      onDoubleClick={() => setEditing({ row, col, value: cell?.formula ?? cellText(cell) })}
                    >
                      {isEditing ? (
                        <input
                          className="cell-editor"
                          value={editing!.value}
                          autoFocus
                          onChange={(event) => setEditing({ row, col, value: event.target.value })}
                          onBlur={() => commitEdit("none")}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") commitEdit("down");
                            if (event.key === "Tab") {
                              event.preventDefault();
                              commitEdit("right");
                            }
                            if (event.key === "Escape") setEditing(null);
                          }}
                        />
                      ) : (
                        <span className="cell-text">{formatCellDisplay(value, style)}</span>
                      )}
                      {style.borders.top ? <span className="cell-border top" /> : null}
                      {style.borders.bottom ? <span className="cell-border bottom" /> : null}
                      {style.borders.left ? <span className="cell-border left" /> : null}
                      {style.borders.right ? <span className="cell-border right" /> : null}
                      {sheet.conditional.some((rule) => rule.kind === "dataBar" && addressesInRange(rule.range, 100).includes(address)) ? (
                        <span className="data-bar" style={{ width: `${Math.min(100, Math.abs(Number(value) || 0))}%` }} />
                      ) : null}
                      {cell?.comment ? <span className="cell-comment-dot" title={cell.comment} /> : null}
                    </div>
                  );
                }),
              )}
            </div>
            {sheet.charts.map((chart) => {
              const position = parseAddress(chart.anchor) ?? { row: 0, col: 0 };
              return (
                <ChartBox
                  key={chart.id}
                  chart={chart}
                  sheet={sheet}
                  workbook={workbook}
                  x={columnX(position.col)}
                  y={position.row * ROW_HEIGHT + ROW_HEIGHT - scroll.top}
                  onRemove={() => updateSheet((current) => ({ ...current, charts: current.charts.filter((candidate) => candidate.id !== chart.id) }))}
                />
              );
            })}
          </div>
        </div>
      </div>

      <div className="calc-sheet-tabs">
        <button type="button" className="icon-btn" onClick={addSheet} title={t("calc.addSheet")}>
          <Plus size={14} />
        </button>
        {workbook.sheets.map((candidate, index) => (
          <div key={candidate.id} className={`sheet-tab${index === sheetIndex ? " is-active" : ""}`} onClick={() => { setSheetIndex(index); setSelection({ anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } }); }}>
            <span onDoubleClick={() => renameSheet(index)}>{candidate.name}</span>
            {workbook.sheets.length > 1 ? (
              <button
                type="button"
                className="icon-btn"
                onClick={(event) => {
                  event.stopPropagation();
                  removeSheet(index);
                }}
                title={t("common.delete")}
              >
                <Trash2 size={11} />
              </button>
            ) : null}
          </div>
        ))}
        <span className="spacer" />
        <span className="muted">
          {tab.path ?? t("writer.unsaved")} {tab.dirty ? "•" : ""}
        </span>
      </div>

      <div className="editor-status">
        <span>{nameBox}</span>
        <span>{activeCell?.formula ? t("calc.formula") : formatCellDisplay(computed.get(formatAddress(selection.focus.row, selection.focus.col)) ?? "", activeCell?.style ?? defaultCellStyle())}</span>
        <span className="spacer" />
        <span>
          {sheet.rowCount} × {sheet.colCount}
        </span>
      </div>

      {chartDialog ? (
        <Dialog title={t("calc.chart")} onClose={() => setChartDialog(false)}>
          <div className="chart-kind-grid">
            {["column", "bar", "line", "pie", "area"].map((kind) => (
              <button key={kind} type="button" className="btn btn-soft" onClick={() => addChart(kind)}>
                {t(`calc.chart_${kind}`)}
              </button>
            ))}
          </div>
          <p className="muted">{t("calc.chartHint")}</p>
        </Dialog>
      ) : null}

      {conditionalDialog ? (
        <ConditionalDialog onClose={() => setConditionalDialog(false)} onApply={addConditional} />
      ) : null}

      {validationDialog ? (
        <ValidationDialog onClose={() => setValidationDialog(false)} onApply={addValidation} />
      ) : null}

      {filterOpen ? (
        <Dialog title={t("calc.filter")} onClose={() => setFilterOpen(null)}>
          <div className="stack filter-list">
            {filterOpen.values.map((entry, index) => (
              <label key={entry.value} className="check">
                <input
                  type="checkbox"
                  checked={entry.checked}
                  onChange={(event) =>
                    setFilterOpen((current) =>
                      current
                        ? { ...current, values: current.values.map((candidate, position) => (position === index ? { ...candidate, checked: event.target.checked } : candidate)) }
                        : current,
                    )
                  }
                />
                {entry.value || t("calc.filterBlank")}
              </label>
            ))}
          </div>
          <div className="row">
            <button type="button" className="btn btn-soft" onClick={() => setFilterOpen((current) => (current ? { ...current, values: current.values.map((entry) => ({ ...entry, checked: true })) } : current))}>
              {t("calc.selectAll")}
            </button>
            <button type="button" className="btn btn-primary" onClick={applyFilter}>
              {t("calc.applyFilter")}
            </button>
            <button
              type="button"
              className="btn btn-soft"
              onClick={() => {
                updateSheet((current) => ({ ...current, rowHeights: {}, filter: null }));
                setFilterOpen(null);
              }}
            >
              {t("calc.clearFilter")}
            </button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Derived data
// ---------------------------------------------------------------------------

function cellValueToScalar(value: CellValue): Scalar {
  switch (value.kind) {
    case "number":
      return value.value;
    case "text":
      return value.value;
    case "bool":
      return value.value;
    case "error":
      return new FormulaError(value.value);
    default:
      return "";
  }
}

export function scalarToCellValue(value: Scalar): CellValue {
  if (isError(value)) return { kind: "error", value: value.code };
  if (typeof value === "number") return { kind: "number", value };
  if (typeof value === "boolean") return { kind: "bool", value };
  return { kind: "text", value: String(value) };
}

function parseInputValue(text: string): CellValue {
  const trimmed = text.trim();
  if (trimmed === "") return { kind: "empty" };
  if (/^-?\d+([.,]\d+)?$/.test(trimmed)) {
    const numeric = Number(trimmed.replace(",", "."));
    if (Number.isFinite(numeric)) return { kind: "number", value: numeric };
  }
  if (/^(true|false)$/i.test(trimmed)) return { kind: "bool", value: trimmed.toLowerCase() === "true" };
  if (/^#(REF|VALUE|NAME|DIV\/0|N\/A|NUM)/i.test(trimmed)) return { kind: "error", value: trimmed.toUpperCase() };
  return { kind: "text", value: text };
}

/** Evaluates every formula cell of the workbook with cycle protection. */
export function computeWorkbookValues(workbook: Workbook): Map<string, Scalar> {
  const cache = new Map<string, Scalar>();
  const resolving = new Set<string>();
  const sheetNames = workbook.sheets.map((candidate) => candidate.name);

  const getValue = (sheetName: string | null, address: string): Scalar => {
    const name = sheetName ?? sheetNames[0] ?? "";
    const key = `${name}!${address}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const target = workbook.sheets.find((candidate) => candidate.name === name);
    if (!target) return ERR.ref();
    const cell = target.cells[address];
    if (!cell) return "";
    if (cell.formula) {
      if (resolving.has(key)) return ERR.circular();
      resolving.add(key);
      cache.set(key, "");
      const result = evaluateFormula(cell.formula, { getValue, sheetNames, currentSheet: name });
      resolving.delete(key);
      cache.set(key, result);
      return result;
    }
    const scalar = cellValueToScalar(cell.value);
    cache.set(key, scalar);
    return scalar;
  };

  for (const candidate of workbook.sheets) {
    for (const address of Object.keys(candidate.cells)) {
      getValue(candidate.name, address);
    }
  }
  return cache;
}

/** Values of one sheet keyed by bare address (for display). */
export function computeSheetValues(workbook: Workbook, sheet: Sheet): Map<string, Scalar> {
  const prefixed = computeWorkbookValues(workbook);
  const out = new Map<string, Scalar>();
  const prefix = `${sheet.name}!`;
  for (const [key, value] of prefixed) {
    if (key.startsWith(prefix)) out.set(key.slice(prefix.length), value);
  }
  return out;
}

function formulaResult(formula: string, workbook: Workbook, sheet: Sheet): CellValue {
  const values = computeWorkbookValues(workbook);
  const result = evaluateFormula(formula, {
    getValue: (sheetName, address) => values.get(`${sheetName ?? sheet.name}!${address}`) ?? "",
    sheetNames: workbook.sheets.map((candidate) => candidate.name),
    currentSheet: sheet.name,
  });
  return scalarToCellValue(result);
}

function formatCellDisplay(value: Scalar, style: CellStyle): string {
  if (isError(value)) return value.code;
  if (typeof value === "number") return formatNumeric(value, style.numberFormat || "General");
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return String(value ?? "");
}

function usedRange(sheet: Sheet): string {
  let maxRow = 0;
  let maxCol = 0;
  for (const address of Object.keys(sheet.cells)) {
    const position = parseAddress(address);
    if (!position) continue;
    maxRow = Math.max(maxRow, position.row);
    maxCol = Math.max(maxCol, position.col);
  }
  return `A1:${formatAddress(Math.max(0, maxRow), Math.max(0, maxCol))}`;
}

function uniqueSheetName(workbook: Workbook, base: string): string {
  let index = 1;
  while (workbook.sheets.some((sheet) => sheet.name === (index === 1 ? base : `${base}${index}`))) index += 1;
  return index === 1 ? base : `${base}${index}`;
}

function conditionalFill(sheet: Sheet, address: string, value: Scalar, all: Map<string, Scalar>): string | null {
  for (const rule of sheet.conditional) {
    const addresses = addressesInRange(rule.range, 5000);
    if (!addresses.includes(address)) continue;
    const number = typeof value === "number" ? value : Number(value);
    const [first, second] = rule.values;
    switch (rule.kind) {
      case "greater":
        if (Number.isFinite(number) && number > Number(first)) return rule.fill ?? "#FEE2E2";
        break;
      case "less":
        if (Number.isFinite(number) && number < Number(first)) return rule.fill ?? "#FEE2E2";
        break;
      case "between":
        if (Number.isFinite(number) && number >= Number(first) && number <= Number(second)) return rule.fill ?? "#FEF3C7";
        break;
      case "equal":
        if (String(value) === String(first)) return rule.fill ?? "#DBEAFE";
        break;
      case "textContains":
        if (String(value).toLowerCase().includes(String(first).toLowerCase())) return rule.fill ?? "#E0E7FF";
        break;
      case "duplicate": {
        const others = addresses.filter((entry) => entry !== address).map((entry) => String(all.get(entry) ?? ""));
        if (others.includes(String(value)) && String(value) !== "") return rule.fill ?? "#FECACA";
        break;
      }
      case "top": {
        const values = addresses.map((entry) => Number(all.get(entry) ?? 0)).filter(Number.isFinite).sort((a, b) => b - a);
        const limit = Math.max(1, rule.topN ?? 10);
        const threshold = values[Math.min(limit, values.length) - 1] ?? Number.POSITIVE_INFINITY;
        if (Number.isFinite(number) && number >= threshold) return rule.fill ?? "#BBF7D0";
        break;
      }
      default:
        break;
    }
  }
  return null;
}

function isValid(rule: { kind: string; values: string[]; min: number | null; max: number | null }, value: Scalar): boolean {
  if (value === "" || value === undefined) return true;
  if (rule.kind === "list") return rule.values.map((entry) => entry.trim().toLowerCase()).includes(String(value).trim().toLowerCase());
  const number = Number(value);
  if (!Number.isFinite(number)) return rule.kind !== "number";
  if (rule.kind === "number") {
    if (rule.min !== null && number < rule.min) return false;
    if (rule.max !== null && number > rule.max) return false;
  }
  return true;
}

function insertFunction(name: string) {
  const active = window.document.activeElement as HTMLElement | null;
  const input = window.document.querySelector<HTMLInputElement>(".formula-input");
  if (input) {
    input.focus();
    const start = input.selectionStart ?? input.value.length;
    input.value = `${input.value.slice(0, start)}=${name}(`;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
  void active;
}

function insertRow(_sheet: Sheet, row: number, updateSheet: (mutate: (sheet: Sheet) => Sheet) => void) {
  updateSheet((current) => {
    const cells: Sheet["cells"] = {};
    for (const [address, cell] of Object.entries(current.cells)) {
      const position = parseAddress(address);
      if (!position) continue;
      cells[formatAddress(position.row >= row ? position.row + 1 : position.row, position.col)] = cell;
    }
    return { ...current, cells, rowCount: current.rowCount + 1 };
  });
}

function deleteRow(_sheet: Sheet, row: number, updateSheet: (mutate: (sheet: Sheet) => Sheet) => void) {
  updateSheet((current) => {
    const cells: Sheet["cells"] = {};
    for (const [address, cell] of Object.entries(current.cells)) {
      const position = parseAddress(address);
      if (!position || position.row === row) continue;
      cells[formatAddress(position.row > row ? position.row - 1 : position.row, position.col)] = cell;
    }
    return { ...current, cells, rowCount: Math.max(10, current.rowCount - 1) };
  });
}

function insertColumn(_sheet: Sheet, col: number, updateSheet: (mutate: (sheet: Sheet) => Sheet) => void) {
  updateSheet((current) => {
    const cells: Sheet["cells"] = {};
    for (const [address, cell] of Object.entries(current.cells)) {
      const position = parseAddress(address);
      if (!position) continue;
      cells[formatAddress(position.row, position.col >= col ? position.col + 1 : position.col)] = cell;
    }
    return { ...current, cells, colCount: current.colCount + 1 };
  });
}

function deleteColumn(_sheet: Sheet, col: number, updateSheet: (mutate: (sheet: Sheet) => Sheet) => void) {
  updateSheet((current) => {
    const cells: Sheet["cells"] = {};
    for (const [address, cell] of Object.entries(current.cells)) {
      const position = parseAddress(address);
      if (!position || position.col === col) continue;
      cells[formatAddress(position.row, position.col > col ? position.col - 1 : position.col)] = cell;
    }
    return { ...current, cells, colCount: Math.max(5, current.colCount - 1) };
  });
}

function toggleMerge(_sheet: Sheet, selection: Selection, updateSheet: (mutate: (sheet: Sheet) => Sheet) => void) {
  const start = formatAddress(Math.min(selection.anchor.row, selection.focus.row), Math.min(selection.anchor.col, selection.focus.col));
  const end = formatAddress(Math.max(selection.anchor.row, selection.focus.row), Math.max(selection.anchor.col, selection.focus.col));
  updateSheet((current) => {
    const existing = current.merges.findIndex((merge) => merge.start === start && merge.end === end);
    if (existing >= 0) return { ...current, merges: current.merges.filter((_, index) => index !== existing) };
    return { ...current, merges: [...current.merges, { start, end }] };
  });
}

function startColumnResize(event: React.MouseEvent, col: number, sheet: Sheet, updateSheet: (mutate: (sheet: Sheet) => Sheet) => void) {
  const startX = event.clientX;
  const startWidth = sheet.colWidths[String(col)] ?? DEFAULT_COL_WIDTH;
  const onMove = (move: MouseEvent) => {
    const width = Math.max(32, startWidth + (move.clientX - startX));
    updateSheet((current) => ({ ...current, colWidths: { ...current.colWidths, [col]: width } }));
  };
  const onUp = () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------

function ChartBox({
  chart,
  sheet,
  workbook,
  x,
  y,
  onRemove,
}: {
  chart: { id: string; chart: ChartData; anchor: string; widthPx: number; heightPx: number };
  sheet: Sheet;
  workbook: Workbook;
  x: number;
  y: number;
  onRemove: () => void;
}) {
  const values = computeSheetValues(workbook, sheet);
  const categories = addressesInRange(chart.chart.categories, 5000).map((address) => String(values.get(address) ?? ""));
  const series = chart.chart.series.map((entry) => ({
    name: entry.name,
    values: addressesInRange(entry.range, 5000).map((address) => Number(values.get(address) ?? 0)),
    color: entry.color,
  }));
  const palette = ["#2563eb", "#059669", "#d97706", "#dc2626", "#7c3aed", "#0891b2"];
  const all = series.flatMap((entry) => entry.values).filter(Number.isFinite);
  const max = Math.max(1, ...all);
  const min = Math.min(0, ...all);
  const width = chart.widthPx;
  const height = chart.heightPx;
  const plotWidth = width - 48;
  const plotHeight = height - 56;
  const count = Math.max(1, categories.length);

  const pointsFor = (values2: number[]) =>
    values2
      .map((value, index) => {
        const px = 40 + (count === 1 ? plotWidth / 2 : (index / (count - 1)) * plotWidth);
        const py = 34 + plotHeight - ((value - min) / (max - min || 1)) * plotHeight;
        return `${px},${py}`;
      })
      .join(" ");

  return (
    <div className="chart-box" style={{ left: x, top: y, width, height }}>
      <div className="chart-head">
        <strong>{chart.chart.title}</strong>
        <button type="button" className="icon-btn" onClick={onRemove} title="Delete chart">
          <Trash2 size={12} />
        </button>
      </div>
      <svg width={width} height={height - 26} viewBox={`0 0 ${width} ${height - 26}`}>
        <line x1={40} y1={height - 22} x2={width - 8} y2={height - 22} stroke="#cbd5e1" />
        <line x1={40} y1={34} x2={40} y2={height - 22} stroke="#cbd5e1" />
        {chart.chart.kind === "pie"
          ? pieSlices(series[0]?.values ?? [], palette).map((slice, index) => (
              <path key={index} d={slice.path} fill={slice.color} opacity={0.85} />
            ))
          : null}
        {chart.chart.kind === "column" || chart.chart.kind === "bar"
          ? series.map((entry, seriesIndex) =>
              entry.values.map((value, index) => {
                const bandWidth = plotWidth / count;
                const barWidth = Math.max(2, (bandWidth * 0.7) / series.length);
                const px = 40 + index * bandWidth + bandWidth * 0.15 + seriesIndex * barWidth;
                const py = 34 + plotHeight - ((value - min) / (max - min || 1)) * plotHeight;
                return <rect key={`${seriesIndex}-${index}`} x={chart.chart.kind === "bar" ? py : px} y={chart.chart.kind === "bar" ? 34 + index * bandWidth : py} width={chart.chart.kind === "bar" ? 40 + plotHeight - py : barWidth} height={chart.chart.kind === "bar" ? barWidth : 34 + plotHeight - py} fill={entry.color ?? palette[seriesIndex % palette.length]} opacity={0.85} />;
              }),
            )
          : null}
        {chart.chart.kind === "line" || chart.chart.kind === "area"
          ? series.map((entry, index) => (
              <g key={index}>
                {chart.chart.kind === "area" ? <polygon points={`40,${34 + plotHeight} ${pointsFor(entry.values)} ${40 + plotWidth},${34 + plotHeight}`} fill={entry.color ?? palette[index % palette.length]} opacity={0.25} /> : null}
                <polyline points={pointsFor(entry.values)} fill="none" stroke={entry.color ?? palette[index % palette.length]} strokeWidth={2} />
              </g>
            ))
          : null}
        {categories.map((label, index) => (
          <text key={index} x={40 + (index + 0.5) * (plotWidth / count)} y={height - 8} fontSize={9} textAnchor="middle" fill="#64748b">
            {label.length > 8 ? `${label.slice(0, 7)}…` : label}
          </text>
        ))}
      </svg>
      {chart.chart.legend ? (
        <div className="chart-legend">
          {series.map((entry, index) => (
            <span key={index}>
              <i style={{ background: entry.color ?? palette[index % palette.length] }} />
              {entry.name}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function pieSlices(values: number[], palette: string[]): Array<{ path: string; color: string }> {
  const total = values.reduce((sum, value) => sum + Math.max(0, value), 0) || 1;
  let angle = -Math.PI / 2;
  const radius = 60;
  const cx = 110;
  const cy = 90;
  return values.map((value, index) => {
    const sweep = (Math.max(0, value) / total) * Math.PI * 2;
    const x1 = cx + radius * Math.cos(angle);
    const y1 = cy + radius * Math.sin(angle);
    angle += sweep;
    const x2 = cx + radius * Math.cos(angle);
    const y2 = cy + radius * Math.sin(angle);
    const large = sweep > Math.PI ? 1 : 0;
    return { path: `M ${cx} ${cy} L ${x1} ${y1} A ${radius} ${radius} 0 ${large} 1 ${x2} ${y2} Z`, color: palette[index % palette.length] };
  });
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

function ConditionalDialog({ onClose, onApply }: { onClose: () => void; onApply: (rule: { kind: string; values: string[]; fill: string; topN?: number }) => void }) {
  const t = useT();
  const [kind, setKind] = useState("greater");
  const [first, setFirst] = useState("100");
  const [second, setSecond] = useState("0");
  const [fill, setFill] = useState("#FEE2E2");
  return (
    <Dialog title={t("calc.conditionalFormatting")} onClose={onClose}>
      <div className="stack">
        <label className="field">
          <span>{t("calc.rule")}</span>
          <select value={kind} onChange={(event) => setKind(event.target.value)}>
            <option value="greater">{t("calc.ruleGreater")}</option>
            <option value="less">{t("calc.ruleLess")}</option>
            <option value="between">{t("calc.ruleBetween")}</option>
            <option value="equal">{t("calc.ruleEqual")}</option>
            <option value="textContains">{t("calc.ruleText")}</option>
            <option value="duplicate">{t("calc.ruleDuplicate")}</option>
            <option value="top">{t("calc.ruleTop")}</option>
          </select>
        </label>
        {kind === "duplicate" ? null : (
          <div className="row">
            <label className="field">
              <span>{t("calc.value")}</span>
              <input value={first} onChange={(event) => setFirst(event.target.value)} />
            </label>
            {kind === "between" ? (
              <label className="field">
                <span>{t("calc.and")}</span>
                <input value={second} onChange={(event) => setSecond(event.target.value)} />
              </label>
            ) : null}
          </div>
        )}
        <label className="field">
          <span>{t("calc.fillColor")}</span>
          <input type="color" value={fill} onChange={(event) => setFill(event.target.value)} />
        </label>
        <button type="button" className="btn btn-primary" onClick={() => onApply({ kind, values: [first, second], fill, topN: kind === "top" ? Number(first) || 10 : undefined })}>
          {t("common.apply")}
        </button>
      </div>
    </Dialog>
  );
}

function ValidationDialog({ onClose, onApply }: { onClose: () => void; onApply: (validation: { kind: string; values: string[]; min: number | null; max: number | null; message: string }) => void }) {
  const t = useT();
  const [kind, setKind] = useState("list");
  const [list, setList] = useState("Open,In progress,Done");
  const [min, setMin] = useState("0");
  const [max, setMax] = useState("100");
  const [message, setMessage] = useState("");
  return (
    <Dialog title={t("calc.dataValidation")} onClose={onClose}>
      <div className="stack">
        <label className="field">
          <span>{t("calc.validationType")}</span>
          <select value={kind} onChange={(event) => setKind(event.target.value)}>
            <option value="list">{t("calc.validationList")}</option>
            <option value="number">{t("calc.validationNumber")}</option>
          </select>
        </label>
        {kind === "list" ? (
          <label className="field">
            <span>{t("calc.validationValues")}</span>
            <input value={list} onChange={(event) => setList(event.target.value)} />
          </label>
        ) : (
          <div className="row">
            <label className="field">
              <span>{t("calc.minimum")}</span>
              <input value={min} onChange={(event) => setMin(event.target.value)} />
            </label>
            <label className="field">
              <span>{t("calc.maximum")}</span>
              <input value={max} onChange={(event) => setMax(event.target.value)} />
            </label>
          </div>
        )}
        <label className="field">
          <span>{t("calc.validationMessage")}</span>
          <input value={message} onChange={(event) => setMessage(event.target.value)} />
        </label>
        <button type="button" className="btn btn-primary" onClick={() => onApply({ kind, values: list.split(",").map((entry) => entry.trim()), min: kind === "number" ? Number(min) : null, max: kind === "number" ? Number(max) : null, message })}>
          {t("common.apply")}
        </button>
      </div>
    </Dialog>
  );
}

export { formatNumeric };
