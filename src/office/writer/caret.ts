/**
 * Caret helpers for the Writer's contentEditable paragraphs.
 *
 * The editor keeps the browser in charge of the caret so native typing, IME and
 * the clipboard keep working. Structural keys (Enter, Backspace, Tab, arrows at
 * a paragraph edge) need to know *where* the caret is in plain-text terms, and
 * need to put it back afterwards, so that logic is isolated here.
 */
import { runsToHtml } from "./writerDom";

/** Reads the caret offset of a contentEditable element as a plain-text index. */
export function caretOffset(element: HTMLElement): number {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return element.textContent?.length ?? 0;
  const range = selection.getRangeAt(0);
  if (!element.contains(range.startContainer)) return 0;

  const probe = range.cloneRange();
  probe.selectNodeContents(element);
  probe.setEnd(range.startContainer, range.startOffset);
  return probe.toString().length;
}

/** True when the selection covers more than a collapsed caret. */
export function hasSelection(element: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return false;
  return element.contains(selection.anchorNode);
}

/** Selected plain-text range inside the element, or null when collapsed. */
export function selectedRange(element: HTMLElement): [number, number] | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) return null;
  const probe = range.cloneRange();
  probe.selectNodeContents(element);
  probe.setEnd(range.startContainer, range.startOffset);
  const start = probe.toString().length;
  return [start, start + range.toString().length];
}

/** True when the caret sits on the first visual line of the element. */
export function caretOnFirstLine(element: HTMLElement): boolean {
  const offset = caretOffset(element);
  const prefix = (element.textContent ?? "").slice(0, offset);
  return !prefix.includes("\n");
}

/** True when the caret sits on the last visual line of the element. */
export function caretOnLastLine(element: HTMLElement): boolean {
  const offset = caretOffset(element);
  const text = element.textContent ?? "";
  return !text.slice(offset).includes("\n");
}

/** Puts a collapsed caret at a plain-text offset, replacing the selection. */
export function setCaretOffset(element: HTMLElement, offset: number): void {
  const selection = window.getSelection();
  if (!selection) return;
  const textNode = findTextNodeAt(element, Math.max(0, offset));
  if (!textNode) {
    element.focus();
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(offset <= 0);
    selection.removeAllRanges();
    selection.addRange(range);
    return;
  }
  const range = document.createRange();
  range.setStart(textNode.node, textNode.offset);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

/** Selects a plain-text range inside the element. */
export function setSelectionRange(element: HTMLElement, from: number, to: number): void {
  const selection = window.getSelection();
  if (!selection) return;
  const start = findTextNodeAt(element, Math.max(0, Math.min(from, to)));
  const end = findTextNodeAt(element, Math.max(from, to));
  if (!start || !end) {
    setCaretOffset(element, to);
    return;
  }
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  selection.removeAllRanges();
  selection.addRange(range);
}

/** Walks the text nodes of an element to find the node holding `offset`. */
function findTextNodeAt(element: HTMLElement, offset: number): { node: Text; offset: number } | null {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  let last: Text | null = null;
  let node = walker.nextNode() as Text | null;
  while (node) {
    const length = node.textContent?.length ?? 0;
    if (remaining <= length) return { node, offset: remaining };
    remaining -= length;
    last = node;
    node = walker.nextNode() as Text | null;
  }
  if (last) return { node: last, offset: last.textContent?.length ?? 0 };
  return null;
}

/**
 * Replaces the inner HTML of a paragraph after a structural change.
 *
 * Called *after* React has committed the new model, so the imperative write
 * cannot race the render the way the typing path can.
 */
export function repaintParagraph(element: HTMLElement, runs: Parameters<typeof runsToHtml>[0]): void {
  const html = runsToHtml(runs);
  if (element.innerHTML !== html) element.innerHTML = html;
}
