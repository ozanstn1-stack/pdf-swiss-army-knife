export type ScreenId =
  | "home"
  | "reader"
  | "merge"
  | "organize"
  | "split"
  | "compress"
  | "convert"
  | "pageops"
  | "watermark"
  | "numbering"
  | "metadata";

export interface NavEntry {
  id: ScreenId;
  label: string;
  icon: string;
  group: string;
}

export const NAV: NavEntry[] = [
  { id: "home", label: "Home", icon: "home", group: "" },
  { id: "reader", label: "Read", icon: "book", group: "" },
  { id: "merge", label: "Merge", icon: "combine", group: "PDF tools" },
  { id: "organize", label: "Organize Pages", icon: "layers", group: "PDF tools" },
  { id: "split", label: "Split", icon: "scissors", group: "PDF tools" },
  { id: "pageops", label: "Page Tools", icon: "wand", group: "PDF tools" },
  { id: "compress", label: "Compress", icon: "minimize", group: "PDF tools" },
  { id: "watermark", label: "Watermark", icon: "stamp", group: "PDF tools" },
  { id: "numbering", label: "Page Numbers", icon: "hash", group: "PDF tools" },
  { id: "metadata", label: "Metadata", icon: "files", group: "PDF tools" },
  { id: "convert", label: "Convert", icon: "images", group: "Convert" },
];
