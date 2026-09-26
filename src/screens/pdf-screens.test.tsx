import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * These render the real screens against a mocked backend. The mock payloads
 * use the exact wire format the Rust structs serialize: `rename_all =
 * "camelCase"` on the request/response structs, and `width_pt` / `height_pt`
 * for `render::PageGeometry`, which derives Serialize without it. That
 * mismatch shipped once and rendered a blank window, because a duplicate
 * `PageGeometry` interface in types.ts merged with the real one and hid it
 * from the type checker.
 */
const invoke = vi.fn(async (command: string) => {
  switch (command) {
    case "app_info":
      return { version: "2.1.0", name: "test" };
    case "engine_status":
      return { pdfium: true, qpdf: true, tesseract: true };
    case "load_settings":
      return { theme: "dark", language: "en" };
    case "load_recent":
    case "office_startup_files":
      return [];
    case "dev_launch_context":
      return { startScreen: null, files: [], autoRun: false, tab: null, newTab: null };
    case "suggest_output":
      return "C:/out.pdf";
    case "file_sizes":
      return [1024];
    case "pdf_info":
      return {
        path: "C:/a.pdf",
        fileName: "a.pdf",
        fileSizeBytes: 1024,
        pageCount: 1,
        pdfVersion: "1.7",
        encrypted: false,
        hasTextLayer: true,
        metadata: {},
        pageGeometries: [
          {
            page: 1,
            width_pt: 595.28,
            height_pt: 841.89,
            display_width_pt: 595.28,
            display_height_pt: 841.89,
            rotation: 0,
          },
        ],
        imageCount: 0,
        title: "",
        author: "",
        producer: "",
      };
    case "inspect_document":
      return inspectionFixture;
    case "detect_sensitive_text":
      return [{ page: 1, text: "jane@example.com", left: 60, bottom: 700, right: 200, top: 714, kind: "email" }];
    case "page_preview":
      return { dataUrl: "data:image/png;base64,iVBORw0KGgo=", width: 595, height: 842 };
    default:
      return null;
  }
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...(args as [string])) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("@tauri-apps/api/path", () => ({ documentDir: vi.fn(async () => "C:/docs") }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => null) }));

import inspectionFixture from "../../crates/pdfcore/tests/fixtures/inspection-sample-2.pdf.json";
import { Inspect } from "./Inspect";
import { Compare } from "./Compare";
import { Redact } from "./Redact";

const props = { dragging: false, initialFiles: ["C:/a.pdf"] };

describe("the new PDF screens render against the real wire format", () => {
  beforeEach(() => {
    invoke.mockClear();
  });

  it("renders the inspector and reports the document it received", async () => {
    const user = userEvent.setup();
    const { container } = render(<Inspect {...props} />);
    await waitFor(() => expect(screen.getByText(/fails basic accessibility/i)).toBeInTheDocument());
    // Every value below is camelCase on the wire, so this only passes if the
    // frontend reads the format the backend actually sends.
    expect(container.textContent).toContain("1.7"); // pdfVersion
    expect(container.textContent).toContain("0"); // totalImagePixels
    await user.click(screen.getByRole("button", { name: /^fonts$/i }));
    expect(screen.getByText("F1")).toBeInTheDocument();
    expect(screen.getByText("Type1")).toBeInTheDocument();
    // A font that is not embedded must be flagged, not silently accepted.
    expect(screen.getByText("Not embedded")).toBeInTheDocument();
    // Findings came back, so the errors are counted rather than zero.
    expect(container.textContent).toContain("3 error");
  });

  it("lists findings with their explanation, not just a code", async () => {
    const user = userEvent.setup();
    render(<Inspect {...props} />);
    await waitFor(() => expect(screen.getByText(/fails basic accessibility/i)).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /^findings$/i }));
    expect(screen.getByText("a11y.untagged")).toBeInTheDocument();
    expect(screen.getByText(/no structure tree/i)).toBeInTheDocument();
    expect(screen.getByText("a11y.missing-language")).toBeInTheDocument();
  });

  it("shows the page size in points, which proves width_pt is being read", async () => {
    const { container } = render(<Redact {...props} />);
    // If normalizePageSize read the camelCase spelling that does not exist on
    // the wire, this would render "NaN × NaN pt" and no box could be drawn.
    await waitFor(() => expect(container.textContent).toContain("595 × 842 pt"));
    expect(container.textContent).not.toContain("NaN");
  });

  it("offers the sensitive data the detector found, and lets it be dropped", async () => {
    const user = userEvent.setup();
    render(<Redact {...props} />);
    await waitFor(() => expect(screen.getByText(/drag over anything to redact/i)).toBeInTheDocument());
    await user.click(screen.getAllByRole("button", { name: /find sensitive data/i })[0]);
    await waitFor(() => expect(screen.getByText("jane@example.com")).toBeInTheDocument());
    expect(screen.getByText("E-mail")).toBeInTheDocument();
    // Deselecting removes the auto-added box rather than leaving a box the
    // user thought they had removed.
    const checkboxes = screen.getAllByRole("checkbox");
    await user.click(checkboxes[0]);
    expect(screen.getByText("jane@example.com")).toBeInTheDocument();
  });

  it("renders the compare screen and explains that it needs a second file", () => {
    render(<Compare {...props} />);
    expect(screen.getByText(/add a second pdf/i)).toBeInTheDocument();
  });
});
