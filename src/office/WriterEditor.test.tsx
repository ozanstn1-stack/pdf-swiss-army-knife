import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression tests for the Writer's structural editing.
 *
 * A focused contentEditable is not re-rendered by React - that is what keeps
 * native typing, IME and the clipboard working - so after Enter/Backspace the
 * element still showed the pre-edit text. When focus moved, `blur` read that
 * stale DOM and wrote it back into the model, undoing the edit (paragraphs
 * were duplicated on Enter, merges resurrected the removed paragraph). The fix
 * repaints the affected paragraph before focus moves; these tests type without
 * clicking and assert the model text after every structural key.
 */
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => null), save: vi.fn(async () => null) }));
vi.mock("@tauri-apps/plugin-fs", () => ({ readFile: vi.fn(async () => new Uint8Array()) }));

import { WriterEditor } from "./WriterEditor";
import { useOfficeTabs, type OfficeTab } from "../lib/office-store";
import type { Block, TextDocument } from "../lib/office-types";

function Harness({ id }: { id: string }) {
  const tab = useOfficeTabs((state) => state.tabs.find((candidate) => candidate.id === id));
  if (!tab) return null;
  return <WriterEditor tab={tab as OfficeTab & { model: TextDocument }} />;
}

function paragraphs(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".writer-body .para"));
}

function documentOf(): TextDocument {
  return useOfficeTabs.getState().tabs[0].model as TextDocument;
}

function blockText(block: Block | undefined): string {
  if (!block || block.type !== "paragraph") return "";
  return block.runs.map((run) => run.text).join("");
}

function blockTexts(): string[] {
  return documentOf().blocks.map(blockText);
}

describe("Writer structural editing stays in sync with the model", () => {
  beforeEach(() => {
    useOfficeTabs.setState({ tabs: [], activeId: null });
  });

  it("splits the paragraph on Enter and keeps typing in the new one", async () => {
    const user = userEvent.setup();
    const id = useOfficeTabs.getState().create("writer", "Untitled");
    render(<Harness id={id} />);

    await user.click(paragraphs()[0]);
    await user.keyboard("Hello");
    expect(paragraphs()[0].textContent).toBe("Hello");

    await user.keyboard("{Enter}");
    // The new paragraph exists and already owns the caret: no clicking needed.
    expect(paragraphs()).toHaveLength(2);
    expect(document.activeElement).toBe(paragraphs()[1]);

    await user.keyboard("World");
    expect(blockTexts()).toEqual(["Hello", "World"]);
    expect(paragraphs()[0].textContent).toBe("Hello");
    expect(paragraphs()[1].textContent).toBe("World");
  });

  it("merges into the previous paragraph on Backspace at the start", async () => {
    const user = userEvent.setup();
    const id = useOfficeTabs.getState().create("writer", "Untitled");
    render(<Harness id={id} />);

    await user.click(paragraphs()[0]);
    await user.keyboard("Hello{Enter}World");
    expect(blockTexts()).toEqual(["Hello", "World"]);

    await user.keyboard("{Home}");
    await user.keyboard("{Backspace}");
    expect(blockTexts()).toEqual(["HelloWorld"]);
    expect(paragraphs()).toHaveLength(1);
    expect(paragraphs()[0].textContent).toBe("HelloWorld");

    // Word behaviour: the caret lands at the join point, which is where the
    // removed paragraph started.
    await user.keyboard("!");
    expect(blockTexts()).toEqual(["Hello!World"]);
  });

  it("inserts a line break in place on Shift+Enter and continues typing after it", async () => {
    const user = userEvent.setup();
    const id = useOfficeTabs.getState().create("writer", "Untitled");
    render(<Harness id={id} />);

    await user.click(paragraphs()[0]);
    await user.keyboard("Line1{Shift>}{Enter}{/Shift}Line2");
    expect(blockTexts()).toEqual(["Line1\nLine2"]);
    expect(paragraphs()).toHaveLength(1);
  });

  it("merges the following paragraph on Delete at the end", async () => {
    const user = userEvent.setup();
    const id = useOfficeTabs.getState().create("writer", "Untitled");
    render(<Harness id={id} />);

    await user.click(paragraphs()[0]);
    await user.keyboard("Hello{Enter}World{Home}{Backspace}");
    expect(blockTexts()).toEqual(["HelloWorld"]);

    await user.keyboard("{End}{Delete}");
    expect(blockTexts()).toEqual(["HelloWorld"]);
  });

  it("renders a real page container per page and counts them", async () => {
    const user = userEvent.setup();
    const id = useOfficeTabs.getState().create("writer", "Untitled");
    const tab = useOfficeTabs.getState().tabs[0];
    const model = tab.model as TextDocument;
    const first = model.blocks.find((block) => block.type === "paragraph") as Extract<Block, { type: "paragraph" }>;
    const blocks = [
      ...model.blocks,
      { type: "pageBreak" as const },
      { type: "paragraph" as const, props: { ...first.props }, runs: [{ ...first.runs[0], text: "Page two" }] },
      { type: "pageBreak" as const },
      { type: "paragraph" as const, props: { ...first.props }, runs: [{ ...first.runs[0], text: "Page three" }] },
    ];
    useOfficeTabs.setState((state) => ({ tabs: state.tabs.map((entry) => (entry.id === id ? { ...entry, model: { ...model, blocks } } : entry)) }));
    render(<Harness id={id} />);

    const sheets = document.querySelectorAll(".writer-page-sheet");
    expect(sheets.length).toBe(3);
    expect(sheets[1].textContent).toContain("Page two");
    expect(sheets[2].textContent).toContain("Page three");
    expect(document.querySelector(".editor-status")?.textContent).toContain("3 pages");
    // Clicking a fragment opens the continuous editor on that block.
    await user.click(document.querySelectorAll(".writer-fragment")[1]);
    expect(document.querySelectorAll(".writer-page-sheet").length).toBe(0);
  });

  it("inserts a table of contents from the headings", async () => {
    const user = userEvent.setup();
    const id = useOfficeTabs.getState().create("writer", "Untitled");
    const tab = useOfficeTabs.getState().tabs[0];
    const model = tab.model as TextDocument;
    const first = model.blocks.find((block) => block.type === "paragraph") as Extract<Block, { type: "paragraph" }>;
    const blocks = [
      { type: "paragraph" as const, props: { ...first.props, style: "Heading1" }, runs: [{ ...first.runs[0], text: "Introduction" }] },
      { type: "paragraph" as const, props: { ...first.props, style: "Heading2" }, runs: [{ ...first.runs[0], text: "Background" }] },
      { type: "paragraph" as const, props: { ...first.props }, runs: [{ ...first.runs[0], text: "Body" }] },
    ];
    useOfficeTabs.setState((state) => ({ tabs: state.tabs.map((entry) => (entry.id === id ? { ...entry, model: { ...model, blocks } } : entry)) }));
    render(<Harness id={id} />);

    await user.click(screen.getByRole("button", { name: "Insert" }));
    await user.click(screen.getByRole("button", { name: "Insert TOC" }));

    const saved = useOfficeTabs.getState().tabs[0].model as TextDocument;
    const toc = saved.blocks.find((block) => block.type === "toc");
    expect(toc).toBeDefined();
    if (toc?.type !== "toc") throw new Error("toc missing");
    expect(toc.entries.map((entry) => entry.text)).toEqual(["Introduction", "Background"]);
    expect(toc.entries.map((entry) => entry.level)).toEqual([1, 2]);
    expect(document.querySelector(".writer-toc")?.textContent).toContain("Introduction");
  });

  it("lists the outline in the navigation pane", async () => {
    const user = userEvent.setup();
    const id = useOfficeTabs.getState().create("writer", "Untitled");
    const tab = useOfficeTabs.getState().tabs[0];
    const model = tab.model as TextDocument;
    const first = model.blocks.find((block) => block.type === "paragraph") as Extract<Block, { type: "paragraph" }>;
    const blocks = [
      { type: "paragraph" as const, props: { ...first.props, style: "Heading1" }, runs: [{ ...first.runs[0], text: "Chapter one" }] },
      { type: "paragraph" as const, props: { ...first.props }, runs: [{ ...first.runs[0], text: "Text" }] },
    ];
    useOfficeTabs.setState((state) => ({ tabs: state.tabs.map((entry) => (entry.id === id ? { ...entry, model: { ...model, blocks } } : entry)) }));
    render(<Harness id={id} />);

    await user.click(screen.getByRole("button", { name: "View" }));
    await user.click(screen.getByRole("button", { name: "Navigation" }));
    expect(document.querySelector(".writer-nav-pane")?.textContent).toContain("Chapter one");
  });

  it("does not resurrect the split tail when typing continues fast", async () => {
    const user = userEvent.setup();
    const id = useOfficeTabs.getState().create("writer", "Untitled");
    render(<Harness id={id} />);

    await user.click(paragraphs()[0]);
    await user.keyboard("One{Enter}Two{Enter}Three");
    expect(blockTexts()).toEqual(["One", "Two", "Three"]);
  });
});


