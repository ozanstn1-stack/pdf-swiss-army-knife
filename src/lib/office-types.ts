/**
 * TypeScript mirrors of the office document model (crates/officecore/src/model.rs).
 * Field names are camelCase and match the Rust serde output exactly.
 */

export type OfficeKind = "writer" | "calc" | "impress";

export interface DocMetadata {
  title: string;
  author: string;
  subject: string;
  keywords: string;
  creator: string;
  lastModifiedBy: string;
  created: string;
  modified: string;
}

export interface ImageData {
  name: string;
  mime: string;
  dataBase64: string;
  alt: string;
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

export interface PageSetup {
  size: string;
  widthPt: number;
  heightPt: number;
  orientation: string;
  marginTopPt: number;
  marginRightPt: number;
  marginBottomPt: number;
  marginLeftPt: number;
  columns: number;
  columnSpacingPt: number;
  headerDistancePt: number;
  footerDistancePt: number;
  differentFirstPage: boolean;
}

export interface ParaStyle {
  id: string;
  name: string;
  basedOn: string | null;
  next: string | null;
  font: string | null;
  sizePt: number | null;
  bold: boolean | null;
  italic: boolean | null;
  underline: boolean | null;
  strike: boolean | null;
  color: string | null;
  highlight: string | null;
  align: string | null;
  lineSpacing: number | null;
  spaceBeforePt: number | null;
  spaceAfterPt: number | null;
  indentLeftPt: number | null;
  indentRightPt: number | null;
  firstLinePt: number | null;
  outlineLevel: number | null;
  keepWithNext: boolean | null;
  pageBreakBefore: boolean | null;
}

export interface ListInfo {
  kind: "bullet" | "number" | string;
  level: number;
  start: number;
  marker: string;
}

export interface ParaProps {
  style: string;
  align: string;
  lineSpacing: number;
  spaceBeforePt: number;
  spaceAfterPt: number;
  indentLeftPt: number;
  indentRightPt: number;
  firstLinePt: number;
  list: ListInfo | null;
  pageBreakBefore: boolean;
}

export interface Run {
  text: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  color: string | null;
  highlight: string | null;
  font: string | null;
  sizePt: number | null;
  link: string | null;
  comment: string | null;
  superscript: boolean;
  subscript: boolean;
}

export interface TableCell {
  blocks: Block[];
  colspan: number;
  rowspan: number;
  background: string | null;
  align: string;
  valign: string;
  widthPt: number | null;
}

export interface TableRow {
  cells: TableCell[];
  heightPt: number | null;
  header: boolean;
}

export interface TableData {
  rows: TableRow[];
  columnWidthsPt: number[];
  borders: boolean;
  borderColor: string;
  align: string;
}

export type Block =
  | { type: "paragraph"; props: ParaProps; runs: Run[] }
  | { type: "table"; table: TableData }
  | { type: "image"; image: ImageData; widthPt: number; heightPt: number; align: string; caption: string }
  | { type: "pageBreak" }
  | { type: "rule" };

export interface DocComment {
  id: string;
  author: string;
  text: string;
  created: string;
  resolved: boolean;
}

export interface TextDocument {
  id: string;
  title: string;
  page: PageSetup;
  styles: ParaStyle[];
  blocks: Block[];
  header: Block[];
  footer: Block[];
  comments: DocComment[];
  metadata: DocMetadata;
}

// ---------------------------------------------------------------------------
// Calc
// ---------------------------------------------------------------------------

export type CellValue =
  | { kind: "empty" }
  | { kind: "number"; value: number }
  | { kind: "text"; value: string }
  | { kind: "bool"; value: boolean }
  | { kind: "error"; value: string };

export interface BorderStyle {
  style: string;
  color: string;
}

export interface CellBorders {
  top: BorderStyle | null;
  right: BorderStyle | null;
  bottom: BorderStyle | null;
  left: BorderStyle | null;
}

export interface CellStyle {
  font: string | null;
  sizePt: number | null;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  color: string | null;
  fill: string | null;
  align: string;
  valign: string;
  wrap: boolean;
  rotation: number;
  borders: CellBorders;
  numberFormat: string;
}

export interface Cell {
  value: CellValue;
  formula: string | null;
  style: CellStyle;
  comment: string | null;
}

export interface MergeRange {
  start: string;
  end: string;
}

export interface ChartSeries {
  name: string;
  range: string;
  color: string | null;
}

export interface ChartData {
  kind: string;
  title: string;
  categories: string;
  series: ChartSeries[];
  legend: boolean;
  xTitle: string;
  yTitle: string;
  stacked: boolean;
  showLabels: boolean;
}

export interface ChartPlacement {
  id: string;
  chart: ChartData;
  anchor: string;
  widthPx: number;
  heightPx: number;
}

export interface CondRule {
  id: string;
  range: string;
  kind: string;
  values: string[];
  fill: string | null;
  color: string | null;
  topN: number | null;
  stopIfTrue: boolean;
}

export interface Validation {
  id: string;
  range: string;
  kind: string;
  values: string[];
  min: number | null;
  max: number | null;
  message: string;
  allowBlank: boolean;
}

export interface FilterState {
  range: string;
  column: number;
  values: string[];
}

export interface Sheet {
  id: string;
  name: string;
  rowCount: number;
  colCount: number;
  cells: Record<string, Cell>;
  colWidths: Record<string, number>;
  rowHeights: Record<string, number>;
  merges: MergeRange[];
  freezeRows: number;
  freezeCols: number;
  charts: ChartPlacement[];
  conditional: CondRule[];
  validations: Validation[];
  filter: FilterState | null;
  showGridlines: boolean;
  tabColor: string | null;
}

export interface Workbook {
  id: string;
  title: string;
  sheets: Sheet[];
  activeSheet: number;
  metadata: DocMetadata;
}

// ---------------------------------------------------------------------------
// Impress
// ---------------------------------------------------------------------------

export interface SlideSize {
  preset: string;
  widthPt: number;
  heightPt: number;
}

export interface TextParagraph {
  text: string;
  level: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  sizePt: number | null;
  color: string | null;
  align: string;
  bullet: boolean;
  runs: Run[];
}

export interface TextFrame {
  paragraphs: TextParagraph[];
  valign: string;
  font: string | null;
  sizePt: number | null;
  color: string | null;
  align: string;
}

export interface ShapeStyle {
  fill: string | null;
  stroke: string | null;
  strokeWidthPt: number;
  opacity: number;
  cornerRadiusPt: number;
  shadow: boolean;
}

export interface LineSpec {
  x2: number;
  y2: number;
  beginArrow: boolean;
  endArrow: boolean;
  dash: string;
}

export interface SlideObject {
  id: string;
  kind: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  z: number;
  text: TextFrame | null;
  image: ImageData | null;
  style: ShapeStyle | null;
  line: LineSpec | null;
  table: TableData | null;
  chart: ChartData | null;
  groupId: string | null;
  name: string;
}

export interface Slide {
  id: string;
  layout: string;
  background: string | null;
  transition: string | null;
  transitionMs: number;
  objects: SlideObject[];
  notes: string;
}

export interface Deck {
  id: string;
  title: string;
  size: SlideSize;
  theme: string;
  slides: Slide[];
  metadata: DocMetadata;
}

// ---------------------------------------------------------------------------
// Factories and defaults
// ---------------------------------------------------------------------------

export function uid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `id-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

export function emptyMetadata(): DocMetadata {
  return { title: "", author: "", subject: "", keywords: "", creator: "", lastModifiedBy: "", created: "", modified: "" };
}

export const PLATFORM_FONT = "'Segoe UI', 'PT Sans', Calibri, sans-serif";

export function defaultStyles(): ParaStyle[] {
  const style = (partial: Partial<ParaStyle> & { id: string; name: string }): ParaStyle => ({
    basedOn: null,
    next: null,
    font: "Calibri",
    sizePt: 11,
    bold: null,
    italic: null,
    underline: null,
    strike: null,
    color: "#1f2328",
    highlight: null,
    align: null,
    lineSpacing: null,
    spaceBeforePt: null,
    spaceAfterPt: 8,
    indentLeftPt: null,
    indentRightPt: null,
    firstLinePt: null,
    outlineLevel: null,
    keepWithNext: null,
    pageBreakBefore: null,
    ...partial,
    id: partial.id,
    name: partial.name,
  });
  return [
    style({ id: "Normal", name: "Normal", lineSpacing: 1.15, spaceAfterPt: 8 }),
    style({ id: "Title", name: "Title", font: "Calibri Light", sizePt: 28, bold: true, color: "#0f172a", spaceAfterPt: 6, next: "Subtitle" }),
    style({ id: "Subtitle", name: "Subtitle", sizePt: 15, italic: true, color: "#475569", spaceAfterPt: 14, next: "Normal" }),
    style({ id: "Heading1", name: "Heading 1", font: "Calibri Light", sizePt: 20, bold: true, color: "#1d4ed8", spaceBeforePt: 16, spaceAfterPt: 4, outlineLevel: 0, keepWithNext: true, next: "Normal" }),
    style({ id: "Heading2", name: "Heading 2", font: "Calibri Light", sizePt: 16, bold: true, color: "#334155", spaceBeforePt: 12, spaceAfterPt: 4, outlineLevel: 1, keepWithNext: true, next: "Normal" }),
    style({ id: "Heading3", name: "Heading 3", font: "Calibri Light", sizePt: 13, bold: true, color: "#334155", spaceBeforePt: 12, spaceAfterPt: 4, outlineLevel: 2, keepWithNext: true, next: "Normal" }),
    style({ id: "Quote", name: "Quote", italic: true, color: "#334155", indentLeftPt: 24, indentRightPt: 24, spaceBeforePt: 8, spaceAfterPt: 8 }),
    style({ id: "Caption", name: "Caption", sizePt: 9.5, italic: true, align: "center", color: "#64748b" }),
    style({ id: "Code", name: "Code", font: "Consolas", sizePt: 10, spaceAfterPt: 0 }),
  ];
}

export function defaultParaProps(styleId = "Normal"): ParaProps {
  return {
    style: styleId,
    align: "left",
    lineSpacing: 1.15,
    spaceBeforePt: 0,
    spaceAfterPt: 8,
    indentLeftPt: 0,
    indentRightPt: 0,
    firstLinePt: 0,
    list: null,
    pageBreakBefore: false,
  };
}

export function defaultRun(text = ""): Run {
  return {
    text,
    bold: false,
    italic: false,
    underline: false,
    strike: false,
    color: null,
    highlight: null,
    font: null,
    sizePt: null,
    link: null,
    comment: null,
    superscript: false,
    subscript: false,
  };
}

export function defaultPageSetup(size = "a4", orientation = "portrait"): PageSetup {
  const sizes: Record<string, [number, number]> = {
    a4: [595.28, 841.89],
    a5: [419.53, 595.28],
    letter: [612, 792],
    legal: [612, 1008],
    a3: [841.89, 1190.55],
  };
  const [width, height] = sizes[size] ?? sizes.a4;
  const landscape = orientation === "landscape";
  return {
    size,
    widthPt: landscape ? height : width,
    heightPt: landscape ? width : height,
    orientation,
    marginTopPt: 72,
    marginRightPt: 72,
    marginBottomPt: 72,
    marginLeftPt: 72,
    columns: 1,
    columnSpacingPt: 24,
    headerDistancePt: 36,
    footerDistancePt: 36,
    differentFirstPage: false,
  };
}

export function newTextDocument(title = "Untitled document"): TextDocument {
  return {
    id: uid(),
    title,
    page: defaultPageSetup(),
    styles: defaultStyles(),
    blocks: [{ type: "paragraph", props: defaultParaProps(), runs: [defaultRun()] }],
    header: [],
    footer: [],
    comments: [],
    metadata: { ...emptyMetadata(), title },
  };
}

export function defaultCellStyle(): CellStyle {
  return {
    font: null,
    sizePt: 11,
    bold: false,
    italic: false,
    underline: false,
    strike: false,
    color: null,
    fill: null,
    align: "general",
    valign: "bottom",
    wrap: false,
    rotation: 0,
    borders: { top: null, right: null, bottom: null, left: null },
    numberFormat: "General",
  };
}

export function emptyCell(): Cell {
  return { value: { kind: "empty" }, formula: null, style: defaultCellStyle(), comment: null };
}

export function cellText(cell: Cell | undefined): string {
  if (!cell) return "";
  if (cell.formula) return cell.formula;
  switch (cell.value.kind) {
    case "number":
      return String(cell.value.value);
    case "text":
      return cell.value.value;
    case "bool":
      return cell.value.value ? "TRUE" : "FALSE";
    case "error":
      return cell.value.value;
    default:
      return "";
  }
}

export function newSheet(name: string): Sheet {
  return {
    id: uid(),
    name,
    rowCount: 200,
    colCount: 26,
    cells: {},
    colWidths: {},
    rowHeights: {},
    merges: [],
    freezeRows: 0,
    freezeCols: 0,
    charts: [],
    conditional: [],
    validations: [],
    filter: null,
    showGridlines: true,
    tabColor: null,
  };
}

export function newWorkbook(title = "Untitled spreadsheet"): Workbook {
  return {
    id: uid(),
    title,
    sheets: [newSheet("Sheet1")],
    activeSheet: 0,
    metadata: { ...emptyMetadata(), title },
  };
}

export function newTextFrame(text: string, sizePt = 18): TextFrame {
  return {
    paragraphs: [{ text, level: 0, bold: false, italic: false, underline: false, sizePt, color: null, align: "left", bullet: false, runs: [] }],
    valign: "top",
    font: null,
    sizePt,
    color: null,
    align: "left",
  };
}

export function newSlideObject(kind: string, x: number, y: number, w: number, h: number): SlideObject {
  return {
    id: uid(),
    kind,
    x,
    y,
    w,
    h,
    rotation: 0,
    z: 1,
    text: null,
    image: null,
    style: { fill: kind === "rect" || kind === "ellipse" ? "#2563eb" : null, stroke: null, strokeWidthPt: 1.5, opacity: 1, cornerRadiusPt: 0, shadow: false },
    line: null,
    table: null,
    chart: null,
    groupId: null,
    name: `${kind} ${Math.round(x)},${Math.round(y)}`,
  };
}

export function newSlide(layout = "titleContent"): Slide {
  return { id: uid(), layout, background: null, transition: null, transitionMs: 500, objects: [], notes: "" };
}

export function newDeck(title = "Untitled presentation"): Deck {
  return {
    id: uid(),
    title,
    size: { preset: "16:9", widthPt: 960, heightPt: 540 },
    theme: "minimal",
    slides: [newSlide()],
    metadata: { ...emptyMetadata(), title },
  };
}

/** Plain text of a Writer block (used for word count and search). */
export function blockText(block: Block): string {
  switch (block.type) {
    case "paragraph":
      return block.runs.map((run) => run.text).join("");
    case "table":
      return block.table.rows
        .map((row) => row.cells.map((cell) => cell.blocks.map(blockText).join(" ")).join("\t"))
        .join("\n");
    case "image":
      return block.caption;
    case "pageBreak":
      return "";
    default:
      return "";
  }
}

export function documentText(document: TextDocument): string {
  return document.blocks.map(blockText).join("\n");
}

export function wordCount(document: TextDocument): { words: number; characters: number; paragraphs: number } {
  const text = documentText(document);
  return {
    words: text.split(/\s+/).filter(Boolean).length,
    characters: text.length,
    paragraphs: document.blocks.length,
  };
}

export function newParaBlock(styleId = "Normal", text = ""): Block {
  return { type: "paragraph", props: defaultParaProps(styleId), runs: [defaultRun(text)] };
}

export interface ParaStyleLike {
  font?: string | null;
  sizePt?: number | null;
  bold?: boolean | null;
  italic?: boolean | null;
  underline?: boolean | null;
  strike?: boolean | null;
  color?: string | null;
  highlight?: string | null;
  align?: string | null;
  lineSpacing?: number | null;
  spaceBeforePt?: number | null;
  spaceAfterPt?: number | null;
  indentLeftPt?: number | null;
  indentRightPt?: number | null;
  firstLinePt?: number | null;
}

/** Resolves a style chain plus paragraph overrides to concrete values. */
export function effectiveStyle(document: TextDocument, props: ParaProps): Required<Pick<ParaStyleLike, "font" | "sizePt" | "bold" | "italic" | "underline" | "strike" | "color" | "align" | "lineSpacing" | "spaceBeforePt" | "spaceAfterPt" | "indentLeftPt" | "indentRightPt" | "firstLinePt">> & { highlight: string | null } {
  const chain: ParaStyle[] = [];
  let current: string | null = props.style;
  for (let depth = 0; depth < 8 && current; depth += 1) {
    const style = document.styles.find((candidate) => candidate.id === current);
    if (!style) break;
    chain.unshift(style);
    current = style.basedOn;
  }
  let result = {
    font: "Calibri",
    sizePt: 11,
    bold: false,
    italic: false,
    underline: false,
    strike: false,
    color: "#1f2328",
    highlight: null as string | null,
    align: "left",
    lineSpacing: 1.15,
    spaceBeforePt: 0,
    spaceAfterPt: 8,
    indentLeftPt: 0,
    indentRightPt: 0,
    firstLinePt: 0,
  };
  for (const style of chain) {
    result = {
      font: style.font ?? result.font,
      sizePt: style.sizePt ?? result.sizePt,
      bold: style.bold ?? result.bold,
      italic: style.italic ?? result.italic,
      underline: style.underline ?? result.underline,
      strike: style.strike ?? result.strike,
      color: style.color ?? result.color,
      highlight: style.highlight ?? result.highlight,
      align: style.align ?? result.align,
      lineSpacing: style.lineSpacing ?? result.lineSpacing,
      spaceBeforePt: style.spaceBeforePt ?? result.spaceBeforePt,
      spaceAfterPt: style.spaceAfterPt ?? result.spaceAfterPt,
      indentLeftPt: style.indentLeftPt ?? result.indentLeftPt,
      indentRightPt: style.indentRightPt ?? result.indentRightPt,
      firstLinePt: style.firstLinePt ?? result.firstLinePt,
    };
  }
  if (props.align) result.align = props.align;
  if (props.lineSpacing) result.lineSpacing = props.lineSpacing;
  if (props.spaceBeforePt) result.spaceBeforePt = props.spaceBeforePt;
  if (props.spaceAfterPt) result.spaceAfterPt = props.spaceAfterPt;
  result.indentLeftPt = Math.max(result.indentLeftPt, props.indentLeftPt);
  result.indentRightPt = Math.max(result.indentRightPt, props.indentRightPt);
  if (props.firstLinePt) result.firstLinePt = props.firstLinePt;
  if (props.list) result.indentLeftPt = Math.max(result.indentLeftPt, 18 * (props.list.level + 1));
  return result;
}
