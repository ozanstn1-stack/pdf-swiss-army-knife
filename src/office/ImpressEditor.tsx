/**
 * Impress editor: slide thumbnails, drag/resize/rotate canvas, properties
 * panel, notes, layouts, themes and transitions, plus a real slideshow.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlignCenterHorizontal,
  AlignEndHorizontal,
  AlignStartHorizontal,
  Braces,
  Circle,
  Copy,
  FileDown,
  Group,
  FolderOpen,
  Image as ImageIcon,
  LineChart,
  Printer,
  Minus,
  MonitorPlay,
  Move,
  Play,
  Plus,
  Redo2,
  RotateCw,
  Save,
  Square,
  Table as TableIcon,
  Trash2,
  Type,
  Undo2,
  Ungroup,
  ArrowRight,
} from "lucide-react";
import type { Deck, OfficeTab, Slide, SlideObject } from "../lib/office-store";
import { useOfficeTabs } from "../lib/office-store";
import { useT } from "../lib/i18n";
import { reportError } from "../lib/store";
import { uid, type ShapeStyle } from "../lib/office-types";
import { Ribbon, RibbonGroup, ToolButton, ToolColor, ToolNumber, ToolSelect } from "./office-ui";
import { openIntoWorkspace, useEditorShortcuts, useOfficeSession } from "./useOfficeSession";

type ImpressTab = OfficeTab & { model: Deck };

const THEMES: Array<{ id: string; name: string; background: string; title: string; body: string; accent: string; titleColor: string; bodyColor: string }> = [
  { id: "minimal", name: "Minimal", background: "#FFFFFF", title: "Segoe UI", body: "Segoe UI", accent: "#2563EB", titleColor: "#111827", bodyColor: "#334155" },
  { id: "business", name: "Business", background: "#F8FAFC", title: "Segoe UI", body: "Segoe UI", accent: "#1D4ED8", titleColor: "#0F172A", bodyColor: "#334155" },
  { id: "dark", name: "Dark", background: "#0F172A", title: "Segoe UI", body: "Segoe UI", accent: "#60A5FA", titleColor: "#F8FAFC", bodyColor: "#CBD5E1" },
  { id: "modern", name: "Modern", background: "#FFFFFF", title: "Segoe UI", body: "Segoe UI", accent: "#14B8A6", titleColor: "#0B1220", bodyColor: "#334155" },
  { id: "education", name: "Education", background: "#FFFDF5", title: "Georgia", body: "Georgia", accent: "#B45309", titleColor: "#1E293B", bodyColor: "#44403C" },
  { id: "simple", name: "Simple", background: "#FFFFFF", title: "Arial", body: "Arial", accent: "#444444", titleColor: "#111111", bodyColor: "#444444" },
];

const LAYOUTS: Array<{ id: string; name: string; build: (deck: Deck) => SlideObject[] }> = [
  {
    id: "title",
    name: "Title",
    build: () => [textObject("Click to add a title", 120, 200, 720, 120, 40, "center")],
  },
  {
    id: "titleContent",
    name: "Title + content",
    build: () => [textObject("Click to add a title", 80, 60, 800, 80, 32, "left"), bulletObject("Click to add text", 80, 180, 800, 280)],
  },
  {
    id: "twoColumns",
    name: "Two columns",
    build: () => [textObject("Title", 80, 50, 800, 70, 30, "left"), bulletObject("Left column", 80, 160, 380, 300), bulletObject("Right column", 500, 160, 380, 300)],
  },
  {
    id: "imageText",
    name: "Image + text",
    build: () => [textObject("Title", 80, 50, 800, 70, 30, "left"), { ...textObject("Add an image", 80, 160, 400, 300, 16, "center") }, bulletObject("Describe the image", 510, 170, 370, 280)],
  },
  {
    id: "section",
    name: "Section header",
    build: () => [textObject("Section title", 80, 220, 800, 100, 36, "center")],
  },
  { id: "blank", name: "Blank", build: () => [] },
  { id: "quote", name: "Quote", build: () => [textObject("“An important quote goes here.”", 140, 180, 680, 180, 28, "center")] },
  {
    id: "comparison",
    name: "Comparison",
    build: () => [textObject("Option A", 80, 80, 380, 60, 24, "left"), textObject("Option B", 500, 80, 380, 60, 24, "left"), bulletObject("Details", 80, 170, 380, 280), bulletObject("Details", 500, 170, 380, 280)],
  },
];

function textObject(text: string, x: number, y: number, w: number, h: number, size: number, align: string): SlideObject {
  return {
    id: uid(),
    kind: "text",
    x,
    y,
    w,
    h,
    rotation: 0,
    z: 1,
    text: { paragraphs: [{ text, level: 0, bold: size >= 30, italic: false, underline: false, sizePt: size, color: null, align, bullet: false, runs: [] }], valign: "top", font: null, sizePt: size, color: null, align },
    image: null,
    style: null,
    line: null,
    table: null,
    chart: null,
    groupId: null,
    name: "Text",
  };
}

function bulletObject(text: string, x: number, y: number, w: number, h: number): SlideObject {
  const object = textObject(text, x, y, w, h, 20, "left");
  object.text!.paragraphs[0].bullet = true;
  object.name = "Bullets";
  return object;
}

export function ImpressEditor({ tab }: { tab: ImpressTab }) {
  const t = useT();
  const deck = tab.model;
  const edit = useOfficeTabs((state) => state.edit);
  const session = useOfficeSession(tab);
  const [ribbon, setRibbon] = useState("home");
  const [slideIndex, setSlideIndex] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [editingText, setEditingText] = useState<string | null>(null);
  const [slideshow, setSlideshow] = useState<number | null>(null);
  const [undoStack, setUndoStack] = useState<Deck[]>([]);
  const [redoStack, setRedoStack] = useState<Deck[]>([]);
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragState = useRef<{ id: string; mode: "move" | "resize" | "rotate"; startX: number; startY: number; object: SlideObject } | null>(null);

  const slide = deck.slides[Math.min(slideIndex, deck.slides.length - 1)] ?? deck.slides[0];

  useEditorShortcuts(session);
  useEditorShortcuts(session);
  const theme = useMemo(() => THEMES.find((candidate) => candidate.id === deck.theme) ?? THEMES[0], [deck.theme]);
  const scale = useMemo(() => {
    const width = canvasRef.current?.clientWidth ?? 800;
    return Math.min(1.4, Math.max(0.2, (width - 48) / deck.size.widthPt));
  }, [deck.size.widthPt, canvasRef.current?.clientWidth]);

  const update = useCallback(
    (mutate: (deck: Deck) => Deck, recordUndo = true) => {
      if (recordUndo) {
        setUndoStack((stack) => [...stack.slice(-40), deck]);
        setRedoStack([]);
      }
      edit(tab.id, (model) => mutate(model as Deck));
    },
    [deck, edit, tab.id],
  );

  const updateSlide = useCallback(
    (mutate: (slide: Slide) => Slide, recordUndo = true) =>
      update((current) => ({ ...current, slides: current.slides.map((candidate, index) => (index === slideIndex ? mutate(candidate) : candidate)) }), recordUndo),
    [slideIndex, update],
  );

  const updateObject = useCallback(
    (id: string, patch: Partial<SlideObject>, recordUndo = true) =>
      updateSlide((current) => ({ ...current, objects: current.objects.map((object) => (object.id === id ? { ...object, ...patch } : object)) }), recordUndo),
    [updateSlide],
  );

  // -------------------------------------------------------------------------
  // Pointer interaction
  // -------------------------------------------------------------------------

  const beginDrag = (event: React.MouseEvent, id: string, mode: "move" | "resize" | "rotate") => {
    event.stopPropagation();
    const object = slide.objects.find((candidate) => candidate.id === id);
    if (!object) return;
    dragState.current = { id, mode, startX: event.clientX, startY: event.clientY, object: { ...object } };
    const onMove = (move: MouseEvent) => {
      const state = dragState.current;
      if (!state) return;
      const dx = (move.clientX - state.startX) / scale;
      const dy = (move.clientY - state.startY) / scale;
      if (state.mode === "move") {
        updateObject(state.id, { x: Math.round(state.object.x + dx), y: Math.round(state.object.y + dy) }, false);
      } else if (state.mode === "resize") {
        updateObject(state.id, { w: Math.max(24, Math.round(state.object.w + dx)), h: Math.max(24, Math.round(state.object.h + dy)) }, false);
      } else {
        const centerX = state.object.x + state.object.w / 2;
        const centerY = state.object.y + state.object.h / 2;
        const angle = (Math.atan2(move.clientY / scale - centerY, move.clientX / scale - centerX) * 180) / Math.PI + 90;
        updateObject(state.id, { rotation: Math.round(angle) }, false);
      }
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      dragState.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // -------------------------------------------------------------------------
  // Slide operations
  // -------------------------------------------------------------------------

  const addSlide = () => {
    const next = LAYOUTS.find((layout) => layout.id === "titleContent")!;
    const created: Slide = { id: uid(), layout: "titleContent", background: null, transition: null, transitionMs: 500, objects: next.build(deck).map((object, index) => ({ ...object, z: index + 1 })), notes: "" };
    update((current) => ({ ...current, slides: [...current.slides.slice(0, slideIndex + 1), created, ...current.slides.slice(slideIndex + 1)] }));
    setSlideIndex(slideIndex + 1);
  };

  const duplicateSlide = () => {
    const copy: Slide = JSON.parse(JSON.stringify(slide));
    copy.id = uid();
    copy.objects = copy.objects.map((object) => ({ ...object, id: uid() }));
    update((current) => ({ ...current, slides: [...current.slides.slice(0, slideIndex + 1), copy, ...current.slides.slice(slideIndex + 1)] }));
    setSlideIndex(slideIndex + 1);
  };

  const deleteSlide = () => {
    if (deck.slides.length <= 1) return;
    update((current) => ({ ...current, slides: current.slides.filter((_, index) => index !== slideIndex) }));
    setSlideIndex(Math.max(0, slideIndex - 1));
  };

  const moveSlide = (from: number, to: number) => {
    if (to < 0 || to >= deck.slides.length) return;
    update((current) => {
      const slides = [...current.slides];
      const [moved] = slides.splice(from, 1);
      slides.splice(to, 0, moved);
      return { ...current, slides };
    });
    setSlideIndex(to);
  };

  const applyLayout = (layoutId: string) => {
    const layout = LAYOUTS.find((candidate) => candidate.id === layoutId);
    if (!layout) return;
    updateSlide((current) => ({ ...current, layout: layoutId, objects: layout.build(deck).map((object, index) => ({ ...object, z: index + 1 })) }));
  };

  const addObject = (kind: string) => {
    const base = { x: 120, y: 140, w: 240, h: 140 };
    let object: SlideObject;
    if (kind === "text") object = textObject("New text", base.x, base.y, 320, 100, 20, "left");
    else if (kind === "image") {
      object = { ...textObject("Add an image", base.x, base.y, 320, 200, 16, "center"), kind: "image" };
    } else if (kind === "line" || kind === "arrow") {
      object = { ...textObject("", base.x, base.y, 200, 40, 16, "left"), kind, line: { x2: 200, y2: 40, beginArrow: false, endArrow: kind === "arrow", dash: "solid" }, style: { fill: null, stroke: theme.accent, strokeWidthPt: 2, opacity: 1, cornerRadiusPt: 0, shadow: false } };
    } else if (kind === "table") {
      object = {
        ...textObject("", base.x, base.y, 460, 200, 14, "left"),
        kind: "table",
        table: {
          rows: Array.from({ length: 3 }, (): import("../lib/office-types").TableRow => ({ cells: Array.from({ length: 3 }, (): import("../lib/office-types").TableCell => ({ blocks: [{ type: "paragraph" as const, props: { style: "Normal", align: "left", lineSpacing: 1.15, spaceBeforePt: 0, spaceAfterPt: 0, indentLeftPt: 0, indentRightPt: 0, firstLinePt: 0, list: null, pageBreakBefore: false }, runs: [{ text: "", bold: false, italic: false, underline: false, strike: false, color: null, highlight: null, font: null, sizePt: null, link: null, comment: null, superscript: false, subscript: false }] }], colspan: 1, rowspan: 1, background: null, align: "left", valign: "top", widthPt: null })), heightPt: null, header: false })),
          columnWidthsPt: [153, 153, 153],
          borders: true,
          borderColor: "#94A3B8",
          align: "left",
        },
      };
    } else if (kind === "chart") {
      object = { ...textObject("", base.x, base.y, 420, 260, 14, "left"), kind: "chart", chart: { kind: "column", title: "Chart", categories: "", series: [], legend: true, xTitle: "", yTitle: "", stacked: false, showLabels: false } };
    } else {
      object = { ...textObject("", base.x, base.y, base.w, base.h, 16, "left"), kind, style: { fill: theme.accent, stroke: null, strokeWidthPt: 1.5, opacity: 1, cornerRadiusPt: kind === "roundRect" ? 12 : 0, shadow: false } };
    }
    object.z = slide.objects.length + 1;
    updateSlide((current) => ({ ...current, objects: [...current.objects, object] }));
    setSelected([object.id]);
  };

  const deleteSelected = () => {
    updateSlide((current) => ({ ...current, objects: current.objects.filter((object) => !selected.includes(object.id)) }));
    setSelected([]);
  };

  const duplicateSelected = () => {
    const copies = slide.objects
      .filter((object) => selected.includes(object.id))
      .map((object) => ({ ...JSON.parse(JSON.stringify(object)) as SlideObject, id: uid(), x: object.x + 16, y: object.y + 16, z: slide.objects.length + 1 }));
    updateSlide((current) => ({ ...current, objects: [...current.objects, ...copies] }));
    setSelected(copies.map((object) => object.id));
  };

  const alignSelected = (mode: "left" | "center" | "right" | "top" | "middle" | "bottom") => {
    updateSlide((current) => ({
      ...current,
      objects: current.objects.map((object) => {
        if (!selected.includes(object.id)) return object;
        switch (mode) {
          case "left":
            return { ...object, x: 0 };
          case "center":
            return { ...object, x: Math.round((deck.size.widthPt - object.w) / 2) };
          case "right":
            return { ...object, x: Math.round(deck.size.widthPt - object.w) };
          case "top":
            return { ...object, y: 0 };
          case "middle":
            return { ...object, y: Math.round((deck.size.heightPt - object.h) / 2) };
          default:
            return { ...object, y: Math.round(deck.size.heightPt - object.h) };
        }
      }),
    }));
  };

  const groupSelected = () => {
    const groupId = uid();
    updateSlide((current) => ({ ...current, objects: current.objects.map((object) => (selected.includes(object.id) ? { ...object, groupId } : object)) }));
  };

  const ungroupSelected = () => {
    updateSlide((current) => ({ ...current, objects: current.objects.map((object) => (selected.includes(object.id) ? { ...object, groupId: null } : object)) }));
  };

  const bringForward = (delta: number) => {
    updateSlide((current) => {
      const objects = [...current.objects].sort((a, b) => a.z - b.z);
      for (const id of selected) {
        const index = objects.findIndex((object) => object.id === id);
        if (index < 0) continue;
        const target = Math.max(0, Math.min(objects.length - 1, index + delta));
        const [moved] = objects.splice(index, 1);
        objects.splice(target, 0, moved);
      }
      return { ...current, objects: objects.map((object, index) => ({ ...object, z: index + 1 })) };
    });
  };

  const undo = () => {
    setUndoStack((stack) => {
      const previous = stack[stack.length - 1];
      if (!previous) return stack;
      setRedoStack((redos) => [...redos, deck]);
      edit(tab.id, () => previous);
      return stack.slice(0, -1);
    });
  };

  const redo = () => {
    setRedoStack((stack) => {
      const next = stack[stack.length - 1];
      if (!next) return stack;
      setUndoStack((undos) => [...undos, deck]);
      edit(tab.id, () => next);
      return stack.slice(0, -1);
    });
  };

  // Autoplay slideshow.
  useEffect(() => {
    if (slideshow === null) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSlideshow(null);
      if (event.key === "ArrowRight" || event.key === " ") setSlideshow((current) => Math.min(deck.slides.length - 1, (current ?? 0) + 1));
      if (event.key === "ArrowLeft") setSlideshow((current) => Math.max(0, (current ?? 0) - 1));
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [slideshow, deck.slides.length]);

  const selectedObjects = slide.objects.filter((object) => selected.includes(object.id));
  const primary = selectedObjects[0];

  return (
    <div className="editor impress-editor">
      <Ribbon
        tabs={[
          { id: "home", label: t("impress.tabHome") },
          { id: "insert", label: t("impress.tabInsert") },
          { id: "design", label: t("impress.tabDesign") },
          { id: "transitions", label: t("impress.tabTransitions") },
          { id: "view", label: t("impress.tabView") },
        ]}
        active={ribbon}
        onSelect={setRibbon}
      >
        {ribbon === "home" ? (
          <>
            <RibbonGroup label={t("writer.clipboard")}>
              <ToolButton icon={<Undo2 size={16} />} onClick={undo} disabled={undoStack.length === 0} title={t("common.undo")} />
              <ToolButton icon={<Redo2 size={16} />} onClick={redo} disabled={redoStack.length === 0} title={t("common.redo")} />
              <ToolButton icon={<Copy size={16} />} label={t("impress.duplicate")} onClick={duplicateSelected} disabled={selected.length === 0} />
              <ToolButton icon={<Trash2 size={16} />} label={t("common.delete")} onClick={deleteSelected} disabled={selected.length === 0} />
            </RibbonGroup>
            <RibbonGroup label={t("impress.objects")}>
              <ToolButton icon={<Type size={16} />} label={t("impress.text")} onClick={() => addObject("text")} />
              <ToolButton icon={<Square size={16} />} label={t("impress.rect")} onClick={() => addObject("rect")} />
              <ToolButton icon={<Circle size={16} />} label={t("impress.ellipse")} onClick={() => addObject("ellipse")} />
              <ToolButton icon={<Minus size={16} />} label={t("impress.line")} onClick={() => addObject("line")} />
              <ToolButton icon={<ArrowRight size={16} />} label={t("impress.arrow")} onClick={() => addObject("arrow")} />
              <ToolButton icon={<ImageIcon size={16} />} label={t("writer.image")} onClick={() => addObject("image")} />
              <ToolButton icon={<TableIcon size={16} />} label={t("writer.table")} onClick={() => addObject("table")} />
              <ToolButton icon={<LineChart size={16} />} label={t("calc.chart")} onClick={() => addObject("chart")} />
            </RibbonGroup>
            <RibbonGroup label={t("impress.arrange")}>
              <ToolButton icon={<AlignStartHorizontal size={16} />} onClick={() => alignSelected("left")} title={t("impress.alignLeft")} />
              <ToolButton icon={<AlignCenterHorizontal size={16} />} onClick={() => alignSelected("center")} title={t("impress.alignCenter")} />
              <ToolButton icon={<AlignEndHorizontal size={16} />} onClick={() => alignSelected("right")} title={t("impress.alignRight")} />
              <ToolButton icon={<Move size={16} />} onClick={() => bringForward(1)} title={t("impress.bringForward")} />
              <ToolButton icon={<Group size={16} />} label={t("impress.group")} onClick={groupSelected} disabled={selected.length < 2} />
              <ToolButton icon={<Ungroup size={16} />} label={t("impress.ungroup")} onClick={ungroupSelected} disabled={selected.length === 0} />
            </RibbonGroup>
            <RibbonGroup label={t("impress.slides")}>
              <ToolButton icon={<Plus size={16} />} label={t("impress.newSlide")} onClick={addSlide} />
              <ToolButton icon={<Copy size={16} />} label={t("impress.duplicateSlide")} onClick={duplicateSlide} />
              <ToolButton icon={<Trash2 size={16} />} label={t("impress.deleteSlide")} onClick={deleteSlide} disabled={deck.slides.length <= 1} />
            </RibbonGroup>
          </>
        ) : null}

        {ribbon === "insert" ? (
          <>
            <RibbonGroup label={t("impress.slides")}>
              <ToolButton icon={<Plus size={16} />} label={t("impress.newSlide")} onClick={addSlide} />
            </RibbonGroup>
            <RibbonGroup label={t("impress.objects")}>
              <ToolButton icon={<Type size={16} />} label={t("impress.text")} onClick={() => addObject("text")} />
              <ToolButton icon={<ImageIcon size={16} />} label={t("writer.image")} onClick={() => addObject("image")} />
              <ToolButton icon={<TableIcon size={16} />} label={t("writer.table")} onClick={() => addObject("table")} />
              <ToolButton icon={<LineChart size={16} />} label={t("calc.chart")} onClick={() => addObject("chart")} />
              <ToolButton icon={<Braces size={16} />} label={t("impress.rect")} onClick={() => addObject("roundRect")} />
            </RibbonGroup>
          </>
        ) : null}

        {ribbon === "design" ? (
          <>
            <RibbonGroup label={t("impress.theme")}>
              <ToolSelect value={deck.theme} onChange={(theme) => update((current) => ({ ...current, theme }))} options={THEMES.map((candidate) => ({ value: candidate.id, label: candidate.name }))} width={130} />
            </RibbonGroup>
            <RibbonGroup label={t("impress.layout")}>
              <ToolSelect value={slide.layout} onChange={applyLayout} options={LAYOUTS.map((layout) => ({ value: layout.id, label: layout.name }))} width={150} />
            </RibbonGroup>
            <RibbonGroup label={t("impress.background")}>
              <ToolColor value={slide.background ?? theme.background} onChange={(background) => updateSlide((current) => ({ ...current, background }))} title={t("impress.background")} />
              <ToolButton label={t("impress.clearBackground")} onClick={() => updateSlide((current) => ({ ...current, background: null }))} />
            </RibbonGroup>
          </>
        ) : null}

        {ribbon === "transitions" ? (
          <RibbonGroup label={t("impress.transition")}>
            <ToolSelect
              value={slide.transition ?? "none"}
              onChange={(transition) => updateSlide((current) => ({ ...current, transition: transition === "none" ? null : transition }))}
              options={[
                { value: "none", label: t("impress.transitionNone") },
                { value: "fade", label: "Fade" },
                { value: "slide", label: "Slide" },
                { value: "push", label: "Push" },
                { value: "wipe", label: "Wipe" },
              ]}
              width={130}
            />
            <ToolNumber value={slide.transitionMs} onChange={(transitionMs) => updateSlide((current) => ({ ...current, transitionMs }))} min={100} max={3000} step={100} title="ms" width={80} />
            <ToolButton label={t("impress.applyToAll")} onClick={() => update((current) => ({ ...current, slides: current.slides.map((candidate) => ({ ...candidate, transition: slide.transition, transitionMs: slide.transitionMs })) }))} />
          </RibbonGroup>
        ) : null}

        {ribbon === "view" ? (
          <RibbonGroup label={t("impress.present")}>
            <ToolButton icon={<Play size={16} />} label={t("impress.startShow")} onClick={() => setSlideshow(slideIndex)} />
            <ToolButton icon={<MonitorPlay size={16} />} label={t("impress.presenter")} onClick={() => setSlideshow(0)} />
          </RibbonGroup>
        ) : null}

        <div className="ribbon-spacer" />
        <RibbonGroup>
          <ToolButton icon={<FolderOpen size={16} />} label={t("common.open")} onClick={() => void openIntoWorkspace()} />
          <ToolButton icon={<Save size={16} />} label={t("common.save")} onClick={() => void session.save()} disabled={session.busy} />
          <ToolButton label={t("common.saveAs")} onClick={() => void session.saveAs()} disabled={session.busy} />
          <ToolButton icon={<FileDown size={16} />} label={t("writer.exportPdf")} onClick={() => void session.exportPdf()} />
          <ToolButton icon={<Printer size={16} />} label={t("common.print")} onClick={() => window.print()} />
        </RibbonGroup>
      </Ribbon>

      <div className="impress-layout">
        <div className="slide-list">
          {deck.slides.map((candidate, index) => (
            <div key={candidate.id} className={`slide-thumb${index === slideIndex ? " is-active" : ""}`} onClick={() => { setSlideIndex(index); setSelected([]); }}>
              <span className="slide-number">{index + 1}</span>
              <SlidePreview deck={deck} slide={candidate} theme={theme} width={148} />
              <div className="slide-thumb-actions">
                <button type="button" className="icon-btn" onClick={(event) => { event.stopPropagation(); moveSlide(index, index - 1); }} title="Move up">
                  ↑
                </button>
                <button type="button" className="icon-btn" onClick={(event) => { event.stopPropagation(); moveSlide(index, index + 1); }} title="Move down">
                  ↓
                </button>
              </div>
            </div>
          ))}
          <button type="button" className="btn btn-soft slide-add" onClick={addSlide}>
            <Plus size={14} /> {t("impress.newSlide")}
          </button>
        </div>

        <div className="slide-stage" ref={canvasRef} onClick={() => setSelected([])}>
          <div
            className="slide-canvas"
            style={{
              width: deck.size.widthPt * scale,
              height: deck.size.heightPt * scale,
              background: slide.background ?? theme.background,
            }}
            onClick={(event) => event.stopPropagation()}
            onMouseDown={() => setSelected([])}
          >
            {[...slide.objects].sort((a, b) => a.z - b.z).map((object) => (
              <div
                key={object.id}
                className={`slide-object${selected.includes(object.id) ? " is-selected" : ""}`}
                style={{
                  left: object.x * scale,
                  top: object.y * scale,
                  width: object.w * scale,
                  height: object.h * scale,
                  transform: `rotate(${object.rotation}deg)`,
                  zIndex: object.z,
                }}
                onMouseDown={(event) => {
                  event.stopPropagation();
                  setSelected(event.shiftKey ? [...new Set([...selected, object.id])] : [object.id]);
                  beginDrag(event, object.id, "move");
                }}
                onDoubleClick={() => {
                  if (object.text) setEditingText(object.id);
                  if (object.kind === "image") void replaceImage(object.id);
                }}
              >
                <SlideObjectView object={object} theme={theme} scale={scale} editing={editingText === object.id} onTextChange={(text) => updateObject(object.id, { text: { ...object.text!, paragraphs: [{ ...object.text!.paragraphs[0], text }] } })} onTextDone={() => setEditingText(null)} />
                {selected.includes(object.id) ? (
                  <>
                    <span className="resize-handle" onMouseDown={(event) => beginDrag(event, object.id, "resize")} />
                    <span className="rotate-handle" onMouseDown={(event) => beginDrag(event, object.id, "rotate")}>
                      <RotateCw size={10} />
                    </span>
                  </>
                ) : null}
              </div>
            ))}
          </div>
        </div>

        <div className="slide-properties">
          <h4>{t("impress.properties")}</h4>
          {primary ? (
            <div className="stack">
              <div className="row">
                <ToolNumber value={Math.round(primary.x)} onChange={(x) => updateObject(primary.id, { x })} title="X" width={64} />
                <ToolNumber value={Math.round(primary.y)} onChange={(y) => updateObject(primary.id, { y })} title="Y" width={64} />
              </div>
              <div className="row">
                <ToolNumber value={Math.round(primary.w)} onChange={(w) => updateObject(primary.id, { w })} title="W" width={64} />
                <ToolNumber value={Math.round(primary.h)} onChange={(h) => updateObject(primary.id, { h })} title="H" width={64} />
              </div>
              <div className="row">
                <ToolNumber value={Math.round(primary.rotation)} onChange={(rotation) => updateObject(primary.id, { rotation })} min={-180} max={180} title={t("impress.rotation")} width={64} />
                <ToolNumber value={primary.z} onChange={(z) => updateObject(primary.id, { z })} min={1} max={99} title="Z" width={64} />
              </div>
              {(primary.kind === "rect" || primary.kind === "ellipse" || primary.kind === "roundRect") ? (
                <>
                  <label className="field">
                    <span>{t("impress.fill")}</span>
                    <input
                      type="color"
                      value={primary.style?.fill ?? "#2563eb"}
                      onChange={(event) => updateObject(primary.id, { style: { ...(primary.style ?? defaultShapeStyle()), fill: event.target.value } })}
                    />
                  </label>
                  <label className="field">
                    <span>{t("impress.cornerRadius")}</span>
                    <input
                      type="number"
                      value={primary.style?.cornerRadiusPt ?? 0}
                      onChange={(event) => updateObject(primary.id, { style: { ...(primary.style ?? defaultShapeStyle()), cornerRadiusPt: Number(event.target.value) } })}
                    />
                  </label>
                </>
              ) : null}
              {primary.text ? (
                <label className="field">
                  <span>{t("impress.fontSize")}</span>
                  <input
                    type="number"
                    value={primary.text.paragraphs[0]?.sizePt ?? primary.text.sizePt ?? 18}
                    onChange={(event) =>
                      updateObject(primary.id, {
                        text: { ...primary.text!, paragraphs: [{ ...primary.text!.paragraphs[0], sizePt: Number(event.target.value) }] },
                      })
                    }
                  />
                </label>
              ) : null}
              <label className="field">
                <span>{t("writer.paragraph")}</span>
                <select value={primary.text?.paragraphs[0]?.align ?? "left"} onChange={(event) => updateObject(primary.id, { text: primary.text ? { ...primary.text, paragraphs: [{ ...primary.text.paragraphs[0], align: event.target.value }] } : null })}>
                  <option value="left">{t("writer.alignLeft")}</option>
                  <option value="center">{t("writer.alignCenter")}</option>
                  <option value="right">{t("writer.alignRight")}</option>
                </select>
              </label>
              <ToolButton label={t("impress.editText")} onClick={() => (primary.text ? setEditingText(primary.id) : updateObject(primary.id, { text: { paragraphs: [{ text: "New text", level: 0, bold: false, italic: false, underline: false, sizePt: 20, color: null, align: "left", bullet: false, runs: [] }], valign: "top", font: null, sizePt: 20, color: null, align: "left" } }))} />
            </div>
          ) : (
            <p className="muted">{t("impress.noSelection")}</p>
          )}
          <h4>{t("impress.notes")}</h4>
          <textarea className="notes-input" value={slide.notes} onChange={(event) => updateSlide((current) => ({ ...current, notes: event.target.value }))} placeholder={t("impress.notesHint")} />
        </div>
      </div>

      <div className="editor-status">
        <span>
          {slideIndex + 1} / {deck.slides.length} {t("impress.slides")}
        </span>
        <span className="spacer" />
        <span>
          {tab.path ?? t("writer.unsaved")} {tab.dirty ? "•" : ""}
        </span>
      </div>

      {slideshow !== null ? (
        <div className="slideshow" onClick={() => setSlideshow(null)}>
          <div
            className="slideshow-slide"
            data-transition={deck.slides[slideshow]?.transition ?? "fade"}
            style={{
              width: "90vw",
              height: `${(90 * deck.size.heightPt) / deck.size.widthPt}vh`,
              background: deck.slides[slideshow]?.background ?? theme.background,
            }}
          >
            <SlidePreview deck={deck} slide={deck.slides[slideshow]} theme={theme} width={0} full slideWidth={deck.size.widthPt} slideHeight={deck.size.heightPt} />
          </div>
          <div className="slideshow-nav">
            <button type="button" className="btn btn-soft" onClick={(event) => { event.stopPropagation(); setSlideshow(Math.max(0, slideshow - 1)); }}>
              ‹
            </button>
            <span>
              {slideshow + 1} / {deck.slides.length}
            </span>
            <button type="button" className="btn btn-soft" onClick={(event) => { event.stopPropagation(); setSlideshow(Math.min(deck.slides.length - 1, slideshow + 1)); }}>
              ›
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );

  async function replaceImage(id: string) {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const { readFile } = await import("@tauri-apps/plugin-fs");
      const path = await open({ multiple: false, filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] }] });
      if (typeof path !== "string") return;
      const bytes = await readFile(path);
      let base64 = "";
      for (let index = 0; index < bytes.length; index += 0x8000) base64 += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
      const name = path.split(/[\\/]/).pop() ?? "image.png";
      const mime = name.endsWith(".jpg") || name.endsWith(".jpeg") ? "image/jpeg" : "image/png";
      updateObject(id, { image: { name, mime, dataBase64: btoa(base64), alt: "" }, kind: "image" });
    } catch (error) {
      reportError(error, t);
    }
  }
}

function defaultShapeStyle(): ShapeStyle {
  return { fill: "#2563eb", stroke: null, strokeWidthPt: 1.5, opacity: 1, cornerRadiusPt: 0, shadow: false };
}

function SlideObjectView({ object, theme, scale, editing, onTextChange, onTextDone }: { object: SlideObject; theme: (typeof THEMES)[number]; scale: number; editing: boolean; onTextChange: (text: string) => void; onTextDone: () => void }) {
  if (object.kind === "image") {
    if (!object.image || object.image.dataBase64 === "") return <div className="slide-image-placeholder">Double-click to add an image</div>;
    return <img className="slide-image" src={`data:${object.image.mime};base64,${object.image.dataBase64}`} alt={object.image.alt} draggable={false} />;
  }
  if (object.kind === "line" || object.kind === "arrow") {
    const line = object.line ?? { x2: object.w, y2: 0, beginArrow: false, endArrow: false, dash: "solid" };
    return (
      <svg width="100%" height="100%" viewBox={`0 0 ${object.w} ${object.h}`} preserveAspectRatio="none">
        <defs>
          <marker id={`arrow-${object.id}`} markerWidth="10" markerHeight="10" refX="7" refY="3" orient="auto">
            <path d="M0,0 L0,6 L8,3 z" fill={object.style?.stroke ?? theme.accent} />
          </marker>
        </defs>
        <line
          x1={0}
          y1={0}
          x2={line.x2}
          y2={line.y2}
          stroke={object.style?.stroke ?? theme.accent}
          strokeWidth={object.style?.strokeWidthPt ?? 2}
          strokeDasharray={line.dash === "dashed" ? "6 4" : line.dash === "dotted" ? "1 3" : undefined}
          markerEnd={line.endArrow ? `url(#arrow-${object.id})` : undefined}
        />
      </svg>
    );
  }
  if (object.kind === "table" && object.table) {
    return (
      <table className="slide-table">
        <tbody>
          {object.table.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.cells.map((cell, cellIndex) => (
                <td key={cellIndex} style={{ background: cell.background ?? undefined }}>
                  {cell.blocks.map((block) => blockTextOf(block)).join(" ")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  if (object.kind === "chart") {
    return <div className="slide-chart-placeholder">{object.chart?.title ?? "Chart"}</div>;
  }
  const style = object.style ?? defaultShapeStyle();
  const isShape = object.kind === "rect" || object.kind === "ellipse" || object.kind === "roundRect";
  return (
    <div
      className={`slide-shape ${object.kind}`}
      style={{
        background: isShape ? (style.fill ?? "transparent") : "transparent",
        border: isShape && style.stroke ? `${style.strokeWidthPt * scale}px solid ${style.stroke}` : undefined,
        borderRadius: object.kind === "ellipse" ? "50%" : `${(style.cornerRadiusPt ?? 0) * scale}px`,
        opacity: style.opacity || 1,
        boxShadow: style.shadow ? "0 6px 18px rgba(15,23,42,.25)" : undefined,
      }}
    >
      {object.text ? (
        editing ? (
          <textarea
            className="slide-text-editor"
            autoFocus
            defaultValue={object.text.paragraphs.map((paragraph) => paragraph.text).join("\n")}
            onBlur={(event) => {
              onTextChange(event.target.value);
              onTextDone();
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") onTextDone();
            }}
            style={{ fontSize: (object.text.paragraphs[0]?.sizePt ?? object.text.sizePt ?? 18) * scale, color: object.text.paragraphs[0]?.color ?? theme.bodyColor }}
          />
        ) : (
          <div className="slide-text" style={{ fontSize: (object.text.paragraphs[0]?.sizePt ?? object.text.sizePt ?? 18) * scale, color: object.text.paragraphs[0]?.color ?? theme.bodyColor, textAlign: (object.text.paragraphs[0]?.align ?? "left") as "left" | "center" | "right" }}>
            {object.text.paragraphs.map((paragraph, index) => (
              <p key={index} style={{ fontWeight: paragraph.bold ? 700 : undefined, fontStyle: paragraph.italic ? "italic" : undefined }}>
                {paragraph.bullet ? "• " : ""}
                {paragraph.text}
              </p>
            ))}
          </div>
        )
      ) : null}
    </div>
  );
}

function blockTextOf(block: { type: string; runs?: Array<{ text: string }> }): string {
  return (block.runs ?? []).map((run) => run.text).join("");
}

export function SlidePreview({
  deck,
  slide,
  theme,
  width,
  full,
  slideWidth,
  slideHeight,
}: {
  deck: Deck;
  slide: Slide;
  theme: (typeof THEMES)[number];
  width: number;
  full?: boolean;
  slideWidth?: number;
  slideHeight?: number;
}) {
  const actualWidth = full ? slideWidth ?? deck.size.widthPt : width;
  const scale = actualWidth / deck.size.widthPt;
  const height = full ? slideHeight ?? deck.size.heightPt : (deck.size.heightPt * width) / deck.size.widthPt;
  return (
    <div className="slide-preview" style={{ width: full ? "100%" : width, height: full ? "100%" : height, background: slide.background ?? theme.background, position: "relative", overflow: "hidden" }}>
      {[...slide.objects].sort((a, b) => a.z - b.z).map((object) => (
        <div
          key={object.id}
          style={{
            position: "absolute",
            left: object.x * scale,
            top: object.y * scale,
            width: object.w * scale,
            height: object.h * scale,
            transform: `rotate(${object.rotation}deg)`,
          }}
        >
          <SlideObjectView object={object} theme={theme} scale={full ? scale * 1.2 : scale} editing={false} onTextChange={() => undefined} onTextDone={() => undefined} />
        </div>
      ))}
    </div>
  );
}
