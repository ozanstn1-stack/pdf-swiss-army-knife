export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[unit]}`;
}

export function formatReduction(reduction: number | null | undefined): string {
  if (reduction === null || reduction === undefined) return "—";
  const percent = Math.round(reduction * 100);
  return percent > 0 ? `-${percent}%` : `${Math.abs(percent)}%`;
}

export function formatDate(timestamp: number | string | null | undefined): string {
  if (timestamp === null || timestamp === undefined || timestamp === "") return "—";
  const value = typeof timestamp === "number" ? timestamp : Date.parse(String(timestamp));
  if (Number.isNaN(value)) return String(timestamp);
  const date = new Date(typeof timestamp === "number" ? timestamp * 1000 : value);
  return date.toLocaleString();
}

export function formatPoints(pt: number): string {
  const mm = (pt * 25.4) / 72;
  return `${pt.toFixed(0)} pt · ${mm.toFixed(0)} mm`;
}

export function fileBaseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export function fileStem(path: string): string {
  const name = fileBaseName(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

export function dirName(path: string): string {
  const parts = path.split(/[\\/]/);
  parts.pop();
  return parts.join("\\");
}

export function joinPath(dir: string, name: string): string {
  if (!dir) return name;
  const separator = dir.includes("\\") ? "\\" : "/";
  return dir.endsWith(separator) ? `${dir}${name}` : `${dir}${separator}${name}`;
}

export function isPdf(path: string): boolean {
  return path.toLowerCase().endsWith(".pdf");
}

export const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff", ".gif"];

export function isImage(path: string): boolean {
  const lower = path.toLowerCase();
  return IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function uid(prefix = "job"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function parsePageList(input: string, total: number): number[] | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (trimmed === "*" || trimmed.toLowerCase() === "all") {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  const pages = new Set<number>();
  for (const part of trimmed.split(",")) {
    const chunk = part.trim();
    if (!chunk) continue;
    if (chunk.includes("-")) {
      const [a, b] = chunk.split("-").map((v) => Number(v.trim()));
      if (!Number.isFinite(a) || !Number.isFinite(b) || a < 1 || b < a) return null;
      for (let p = a; p <= Math.min(b, total); p += 1) pages.add(p);
    } else {
      const value = Number(chunk);
      if (!Number.isFinite(value) || value < 1) return null;
      if (value <= total) pages.add(value);
    }
  }
  return pages.size ? Array.from(pages).sort((a, b) => a - b) : null;
}

export function summarisePages(pages: number[]): string {
  if (!pages.length) return "—";
  const sorted = [...pages].sort((a, b) => a - b);
  const ranges: string[] = [];
  let start = sorted[0];
  let previous = sorted[0];
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i] === previous + 1) {
      previous = sorted[i];
      continue;
    }
    ranges.push(start === previous ? `${start}` : `${start}-${previous}`);
    start = sorted[i];
    previous = sorted[i];
  }
  ranges.push(start === previous ? `${start}` : `${start}-${previous}`);
  return ranges.join(", ");
}
