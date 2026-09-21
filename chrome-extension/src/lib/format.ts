// Small formatting/parsing helpers shared by the extension UI.

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[unit]}`;
}

export function fileBaseName(name: string): string {
  return name.split(/[\\/]/).pop() || name;
}

export function fileStem(name: string): string {
  const base = fileBaseName(name);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Parses "1,3,5-8,12" (or "*") into a sorted, unique page list. */
export function parsePageSelection(input: string, total: number): number[] | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (trimmed === "*" || trimmed.toLowerCase() === "all") {
    return Array.from({ length: total }, (_, index) => index + 1);
  }
  const pages = new Set<number>();
  for (const part of trimmed.split(",")) {
    const chunk = part.trim();
    if (!chunk) continue;
    if (chunk.includes("-")) {
      const [a, b] = chunk.split("-").map((value) => Number(value.trim()));
      if (!Number.isFinite(a) || !Number.isFinite(b) || a < 1 || b < a || b > total) return null;
      for (let page = a; page <= b; page += 1) pages.add(page);
    } else {
      const value = Number(chunk);
      if (!Number.isFinite(value) || value < 1 || value > total) return null;
      pages.add(value);
    }
  }
  return pages.size ? Array.from(pages).sort((a, b) => a - b) : null;
}

/** PDF header version, e.g. "1.7". */
export function pdfVersionFromBytes(bytes: Uint8Array): string {
  const header = new TextDecoder("latin1").decode(bytes.slice(0, 1024));
  const match = header.match(/%PDF-(\d\.\d)/);
  return match ? match[1] : "unknown";
}

/** Cheap trailer scan: does the file declare an /Encrypt dictionary? */
export function hasEncryptDictionary(bytes: Uint8Array): boolean {
  const tail = new TextDecoder("latin1").decode(bytes.slice(Math.max(0, bytes.length - 4096)));
  return tail.includes("/Encrypt");
}

export function isPdfName(name: string): boolean {
  return name.toLowerCase().endsWith(".pdf");
}

export function isImageName(name: string): boolean {
  return /\.(png|jpe?g|webp)$/i.test(name);
}
