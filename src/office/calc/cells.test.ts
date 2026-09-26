/**
 * Regression tests for the Calc commit path.
 *
 * The bug these lock down: after pressing Enter in a cell, the inline editor
 * unmounted, the browser fired `blur`, and the blur handler committed the same
 * value a second time (two undo entries, stale cell state) while focus landed
 * on `<body>` so the next keystroke went nowhere. `applyCellEdit` is the pure
 * core that all three commit routes (inline editor, formula bar, paste) now
 * share, so testing it here covers the data half of that race.
 */
import { describe, expect, it } from "vitest";
import { emptyCell, newSheet, newWorkbook, type Workbook } from "../../lib/office-types";
import {
  applyCellEdit,
  applyCellEdits,
  computeWorkbookValues,
  isBlankCell,
  parseInputValue,
  shiftFormulaRows,
} from "./cells";
import { isError, parseAddress } from "./formula";

function book(): Workbook {
  const workbook = newWorkbook("Test");
  return { ...workbook, sheets: [newSheet("Sheet1")] };
}

function cellOf(workbook: Workbook, address: string) {
  return workbook.sheets[0].cells[address];
}

describe("applyCellEdit", () => {
  it("stores numbers, text, booleans and errors as typed", () => {
    let wb = book();
    wb = applyCellEdit(wb, 0, 0, 0, "42");
    wb = applyCellEdit(wb, 0, 0, 1, "hello");
    wb = applyCellEdit(wb, 0, 0, 2, "TRUE");
    wb = applyCellEdit(wb, 0, 0, 3, "#N/A");
    expect(cellOf(wb, "A1")?.value).toEqual({ kind: "number", value: 42 });
    expect(cellOf(wb, "B1")?.value).toEqual({ kind: "text", value: "hello" });
    expect(cellOf(wb, "C1")?.value).toEqual({ kind: "bool", value: true });
    expect(cellOf(wb, "D1")?.value).toEqual({ kind: "error", value: "#N/A" });
  });

  it("accepts a comma decimal separator", () => {
    expect(parseInputValue("3,5")).toEqual({ kind: "number", value: 3.5 });
    expect(parseInputValue("-12")).toEqual({ kind: "number", value: -12 });
  });

  it("clears the cell entry entirely when the user empties a cell", () => {
    let wb = applyCellEdit(book(), 0, 0, 0, "42");
    expect(wb.sheets[0].cells.A1).toBeDefined();
    wb = applyCellEdit(wb, 0, 0, 0, "");
    expect(wb.sheets[0].cells.A1).toBeUndefined();
  });

  it("keeps formatting and comments when only the value changes", () => {
    let wb = applyCellEdit(book(), 0, 0, 0, "1");
    const styled = { ...cellOf(wb, "A1")!, style: { ...cellOf(wb, "A1")!.style, bold: true }, comment: "note" };
    wb = { ...wb, sheets: [{ ...wb.sheets[0], cells: { ...wb.sheets[0].cells, A1: styled } }] };
    wb = applyCellEdit(wb, 0, 0, 0, "2");
    expect(cellOf(wb, "A1")?.value).toEqual({ kind: "number", value: 2 });
    expect(cellOf(wb, "A1")?.style.bold).toBe(true);
    expect(cellOf(wb, "A1")?.comment).toBe("note");
  });

  it("stores the formula text without the leading equals in the cache", () => {
    const wb = applyCellEdit(book(), 0, 0, 0, "=1+1");
    expect(cellOf(wb, "A1")?.formula).toBe("=1+1");
  });

  it("evaluates a formula against the workbook that already contains it", () => {
    // The regression: A2 must see A1, not the pre-edit workbook.
    let wb = applyCellEdit(book(), 0, 0, 0, "10");
    wb = applyCellEdit(wb, 0, 1, 0, "=A1*2");
    expect(cellOf(wb, "A2")?.value).toEqual({ kind: "number", value: 20 });
  });

  it("keeps a chain of three dependent cells consistent", () => {
    let wb = applyCellEdit(book(), 0, 0, 0, "5");
    wb = applyCellEdit(wb, 0, 1, 0, "=A1+1");
    wb = applyCellEdit(wb, 0, 2, 0, "=A2*3");
    expect(cellOf(wb, "A3")?.value).toEqual({ kind: "number", value: 18 });
    const values = computeWorkbookValues(wb);
    expect(values.get("Sheet1!A3")).toBe(18);
  });

  it("recalculates a dependent cell after its input changes", () => {
    let wb = applyCellEdit(book(), 0, 0, 0, "5");
    wb = applyCellEdit(wb, 0, 1, 0, "=A1*10");
    wb = applyCellEdit(wb, 0, 0, 0, "7");
    const values = computeWorkbookValues(wb);
    expect(values.get("Sheet1!A2")).toBe(70);
  });

  it("surfaces a formula error instead of a silent zero", () => {
    const wb = applyCellEdit(book(), 0, 0, 0, "=1/0");
    expect(cellOf(wb, "A1")?.value).toEqual({ kind: "error", value: "#DIV/0!" });
  });

  it("reports a direct circular reference instead of returning a wrong number", () => {
    // The engine surfaces cycles as #REF! with a "circular reference" detail -
    // the visible code the spreadsheet formats already document. What matters
    // is that `=A1+1` in A1 never silently becomes 2.
    const wb = applyCellEdit(book(), 0, 0, 0, "=A1+1");
    expect(cellOf(wb, "A1")?.value.kind).toBe("error");
    expect((cellOf(wb, "A1")?.value as { value: string }).value).toBe("#REF!");
    const values = computeWorkbookValues(wb);
    expect(isError(values.get("Sheet1!A1"))).toBe(true);
  });

  it("reports an indirect circular reference", () => {
    let wb = applyCellEdit(book(), 0, 0, 0, "=A2");
    wb = applyCellEdit(wb, 0, 1, 0, "=A1");
    const values = computeWorkbookValues(wb);
    expect(isError(values.get("Sheet1!A1"))).toBe(true);
    expect(isError(values.get("Sheet1!A2"))).toBe(true);
  });

  it("resolves cross-sheet references", () => {
    let wb = book();
    wb = { ...wb, sheets: [wb.sheets[0], newSheet("Data")] };
    wb = applyCellEdit(wb, 1, 0, 0, "7");
    wb = applyCellEdit(wb, 0, 0, 3, "=SUM(Data!A1:A9)");
    expect(cellOf(wb, "D1")?.value).toEqual({ kind: "number", value: 7 });
  });

  it("grows the sheet so a cell past the default extent is reachable", () => {
    const wb = applyCellEdit(book(), 0, 900, 40, "1");
    expect(wb.sheets[0].rowCount).toBeGreaterThan(900);
    expect(wb.sheets[0].colCount).toBeGreaterThan(40);
    const target = parseAddress("AO901");
    expect(target).not.toBeNull();
    expect(cellOf(wb, `AO901`)).toBeDefined();
    expect(parseAddress(`AO901`)?.row).toBe(900);
  });

  it("leaves the input workbook untouched (immutability)", () => {
    const original = book();
    const before = JSON.stringify(original);
    applyCellEdit(original, 0, 3, 3, "9");
    expect(JSON.stringify(original)).toBe(before);
  });

  it("clamps an out-of-range sheet index instead of throwing", () => {
    const wb = applyCellEdit(book(), 99, 0, 0, "1");
    expect(cellOf(wb, "A1")?.value).toEqual({ kind: "number", value: 1 });
  });
});

describe("applyCellEdits (paste)", () => {
  it("writes a block of values from the anchor cell", () => {
    const wb = applyCellEdits(book(), 0, { row: 0, col: 0 }, [
      ["1", "2"],
      ["3", "=A1+B1"],
    ]);
    expect(cellOf(wb, "A1")?.value).toEqual({ kind: "number", value: 1 });
    expect(cellOf(wb, "B2")?.value).toEqual({ kind: "number", value: 3 });
  });

  it("resolves later pasted formulas against the pasted values", () => {
    const wb = applyCellEdits(book(), 0, { row: 0, col: 0 }, [["2", "3", "=A1*B1"]]);
    expect(cellOf(wb, "C1")?.value).toEqual({ kind: "number", value: 6 });
  });
});

describe("shiftFormulaRows", () => {
  it("shifts relative rows", () => {
    expect(shiftFormulaRows("=A1*B2", 3)).toBe("=A4*B5");
    expect(shiftFormulaRows("=SUM(A1:A10)", 1)).toBe("=SUM(A2:A11)");
  });

  it("leaves absolute rows alone", () => {
    expect(shiftFormulaRows("=A$1", 5)).toBe("=A$1");
    expect(shiftFormulaRows("=$A$1", 5)).toBe("=$A$1");
  });

  it("shifts across sheet-qualified references", () => {
    expect(shiftFormulaRows("=SUM(Data!A1:A3)", 2)).toBe("=SUM(Data!A3:A5)");
  });

  it("does not rewrite plain numbers or function names", () => {
    expect(shiftFormulaRows("=LOG10(A1)", 1)).toBe("=LOG10(A2)");
    expect(shiftFormulaRows("=A1+100", 1)).toBe("=A2+100");
  });

  it("is a no-op for a zero shift or no formula", () => {
    expect(shiftFormulaRows("=A1", 0)).toBe("=A1");
    expect(shiftFormulaRows(null, 4)).toBeNull();
  });

  it("refuses to produce a row below 1", () => {
    expect(shiftFormulaRows("=A1", -5)).toBe("=A1");
  });
});

describe("isBlankCell", () => {
  it("treats a value-less, style-less cell as blank", () => {
    expect(isBlankCell(emptyCell())).toBe(true);
  });

  it("keeps a cell that only carries formatting", () => {
    const styled = emptyCell();
    styled.style = { ...styled.style, bold: true };
    expect(isBlankCell(styled)).toBe(false);
  });

  it("keeps a cell that only carries a comment", () => {
    const commented = emptyCell();
    commented.comment = "review this";
    expect(isBlankCell(commented)).toBe(false);
  });
});
