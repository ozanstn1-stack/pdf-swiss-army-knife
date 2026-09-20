import React, { useCallback, useEffect, useMemo, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Archive,
  BookOpen,
  Combine,
  FileSearch,
  FolderClock,
  FileImage,
  Home,
  Images,
  Info,
  Layers,
  Lock,
  LockOpen,
  Minimize2,
  Moon,
  Puzzle,
  Scissors,
  Settings as SettingsIcon,
  Stamp,
  Sun,
  Type,
  Wand2,
} from "lucide-react";
import { useT } from "./lib/i18n";
import { useDev, useDrop, useJobs, useRecent, useSettings, useToasts } from "./lib/store";
import packageJson from "../package.json";
import { devLaunchContext } from "./lib/api";
import type { Navigate, ScreenId } from "./lib/nav";
import { Home as HomeScreen } from "./screens/Home";
import { Reader } from "./screens/Reader";
import { Merge } from "./screens/Merge";
import { Organize } from "./screens/Organize";
import { Split } from "./screens/Split";
import { Compress } from "./screens/Compress";
import { Ocr } from "./screens/Ocr";
import { Convert } from "./screens/Convert";
import { Security } from "./screens/Security";
import { Watermark } from "./screens/Watermark";
import { PageTools } from "./screens/PageTools";
import { Annotate } from "./screens/Annotate";
import { Metadata } from "./screens/Metadata";
import { Batch } from "./screens/Batch";
import { History } from "./screens/History";
import { Settings } from "./screens/Settings";
import { InfoScreen } from "./screens/Info";
import { OverwriteDialog, PasswordDialog, Toasts } from "./components/files";
import { Badge, IconButton } from "./components/ui";

type PageToolTab = "extract" | "delete" | "rotate" | "resize" | "crop" | "numbering";

export default function App() {
  const t = useT();
  const init = useSettings((s) => s.init);
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const attachJobs = useJobs((s) => s.attach);
  const refreshRecent = useRecent((s) => s.refresh);
  const setDropHandler = useDrop((s) => s.setHandler);
  const pushToast = useToasts((s) => s.push);

  const [screen, setScreen] = useState<ScreenId>("home");
  const [files, setFiles] = useState<string[]>([]);
  const [pageToolTab, setPageToolTab] = useState<PageToolTab>("extract");
  const [convertTab, setConvertTab] = useState<"pdfToImages" | "imagesToPdf">("pdfToImages");
  const [securityTab, setSecurityTab] = useState<"protect" | "unlock">("protect");
  const [dragging, setDragging] = useState(false);
  const [sidebarCompact, setSidebarCompact] = useState(false);

  const navigate = useCallback<Navigate>((next, options) => {
    setFiles(options?.files ?? []);
    if (options?.pageToolsTab) setPageToolTab(options.pageToolsTab);
    if (next === "pdfToImages") {
      setConvertTab("pdfToImages");
      setScreen("pdfToImages");
      return;
    }
    if (next === "imagesToPdf") {
      setConvertTab("imagesToPdf");
      setScreen("imagesToPdf");
      return;
    }
    if (next === "protect" || next === "unlock") {
      setSecurityTab(next);
      setScreen(next);
      return;
    }
    setScreen(next);
  }, []);

  // Global initialization
  useEffect(() => {
    void init();
    void refreshRecent();
    let unlisten: (() => void) | undefined;
    void attachJobs().then((fn) => {
      unlisten = fn;
    });
    // Development/screenshot hook (no-op unless PDFSAK_* env vars are set).
    void devLaunchContext()
      .then((context) => {
        useDev.getState().set({
          startScreen: context.startScreen,
          files: context.files,
          autoRun: Boolean(context.autoRun),
        });
        void import("./lib/api").then(({ logFrontend }) =>
          logFrontend("info", `dev-context: screen=${context.startScreen} files=${(context.files ?? []).length} autoRun=${context.autoRun}`),
        );
        if (context.startScreen) {
          navigate(context.startScreen as ScreenId, { files: context.files ?? [] });
        } else if (context.files?.length) {
          setFiles(context.files);
        }
      })
      .catch(() => undefined);
    return () => unlisten?.();
  }, [attachJobs, init, navigate, refreshRecent]);

  // Keep the native window chrome in sync with the selected theme.
  useEffect(() => {
    const resolved = settings.theme === "system" ? (document.documentElement.classList.contains("dark") ? "dark" : "light") : settings.theme;
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => getCurrentWindow().setTheme(resolved))
      .catch(() => undefined);
  }, [settings.theme]);

  // OS drag & drop from Explorer
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "enter" || event.payload.type === "over") {
          setDragging(true);
        } else if (event.payload.type === "drop") {
          setDragging(false);
          const paths = event.payload.paths ?? [];
          if (!paths.length) return;
          if (screen === "home") {
            setFiles(paths);
            pushToast({
              kind: "info",
              title: t("home.quickActions"),
              detail: paths.length === 1 ? paths[0] : `${paths.length} files`,
            });
            return;
          }
          const handler = useDrop.getState().handler;
          if (handler) handler(paths);
        } else {
          setDragging(false);
        }
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => unlisten?.();
  }, [pushToast, screen, t]);

  // Global keyboard shortcuts
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
      if ((event.ctrlKey || event.metaKey) && event.key === ",") {
        event.preventDefault();
        setScreen("settings");
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "o") {
        event.preventDefault();
        void open({
          multiple: true,
          filters: [{ name: "Documents", extensions: ["pdf", "jpg", "jpeg", "png", "webp", "bmp", "tif", "tiff"] }],
        }).then((picked) => {
          if (!picked) return;
          const paths = (Array.isArray(picked) ? picked : [picked]).map(String);
          if (screen === "home") {
            setFiles(paths);
          } else {
            const handler = useDrop.getState().handler;
            if (handler) handler(paths);
          }
        });
        return;
      }
      if (event.key === "Escape") {
        // Esc is handled by modals; nothing global to do here.
        return;
      }
      void typing;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [screen]);

  const homeDrop = useCallback((paths: string[]) => {
    setFiles(paths);
    setDropHandler(null);
  }, [setDropHandler]);

  const screens: Record<ScreenId, React.ReactElement> = useMemo(
    () => ({
      home: <HomeScreen onNavigate={navigate} onDropFiles={homeDrop} dragging={dragging} onFileList={setFiles} />,
      reader: <Reader initialFiles={files} dragging={dragging} />,
      merge: <Merge initialFiles={files} dragging={dragging} />,
      organize: <Organize initialFiles={files} dragging={dragging} />,
      split: <Split initialFiles={files} dragging={dragging} />,
      compress: <Compress initialFiles={files} dragging={dragging} />,
      ocr: <Ocr initialFiles={files} dragging={dragging} />,
      pdfToImages: <Convert tab={convertTab} initialFiles={files} dragging={dragging} />,
      imagesToPdf: <Convert tab={convertTab} initialFiles={files} dragging={dragging} />,
      protect: <Security tab={securityTab} initialFiles={files} dragging={dragging} />,
      unlock: <Security tab={securityTab} initialFiles={files} dragging={dragging} />,
      watermark: <Watermark initialFiles={files} dragging={dragging} />,
      annotate: <Annotate initialFiles={files} dragging={dragging} />,
      metadata: <Metadata initialFiles={files} dragging={dragging} />,
      pageTools: <PageTools tab={pageToolTab} initialFiles={files} dragging={dragging} />,
      batch: <Batch initialFiles={files} dragging={dragging} />,
      history: <History onNavigate={navigate} />,
      settings: <Settings />,
      info: <InfoScreen initialFiles={files} />,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [convertTab, dragging, files, homeDrop, navigate, pageToolTab, securityTab],
  );

  const navGroups: { label?: string; items: { id: ScreenId; label: string; icon: React.ReactElement }[] }[] = [
    {
      items: [
        { id: "home", label: t("nav.home"), icon: <Home size={16} /> },
        { id: "reader", label: t("nav.reader"), icon: <BookOpen size={16} /> },
      ],
    },
    {
      label: t("nav.pdfTools"),
      items: [
        { id: "merge", label: t("nav.merge"), icon: <Combine size={16} /> },
        { id: "organize", label: t("nav.organize"), icon: <Layers size={16} /> },
        { id: "split", label: t("nav.split"), icon: <Scissors size={16} /> },
        { id: "compress", label: t("nav.compress"), icon: <Minimize2 size={16} /> },
        { id: "pageTools", label: t("nav.pageTools"), icon: <Wand2 size={16} /> },
        { id: "watermark", label: t("nav.watermark"), icon: <Stamp size={16} /> },
        { id: "annotate", label: t("nav.annotate"), icon: <Type size={16} /> },
        { id: "metadata", label: t("nav.metadata"), icon: <Puzzle size={16} /> },
      ],
    },
    {
      label: t("nav.convert"),
      items: [
        { id: "pdfToImages", label: t("nav.pdfToImages"), icon: <FileImage size={16} /> },
        { id: "imagesToPdf", label: t("nav.imagesToPdf"), icon: <Images size={16} /> },
      ],
    },
    { items: [{ id: "ocr", label: t("nav.ocr"), icon: <FileSearch size={16} /> }] },
    {
      label: t("nav.security"),
      items: [
        { id: "protect", label: t("nav.protect"), icon: <Lock size={16} /> },
        { id: "unlock", label: t("nav.unlock"), icon: <LockOpen size={16} /> },
      ],
    },
    {
      label: t("nav.batch"),
      items: [
        { id: "batch", label: t("nav.batch"), icon: <Archive size={16} /> },
        { id: "info", label: t("nav.info"), icon: <Info size={16} /> },
        { id: "history", label: t("nav.history"), icon: <FolderClock size={16} /> },
        { id: "settings", label: t("nav.settings"), icon: <SettingsIcon size={16} /> },
      ],
    },
  ];

  const isDark = settings.theme === "dark" || (settings.theme === "system" && document.documentElement.classList.contains("dark"));

  return (
    <div className="flex h-full" style={{ background: "var(--bg)" }}>
      {/* Sidebar */}
      <aside
        className="flex flex-col shrink-0 border-r"
        style={{
          width: sidebarCompact ? 64 : 232,
          borderColor: "var(--border)",
          background: "var(--bg-soft)",
          transition: "width 0.15s ease",
        }}
      >
        <div className="flex items-center gap-2.5 px-3.5 py-4">
          <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: "var(--accent)", color: "var(--accent-text)" }}>
            <Puzzle size={18} />
          </div>
          {!sidebarCompact ? (
            <div className="min-w-0">
              <p className="font-bold text-[13.5px] leading-tight truncate">{t("app.name")}</p>
              <p className="text-[11px] muted truncate">v{packageJson.version} · local</p>
            </div>
          ) : null}
        </div>

        <nav className="flex-1 overflow-y-auto px-2 pb-3">
          {navGroups.map((group, index) => (
            <div key={index}>
              {group.label && !sidebarCompact ? <p className="nav-group-label">{group.label}</p> : null}
              {group.items.map((item) => {
                const active =
                  screen === item.id ||
                  (item.id === "pdfToImages" && screen === "pdfToImages") ||
                  (item.id === "imagesToPdf" && screen === "imagesToPdf");
                return (
                  <button
                    key={item.id}
                    className="nav-item"
                    data-active={active}
                    onClick={() => navigate(item.id)}
                    title={sidebarCompact ? item.label : undefined}
                  >
                    <span className="shrink-0">{item.icon}</span>
                    {!sidebarCompact ? <span className="truncate">{item.label}</span> : null}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="px-3 py-3 border-t flex items-center justify-between" style={{ borderColor: "var(--border)" }}>
          {!sidebarCompact ? (
            <Badge tone="ok">
              <Lock size={10} /> {t("nav.privacy")}
            </Badge>
          ) : null}
          <div className="flex items-center gap-1">
            <IconButton
              label={t("settings.theme")}
              onClick={() => void update({ theme: isDark ? "light" : "dark" })}
            >
              {isDark ? <Sun size={15} /> : <Moon size={15} />}
            </IconButton>
            <IconButton label="Sidebar" onClick={() => setSidebarCompact((previous) => !previous)}>
              <Layers size={15} />
            </IconButton>
          </div>
        </div>
      </aside>

      {/* Main area */}
      <main className="flex-1 min-w-0 h-full relative">
        {dragging ? (
          <div
            className="absolute inset-0 z-50 flex items-center justify-center pointer-events-none"
            style={{ background: "color-mix(in srgb, var(--accent) 8%, transparent)", border: "2px dashed var(--accent)" }}
          >
            <p className="font-semibold" style={{ color: "var(--accent)" }}>
              {t("common.dropHere")}
            </p>
          </div>
        ) : null}
        <div key={`${screen}-${files.join("|")}`} className="h-full">{screens[screen]}</div>
      </main>

      <Toasts />
      <OverwriteDialog />
      <PasswordDialog />
    </div>
  );
}


