/**
 * Pure cell-model operations for the Calc engine.
 *
 * Everything here is a plain function over the `Workbook` model so it can be
 * unit tested without mounting the editor or talking to Tauri. `CalcEditor`
 * is the only consumer; keeping the logic out of the component is what makes
 * the commit path (inline editor, formula bar, paste, fill) testable at all.
 */
import {
  defaultCellStyle,
  emptyCell,
  type Cell,
  type CellStyle,
  type CellValue,
  type Sheet,
  type Workbook,
} from "../../lib/office-types";
import {
  ERR,
  FormulaError,
  evaluateFormula,
  formatAddress,
  formatNumber,
  isError,
  parseAddress,
  type Scalar,
} from "./formula";

export function cellValueToScalar(value: CellValue): Scalar {
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

/** Parses what a user typed into a cell into a typed value. */
export function parseInputValue(text: string): CellValue {
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

export function isDefaultCellStyle(style: CellStyle): boolean {
  const base = defaultCellStyle();
  return (
    !style.font &&
    style.sizePt === base.sizePt &&
    !style.bold &&
    !style.italic &&
    !style.underline &&
    !style.strike &&
    !style.color &&
    !style.fill &&
    style.align === base.align &&
    style.valign === base.valign &&
    !style.wrap &&
    !style.rotation &&
    !style.borders.top &&
    !style.borders.right &&
    !style.borders.bottom &&
    !style.borders.left &&
    style.numberFormat === base.numberFormat
  );
}

/** True when a cell carries no value, formula, comment or formatting. */
export function isBlankCell(cell: Cell): boolean {
  return cell.value.kind === "empty" && !cell.formula && !cell.comment && isDefaultCellStyle(cell.style);
}

function replaceSheet(workbook: Workbook, index: number, sheet: Sheet): Workbook {
  return { ...workbook, sheets: workbook.sheets.map((candidate, at) => (at === index ? sheet : candidate)) };
}

/**
 * Applies a typed value to one cell and returns the resulting workbook.
 *
 * A formula is evaluated against the workbook that *already contains the new
 * formula text*, so the cached value persisted into `.oswk`/XLSX/ODS on save is
 * never one edit behind - the bug that made chained commits write stale
 * numbers to disk.
 */
export function applyCellEdit(workbook: Workbook, sheetIndex: number, row: number, col: number, rawValue: string): Workbook {
  const index = Math.min(Math.max(0, sheetIndex), workbook.sheets.length - 1);
  const target = workbook.sheets[index];
  if (!target) return workbook;
  const address = formatAddress(row, col);
  const current = target.cells[address] ?? emptyCell();
  const isFormula = rawValue.startsWith("=");
  const staged: Cell = isFormula
    ? { ...current, formula: rawValue, value: { kind: "empty" } }
    : { ...current, formula: null, value: parseInputValue(rawValue) };

  const cells = { ...target.cells };
  if (isBlankCell(staged)) delete cells[address];
  else cells[address] = staged;
  const stagedSheet: Sheet = {
    ...target,
    cells,
    rowCount: Math.max(target.rowCount, row + 51),
    colCount: Math.max(target.colCount, col + 6),
  };
  const stagedWorkbook = replaceSheet(workbook, index, stagedSheet);
  if (!isFormula) return stagedWorkbook;

  const resolved: Cell = { ...staged, value: formulaResult(rawValue, stagedWorkbook, stagedSheet) };
  return replaceSheet(stagedWorkbook, index, { ...stagedSheet, cells: { ...stagedSheet.cells, [address]: resolved } });
}

/** Applies a block of typed values starting at a cell (used by paste). */
export function applyCellEdits(workbook: Workbook, sheetIndex: number, start: { row: number; col: number }, values: string[][]): Workbook {
  let next = workbook;
  values.forEach((line, rowOffset) => {
    line.forEach((value, colOffset) => {
      next = applyCellEdit(next, sheetIndex, start.row + rowOffset, start.col + colOffset, value);
    });
  });
  return next;
}

/**
 * Shifts the row part of every relative reference in a formula by `delta`.
 * Absolute rows (`$1`) and non-references (bare numbers) are untouched. The
 * lookbehind stops the rewrite from biting into sheet names such as `Data1`,
 * while still allowing the `!` that precedes a sheet-qualified reference.
 */
export function shiftFormulaRows(formula: string | null, delta: number): string | null {
  if (!formula || delta === 0) return formula;
  return formula.replace(/(?<![A-Za-z0-9_$])(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})(?![A-Za-z0-9_(])/g, (match, dollarCol: string, letters: string, dollarRow: string, digits: string) => {
    if (parseAddress(`${letters}${digits}`) === null) return match;
    if (dollarRow) return match;
    const nextRow = Number(digits) + delta;
    if (nextRow < 1 || nextRow > 1_048_576) return match;
    return `${dollarCol}${letters}${nextRow}`;
  });
}

/** Evaluates every formula cell of the workbook with cycle protection. */
export function computeWorkbookValues(workbook: Workbook): Map<string, Scalar> {
  const cache = new Map<string, Scalar>();
  const resolving = new Set<string>();
  const sheetNames = workbook.sheets.map((candidate) => candidate.name);
  // A sheet-scoped name shadows a workbook-level one of the same name, which is
  // what Excel does; names are compared case-insensitively.
  const names: Record<string, string> = {};
  for (const entry of workbook.names ?? []) {
    if (entry.sheet === null || entry.sheet === undefined) names[entry.name.toUpperCase()] = entry.definition;
  }
  const scoped = new Map<string, Record<string, string>>();
  for (const entry of workbook.names ?? []) {
    if (entry.sheet === null || entry.sheet === undefined) continue;
    const bucket = scoped.get(entry.sheet) ?? {};
    bucket[entry.name.toUpperCase()] = entry.definition;
    scoped.set(entry.sheet, bucket);
  }

  const getValue = (sheetName: string | null, address: string): Scalar => {
    const name = sheetName ?? sheetNames[0] ?? "";
    const key = `${name}!${address}`;
    // The cycle check has to come before the cache lookup: a cell currently
    // being resolved is already in the cache as an in-progress placeholder, and
    // reading that placeholder back would make `=A1+1` in A1 silently return
    // 0 + 1 instead of reporting a circular reference.
    if (resolving.has(key)) return ERR.circular();
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const target = workbook.sheets.find((candidate) => candidate.name === name);
    if (!target) return ERR.ref();
    const cell = target.cells[address];
    if (!cell) return "";
    if (cell.formula) {
      resolving.add(key);
      const result = evaluateFormula(cell.formula, {
        getValue,
        sheetNames,
        currentSheet: name,
        names: { ...names, ...(scoped.get(name) ?? {}) },
      });
      resolving.delete(key);
      cache.set(key, result);
      return result;
    }
    const scalar = cellValueToScalar(cell.value);
    cache.set(key, scalar);
    return scalar;
  };

  for (const candidate of workbook.sheets) {
    for (const address of Object.keys(candidate.cells)) getValue(candidate.name, address);
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

export function formulaResult(formula: string, workbook: Workbook, sheet: Sheet): CellValue {
  const values = computeWorkbookValues(workbook);
  const result = evaluateFormula(formula, {
    getValue: (sheetName, address) => values.get(`${sheetName ?? sheet.name}!${address}`) ?? "",
    sheetNames: workbook.sheets.map((candidate) => candidate.name),
    currentSheet: sheet.name,
  });
  return scalarToCellValue(result);
}

export function formatCellDisplay(value: Scalar, style: CellStyle): string {
  if (isError(value)) return value.code;
  if (typeof value === "number") return formatNumber(value, style.numberFormat || "General");
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return String(value ?? "");
}

export function usedRange(sheet: Sheet): string {
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

export function uniqueSheetName(workbook: Workbook, base: string): string {
  let index = 1;
  while (workbook.sheets.some((sheet) => sheet.name === (index === 1 ? base : `${base}${index}`))) index += 1;
  return index === 1 ? base : `${base}${index}`;
}
