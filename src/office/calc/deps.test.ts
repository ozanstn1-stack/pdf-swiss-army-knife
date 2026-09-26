/**
 * Dependency-graph and dynamic-array tests.
 *
 * V2.5 replaced the "evaluate every formula from scratch on every change"
 * pass with a dependency graph: an edit recalculates the edited cell and the
 * formulas that (transitively) read it, and nothing else. Dynamic arrays spill
 * their extra cells into the grid, and a blocked spill range is `#SPILL!`.
 */
import { describe, expect, it } from "vitest";
import { newSheet, newWorkbook, type Workbook } from "../../lib/office-types";
import {
  applyCellEdit,
  computeSheetValues,
  computeWorkbookValues,
  dependencyGraph,
  lastComputeStats,
  spillTargetsOf,
} from "./cells";
import { isError } from "./formula";

function book(): Workbook {
  const workbook = newWorkbook("Deps");
  return { ...workbook, sheets: [newSheet("Sheet1")] };
}

function withData(rows: Array<[string, string]>): Workbook {
  let workbook = book();
  for (const [address, input] of rows) {
    const position = address.match(/^([A-Z]+)(\d+)$/)!;
    const column = position[1].split("").reduce((sum, letter) => sum * 26 + letter.charCodeAt(0) - 64, 0) - 1;
    workbook = applyCellEdit(workbook, 0, Number(position[2]) - 1, column, input);
  }
  return workbook;
}

function value(workbook: Workbook, address: string) {
  return computeSheetValues(workbook, workbook.sheets[0]).get(address);
}

describe("incremental recalculation", () => {
  it("recalculates the edited cell and its dependents only", () => {
    let workbook = withData([
      ["A1", "10"],
      ["A2", "20"],
      ["A3", "=A1+A2"],
      ["B1", "=A3*2"],
      ["B2", "=SUM(A1:A3)"],
      ["C1", "=999"],
    ]);
    expect(computeWorkbookValues(workbook).get("Sheet1!A3")).toBe(30);
    expect(lastComputeStats(workbook)?.mode).toBe("full");

    workbook = applyCellEdit(workbook, 0, 0, 0, "11");
    computeWorkbookValues(workbook);
    const stats = lastComputeStats(workbook);
    expect(stats?.mode).toBe("incremental");
    // A3, B1 and B2 read A1 (directly or through A3); C1 does not.
    expect(stats?.recomputed).toBe(3);
    expect(value(workbook, "A1")).toBe(11);
    expect(value(workbook, "A3")).toBe(31);
    expect(value(workbook, "B1")).toBe(62);
    expect(value(workbook, "B2")).toBe(62);
    expect(value(workbook, "C1")).toBe(999);
  });

  it("follows cross-sheet dependencies", () => {
    let workbook = book();
    workbook = { ...workbook, sheets: [workbook.sheets[0], newSheet("Data")] };
    workbook = applyCellEdit(workbook, 1, 0, 0, "5");
    workbook = applyCellEdit(workbook, 0, 0, 0, "=Data!A1*3");
    expect(computeWorkbookValues(workbook).get("Sheet1!A1")).toBe(15);
    workbook = applyCellEdit(workbook, 1, 0, 0, "7");
    const values = computeWorkbookValues(workbook);
    expect(values.get("Sheet1!A1")).toBe(21);
    expect(lastComputeStats(workbook)?.mode).toBe("incremental");
  });

  it("recalculates a chain through several levels", () => {
    let workbook = withData([
      ["A1", "1"],
      ["B1", "=A1+1"],
      ["C1", "=B1+1"],
      ["D1", "=C1+1"],
      ["E1", "=D1+1"],
    ]);
    computeWorkbookValues(workbook);
    workbook = applyCellEdit(workbook, 0, 0, 0, "10");
    const values = computeWorkbookValues(workbook);
    expect(values.get("Sheet1!E1")).toBe(14);
    expect(lastComputeStats(workbook)?.recomputed).toBe(4);
  });

  it("keeps circular references an error after an incremental edit", () => {
    let workbook = withData([
      ["A1", "=A2"],
      ["A2", "=A1"],
      ["B1", "7"],
    ]);
    computeWorkbookValues(workbook);
    workbook = applyCellEdit(workbook, 0, 0, 1, "8");
    const values = computeWorkbookValues(workbook);
    expect(isError(values.get("Sheet1!A1"))).toBe(true);
    expect(isError(values.get("Sheet1!A2"))).toBe(true);
    expect(values.get("Sheet1!B1")).toBe(8);
  });

  it("recalculates formulas that read a range when a member cell changes", () => {
    let workbook = withData([
      ["A1", "1"],
      ["A2", "2"],
      ["A3", "3"],
      ["B1", "=SUM(A1:A3)"],
    ]);
    computeWorkbookValues(workbook);
    workbook = applyCellEdit(workbook, 0, 1, 0, "20");
    expect(computeWorkbookValues(workbook).get("Sheet1!B1")).toBe(24);
  });

  it("recalculates volatile formulas on every change", () => {
    let workbook = withData([
      ["A1", "1"],
      ["B1", "=NOW()"],
    ]);
    const first = computeWorkbookValues(workbook).get("Sheet1!B1");
    workbook = applyCellEdit(workbook, 0, 0, 0, "2");
    const second = computeWorkbookValues(workbook).get("Sheet1!B1");
    expect(typeof first).toBe("number");
    expect(typeof second).toBe("number");
    // The value is always the current time, so it can never go backwards.
    expect(second as number).toBeGreaterThanOrEqual(first as number);
  });

  it("falls back to a full pass when a formula stops being a formula", () => {
    let workbook = withData([
      ["A1", "=1+1"],
      ["B1", "=A1*5"],
    ]);
    expect(computeWorkbookValues(workbook).get("Sheet1!B1")).toBe(10);
    workbook = applyCellEdit(workbook, 0, 0, 0, "4");
    const values = computeWorkbookValues(workbook);
    expect(values.get("Sheet1!A1")).toBe(4);
    expect(values.get("Sheet1!B1")).toBe(20);
  });

  it("reports precedents and dependents for the auditing UI", () => {
    const workbook = withData([
      ["A1", "1"],
      ["A2", "2"],
      ["B1", "=A1+A2"],
      ["C1", "=B1*2"],
    ]);
    computeWorkbookValues(workbook);
    const graph = dependencyGraph(workbook);
    expect([...(graph.precedents.get("Sheet1!B1") ?? [])].sort()).toEqual(["Sheet1!A1", "Sheet1!A2"]);
    expect([...(graph.dependents.get("Sheet1!A1") ?? [])]).toEqual(["Sheet1!B1"]);
    expect([...(graph.dependents.get("Sheet1!B1") ?? [])]).toEqual(["Sheet1!C1"]);
  });
});

describe("dynamic arrays", () => {
  it("spills SEQUENCE down from the source cell", () => {
    const workbook = withData([["A1", "=SEQUENCE(4)"]]);
    const values = computeWorkbookValues(workbook);
    expect(values.get("Sheet1!A1")).toBe(1);
    expect(values.get("Sheet1!A2")).toBe(2);
    expect(values.get("Sheet1!A3")).toBe(3);
    expect(values.get("Sheet1!A4")).toBe(4);
    expect(spillTargetsOf(workbook, "Sheet1", "A1")).toEqual(["Sheet1!A2", "Sheet1!A3", "Sheet1!A4"]);
  });

  it("spills FILTER across the grid", () => {
    const workbook = withData([
      ["A1", "1"],
      ["A2", "5"],
      ["A3", "2"],
      ["C1", "=FILTER(A1:A3,A1:A3>1)"],
    ]);
    const values = computeWorkbookValues(workbook);
    expect(values.get("Sheet1!C1")).toBe(5);
    expect(values.get("Sheet1!C2")).toBe(2);
  });

  it("reports #SPILL! when a target cell already has data", () => {
    const workbook = withData([
      ["A1", "=SEQUENCE(4)"],
      ["A3", "blocked"],
    ]);
    const values = computeWorkbookValues(workbook);
    expect(isError(values.get("Sheet1!A1"))).toBe(true);
    expect((values.get("Sheet1!A1") as { code: string }).code).toBe("#SPILL!");
    expect(values.get("Sheet1!A3")).toBe("blocked");
  });

  it("reports #SPILL! on the blocked array and lets the free one spill", () => {
    const workbook = withData([
      ["A1", "=SEQUENCE(5)"],
      ["A2", "=SEQUENCE(3)"],
    ]);
    const values = computeWorkbookValues(workbook);
    // A1's spill range includes A2, which has a formula: A1 cannot expand.
    expect((values.get("Sheet1!A1") as { code: string }).code).toBe("#SPILL!");
    // A2 spills down into the cells A1 could not claim.
    expect(values.get("Sheet1!A2")).toBe(1);
    expect(values.get("Sheet1!A3")).toBe(2);
    expect(values.get("Sheet1!A4")).toBe(3);
  });

  it("lets other formulas read spilled cells and refresh them after an edit", () => {
    let workbook = withData([
      ["A1", "=SEQUENCE(3)"],
      ["D1", "=SUM(A1:A5)"],
    ]);
    expect(computeWorkbookValues(workbook).get("Sheet1!D1")).toBe(6);
    workbook = applyCellEdit(workbook, 0, 0, 0, "=SEQUENCE(5)");
    // The workbook carries spills, so the edit runs a full pass with the new
    // spill extents; the sum must follow the array.
    expect(computeWorkbookValues(workbook).get("Sheet1!D1")).toBe(15);
  });

  it("frees the spill range when the array shrinks", () => {
    let workbook = withData([["A1", "=SEQUENCE(4)"]]);
    expect(computeWorkbookValues(workbook).get("Sheet1!A4")).toBe(4);
    workbook = applyCellEdit(workbook, 0, 0, 0, "=SEQUENCE(2)");
    const values = computeWorkbookValues(workbook);
    expect(values.get("Sheet1!A2")).toBe(2);
    // The old target cells are gone, not stale numbers.
    expect(values.get("Sheet1!A3") ?? "").toBe("");
    expect(values.get("Sheet1!A4") ?? "").toBe("");
  });
});
