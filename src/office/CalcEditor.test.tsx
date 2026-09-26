import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression tests for the Calc editing loop. The README used to carry this as
 * a known limitation: "After committing a cell with Enter, continuing to type
 * without clicking the next cell is not yet fully reliable."
 *
 * The cause was two-fold. The grid keydown handler closed over the `editing`
 * *state*, so a keystroke that arrived in the same tick as the commit was
 * rejected by the previous render's closure; and focus was restored in a
 * passive effect, which runs after paint - a fast keystroke was dispatched to
 * `<body>` before the grid got focus back. These tests type straight after
 * Enter with no clicking in between and assert both the model and the caret
 * destination.
 */
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => null), save: vi.fn(async () => null) }));
vi.mock("@tauri-apps/plugin-fs", () => ({ readFile: vi.fn(async () => new Uint8Array()) }));

import { CalcEditor } from "./CalcEditor";
import { useOfficeTabs, type OfficeTab } from "../lib/office-store";
import { cellText, type Workbook } from "../lib/office-types";

function Harness({ id }: { id: string }) {
  const tab = useOfficeTabs((state) => state.tabs.find((candidate) => candidate.id === id));
  if (!tab) return null;
  return <CalcEditor tab={tab as OfficeTab & { model: Workbook }} />;
}

function cells(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".calc-cell"));
}

function activeCellEditor(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>(".cell-editor");
}

function workbookOf(): Workbook {
  return useOfficeTabs.getState().tabs[0].model as Workbook;
}

describe("Calc keyboard entry is reliable without clicking between cells", () => {
  beforeEach(() => {
    useOfficeTabs.setState({ tabs: [], activeId: null });
  });

  it("keeps typing into the next cell after Enter", async () => {
    const user = userEvent.setup();
    const id = useOfficeTabs.getState().create("calc", "Untitled");
    render(<Harness id={id} />);
    expect(cells().length).toBeGreaterThan(2);

    await user.click(cells()[0]);
    await user.keyboard("1");
    expect(activeCellEditor()?.value).toBe("1");

    await user.keyboard("{Enter}");
    // The grid must own focus again in the same event, so the very next
    // keystroke is not swallowed by <body>.
    expect(document.activeElement).toBe(document.querySelector(".calc-grid"));

    await user.keyboard("2");
    expect(activeCellEditor()?.value).toBe("2");
    await user.keyboard("{Enter}");

    const sheet = workbookOf().sheets[0];
    expect(cellText(sheet.cells.A1)).toBe("1");
    expect(cellText(sheet.cells.A2)).toBe("2");
  });

  it("keeps a whole run of consecutive values in one pass", async () => {
    const user = userEvent.setup();
    const id = useOfficeTabs.getState().create("calc", "Untitled");
    render(<Harness id={id} />);

    await user.click(cells()[0]);
    for (const value of ["10", "20", "30", "40"]) {
      await user.keyboard(`${value}{Enter}`);
    }

    const sheet = workbookOf().sheets[0];
    expect(cellText(sheet.cells.A1)).toBe("10");
    expect(cellText(sheet.cells.A2)).toBe("20");
    expect(cellText(sheet.cells.A3)).toBe("30");
    expect(cellText(sheet.cells.A4)).toBe("40");
  });

  it("aims the caret at the edited cell when the next entry starts with a click-free Escape", async () => {
    const user = userEvent.setup();
    const id = useOfficeTabs.getState().create("calc", "Untitled");
    render(<Harness id={id} />);

    await user.click(cells()[0]);
    await user.keyboard("5");
    await user.keyboard("{Enter}");
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{ArrowUp}");
    await user.keyboard("6{Enter}");

    const sheet = workbookOf().sheets[0];
    expect(cellText(sheet.cells.A1)).toBe("5");
    expect(cellText(sheet.cells.A2)).toBe("6");
  });

  it("moves right with Tab and commits into the neighbouring column", async () => {
    const user = userEvent.setup();
    const id = useOfficeTabs.getState().create("calc", "Untitled");
    render(<Harness id={id} />);

    await user.click(cells()[0]);
    await user.keyboard("7{Tab}");
    expect(document.activeElement).toBe(document.querySelector(".calc-grid"));
    await user.keyboard("8{Enter}");

    const sheet = workbookOf().sheets[0];
    expect(cellText(sheet.cells.A1)).toBe("7");
    expect(cellText(sheet.cells.B1)).toBe("8");
  });

  it("applies a data-bar conditional rule and scales the bar to the range maximum", async () => {
    const user = userEvent.setup();
    const id = useOfficeTabs.getState().create("calc", "Untitled");
    render(<Harness id={id} />);

    await user.click(cells()[0]);
    await user.keyboard("50{Enter}");
    await user.keyboard("10{Enter}");

    await user.click(screen.getByRole("button", { name: "Formulas" }));
    await user.click(screen.getByRole("button", { name: "Conditional formatting" }));
    const dialog = screen.getByRole("dialog");
    await user.selectOptions(within(dialog).getByRole("combobox"), "dataBar");
    await user.click(within(dialog).getByRole("button", { name: "Apply" }));

    const rules = workbookOf().sheets[0].conditional;
    expect(rules.at(-1)?.kind).toBe("dataBar");
    const bar = document.querySelector<HTMLElement>(".data-bar");
    expect(bar).not.toBeNull();
    expect(bar!.style.width).toBe("100%");
  });

  it("highlights only the cells a greater-than rule matches", async () => {
    const user = userEvent.setup();
    const id = useOfficeTabs.getState().create("calc", "Untitled");
    render(<Harness id={id} />);

    await user.click(cells()[0]);
    await user.keyboard("50{Enter}");
    await user.keyboard("10{Enter}");

    await user.click(screen.getByRole("button", { name: "Formulas" }));
    await user.click(screen.getByRole("button", { name: "Conditional formatting" }));
    const dialog = screen.getByRole("dialog");
    const valueField = within(dialog).getByRole("textbox", { name: "Value" });
    await user.clear(valueField);
    await user.type(valueField, "20");
    await user.click(within(dialog).getByRole("button", { name: "Apply" }));

    // A1 (50) matches, A2 (10) does not.
    expect(cells()[0].style.background).not.toBe("");
    expect(cells()[1].style.background).toBe("");
  });

  it("commits a formula from the formula bar and continues on the grid", async () => {
    const user = userEvent.setup();
    const id = useOfficeTabs.getState().create("calc", "Untitled");
    render(<Harness id={id} />);

    await user.click(cells()[0]);
    await user.keyboard("2{Enter}");
    await user.keyboard("3{Enter}");

    // After two Enter commits the selection is already on A3.
    const formulaBar = document.querySelector<HTMLInputElement>(".formula-input");
    expect(formulaBar).not.toBeNull();
    await user.click(formulaBar!);
    await user.keyboard("=SUM(A1:A2){Enter}");

    expect(document.activeElement).toBe(document.querySelector(".calc-grid"));
    const sheet = workbookOf().sheets[0];
    expect(sheet.cells.A3?.formula).toBe("=SUM(A1:A2)");
    // The cached result must reflect the edit, not the pre-edit workbook.
    expect(sheet.cells.A3?.value).toEqual({ kind: "number", value: 5 });

    expect(document.querySelector<HTMLInputElement>(".name-box")?.value).toBe("A4");
    await user.keyboard("9{Enter}");
    expect(document.querySelector<HTMLInputElement>(".name-box")?.value).toBe("A5");
    expect(cellText(workbookOf().sheets[0].cells.A4)).toBe("9");
  });
});
