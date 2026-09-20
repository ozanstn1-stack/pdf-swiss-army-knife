import { useEffect } from "react";
import { FilePlus2, FolderOpen, Trash2 } from "lucide-react";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { Button, Card, EmptyState } from "../components/ui";
import { Screen } from "../components/layout";
import { useT } from "../lib/i18n";
import { useRecent, useToasts } from "../lib/store";
import { formatDate, isPdf } from "../lib/format";
import type { Navigate } from "../lib/nav";

export function History({ onNavigate }: { onNavigate: Navigate }) {
  const t = useT();
  const entries = useRecent((s) => s.entries);
  const refresh = useRecent((s) => s.refresh);
  const clear = useRecent((s) => s.clear);
  const pushToast = useToasts((s) => s.push);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <Screen
      title={t("history.title")}
      subtitle={t("history.subtitle")}
      actions={
        entries.length ? (
          <Button
            variant="danger"
            size="sm"
            icon={<Trash2 size={14} />}
            onClick={() => {
              void clear().then(() => pushToast({ kind: "success", title: t("history.cleared") }));
            }}
          >
            {t("history.clear")}
          </Button>
        ) : null
      }
    >
      {entries.length === 0 ? (
        <Card>
          <EmptyState
            icon={<FilePlus2 size={22} />}
            title={t("history.empty")}
            hint={t("home.recentEmptyHint")}
            action={
              <Button variant="primary" onClick={() => onNavigate("home")}>
                {t("nav.home")}
              </Button>
            }
          />
        </Card>
      ) : (
        <Card className="p-2">
          <table className="table">
            <thead>
              <tr>
                <th>{t("common.name")}</th>
                <th>{t("common.actions")}</th>
                <th style={{ width: 180 }}>{t("settings.version") === "" ? "Date" : "Date"}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.path}>
                  <td>
                    <p className="font-medium truncate max-w-[520px]" title={entry.path}>
                      {entry.fileName}
                    </p>
                    <p className="text-xs muted truncate max-w-[520px]">{entry.path}</p>
                  </td>
                  <td>
                    <div className="flex gap-1.5">
                      <Button
                        size="sm"
                        onClick={() => {
                          if (isPdf(entry.path)) {
                            onNavigate("organize", { files: [entry.path] });
                          } else {
                            void openPath(entry.path).catch(() => undefined);
                          }
                        }}
                      >
                        {t("common.open")}
                      </Button>
                      <Button size="sm" variant="ghost" icon={<FolderOpen size={13} />} onClick={() => void revealItemInDir(entry.path).catch(() => undefined)} />
                    </div>
                  </td>
                  <td className="muted text-xs">{formatDate(entry.timestamp)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </Screen>
  );
}
